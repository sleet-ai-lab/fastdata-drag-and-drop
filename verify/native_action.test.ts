// ========================================
// the native action path: what actually lands on chain.
//
// this is the file that matters. it pins the ONE thing that decides
// whether an upload works or silently 404s.
//
// THE STORY, in the wallet's own source (INTEARnear/wallet):
//
// web/src/utils.rs
//
//   #[derive(Deserialize)]
//   #[serde(untagged)]
//   pub enum SendTransactionsAction {
//       Native(NearAction),
//       WalletSelector(WalletSelectorAction),
//   }
//
//   impl From<WalletSelectorAction> for NearAction {
//       ... FunctionCall { method_name, args, gas, deposit } =>
//           NearAction::FunctionCall(Box::new(FunctionCallAction {
//               method_name,
//               args: serde_json::to_vec(&args).unwrap_or_default(),
//               ...
//           }))
//   }
//
// near-min-api/src/types.rs
//
//   pub struct FunctionCallAction {
//       pub method_name: String,
//       #[serde_as(as = "Base64")]
//       pub args: Vec<u8>,
//       ...
//   }
//
// so the wallet has TWO paths, and the NATIVE one is tried FIRST:
//
//   NATIVE           args are BASE64 in json, DECODED to raw bytes on chain
//   WALLET-SELECTOR  args are a serde_json::Value, SERIALIZED as json
//
// the wallet-selector path is what near-kit's adapter produces, and it
// CANNOT carry raw bytes: a string value comes out QUOTED, so the
// on-chain args are ascii and the fastfs indexer's borsh::from_slice
// fails and drops the action. the file 404s and nothing says why.
//
// we proved that on chain. our tx
// 4s6v2whoeMhkHtwHDBVsp8EqYAVENoVgq4yxbdXJnuDj landed 66 bytes
// starting with 0x22 (a quote) and was never picked up.
//
// so we send the NATIVE shape and the bytes land verbatim.
//
// run: bun test verify/native_action.test.ts
// ========================================
import { describe, expect, test } from "bun:test";
import { NearConnector } from "@hot-labs/near-connect";
import { serialize as borshSerialize } from "borsh";
import { FastfsSchema } from "../src/fastfs/schema.js";
import {
  METHOD_NAME,
  GAS,
  send_native_function_call,
  bytes_to_base64,
  base64_to_bytes,
} from "../src/fastfs/upload.js";

// ========================================
const PATH = "test.txt";
const MIME = "text/plain";
const CONTENT = new Uint8Array(Buffer.from("hello fastfs\n"));

function build_payload() {
  return borshSerialize(FastfsSchema.FastfsData, {
    simple: { relativePath: PATH, content: { mimeType: MIME, content: CONTENT } },
  });
}
// ========================================

// ========================================
// a connector that records the action and models the wallet's own
// parsing: the native action's args are base64, and the wallet decodes
// them into the bytes that go on chain.
function make_connector() {
  const captured = { value: null };
  const connector = new NearConnector({ network: "testnet" });
  connector.wallet = async () => ({
    manifest: { features: {} },
    getAccounts: async () => [{ accountId: "sleet.near" }],
    // the real wallet's `executor` is a PUBLIC field and is what
    // carries the action to the wallet iframe without near-connect's
    // conversion. that is the route we use.
    executor: {
      call: async (method: string, params: unknown) => {
        captured.value = { method, ...(params as object) };
        return {
          final_execution_status: "EXECUTED_OPTIMISTIC",
          transaction: { hash: "HASH", signer_id: "sleet.near" },
        };
      },
    },
    signAndSendTransaction: async (params: unknown) => {
      captured.value = params;
      return {
        final_execution_status: "EXECUTED_OPTIMISTIC",
        transaction: { hash: "HASH", signer_id: "sleet.near" },
      };
    },
    signMessage: async () => ({}),
    signDelegateActions: async () => ({ signedDelegateActions: [] }),
  });
  return { connector, captured };
}
// ========================================

describe("the native action shape", () => {
  test("the action is a NATIVE FunctionCall with base64 args", async () => {
    const { connector, captured } = make_connector();
    const bytes = build_payload();

    await send_native_function_call("fastfs.near", bytes, { connector });

    // the executor route was used, not signAndSendTransaction.
    expect(captured.value.method).toBe("wallet:signAndSendTransaction");

    const action = captured.value.actions[0];

    // --- THE NATIVE SHAPE ---
    // PascalCase variant, snake_case fields. NOT { type, params }.
    expect(action.FunctionCall).toBeDefined();
    expect(action.FunctionCall.method_name).toBe(METHOD_NAME);
    expect(action.FunctionCall.gas).toBe(GAS);
    expect(action.FunctionCall.deposit).toBe("0");

    // NO top-level "type" key. the wallet's native variant is an
    // externally tagged enum, so a sibling "type" key makes serde look
    // for a variant named "type" and fail with
    // "unknown variant `type`, expected `FunctionCall`".
    expect(action.type).toBeUndefined();

    // the args are base64, which the wallet decodes into raw bytes.
    expect(typeof action.FunctionCall.args).toBe("string");
    const decoded = base64_to_bytes(action.FunctionCall.args);
    expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
    expect(decoded[0]).toBe(0x00);
  });

  // --- WHY --- near-connect's conversion cannot pass a native action
  // through, which is why we use the wallet's executor instead.
  //
  //   const nearActionsToConnectorActions = (actions) => actions.map((action) => {
  //     if ("type" in action) return action;      // passthrough
  //     if (action.functionCall) { ...convert... }
  //     throw new Error("Unsupported action type");
  //   });
  //
  // a native action has no "type" key, so it hits the throw. adding
  // one gets it past the conversion, but the wallet's externally
  // tagged native variant then rejects it. we verified that by
  // compiling the wallet's exact serde types:
  //
  //   native, no type key   -> OK Native, raw bytes, first 0x00
  //   native WITH type key  -> ERR unknown variant `type`
  //
  // so the executor is the way through: it posts the params to the
  // wallet iframe with no conversion at all.
  test("near-connect's conversion rejects a native action", async () => {
    const { nearActionsToConnectorActions } = await import(
      "@hot-labs/near-connect/build/actions/index.js"
    );

    const native = {
      FunctionCall: {
        method_name: METHOD_NAME,
        args: "ABEAAA==",
        gas: "1",
        deposit: "0",
      },
    };

    expect(() => nearActionsToConnectorActions([native])).toThrow(
      "Unsupported action type",
    );
  });

  test("the receiver, signer and gas all go through unchanged", async () => {
    const { connector, captured } = make_connector();

    await send_native_function_call("fastfs.testnet", build_payload(), {
      connector,
      signer_id: "sleet.testnet",
    });

    expect(captured.value.receiverId).toBe("fastfs.testnet");
    expect(captured.value.signerId).toBe("sleet.testnet");
    expect(captured.value.actions[0].FunctionCall.gas).toBe("1");
  });
});
// ========================================
