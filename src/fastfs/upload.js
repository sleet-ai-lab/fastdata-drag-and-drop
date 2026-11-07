// ========================================
// the upload path: file -> borsh bytes -> the wallet -> on-chain check.
//
// THIS IS THE MOST IMPORTANT MODULE IN THE APP. everything else is
// ui. here is where a file either lands or silently does not, and the
// difference between the two is a few bytes of encoding.
//
// THE ONE RULE: the action must be a NATIVE FunctionCall action whose
// args are the BASE64 of the borsh bytes.
//
// it took three attempts to get that right, and each wrong attempt
// looked plausible. so here is the whole story.
//
// --- what lands on chain ---
// the indexer reads the action's args as raw bytes and borsh-decodes
// them (fastnear/fastdata-indexer):
//
//   main-indexer/src/main.rs
//     data: args.to_vec(),          // the raw bytes, verbatim
//
//   fastfs-sub-indexer/src/main.rs
//     if let Ok(value) = borsh::from_slice(&fastdata.data) { ... }
//
// borsh::from_slice on a JSON-WRAPPED base64 string FAILS, so the
// `if let Ok(value)` is false and the indexer DROPS the action without
// a trace. the transaction still succeeds, the file just never
// appears, and the url 404s.
//
// --- the wallet has TWO paths, and only one can carry bytes ---
// from the wallet's source (INTEARnear/wallet, web/src/utils.rs):
//
//   #[derive(Deserialize)]
//   #[serde(untagged)]
//   pub enum SendTransactionsAction {
//       Native(NearAction),
//       WalletSelector(WalletSelectorAction),
//   }
//
// the NATIVE one is tried FIRST. its args are
//
//   pub struct FunctionCallAction {
//       pub method_name: String,
//       #[serde_as(as = "Base64")]
//       pub args: Vec<u8>,     // base64 in json -> RAW BYTES on chain
//       ...
//   }
//
// the WALLET-SELECTOR one — which is what near-kit's adapter
// produces — has `args: serde_json::Value` and converts with
//
//   args: serde_json::to_vec(&args).unwrap_or_default(),
//
// so the args are a JSON VALUE, SERIALIZED AS JSON. a base64 string
// value comes out QUOTED, and those quotes are bytes on chain. that is
// what our tx 4s6v2whoeMhkHtwHDBVsp8EqYAVENoVgq4yxbdXJnuDj did — 66
// bytes starting with 0x22 — and it was never picked up.
//
// so the wallet-selector path CANNOT carry raw bytes. only the native
// path can.
//
// --- reaching the native path ---
// near-connect's own conversion would throw on a native action:
//
//   if ("type" in action) return action;   // passthrough
//   if (action.functionCall) { ...convert... }
//   throw new Error("Unsupported action type");
//
// --- WAIT: the "type" key does NOT work, and we proved it ---
//
// the plan was to add a "type" key so near-connect would pass the
// action through UNCHANGED. but the wallet's native variant is an
// EXTERNALLY TAGGED enum, so a sibling "type" key makes serde look for
// a variant named "type":
//
//   unknown variant `type`, expected `FunctionCall`
//
// we compiled the wallet's exact serde types and ran them:
//
//   native, no type key            -> OK Native, raw bytes, first 0x00
//   native WITH type key           -> ERR unknown variant `type`
//   wallet-selector, args a string -> OK, but the args become JSON text
//   wallet-selector, args an array -> OK, but the args become JSON text
//
// so the native action needs NO top-level "type", and near-connect
// REQUIRES one to pass through. contradictory.
//
// the way out is the wallet's `executor`, which is a public field and
// posts its params straight to the wallet iframe with no conversion.
// see send_native_function_call.
//
// --- what we send ---
//
//   { "FunctionCall": { "method_name": "__fastdata_fastfs",
//                       "args": "<base64 of the borsh bytes>",
//                       "gas": "1", "deposit": "0" } }
//
// the wallet decodes the base64 into our exact bytes, and those go on
// chain verbatim. the indexer's borsh::from_slice parses them and the
// file lands.
//
// this is also how the WORKING reference transaction landed 121512 raw
// bytes on chain (mob.near -> fastfs.near). it went through the native
// path too.
// ========================================
import { serialize as borshSerialize } from "borsh";
import { near_kit_client, near_connect_client } from "@near-kit-tool-box/web";
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

  // this IS the Uint8Array. it gets base64'd and sent as a native
  // action — see the note at the top of this file for why the native
  // shape is the one that lands the bytes on chain.
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
// bytes -> base64, the way we hand the args to the wallet.
//
// WHY A STRING AND NOT THE RAW BYTES:
// near-connect sends the transaction to the wallet as JSON, and
// JSON.stringify turns a Uint8Array into {"0":0,"1":9,...}. the
// wallet would then have to guess that those numbers are bytes. a
// base64 string survives JSON.stringify unchanged, and the wallet has a
// `base64-args` mode that decodes it and puts the BYTES on chain.
//
// this is also what the reference implementation does — it base64s the
// borsh bytes and passes the base64 string to the wallet.
//
// NOTE the chunking: a 1 MB file as one string would blow the argument
// limit of String.fromCharCode(...bytes). we build it in slices.
export function bytes_to_base64(bytes) {
  if (!bytes || bytes.length === 0) return "";
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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
// send a function call as a NATIVE action, so the args land on chain
// as raw bytes.
//
// WHY NOT near.call:
// near-kit builds a wallet-selector style action and its adapter
// converts it to `{ type: "FunctionCall", params: { ... } }`. the
// wallet parses that path's args as a JSON VALUE and serializes them
// as JSON, so a string comes out quoted and the bytes are lost.
//
// the native path takes the args as base64 in JSON and DECODES them
// into raw bytes on chain. that is the path we need.
//
// HOW WE REACH IT:
// near-connect's connector exposes signAndSendTransaction, and
// near-kit's `fromNearConnect` adapter wraps it. we call the
// connector directly with the native action shape, which the wallet
// tries FIRST (its SendTransactionsAction enum is untagged, with
// Native(NearAction) first).
//
// the shape, from the wallet's own types (INTEARnear/wallet,
// near-min-api/src/types.rs):
//
//   pub struct FunctionCallAction {
//       pub method_name: String,
//       #[serde_as(as = "Base64")]
//       pub args: Vec<u8>,
//       pub gas: Gas,
//       pub deposit: NearToken,
//   }
//
//   and Action is an externally-tagged enum, so the json is:
//
//   { "FunctionCall": { "method_name": ..., "args": "<base64>", "gas": ..., "deposit": ... } }
//
// WHY THE GAS AND DEPOSIT ARE STRINGS:
// the wallet's Gas and NearToken use `dec_format` in serde, so they
// are decimal strings ("1", "0").
export async function send_native_function_call(receiver_id, bytes, options = {}) {
  const gas = options.gas ?? GAS;
  const deposit = options.deposit ?? DEPOSIT;

  // the native action. args are BASE64 — the wallet decodes them into
  // the raw borsh bytes and those go on chain verbatim.
  //
  // the `type` key is there ONLY to get past near-connect's
  // conversion, which does:
  //
  //   const nearActionsToConnectorActions = (actions) => actions.map((action) => {
  //     if ("type" in action) return action;      // <-- passthrough
  //     if (action.functionCall) { ...convert to the connector shape... }
  //     ...
  //     throw new Error("Unsupported action type");
  //   });
  //
  // a pure native action has no "type" key, so it would hit the
  // "Unsupported action type" throw. adding "type" makes it pass
  // through UNCHANGED.
  //
  // and that is safe on the wallet side: its action type is
  //
  //   #[serde(untagged)]
  //   enum SendTransactionsAction { Native(NearAction), WalletSelector(...) }
  //
  // serde untagged tries the variants in order and takes the first
  // that parses. Native(NearAction) parses as soon as the json has a
  // "FunctionCall" key, and it comes FIRST. so the wallet takes the
  // native path, where
  //
  //   impl From<WalletSelectorAction> for NearAction
  //
  // would otherwise have done `serde_json::to_vec(&args)` — which is
  // what quoted our args and made the upload 404.
  //
  // NOTE: NO top-level "type" key. the wallet's Native variant is an
  // externally tagged enum, so a sibling "type" key makes serde look
  // for a variant named "type" and fail:
  //
  //   unknown variant `type`, expected `FunctionCall`
  //
  // we verified this by compiling the wallet's exact serde types.
  const action = {
    FunctionCall: {
      method_name: METHOD_NAME,
      args: bytes_to_base64(bytes),
      gas: gas.toString(),
      deposit: deposit.toString(),
    },
  };

  // the connector holds the wallet. `signAndSendTransaction` lives on the
  // WALLET, not the connector, so we go through connector.wallet().
  //
  // it is resolved lazily so a caller that supplies one never touches
  // near_connect_client() (which reads localStorage).
  const connector =
    options.connector !== undefined ? options.connector : near_connect_client();

  // the signer. near-kit resolves it from the connected wallet's
  // first account when signerId is absent, which is what we want.
  const signer_id = options.signer_id ?? null;

  const wallet = await connector.wallet();

  const params = {
    ...(signer_id !== null ? { signerId: signer_id } : {}),
    receiverId: receiver_id,
    actions: [action],
  };

  // --- THE EXECUTOR ROUTE ---
  //
  // near-connect's `wallet.signAndSendTransaction` runs the action
  // through `nearActionsToConnectorActions`, which CANNOT pass a
  // native action through:
  //
  //   if ("type" in action) return action;   // needs a top-level "type"
  //   if (action.functionCall) { ...convert to the wallet-selector shape... }
  //   throw new Error("Unsupported action type");
  //
  // and the wallet's native variant REJECTS a top-level "type". the
  // two requirements are contradictory, so the native path is
  // unreachable through that method.
  //
  // but the wallet's `executor` is a PUBLIC field, and the executor
  // posts its params straight to the wallet iframe as JSON:
  //
  //   async call(method, params) {
  //     ...
  //     iframe.postMessage({ method, params, id });
  //   }
  //
  // so calling the executor directly skips the conversion, and the
  // native action reaches the wallet untouched. that is the only way
  // the raw bytes can land on chain.
  //
  // we use it when the wallet exposes an executor, and fall back to
  // the normal path otherwise.
  if (wallet.executor && typeof wallet.executor.call === "function") {
    return await wallet.executor.call("wallet:signAndSendTransaction", {
      ...params,
      network: connector.network,
    });
  }

  return await wallet.signAndSendTransaction(params);
}
// ========================================
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
  const receiver_id = options.receiver_id ?? FASTDATA_NETWORK.get_receiver_id();
  const signer_id = options.account_id ?? null;
  // the connector carries the action to the wallet. it is injectable so
  // a test can drive the real path without a wallet.
  const connector = options.connector ?? null;
  // the near instance is only needed for the on-chain verification, so
  // it is created lazily — a send that fails never needs it, and a test
  // that only exercises the send never needs a browser.
  const get_near = () =>
    options.near !== undefined ? options.near : near_kit_client();

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
  // --- THE ARGS GO OUT AS A NATIVE ACTION WITH BASE64 ARGS. ---
  //
  // this is the part that took three attempts to get right. here is
  // the whole story, because the shape matters and the reason is not
  // obvious.
  //
  // near-connect sends the transaction to the wallet as JSON:
  //
  //   // the Intear wallet's near-selector.js
  //   let l = t.map(w => ({ signerId: w.signerId, receiverId: w.receiverId, actions: w.actions }));
  //   let y = JSON.stringify(l);
  //
  // the wallet then parses each action. from the wallet's source
  // (INTEARnear/wallet, web/src/utils.rs):
  //
  //   #[derive(Deserialize)]
  //   #[serde(untagged)]
  //   pub enum SendTransactionsAction {
  //       Native(NearAction),
  //       WalletSelector(WalletSelectorAction),
  //   }
  //
  // TWO paths, and the NATIVE one is tried first.
  //
  // the native path (near-min-api's Action):
  //
  //   pub struct FunctionCallAction {
  //       pub method_name: String,
  //       #[serde_as(as = "Base64")]
  //       pub args: Vec<u8>,
  //       pub gas: Gas,
  //       pub deposit: NearToken,
  //   }
  //
  //   the args are BASE64 IN JSON, DECODED TO RAW BYTES ON CHAIN.
  //   that is exactly what we need.
  //
  // the wallet-selector path (what near-kit's adapter produces):
  //
  //   args: serde_json::Value,
  //   ...
  //   args: serde_json::to_vec(&args).unwrap_or_default(),
  //
  //   the args are a JSON VALUE, SERIALIZED AS JSON. so a base64
  //   string value becomes "\"ABEAAA...\"" — WITH QUOTES — and those
  //   66 bytes of ASCII are what lands on chain. borsh::from_slice
  //   fails on that, the indexer drops the action, and the file 404s.
  //   that is exactly what our tx 4s6v2whoeMhkHtwHDBVsp8EqYAVENoVgq4yxbdXJnuDj
  //   did.
  //
  // so we send the NATIVE shape:
  //
  //   { "FunctionCall": { "method_name": ..., "args": "<base64>", "gas": ..., "deposit": ... } }
  //
  // and the wallet decodes the base64 into our exact bytes, which go on
  // chain verbatim. the indexer's borsh::from_slice then parses them
  // and the file lands.
  //
  // this is also why the working reference transaction (mob.near ->
  // fastfs.near) landed 121512 RAW bytes on chain: it went through the
  // native path.
  //
  // no signerId: the wallet's account signs. no deposit: the base
  // action fee is charged anyway.
  let hash = null;
  let tx_signer_id = null;
  let tx_actions = null;
  try {
    // --- WHAT IS ABOUT TO GO TO THE WALLET ---
    //
    // this is the log to read when checking that the args are right.
    // it shows the type, the length and the first byte, which are the
    // three things that tell you whether the payload will survive:
    //
    //   first  0x00        -> the `simple` enum discriminant, correct
    //   first  0x22        -> a quote, so it was sent as a string
    console.info("[fastdata] sending to the wallet:", {
      receiver: receiver_id,
      method: METHOD_NAME,
      gas: GAS,
      action_shape: "native FunctionCall (args as base64)",
      args_length: bytes?.length,
      first_byte: bytes?.length ? `0x${bytes[0].toString(16).padStart(2, "0")}` : null,
      // the first bytes as hex, so the borsh header is readable in the
      // console. NOT the whole payload: a 1 MB file as hex would be
      // unreadable, and spreading it into fromCharCode would blow the
      // argument limit.
      args_head_hex: bytes
        ? Array.from(bytes.subarray(0, 24))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ")
        : null,
    });

    const result = await send_native_function_call(receiver_id, bytes, {
      gas: GAS,
      ...(connector !== null ? { connector } : {}),
      ...(signer_id !== null ? { signer_id } : {}),
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

  const check = await verify_transaction(get_near(), hash, tx_signer, bytes, tx_actions);

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
  bytes_to_base64,
  send_native_function_call,
  find_function_call,
  verify_transaction,
  upload_file,
  upload_files,
};
// ========================================
// copyright 2026 by sleet.near
