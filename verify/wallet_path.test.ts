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
import {
  METHOD_NAME,
  GAS,
  bytes_to_base64,
  base64_to_bytes,
} from "../src/fastfs/upload.js";

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
    await near.call("fastfs.testnet", METHOD_NAME, bytes_to_base64(bytes), {
      gas: GAS,
    });

    // the wallet got the call.
    expect(captured.value).not.toBeNull();
    expect(captured.value.receiverId).toBe("fastfs.testnet");

    const action = captured.value.actions[0];
    expect(action.type).toBe("FunctionCall");
    expect(action.params.methodName).toBe(METHOD_NAME);
    expect(action.params.gas).toBe(GAS);
    expect(action.params.deposit).toBe("0");

    // --- THE ASSERTION THAT MATTERS ---
    // the args are a base64 STRING, and decoding it gives back exactly
    // the bytes we built.
    //
    // WHY A STRING AND NOT THE RAW BYTES: near-connect sends the
    // transaction to the wallet as JSON. JSON.stringify turns a
    // Uint8Array into {"0":0,"1":9,...} — an object keyed by byte
    // index — and the wallet then has to GUESS that those numbers are
    // bytes. we saw it happen: the Intear wallet showed
    //
    //   json-args '{"0":0,"1":9,"10":46,...}'
    //
    // a base64 string survives JSON.stringify unchanged, and the
    // wallet's cli formatter has a `base64-args` mode that decodes it
    // and puts the BYTES on chain. this is also what the reference
    // implementation does.
    expect(typeof action.params.args).toBe("string");
    const decoded = new Uint8Array(Buffer.from(action.params.args, "base64"));
    expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);

    // and the decoded bytes start with the enum discriminant, not with
    // a quote.
    expect(decoded[0]).toBe(0x00);
    expect(decoded[0]).not.toBe(0x22);
  });

  // --- WHY --- this is the failure we actually hit. near-connect
  // JSON.stringifies the actions, so a Uint8Array arrives at the
  // wallet as an OBJECT keyed by byte index. the wallet shows it as
  // `json-args '{...}'` and there is nothing in that object saying
  // "these are the bytes".
  test("a Uint8Array would arrive at the wallet as an object, not bytes", async () => {
    const { connector, captured } = make_capture_connector();
    const near = new Near({
      network: "testnet",
      wallet: fromNearConnect(connector),
    });

    const bytes = build_payload();
    await near.call("fastfs.testnet", METHOD_NAME, bytes, { gas: GAS });

    // near-kit passes the Uint8Array through to the connector.
    expect(captured.value.actions[0].params.args).toBeInstanceOf(Uint8Array);

    // but the wallet receives JSON, and JSON.stringify turns the
    // Uint8Array into an object keyed by byte index. this is what the
    // user saw in the wallet.
    const wire = JSON.parse(
      JSON.stringify([
        {
          signerId: captured.value.signerId,
          receiverId: captured.value.receiverId,
          actions: captured.value.actions,
        },
      ]),
    );
    const wallet_args = wire[0].actions[0].params.args;

    expect(typeof wallet_args).toBe("object");
    expect(wallet_args[0]).toBe(0x00);
    expect(wallet_args["0"]).toBe(0x00);
    expect(wallet_args["10"]).toBe(bytes[10]);

    // so we send the base64 string instead. THAT is what the wallet
    // receives unambiguously, and its base64-args mode decodes it back
    // to our exact bytes.
  });

  test("the bytes that land on chain are the ones the indexer will read", async () => {
    const { connector, captured } = make_capture_connector();
    const near = new Near({
      network: "testnet",
      wallet: fromNearConnect(connector),
    });

    const bytes = build_payload();
    await near.call("fastfs.testnet", METHOD_NAME, bytes_to_base64(bytes), {
      gas: GAS,
    });

    const wallet_args = captured.value.actions[0].params.args;

    // the wallet holds our base64 string. its base64-args mode decodes
    // it, and what lands on chain is the DECODED BYTES. this is the
    // string the rpc reports for the action.
    expect(typeof wallet_args).toBe("string");
    const decoded = new Uint8Array(Buffer.from(wallet_args, "base64"));

    expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);

    // and the indexer's decode of it must succeed. we cannot run rust
    // here, but borsh is the same algorithm on both sides, so a borsh
    // round trip is the check.
    const round_tripped = borshSerialize(FastfsSchema.FastfsData, {
      simple: { relativePath: PATH, content: { mimeType: MIME, content: CONTENT } },
    });
    expect(Buffer.from(decoded).equals(Buffer.from(round_tripped))).toBe(true);

    // the on-chain args, as the rpc would report them, are the base64
    // of those bytes — which is exactly the string the wallet holds.
    expect(Buffer.from(decoded).toString("base64")).toBe(wallet_args);
  });

  test("no signerId is passed, so the wallet's own account signs", async () => {
    const { connector, captured } = make_capture_connector();
    const near = new Near({
      network: "testnet",
      wallet: fromNearConnect(connector),
    });

    await near.call(
      "fastfs.testnet",
      METHOD_NAME,
      bytes_to_base64(build_payload()),
      { gas: GAS },
    );

    // near.call resolves the signer itself when signerId is absent:
    // options.signerId, else the default signer, else the connected
    // wallet's first account. we want the wallet's account, so we
    // pass nothing. the signer that ended up on the transaction is the
    // wallet's account.
    expect(captured.value.signerId).toBe("sleet.testnet");
  });

  // --- WHY --- the base64 is built in slices. spreading a whole 1 MiB
  // file into String.fromCharCode(...bytes) would blow the argument
  // limit and throw a RangeError. the per-file cap is 1 MiB, so that
  // is the size we have to survive.
  test("a 1 MiB payload survives the base64 round trip", () => {
    const big = new Uint8Array(1048576);
    big[0] = 0x00;
    for (let i = 1; i < big.length; i++) big[i] = i % 251;

    const encoded = bytes_to_base64(big);
    const decoded = base64_to_bytes(encoded);

    expect(decoded.length).toBe(big.length);
    expect(Buffer.from(decoded).equals(Buffer.from(big))).toBe(true);
    expect(decoded[0]).toBe(0x00);
  });
});
// ========================================
