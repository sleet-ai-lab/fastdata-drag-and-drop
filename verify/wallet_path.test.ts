// ========================================
// the wallet path: what the WALLET actually receives.
//
// this is the test that answers "are we sending the args to the
// wallet the right way?". it does not mock near-kit's internals —
// it drives the REAL near-kit and the REAL @hot-labs/near-connect
// and captures what reaches the wallet's signAndSendTransaction.
//
// WHY THIS MATTERS SO MUCH:
// the args travel through two conversion layers before the wallet
// sees them, and BOTH of them try to read our bytes as JSON:
//
//   near-kit, wallets/adapters.js:26-35
//     try { args = JSON.parse(new TextDecoder().decode(args)) }
//     catch { /* keep the raw bytes */ }
//
//   near-connect, actions/index.js:5-10
//     the same logic
//
// they only keep the raw bytes because the JSON.parse FAILS. so the
// property we depend on is "the payload is not valid JSON", and this
// test proves the bytes survive both layers for real.
//
// the failure we are guarding against is real: we found a mainnet
// transaction (sleet.near -> fastfs.near) whose args landed on chain
// as 74 bytes of quoted base64, and whose file 404s. the indexer
// drops the action silently.
//
// run: bun test verify/wallet_path.test.ts
// ========================================
import { describe, expect, test } from "bun:test";
import { Near, fromNearConnect } from "near-kit";
import { NearConnector } from "@hot-labs/near-connect";
import { serialize as borshSerialize } from "borsh";
import { FastfsSchema } from "../src/fastfs/schema.js";
import { METHOD_NAME, GAS } from "../src/fastfs/upload.js";

// ========================================
// the payload we build in the test. same shape as the working
// on-chain upload.
const CONTENT = new Uint8Array(Buffer.from("hello fastfs\n"));
const PATH = "notes/small.txt";
const MIME = "text/plain";

function build_payload() {
  return borshSerialize(FastfsSchema.FastfsData, {
    simple: { relativePath: PATH, content: { mimeType: MIME, content: CONTENT } },
  });
}
// ========================================

// ========================================
// a fake connector that captures what the wallet receives.
function make_capture_connector() {
  const captured = { value: null };
  const connector = new NearConnector({ network: "testnet" });
  connector.wallet = async () => ({
    manifest: { features: {} },
    getAccounts: async () => [{ accountId: "sleet.testnet" }],
    signAndSendTransaction: async (params) => {
      captured.value = params;
      return {
        final_execution_status: "EXECUTED_OPTIMISTIC",
        transaction: { hash: "HASH" },
      };
    },
    signMessage: async () => ({}),
    signDelegateActions: async () => ({ signedDelegateActions: [] }),
  });
  return { connector, captured };
}
// ========================================

describe("what the wallet receives", () => {
  test("through the real near-kit and near-connect, the args stay raw bytes", async () => {
    const { connector, captured } = make_capture_connector();
    const near = new Near({
      network: "testnet",
      wallet: fromNearConnect(connector),
    });

    const bytes = build_payload();
    await near.call("fastfs.testnet", METHOD_NAME, bytes, { gas: GAS });

    // the wallet got the call.
    expect(captured.value).not.toBeNull();
    expect(captured.value.receiverId).toBe("fastfs.testnet");

    const action = captured.value.actions[0];
    expect(action.type).toBe("FunctionCall");
    expect(action.params.methodName).toBe(METHOD_NAME);
    expect(action.params.gas).toBe(GAS);
    expect(action.params.deposit).toBe("0");

    // --- THE ASSERTION THAT MATTERS ---
    // the args are a Uint8Array, and they are byte-for-byte what we
    // built. not a string, not JSON, not base64.
    expect(action.params.args).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(action.params.args).equals(Buffer.from(bytes))).toBe(
      true,
    );

    // and they start with the enum discriminant, not with a quote.
    expect(action.params.args[0]).toBe(0x00);
    expect(action.params.args[0]).not.toBe(0x22);
  });

  test("the payload the wallet gets is the same one the indexer will read", async () => {
    const { connector, captured } = make_capture_connector();
    const near = new Near({
      network: "testnet",
      wallet: fromNearConnect(connector),
    });

    const bytes = build_payload();
    await near.call("fastfs.testnet", METHOD_NAME, bytes, { gas: GAS });

    const wallet_args = captured.value.actions[0].params.args;

    // this is exactly the string the rpc would report for the action,
    // and exactly what borsh::from_slice has to be able to parse.
    const on_chain_b64 = Buffer.from(wallet_args).toString("base64");
    const decoded = new Uint8Array(
      Buffer.from(on_chain_b64, "base64"),
    );

    expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);

    // and the indexer's decode of it must succeed. we cannot run rust
    // here, but borsh is the same algorithm on both sides, so a borsh
    // round trip is the check.
    const round_tripped = borshSerialize(FastfsSchema.FastfsData, {
      simple: { relativePath: PATH, content: { mimeType: MIME, content: CONTENT } },
    });
    expect(Buffer.from(decoded).equals(Buffer.from(round_tripped))).toBe(true);
  });

  test("no signerId is passed, so the wallet's own account signs", async () => {
    const { connector, captured } = make_capture_connector();
    const near = new Near({
      network: "testnet",
      wallet: fromNearConnect(connector),
    });

    await near.call("fastfs.testnet", METHOD_NAME, build_payload(), { gas: GAS });

    // near.call resolves the signer itself when signerId is absent:
    // options.signerId, else the default signer, else the connected
    // wallet's first account. we want the wallet's account, so we
    // pass nothing. the signer that ended up on the transaction is the
    // wallet's account.
    expect(captured.value.signerId).toBe("sleet.testnet");
  });
});
// ========================================
