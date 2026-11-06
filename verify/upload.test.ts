// ========================================
// verify the upload path: the encoding we send, the url we build, and
// the on-chain check that decides whether an upload really landed.
//
// THE PART THAT MATTERS MOST:
//
// the fastfs indexer takes the action's args as RAW BYTES
// (fastnear/fastdata-indexer, main-indexer/src/main.rs:
//
//   data: args.to_vec(),          // the raw bytes, verbatim
//
// ) and borsh-decodes them straight into the schema
// (fastfs-sub-indexer/src/main.rs:
//
//   if let Ok(value) = borsh::from_slice(&fastdata.data) { ... }
//
// borsh::from_slice on a JSON-wrapped base64 string FAILS, so the
// action is DROPPED WITHOUT A TRACE. the transaction still succeeds,
// the file just never appears, and the url 404s.
//
// so the tests below pin the shape of what we send, and they pin the
// verification that catches the failure: the on-chain args must match
// our bytes byte for byte.
//
// we also pin that the payload is NOT valid JSON. near-kit's wallet
// adapter and near-connect both try `JSON.parse` on the args and only
// keep the raw bytes when the parse FAILS — that branch is load
// bearing, so the property "our payload is not valid JSON" has to
// hold.
//
// WHY WE IGNORE THE RECEIPT STATUS:
// `outcomes.status` is false on EVERY fastfs upload, including the
// working one (mob.near -> fastfs.near, whose file is served). the
// receiver has no contract code, so there is no successful method
// return to report. the status is false on the working uploads AND on
// the failed ones, so it tells us nothing either way. the args
// comparison is the signal. see plan.md section 6.
//
// run: bun test verify/upload.test.ts
// ========================================
import { describe, expect, test } from "bun:test";
import {
  FASTDATA_UPLOAD,
  base64_to_bytes,
  build_file_url,
  build_relative_path,
  bytes_equal,
  encode_file,
  find_function_call,
  verify_transaction,
} from "../src/fastfs/upload";

// ========================================
// a fake File. we do not need a real browser File: encode_file only
// reads `name`, `type` and `arrayBuffer()`.
function make_file(content, type = "text/plain", name = "small.txt") {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    name,
    type,
    size: bytes.length,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
}
// ========================================

// ========================================
// a fake `near` client.
//
// getTransactionStatus returns the shape the rpc returns: the
// transaction's actions are a union, and the function call action is
//
//   { FunctionCall: { method_name, args, gas, deposit } }
//
// with `args` as a BASE64 STRING (near-kit, core/rpc/rpc-schemas.js —
// `FunctionCall: z.object({ method_name: z.string(), args: z.string(),
// gas: z.number(), deposit: z.string() })`).
//
// so the fake builds that exact shape.
function make_near(base64_args, method_name = "__fastdata_fastfs") {
  return {
    async getTransactionStatus(_hash, _signer_id, _wait_until) {
      return {
        transaction: {
          signer_id: "mob.near",
          receiver_id: "fastfs.near",
          hash: "FAKEHASH",
          actions: [
            {
              FunctionCall: {
                method_name,
                args: base64_args,
                gas: 1,
                deposit: "0",
              },
            },
          ],
        },
      };
    },
  };
}
// ========================================

// ========================================
// the bytes -> base64 helper, for building the fake rpc answers.
function to_base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
// ========================================

