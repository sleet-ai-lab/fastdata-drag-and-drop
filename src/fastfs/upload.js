// ========================================
// the upload path: file -> borsh bytes -> near.call -> on-chain check.
//
// THIS IS THE MOST IMPORTANT MODULE IN THE APP. everything else is
// ui. here is where a file either lands or silently does not, and the
// difference between the two is a few bytes of encoding.
//
// THE ONE RULE: the args to near.call must be the RAW borsh bytes,
// as a Uint8Array. never a base64 string, never JSON, never a string
// of any kind.
//
// WHY, from the consumer's own source (fastnear/fastdata-indexer):
//
//   main-indexer/src/main.rs
//     data: args.to_vec(),          // the raw bytes, verbatim
//
//   fastfs-sub-indexer/src/main.rs
//     if let Ok(value) = borsh::from_slice(&fastdata.data) { ... }
//
// borsh::from_slice on a JSON-wrapped base64 string FAILS, so the
// `if let Ok(value)` is false and the indexer DROPS the action without
// a trace. the transaction still succeeds, the file just never
// appears, and the url 404s. we found a real mainnet transaction that
// failed exactly this way (sleet.near -> fastfs.near, args = 74 bytes
// of quoted base64).
//
// a base64 string would also be mangled on the way out: near-kit's
// TransactionBuilder.functionCall does
//
//   args instanceof Uint8Array ? args : TextEncoder().encode(JSON.stringify(args))
//
// (near-kit, core/transaction.js:204) — so a string gets JSON-wrapped
// and the file becomes garbage.
//
// and near-kit's wallet adapter AND near-connect both try to read our
// bytes as JSON (`wallets/adapters.js:26-35`, near-connect
// actions/index.js:5-10). they only keep the raw bytes when the
// parse FAILS. our payload starts with 0x00 0x0f 0x00 0x00 0x00, so
// it is never valid JSON and the bytes survive. that property is
// load-bearing, so verify/upload.test.ts pins it.
//
// WHY WE IGNORE THE RECEIPT STATUS:
// `outcomes.status` is FALSE on every fastfs upload — including the
// working one (the mob.near transaction that produced a live, served
// 121 KB png). the receiver has NO contract code, so there is no
// successful method return to report. the status is false on the
// working uploads AND on the failed ones, so it tells us nothing.
// the signal is the args comparison. see plan.md section 6.
//
// WHY GAS IS "1":
// a real working upload (mob.near -> fastfs.near) attached exactly 1
// gas and used 7.49 TGas. the receiver has no contract, so no wasm
// executes and the protocol refunds everything unused. the spec's
// 300 TGas is a generous default for a real contract. near-kit's
// 30 TGas default is also wrong here. see plan.md section 6.
//
// WHY WE DO NOT PASS signerId:
// near.call resolves the signer itself — options.signerId, else the
// default signer, else the connected wallet's first account. we want
// the wallet's account to sign, so we pass nothing. see plan.md
// section 3b.
// ========================================
import { serialize as borshSerialize } from "borsh";
import { near_kit_client } from "@near-kit-tool-box/web";
import { FastfsSchema } from "./schema.js";
import { FASTDATA_NETWORK } from "../near/network.js";

// ========================================
// the constants of the fastfs protocol.
//
// METHOD_NAME — the function call the fastfs indexer watches for. it
// picks up ANY method with the "__fastdata_" prefix
// (main-indexer/src/main.rs:12), but this is the documented one.
//
// GAS — "1", in yocto-gas. see the note at the top of this file.
//
// DEPOSIT — "0". the upload costs nothing to send; the base action
// fee is charged no matter what.
// ========================================
export const METHOD_NAME = "__fastdata_fastfs";
export const GAS = "1";
export const DEPOSIT = "0";
// ========================================

