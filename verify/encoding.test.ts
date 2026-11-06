// ========================================
// verify the fastfs borsh encoding against the real on-chain bytes.
//
// this pins the encoding. the expected value is the args of a real
// mainnet transaction:
//
//   signer   sleet.near
//   receiver fastfs.near
//   method   __fastdata_fastfs
//   path     notes/small.txt
//   content  "hello fastfs\n"
//
// we pull that tx back from the chain and compare its base64 args to
// what we build here. if this test fails, our bytes are wrong and the
// upload will not land correctly.
//
// run: bun test verify/encoding.test.ts
// ========================================
import { describe, expect, test } from "bun:test";
import { serialize as borshSerialize } from "borsh";
import { FastfsSchema } from "../src/fastfs/schema";

// ========================================
// the args of the real transaction, base64.
const ON_CHAIN_ARGS_B64 =
  "AA8AAABub3Rlcy9zbWFsbC50eHQBCgAAAHRleHQvcGxhaW4NAAAAaGVsbG8gZmFzdGZzCg==";

// ========================================
describe("fastfs encoding", () => {
  test("encodes notes/small.txt to the exact on-chain bytes", () => {
    const bytes = borshSerialize(FastfsSchema.FastfsData, {
      simple: {
        relativePath: "notes/small.txt",
        content: {
          mimeType: "text/plain",
          content: new Uint8Array(Buffer.from("hello fastfs\n")),
        },
      },
    });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(52);
    expect(Buffer.from(bytes).toString("base64")).toBe(ON_CHAIN_ARGS_B64);
  });

  // --- WHY this matters ---
  // near-kit's adapter and near-connect's own helper both do:
  //   try { args = JSON.parse(new TextDecoder().decode(args)) }
  //   catch { /* keep the raw bytes */ }
  // so the raw bytes only survive because the JSON.parse FAILS. if a
  // payload ever parsed as JSON, the wallet would sign a different
  // transaction than the one we built. this test guards that.
  test("the payload is NOT valid JSON, so the bytes pass through intact", () => {
    const bytes = borshSerialize(FastfsSchema.FastfsData, {
      simple: {
        relativePath: "notes/small.txt",
        content: {
          mimeType: "text/plain",
          content: new Uint8Array(Buffer.from("hello fastfs\n")),
        },
      },
    });

    let parsed_as_json = true;
    try {
      JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parsed_as_json = false;
    }
    expect(parsed_as_json).toBe(false);
  });

  // --- WHY this matters ---
  // the bytes must stay a Uint8Array from here all the way to the
  // wallet. near-kit's functionCall does:
  //   args instanceof Uint8Array ? args : TextEncoder().encode(JSON.stringify(args))
  // so a base64 string would be JSON-wrapped and the file would be
  // garbage on chain. this test pins the type.
  test("the encoded payload is a Uint8Array, never a string", () => {
    const bytes = borshSerialize(FastfsSchema.FastfsData, {
      simple: {
        relativePath: "notes/small.txt",
        content: {
          mimeType: "text/plain",
          content: new Uint8Array(Buffer.from("hello fastfs\n")),
        },
      },
    });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(typeof bytes).not.toBe("string");
    // a Uint8Array has byteLength === length. a string does not.
    expect(bytes.byteLength).toBe(bytes.length);
  });
});
// ========================================