describe("fastfs upload — the payload we send", () => {
  // --- WHY --- near-kit's functionCall does
  //   args instanceof Uint8Array ? args : TextEncoder().encode(JSON.stringify(args))
  // so a string would be JSON-wrapped on the way to the chain and the
  // upload would silently not land. the payload has to be a
  // Uint8Array, all the way through.
  test("encode_file returns a Uint8Array, never a string", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(typeof bytes).not.toBe("string");
    expect(bytes.byteLength).toBe(bytes.length);
  });

  // --- WHY --- `simple` is variant 0 of the FastfsData enum. the
  // working on-chain transaction's args start with 0x00, so the enum
  // ordering has to stay exactly as it is in src/fastfs/schema.js.
  test("the payload starts with 0x00, the `simple` discriminant", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    expect(bytes[0]).toBe(0x00);
  });

  // --- WHY --- near-kit's adapter and near-connect both do
  //   try { args = JSON.parse(decode(args)) } catch { /* keep raw */ }
  // and only the catch keeps our bytes intact. if the payload ever
  // parsed as JSON, it would be turned into an object and the wallet
  // would sign a completely different transaction.
  test("the payload is NOT valid JSON, so the bytes pass through intact", async () => {
    const bytes = await encode_file(make_file("hello"), "/");

    let parsed_as_json = true;
    try {
      JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parsed_as_json = false;
    }
    expect(parsed_as_json).toBe(false);
  });

  // --- WHY --- the failed upload we found on chain had its args as a
  // quoted base64 string, so the first byte was 0x22 (the quote).
  // borsh::from_slice fails on that and the indexer drops the action.
  // if our args start with a quote, the file will 404.
  test("the payload does NOT start with 0x22, the quote byte", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    expect(bytes[0]).not.toBe(0x22);
    expect(FASTDATA_UPLOAD.QUOTE_BYTE).toBe(0x22);
  });

  // --- WHY --- the layout has to match the working transaction's:
  //   00 0f000000 "notes/small.txt" 01 0a000000 "text/plain" 05000000 <content>
  //   ^^                                ^^
  //   enum discriminant + string len    option Some + string len
  test("the payload has the same layout as the working on-chain upload", async () => {
    const bytes = await encode_file(
      make_file("hello", "text/plain", "small.txt"),
      "notes/",
    );

    const expected = Buffer.concat([
      Buffer.from([0x00]), // enum discriminant: simple
      Buffer.from([0x0f, 0x00, 0x00, 0x00]), // string len 15
      Buffer.from("notes/small.txt", "utf8"),
      Buffer.from([0x01]), // option: Some
      Buffer.from([0x0a, 0x00, 0x00, 0x00]), // string len 10
      Buffer.from("text/plain", "utf8"),
      Buffer.from([0x05, 0x00, 0x00, 0x00]), // u8 array len 5
      Buffer.from("hello", "utf8"),
    ]);

    expect(Buffer.from(bytes).equals(expected)).toBe(true);
  });
});

describe("fastfs upload — the relative path", () => {
  // --- WHY --- the reference does
  //   relativePath = relativePath.replace(/^\//, "");
  //   const path = relativePath + file.name;
  // (fastnear/fastdata-drag-and-drop, src/Upload/Upload.jsx) and its
  // default relative path is "/", which becomes "" after the strip.
  test("one leading slash is stripped and the file name is appended", () => {
    // the reference's default relative path is "/", which becomes ""
    // after the strip, so the path is just the file name.
    expect(build_relative_path("/", "small.txt")).toBe("small.txt");
    expect(build_relative_path("", "small.txt")).toBe("small.txt");
    // the reference CONCATENATES, it does not insert a separator, so
    // the user has to type the trailing slash themselves.
    expect(build_relative_path("notes", "small.txt")).toBe("notessmall.txt");
    expect(build_relative_path("notes/", "small.txt")).toBe("notes/small.txt");
  });

  // --- WHY --- the regex strips exactly ONE slash, so "//notes" keeps
  // its second slash. we mirror the reference exactly, because the
  // path is the served path.
  test("only ONE leading slash is stripped, like the reference", () => {
    expect(build_relative_path("//notes", "small.txt")).toBe("/notessmall.txt");
  });

  // --- WHY --- the path is part of the url, so it must not start with
  // a slash of its own — the url builder adds the separators.
  test("the encoded path matches the relative path rules", async () => {
    const bytes = await encode_file(
      make_file("hello", "text/plain", "small.txt"),
      "notes/",
    );
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toContain("notes/small.txt");
  });
});