// ========================================
// the byte that opens a quote character.
//
// if the args on chain start with this, they were sent as a STRING and
// the upload will 404. the failed upload we found on chain looked
// like this:
//
//   22 41 41 38 41 41 41 42 ... 22
//   ^-- 0x22 is the opening quote
//
// the working one started with 0x00 (the enum discriminant).
export const QUOTE_BYTE = 0x22;
// ========================================

// ========================================
// the relative path.
//
// WHY: this is the path the file is served under, and it is part of
// the url, so it is worth letting the user edit it.
//
// the rule mirrors the reference implementation
// (fastnear/fastdata-drag-and-drop, src/Upload/Upload.jsx):
//
//   relativePath = relativePath.replace(/^\//, "");   // strip ONE leading slash
//   const path = relativePath + file.name;
//
// the reference's default relative path is "/", which becomes ""
// after the strip, so the path is just the file name.
//
// NOTE the regex strips exactly ONE leading slash, so "//notes" keeps
// its second slash (and becomes "/notes" + the file name).
//
// NOTE there is NO separator inserted: the reference CONCATENATES the
// relative path and the file name directly, so "notes" + "a.txt" is
// "notesa.txt". the user has to type the trailing slash themselves.
// we mirror the reference exactly, because the path is the served
// path and a different path means a different url.
export function build_relative_path(relative_path, file_name) {
  const base = (relative_path ?? "").replace(/^\//, "");
  return base + (file_name ?? "");
}
// ========================================

// ========================================
// the url a file is served at.
//
//   https://{predecessor_id}.fastfs.io/{receiver_id}/{relative_path}
//
// `predecessor_id` is the uploader — the account that SIGNED the
// transaction — and `receiver_id` is the namespace account. both
// come from the same place, so the url always names the account that
// actually paid for the file.
//
// the fastfs server only serves MAINNET files. on testnet the url is
// well-formed but nothing is served there — which is exactly why the
// on-chain args check is the automated verification. see plan.md
// section 3b.
export function build_file_url(account_id, receiver_id, relative_path) {
  const path = (relative_path ?? "").replace(/^\/+/, "");
  return `https://${account_id}.fastfs.io/${receiver_id}/${path}`;
}
// ========================================

// ========================================
// encode one file into the fastfs payload.
//
// returns a Uint8Array — the raw borsh bytes, ready to be handed to
// near.call AS IS. never a string.
//
// the payload layout (the `simple` variant, discriminant 0):
//
//   00              enum discriminant: simple
//   0c000000        string len 12
//   "fastnear.png"  the relative path
//   01              option = Some
//   09000000        string len 9
//   "image/png"     the mime type
//   85da0100        u8 array len 121477
//   <content>       the file bytes
//
// WHY `simple` AND NOT `partial`:
// the `partial` variant is the chunked format for files over 1 MiB.
// we do not chunk: one file is one transaction, and the protocol's
// max_transaction_size is 1.5 MiB, so the per-file cap is 1 MiB. the
// enum ordering matters though — `simple` has to stay variant 0,
// because the working on-chain transaction's args start with 0x00.
//
// the file is read with `file.arrayBuffer()`, so this is async.
export async function encode_file(file, relative_path) {
  const path = build_relative_path(relative_path, file?.name);
  const content = new Uint8Array(await file.arrayBuffer());

  // this IS the Uint8Array. it goes straight into near.call.
  const bytes = borshSerialize(FastfsSchema.FastfsData, {
    simple: {
      relativePath: path,
      content: {
        mimeType: file?.type ?? "",
        content,
      },
    },
  });

  return bytes;
}
// ========================================

// ========================================
// compare two byte arrays, byte for byte.
//
// returns true when they are the same length AND every byte matches.
// the length check matters: a prefix match is not a match.
export function bytes_equal(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
// ========================================

// ========================================
// base64 -> bytes, without depending on a node-only API.
//
// `atob` is available in the browser and in bun. we do the decode
// manually so the module has no environment-specific branch.
//
// WHY WE DECODE AT ALL: the rpc returns the action's args as a
// base64 STRING (near-kit, core/rpc/rpc-schemas.js —
// `FunctionCall: { method_name, args: z.string(), gas, deposit }`).
// the bytes we compare against are the bytes we built, so the
// string has to come back to bytes first.
export function base64_to_bytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
// ========================================

// ========================================
// pull the function call action out of a transaction status.
//
// the rpc's action list is a union of shapes (near-kit,
// core/rpc/rpc-schemas.js ActionSchema):
//
//   "CreateAccount"                                  (a bare string)
//   { CreateAccount: {} }
//   { Transfer: { deposit } }
//   { FunctionCall: { method_name, args, gas, deposit } }
//   { DeployContract: { code } }
//   ...
//
// so we cannot just index into actions[0] and read `.FunctionCall`:
// the action might not be a function call at all, and the key we want
// is `FunctionCall` (capital F) with SNAKE_CASE fields inside.
//
// we look for the FIRST action whose method name is ours, so a
// transaction that carries something before our call still verifies.
export function find_function_call(actions, method_name = METHOD_NAME) {
  const list = Array.isArray(actions) ? actions : [];
  for (const action of list) {
    if (!action || typeof action !== "object") continue;
    const call = action.FunctionCall ?? action.functionCall;
    if (!call) continue;
    if (call.method_name !== undefined && call.method_name !== method_name) {
      continue;
    }
    return call;
  }
  return null;
}
// ========================================

// ========================================
// the wait level we pull the transaction back at.
//
// WHY NOT "INCLUDED" (the obvious choice, and what the plan sketched):
// near-kit parses the rpc answer through a discriminated union
// (core/rpc/rpc-schemas.js, FinalExecutionOutcomeSchema). at the
// "INCLUDED" level the transaction is a MINIMAL transaction:
//
//   MinimalTransactionSchema = z.object({
//     hash, signer_id, receiver_id, nonce
//   })
//
// and zod STRIPS the keys a schema does not declare. we verified it:
//
//   INCLUDED            -> transaction keys: [hash, signer_id, receiver_id, nonce]
//                          actions present: false
//   EXECUTED_OPTIMISTIC -> transaction keys: [..., actions, ...]
//                          actions present: true
//
// so an "INCLUDED" pull has NO actions in it and the verification
// could never work. "EXECUTED_OPTIMISTIC" carries the full
// TransactionSchema, actions included, and it is near-kit's own
// default wait level (TransactionBuilder's defaultWaitUntil), so it
// is also the level the wallet's own result comes back at — no extra
// waiting.
//
// it costs us nothing: a fastfs upload executes no wasm, so it is
// included and executed in the same breath.
export const VERIFY_WAIT_UNTIL = "EXECUTED_OPTIMISTIC";
// ========================================

// ========================================
// verify that what landed on chain is what we built.
//
// THIS IS THE ONE CHECK THE APP MAKES. the reference implementation
// verifies NOTHING — it swallows every error and marks the file
// "Success" as soon as the promise settles, so a transaction the
// indexer silently dropped looks exactly like a successful upload.
//
// what we do:
//   1. pull the transaction back from the chain
//   2. read the action's args
//   3. base64-decode them
//   4. compare them to our bytes, byte for byte
//
// the args match  -> the encoding we built is the encoding the chain
//                    got. the upload is real.
// the args differ  -> something mangled them on the way. that is the
//                    base64 bug, and we report a failure instead of a
//                    success link.
//
// we also check the decoded args do NOT start with 0x22 (a quote).
// if they do, we sent a string, and the upload will 404.
//
// `fallback_actions` is the action list from the outcome `near.call`
// already gave us. if the pull-back cannot be read (or comes back
// without the actions), we use that instead, so a flaky rpc read does
// not turn a good upload into a failure. the fallback still comes
// from the chain — the wallet's own outcome — so the check stays
// honest.
//
// returns { ok, reason, args } — `ok` is the signal, `reason` explains
// a failure.
export async function verify_transaction(
  near,
  hash,
  signer_id,
  expected_bytes,
  fallback_actions = null,
) {
  // --- 1. pull the transaction back ---
  let status = null;
  let read_error = null;
  try {
    status = await near.getTransactionStatus(hash, signer_id, VERIFY_WAIT_UNTIL);
  } catch (error) {
    read_error = error?.message ?? String(error);
  }

  // --- 2. find our action ---
  let actions = status?.transaction?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    actions = fallback_actions;
  }

  const call = find_function_call(actions);
  if (!call) {
    if (read_error) {
      return {
        ok: false,
        reason: `could not read the transaction back from the chain: ${read_error}`,
        args: null,
      };
    }
    return {
      ok: false,
      reason:
        'the transaction on chain has no "__fastdata_fastfs" function call in it',
      args: null,
    };
  }

  // --- 3. the args come back as a base64 string ---
  const raw_args = call.args;
  if (typeof raw_args !== "string") {
    return {
      ok: false,
      reason: `the transaction on chain has no readable args (got ${typeof raw_args})`,
      args: null,
    };
  }

  const args = base64_to_bytes(raw_args);

  // --- 4. the quote check ---
  // a quote as the first byte means the args were sent as a STRING.
  // the indexer's borsh::from_slice fails on that and the action is
  // dropped, so the file will never appear.
  if (args.length > 0 && args[0] === QUOTE_BYTE) {
    return {
      ok: false,
      reason:
        'the args on chain start with a quote character ("): the upload was sent as a base64 STRING, not as raw bytes, so the fastfs indexer will drop it and the file will 404',
      args,
    };
  }

  // --- 5. the byte-for-byte comparison ---
  if (!bytes_equal(args, expected_bytes)) {
    return {
      ok: false,
      reason: `the args on chain do not match the bytes we built (on chain: ${args.length} bytes, expected: ${expected_bytes?.length ?? 0} bytes) — something mangled the payload on the way to the chain`,
      args,
    };
  }

  return { ok: true, reason: null, args };
}
// ========================================

// ========================================
// upload one file.
//
// the whole flow: encode -> send -> verify.
//
// `options` may carry:
//   near        — a Near instance (for tests). defaults to the
//                 current network's client.
//   account_id  — the account that signs / owns the url. defaults to
//                 the wallet's connected account.
//   receiver_id — the namespace account. defaults to the current
//                 network's receiver.
//
// returns:
//   {
//     status:    "success" | "failed",
//     path:      the relative path used,
//     url:       the served url,
//     hash:      the transaction hash,
//     signer_id: the account that signed,
//     bytes:     the payload size,
//     error:     null | the message
//   }
//
// the url is present even on failure, so the user can look at it.
// but `status` is only ever "success" when the args comparison
// PASSED. we never report success on a receipt status, because the
// receipt status is false on working uploads too.
export async function upload_file(file, relative_path, options = {}) {
  const near = options.near ?? near_kit_client();
  const receiver_id = options.receiver_id ?? FASTDATA_NETWORK.get_receiver_id();
  const signer_id = options.account_id ?? null;

  // the path we will serve the file under. computed up front so the
  // failure result can still carry it.
  const path = build_relative_path(relative_path, file?.name);

  let bytes = null;
  try {
    bytes = await encode_file(file, relative_path);
  } catch (error) {
    return {
      status: "failed",
      path,
      url: build_file_url(signer_id, receiver_id, path),
      hash: null,
      signer_id,
      bytes: 0,
      error: `could not encode the file: ${error?.message ?? String(error)}`,
    };
  }

  // --- send ---
  //
  // `bytes` goes in AS IS. it is a Uint8Array, and near-kit passes a
  // Uint8Array through untouched (core/transaction.js:204). passing
  // a base64 string here is the bug that silently kills an upload.
  //
  // no signerId: near.call resolves the signer itself, so the wallet's
  // account signs. no deposit: the base action fee is charged anyway.
  let hash = null;
  let tx_signer_id = null;
  let tx_actions = null;
  try {
    const result = await near.call(receiver_id, METHOD_NAME, bytes, {
      gas: GAS,
    });
    hash = result?.transaction?.hash ?? result?.hash ?? null;
    // the transaction itself knows who signed it. this is the
    // authoritative signer id — it is the account the url has to
    // name, and the account getTransactionStatus has to ask about.
    tx_signer_id = result?.transaction?.signer_id ?? null;
    // the wallet's own outcome already carries the actions. we keep
    // them as a fallback for the pull-back, in case the rpc read
    // fails or comes back without them. it is still the chain's view
    // of the transaction — the wallet built it from the node's answer.
    tx_actions = Array.isArray(result?.transaction?.actions)
      ? result.transaction.actions
      : null;
  } catch (error) {
    return {
      status: "failed",
      path,
      url: build_file_url(signer_id, receiver_id, path),
      hash: null,
      signer_id,
      bytes: bytes.length,
      error: `the transaction was not sent: ${error?.message ?? String(error)}`,
    };
  }

  // --- verify ---
  //
  // the signer we verify against has to be the account that signed.
  // we take it from the transaction result (the truth), and fall back
  // to the account id the caller gave us.
  const tx_signer = tx_signer_id ?? signer_id;

  const check = await verify_transaction(near, hash, tx_signer, bytes, tx_actions);

  // the url names the account that actually paid for the file, so it
  // uses the signer we just saw on chain.
  const final_signer = tx_signer ?? signer_id;

  if (!check.ok) {
    return {
      status: "failed",
      path,
      url: build_file_url(final_signer, receiver_id, path),
      hash,
      signer_id: final_signer,
      bytes: bytes.length,
      error: check.reason,
    };
  }

  return {
    status: "success",
    path,
    url: build_file_url(final_signer, receiver_id, path),
    hash,
    signer_id: final_signer,
    bytes: bytes.length,
    error: null,
  };
}
// ========================================

// ========================================
// upload several files.
//
// EACH FILE IS ITS OWN TRANSACTION. we do not chunk and we do not
// batch, so one file per transaction is the natural shape.
//
// ONE FAILING FILE MUST NOT ABORT THE OTHERS. a bad file is a
// per-file error, not a per-drop error: the user drops five files,
// three land and two do not, and they need to see exactly which two
// and why.
//
// the results come back in the same order as the files.
export async function upload_files(files, relative_path, options = {}) {
  const list = Array.isArray(files) ? files : [];
  const results = [];

  for (const file of list) {
    try {
      results.push(await upload_file(file, relative_path, options));
    } catch (error) {
      // upload_file already catches everything it can, but a throw
      // here must still not take the rest of the drop down.
      const path = build_relative_path(relative_path, file?.name);
      results.push({
        status: "failed",
        path,
        url: build_file_url(
          options?.account_id ?? null,
          options?.receiver_id ?? FASTDATA_NETWORK.get_receiver_id(),
          path,
        ),
        hash: null,
        signer_id: options?.account_id ?? null,
        bytes: 0,
        error: `the upload failed: ${error?.message ?? String(error)}`,
      });
    }
  }

  return results;
}
// ========================================

// ========================================
// the module's public surface, as one object.
//
// the ui imports this and destructures what it needs:
//
//   import { FASTDATA_UPLOAD } from "./fastfs/upload.js";
//   const { upload_files, build_file_url } = FASTDATA_UPLOAD;
export const FASTDATA_UPLOAD = {
  METHOD_NAME,
  GAS,
  DEPOSIT,
  QUOTE_BYTE,
  VERIFY_WAIT_UNTIL,
  build_relative_path,
  build_file_url,
  encode_file,
  bytes_equal,
  base64_to_bytes,
  find_function_call,
  verify_transaction,
  upload_file,
  upload_files,
};
// ========================================
// copyright 2026 by sleet.near
