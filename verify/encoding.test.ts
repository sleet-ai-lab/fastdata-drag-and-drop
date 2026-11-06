// ========================================
// verify the fastfs borsh encoding against a real on-chain SUCCESSFUL
// upload.
//
// this pins the encoding. the expected values come from a real
// mainnet transaction whose file IS served by fastfs:
//
//   tx        5vUqtNhYchWyrifviVZ9F6k4QprgfW9fjSAtcGMdQyRw
//   signer    mob.near
//   receiver  fastfs.near
//   method    __fastdata_fastfs
//   path      fastnear.png
//   mime      image/png
//   content   a 121477-byte png
//   served at https://mob.near.fastfs.io/fastfs.near/fastnear.png  (200)
//
// the tx's on-chain args are 121512 RAW borsh bytes, starting:
//
//   00 0c000000 "fastnear.png" 01 09000000 "image/png" 85da0100 <png>
//
//   00        enum discriminant 0 = simple
//   0c000000  string len 12
//   01        option = Some
//   09000000  string len 9
//   85da0100  u8 array len 121477 = the png size
//
// WHY THIS MATTERS SO MUCH:
// there is a real FAILED upload we have to not copy. a transaction
// that sent its args as a base64 STRING (json-wrapped by near-api-js)
// looks like this on chain:
//
//   "AA8AAABub3Rlcy9zbWFsbC50eHQBCgAAAHRleHQvcGxhaW4NAAAAaGVsbG8gZmFzdGZzCg=="
//   ^-- 74 bytes, the borsh bytes as a quoted base64 string
//
// its file 404s. the indexer cannot read double-encoded args, so the
// upload silently does not land.
//
// the difference is entirely in how the args are passed:
//   raw Uint8Array  -> lands  (what the working tx did)
//   base64 string   -> 404s  (what the failed tx did)
//
// so the tests below check the SHAPE of the encoding, not just one
// fixed byte string. that way the layout stays pinned even though we
// do not have the png itself checked in.
//
// run: bun test verify/encoding.test.ts
// ========================================
import { describe, expect, test } from "bun:test";
import { serialize as borshSerialize } from "borsh";
import { FastfsSchema } from "../src/fastfs/schema";

// ========================================
// the reference layout, taken from the working transaction's args.
// ========================================
const REF_PATH = "fastnear.png";
const REF_MIME = "image/png";
const REF_CONTENT_LEN = 121477;
const REF_ARGS_LEN = 121512;

// ========================================
// the failed upload's args, kept here as a counter-example so nobody
// "simplifies" the encoding back into this shape.
const FAILED_ARGS_PREFIX = '"AA8AAABub3Rlcy9zbWFsbC50eHQB';
// ========================================

describe("fastfs encoding", () => {
  test("produces the same borsh layout as the working on-chain upload", () => {
    const bytes = borshSerialize(FastfsSchema.FastfsData, {
      simple: {
        relativePath: REF_PATH,
        content: {
          mimeType: REF_MIME,
          content: new Uint8Array(REF_CONTENT_LEN),
        },
      },
    });

    // the reference layout, byte by byte.
    const expected = Buffer.concat([
      Buffer.from([0x00]), // enum discriminant: simple
      Buffer.from([0x0c, 0x00, 0x00, 0x00]), // string len 12
      Buffer.from(REF_PATH, "utf8"),
      Buffer.from([0x01]), // option: Some
      Buffer.from([0x09, 0x00, 0x00, 0x00]), // string len 9
      Buffer.from(REF_MIME, "utf8"),
      Buffer.from([0x85, 0xda, 0x01, 0x00]), // u8 array len 121477
      Buffer.alloc(REF_CONTENT_LEN),
    ]);

    expect(bytes.length).toBe(expected.length);
    expect(Buffer.from(bytes).equals(expected)).toBe(true);
  });

  // --- WHY --- this is the length of the working tx's on-chain args.
  // if this drifts, our payload is not the shape the indexer reads.
  test("the reference payload is 121512 bytes, like the working tx args", () => {
    const bytes = borshSerialize(FastfsSchema.FastfsData, {
      simple: {
        relativePath: REF_PATH,
        content: {
          mimeType: REF_MIME,
          content: new Uint8Array(REF_CONTENT_LEN),
        },
      },
    });

    expect(bytes.length).toBe(REF_ARGS_LEN);
  });

  // --- WHY --- the failed upload wrapped the borsh bytes as a quoted
  // base64 string. near-api-js does that when args are not a
  // Uint8Array, and the indexer cannot read it, so the file 404s.
  // this test asserts we are NOT doing that.
  test("the payload is raw borsh, NOT a base64 string", () => {
    const bytes = borshSerialize(FastfsSchema.FastfsData, {
      simple: {
        relativePath: REF_PATH,
        content: {
          mimeType: REF_MIME,
          content: new Uint8Array(REF_CONTENT_LEN),
        },
      },
    });

    // it must start with the enum discriminant, not with a quote.
    expect(bytes[0]).toBe(0x00);
    // it must not look like the failed upload's args.
    expect(Buffer.from(bytes).toString("utf8", 0, 40)).not.toStartWith(
      FAILED_ARGS_PREFIX,
    );
    // and the first bytes must be the borsh header, not ascii.
    expect(Buffer.from(bytes).toString("hex", 0, 2)).toBe("000c");
  });

  // --- WHY --- the bytes must stay a Uint8Array from here all the way
  // to the wallet. near-kit's functionCall does:
  //   args instanceof Uint8Array ? args : TextEncoder().encode(JSON.stringify(args))
  // so a base64 string would be JSON-wrapped on the way to the chain
  // and the upload would silently not land.
  test("the encoded payload is a Uint8Array, never a string", () => {
    const bytes = borshSerialize(FastfsSchema.FastfsData, {
      simple: {
        relativePath: REF_PATH,
        content: {
          mimeType: REF_MIME,
          content: new Uint8Array(REF_CONTENT_LEN),
        },
      },
    });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(typeof bytes).not.toBe("string");
    expect(bytes.byteLength).toBe(bytes.length);
  });

  // --- WHY --- the JSON.parse branches in near-kit's adapter and in
  // near-connect both try to read our bytes as JSON. they only keep
  // the raw bytes when the parse FAILS. a payload that parsed as JSON
  // would be turned into an object and the wallet would sign a
  // different transaction than the one we built.
  test("the payload is NOT valid JSON, so the bytes pass through intact", () => {
    const bytes = borshSerialize(FastfsSchema.FastfsData, {
      simple: {
        relativePath: REF_PATH,
        content: {
          mimeType: REF_MIME,
          content: new Uint8Array(REF_CONTENT_LEN),
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
});
// ========================================