describe("fastfs upload — the served url", () => {
  // --- WHY --- the url shape is
  //   https://{predecessor_id}.fastfs.io/{receiver_id}/{relative_path}
  // where predecessor_id is the account that SIGNED the transaction
  // and receiver_id is the namespace account. plan.md section 2.
  test("build_file_url builds the fastfs url for a mainnet receiver", () => {
    expect(build_file_url("mob.near", "fastfs.near", "fastnear.png")).toBe(
      "https://mob.near.fastfs.io/fastfs.near/fastnear.png",
    );
  });

  // --- WHY --- the receiver id follows the network: fastfs.near on
  // mainnet, fastfs.testnet on testnet. both accounts exist on their
  // network (verified on chain).
  test("build_file_url builds the fastfs url for a testnet receiver", () => {
    expect(build_file_url("mob.testnet", "fastfs.testnet", "fastnear.png")).toBe(
      "https://mob.testnet.fastfs.io/fastfs.testnet/fastnear.png",
    );
  });

  // --- WHY --- a path with a leading slash would produce a double
  // slash in the url.
  test("a leading slash on the path does not double up the separators", () => {
    expect(build_file_url("mob.near", "fastfs.near", "/fastnear.png")).toBe(
      "https://mob.near.fastfs.io/fastfs.near/fastnear.png",
    );
  });
});

describe("fastfs upload — reading the action back", () => {
  // --- WHY --- the rpc's action list is a UNION of shapes. "CreateAccount"
  // comes back as a bare string, a function call comes back as
  //   { FunctionCall: { method_name, args, gas, deposit } }
  // so we cannot just index actions[0] and read `.FunctionCall`.
  test("find_function_call picks the function call out of the action list", () => {
    const call = find_function_call([
      "CreateAccount",
      {
        FunctionCall: {
          method_name: "__fastdata_fastfs",
          args: "AA==",
          gas: 1,
          deposit: "0",
        },
      },
    ]);
    expect(call).not.toBe(null);
    expect(call.method_name).toBe("__fastdata_fastfs");
  });

  // --- WHY --- a transaction with no function call at all must not be
  // read as a success.
  test("find_function_call returns null when there is no function call", () => {
    expect(find_function_call(["CreateAccount", { Transfer: { deposit: "1" } }])).toBe(
      null,
    );
  });

  // --- WHY --- the args come back from the rpc as a base64 STRING, so
  // they have to be decoded before they can be compared to our bytes.
  test("base64_to_bytes round-trips the bytes", () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0x22, 0xff, 0x10]);
    expect(bytes_equal(base64_to_bytes(to_base64(bytes)), bytes)).toBe(true);
  });
});

describe("fastfs upload — the on-chain check", () => {
  // --- WHY --- the args match our bytes -> the encoding we built is
  // the encoding the chain got. the upload is real.
  test("matching args verify as ok", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    const near = make_near(to_base64(bytes));

    const result = await verify_transaction(near, "FAKEHASH", "mob.near", bytes);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe(null);
  });

  // --- WHY --- THIS IS THE FAILURE MODE. the args on chain are the
  // borsh bytes wrapped in a JSON string — 74 bytes of quoted base64.
  // borsh::from_slice fails on that, the indexer drops the action,
  // the transaction still succeeds and the file 404s. the check must
  // catch it and report a failure, not a success.
  test("args that are a json-wrapped base64 string FAIL the check", async () => {
    const bytes = await encode_file(make_file("hello"), "/");

    // exactly the shape of the failed on-chain transaction: the
    // borsh bytes, base64'd, then json-wrapped as a string.
    const as_string = JSON.stringify(to_base64(bytes));
    expect(as_string.startsWith('"')).toBe(true);

    const near = make_near(to_base64(new TextEncoder().encode(as_string)));
    const result = await verify_transaction(near, "FAKEHASH", "mob.near", bytes);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("quote");
  });

  // --- WHY --- the quote byte is the signature of that failure, so we
  // check for it explicitly and say what it means.
  test("args starting with the quote byte are reported as a string upload", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    const near = make_near(to_base64(new TextEncoder().encode('"AA8AAAB')));
    const result = await verify_transaction(near, "FAKEHASH", "mob.near", bytes);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("base64 STRING");
  });

  // --- WHY --- the length is part of the comparison. a prefix match
  // is not a match.
  test("args of a different length fail the check", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    const truncated = bytes.slice(0, bytes.length - 1);
    const near = make_near(to_base64(truncated));

    const result = await verify_transaction(near, "FAKEHASH", "mob.near", bytes);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("do not match");
  });

  // --- WHY --- if the chain cannot be read we cannot claim the upload
  // landed. "unknown" is not "success".
  test("a failing rpc read is reported as a failure", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    const near = {
      async getTransactionStatus() {
        throw new Error("rpc is down");
      },
    };

    const result = await verify_transaction(near, "FAKEHASH", "mob.near", bytes);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("rpc is down");
  });

  // --- WHY --- a transaction with no function call is not an upload.
  test("a transaction with no function call fails the check", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    const near = {
      async getTransactionStatus() {
        return { transaction: { actions: ["CreateAccount"] } };
      },
    };

    const result = await verify_transaction(near, "FAKEHASH", "mob.near", bytes);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("__fastdata_fastfs");
  });

  // --- WHY --- the wait level matters, and this is not an
  // academic detail. near-kit parses the rpc answer through a
  // discriminated union (core/rpc/rpc-schemas.js,
  // FinalExecutionOutcomeSchema). at the "INCLUDED" level the
  // transaction is a MINIMAL transaction:
  //
  //   MinimalTransactionSchema = z.object({ hash, signer_id, receiver_id, nonce })
  //
  // and zod STRIPS the keys the schema does not declare. we verified
  // it against the real schema:
  //
  //   INCLUDED            -> actions present: false
  //   EXECUTED_OPTIMISTIC -> actions present: true
  //
  // so pulling the tx back at "INCLUDED" gives us a transaction with
  // NO actions in it, and the check could never work. we use
  // "EXECUTED_OPTIMISTIC", which is also near-kit's own default wait
  // level, so it costs us no extra waiting.
  test("the pull-back uses a wait level that actually carries the actions", async () => {
    let seen_wait_until = null;
    const bytes = await encode_file(make_file("hello"), "/");
    const near = {
      async getTransactionStatus(_hash, _signer_id, wait_until) {
        seen_wait_until = wait_until;
        return { transaction: { actions: [] } };
      },
    };

    await verify_transaction(near, "FAKEHASH", "mob.near", bytes);

    expect(seen_wait_until).toBe("EXECUTED_OPTIMISTIC");
    expect(seen_wait_until).not.toBe("INCLUDED");
  });

  // --- WHY --- a flaky rpc read must not turn a good upload into a
  // failure. the wallet's own outcome already carries the chain's
  // actions, so we fall back to those.
  test("a failing rpc read falls back to the actions the wallet gave us", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    const near = {
      async getTransactionStatus() {
        throw new Error("rpc is down");
      },
    };

    const fallback = [
      {
        FunctionCall: {
          method_name: "__fastdata_fastfs",
          args: to_base64(bytes),
          gas: 1,
          deposit: "0",
        },
      },
    ];

    const result = await verify_transaction(
      near,
      "FAKEHASH",
      "mob.near",
      bytes,
      fallback,
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe(null);
  });

  // --- WHY --- and the fallback does not launder a bad upload: if the
  // actions on chain are a quoted base64 string, it still fails.
  test("the fallback does not launder a mangled upload", async () => {
    const bytes = await encode_file(make_file("hello"), "/");
    const near = {
      async getTransactionStatus() {
        throw new Error("rpc is down");
      },
    };

    const mangled = new TextEncoder().encode(
      JSON.stringify(to_base64(bytes)),
    );
    const fallback = [
      {
        FunctionCall: {
          method_name: "__fastdata_fastfs",
          args: to_base64(mangled),
          gas: 1,
          deposit: "0",
        },
      },
    ];

    const result = await verify_transaction(
      near,
      "FAKEHASH",
      "mob.near",
      bytes,
      fallback,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("quote");
  });
});

// ========================================
// a fake `near` that records the call and can be told to mangle the
// args on the way back — which is exactly what a base64-string upload
// looks like from the chain's point of view.
function make_sending_near(mangle = false) {
  const sent = [];
  return {
    sent,
    async call(receiver_id, method_name, args, options) {
      sent.push({ receiver_id, method_name, args, options });
      return {
        transaction: {
          hash: "FAKEHASH",
          signer_id: "mob.near",
          receiver_id,
        },
      };
    },
    async getTransactionStatus(_hash, _signer_id, _wait_until) {
      const sent_args = sent[sent.length - 1]?.args ?? "";

      // we send a base64 string. the wallet decodes it and the chain
      // ends up with the BYTES, which the rpc reports base64-encoded.
      const decoded = new Uint8Array(Buffer.from(sent_args, "base64"));

      // the mangled case models the failure we found on chain: the
      // args went out as a JSON-wrapped base64 STRING instead of the
      // bytes, so borsh::from_slice fails and the indexer drops the
      // action. the file 404s and nothing says why.
      const on_chain = mangle
        ? new TextEncoder().encode(JSON.stringify(to_base64(decoded)))
        : decoded;

      return {
        transaction: {
          signer_id: "mob.near",
          receiver_id: "fastfs.near",
          hash: "FAKEHASH",
          actions: [
            {
              FunctionCall: {
                method_name: "__fastdata_fastfs",
                args: to_base64(on_chain),
                gas: 1,
                deposit: "0",
              },
            },
          ],
        },
      };
    },
  };
}
// ========================================

describe("fastfs upload — the whole flow", () => {
  // --- WHY --- the args go in as a Uint8Array and the gas is "1".
  // a base64 string here is the bug that silently kills an upload,
  // and the gas is proven on chain (the working mob.near upload
  // attached exactly 1 gas). see plan.md section 6.
  test("the call carries the base64 of the bytes, the right method, the right gas and no signerId", async () => {
    const near = make_sending_near();
    await FASTDATA_UPLOAD.upload_file(make_file("hello"), "/", {
      near,
      receiver_id: "fastfs.near",
      account_id: "mob.near",
    });

    expect(near.sent.length).toBe(1);
    const call = near.sent[0];
    expect(call.method_name).toBe("__fastdata_fastfs");
    expect(call.receiver_id).toBe("fastfs.near");

    // --- THE ARGS ARE A BASE64 STRING ---
    // near-connect sends the transaction to the wallet as JSON, and
    // JSON.stringify turns a Uint8Array into {"0":0,"1":9,...}. the
    // wallet would then have to guess those numbers are bytes. a
    // base64 string survives JSON.stringify unchanged, and the wallet's
    // `base64-args` mode decodes it and puts the BYTES on chain.
    //
    // this is what the reference implementation does too.
    expect(typeof call.args).toBe("string");
    const decoded = new Uint8Array(Buffer.from(call.args, "base64"));
    expect(decoded[0]).toBe(0x00);
    expect(decoded.length).toBeGreaterThan(1);

    expect(call.options.gas).toBe("1");
    // near.call resolves the signer itself, so we must not pass one.
    expect(call.options.signerId).toBe(undefined);
  });

  // --- WHY --- the args on chain match ours, so the upload is real.
  test("a matching transaction is reported as success", async () => {
    const near = make_sending_near();
    const result = await FASTDATA_UPLOAD.upload_file(
      make_file("hello", "text/plain", "small.txt"),
      "/",
      { near, receiver_id: "fastfs.near", account_id: "mob.near" },
    );

    expect(result.status).toBe("success");
    expect(result.error).toBe(null);
    expect(result.path).toBe("small.txt");
    expect(result.url).toBe("https://mob.near.fastfs.io/fastfs.near/small.txt");
    expect(result.hash).toBe("FAKEHASH");
    expect(result.signer_id).toBe("mob.near");
    expect(result.bytes).toBeGreaterThan(0);
  });

  // --- WHY --- THE failure mode. the args came back as a quoted
  // base64 string, so the indexer will drop the action and the file
  // will 404 — but the transaction SUCCEEDED. we must NOT report
  // success here.
  test("a mangled transaction is reported as failed, with the url still present", async () => {
    const near = make_sending_near(true);
    const result = await FASTDATA_UPLOAD.upload_file(
      make_file("hello", "text/plain", "small.txt"),
      "/",
      { near, receiver_id: "fastfs.near", account_id: "mob.near" },
    );

    expect(result.status).toBe("failed");
    expect(result.error).not.toBe(null);
    // the url is still there so the user can go and look at it.
    expect(result.url).toBe("https://mob.near.fastfs.io/fastfs.near/small.txt");
    expect(result.hash).toBe("FAKEHASH");
  });

  // --- WHY --- a transaction that cannot even be sent is a failure,
  // not a success with an empty error.
  test("a failed send is reported as failed", async () => {
    const near = {
      async call() {
        throw new Error("the user rejected the transaction");
      },
    };
    const result = await FASTDATA_UPLOAD.upload_file(
      make_file("hello"),
      "/",
      { near, receiver_id: "fastfs.near", account_id: "mob.near" },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("rejected");
    expect(result.hash).toBe(null);
  });
});

describe("fastfs upload — several files", () => {
  // --- WHY --- EACH FILE IS ITS OWN TRANSACTION. we do not chunk and
  // we do not batch.
  test("each file is its own transaction", async () => {
    const near = make_sending_near();
    await FASTDATA_UPLOAD.upload_files(
      [make_file("a", "text/plain", "a.txt"), make_file("b", "text/plain", "b.txt")],
      "/",
      { near, receiver_id: "fastfs.near", account_id: "mob.near" },
    );

    expect(near.sent.length).toBe(2);
  });

  // --- WHY --- ONE FAILING FILE MUST NOT ABORT THE OTHERS. the user
  // drops five files, three land and two do not, and they need to see
  // exactly which two and why.
  test("one failing file does not abort the rest", async () => {
    // the middle file is the one that fails: the wallet rejects it.
    const near = {
      sent: [],
      async call(receiver_id, method_name, args, options) {
        // the args are a base64 string of the borsh bytes. the path is
        // in there as plain ascii, so decode to find the file name.
        const decoded = Buffer.from(args, "base64").toString("latin1");
        if (decoded.includes("b.txt")) {
          throw new Error("the user rejected the transaction");
        }
        this.sent.push({ receiver_id, method_name, args, options });
        return {
          transaction: {
            hash: "FAKEHASH",
            signer_id: "mob.near",
            receiver_id,
          },
        };
      },
      async getTransactionStatus(_hash, _signer_id, _wait_until) {
        const sent_args = this.sent[this.sent.length - 1]?.args ?? "";
        const decoded = new Uint8Array(Buffer.from(sent_args, "base64"));
        return {
          transaction: {
            signer_id: "mob.near",
            receiver_id: "fastfs.near",
            hash: "FAKEHASH",
            actions: [
              {
                FunctionCall: {
                  method_name: "__fastdata_fastfs",
                  args: to_base64(decoded),
                  gas: 1,
                  deposit: "0",
                },
              },
            ],
          },
        };
      },
    };

    const results = await FASTDATA_UPLOAD.upload_files(
      [
        make_file("a", "text/plain", "a.txt"),
        make_file("b", "text/plain", "b.txt"),
        make_file("c", "text/plain", "c.txt"),
      ],
      "/",
      { near, receiver_id: "fastfs.near", account_id: "mob.near" },
    );

    expect(results.length).toBe(3);
    expect(results.map((r) => r.status)).toEqual(["success", "failed", "success"]);
    expect(results[1].error).toContain("rejected");
    // the good ones still carry their url.
    expect(results[0].url).toBe("https://mob.near.fastfs.io/fastfs.near/a.txt");
    expect(results[2].url).toBe("https://mob.near.fastfs.io/fastfs.near/c.txt");
  });

  // --- WHY --- the results come back in the same order as the files,
  // so the ui can zip them with the staged file list.
  test("the results keep the order of the files", async () => {
    const near = make_sending_near();
    const results = await FASTDATA_UPLOAD.upload_files(
      [
        make_file("a", "text/plain", "one.txt"),
        make_file("b", "text/plain", "two.txt"),
      ],
      "/",
      { near, receiver_id: "fastfs.near", account_id: "mob.near" },
    );

    expect(results.map((r) => r.path)).toEqual(["one.txt", "two.txt"]);
  });
});
// ========================================
