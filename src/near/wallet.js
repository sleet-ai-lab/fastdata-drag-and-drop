// ========================================
// the wallet connection.
//
// the flow (plan.md section 5):
//
//   user clicks "connect"
//     -> near_connect_client().connect()      // opens the wallet picker
//     -> connector event "wallet:signIn"      // payload.accounts[0].accountId
//     -> we store the account id in module state
//
//   user clicks "disconnect"
//     -> connector.disconnect()
//     -> connector event "wallet:signOut"
//     -> we clear the account id
//
// WHY WE DO NOT DO THE NEP-413 SIGNED-MESSAGE DANCE:
// signed messages exist to prove identity to a BACKEND. we have no
// backend — the transaction itself is the only thing we sign. a plain
// connect() is enough, and it keeps one less round trip to the wallet.
//
// WHY THE ACCOUNT ID LIVES IN MODULE STATE AND NOT IN A GLOBAL STORE:
// the account id has to survive re-renders, so it cannot live inside a
// component. but it also should not be a global store: this module IS
// the store. components read it with get_account_id() and follow it
// with subscribe().
//
// WHY THE SIGNED-IN CHECK IS JUST "is there an account id":
// the account id we get from wallet:signIn is just an account id. we
// do not try to validate it beyond that — it is UI state, not a
// credential. the ui separately checks whether the account belongs to
// the network that is currently selected (see src/near/network.js).
// ========================================
import { near_connect_client } from "@near-kit-tool-box/web";

// ========================================
// the connectors we already attached listeners to.
//
// WHY A SET AND NOT A BOOLEAN FLAG:
// the tool box keeps a SEPARATE NearConnector per network (mainnet /
// testnet) and picks between them from the stored network id. a
// boolean flag would skip the attachment for the second network's
// connector, and that network would go deaf to wallet:signIn /
// wallet:signOut.
//
// the set is keyed on the connector INSTANCE, so each network's
// connector gets its own listeners, exactly once.
//
// (this is the note from the tool box's own auth_status.ts:
//  "the wallet listeners are attached per connector, and
//   @near-kit-tool-box/web keeps a SEPARATE NearConnector per network
//   (mainnet / testnet) and picks between them from the stored network
//   id. a boolean flag would skip the attachment for the second
//   network's connector and that network would go deaf to
//   wallet:signIn / wallet:signOut.")
const attached_connectors = new Set();
// ========================================

// ========================================
// the module state. the account id we are signed in as, and the last
// error message.
let account_id = null;
let last_error = null;
// ========================================

// ========================================
// the subscribers. same rule as in src/near/network.js: walk a COPY and
// catch each one, so a single broken listener cannot break the rest.
const subscribers = [];
// ========================================

// ========================================
// notify the subscribers.
function notify_subscribers() {
  for (const listener of [...subscribers]) {
    try {
      listener(account_id);
    } catch (error) {
      console.warn("[fastdata] wallet subscriber failed:", error);
    }
  }
}
// ========================================

// ========================================
// set the account id and tell the ui.
function set_account_id(value) {
  account_id = value;
  notify_subscribers();
}
// ========================================

// ========================================
// read the account id out of a wallet:signIn payload.
//
// the payload is { wallet, accounts, success, source }. accounts[0] is
// the account the wallet signed in with — and it is the SAME account
// that signs our transaction, because near.call resolves the signer
// from the connected wallet's first account. so this is also the
// account id that goes into the served url.
function read_account_id(payload) {
  const accounts = payload?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const first = accounts[0];
  return first?.accountId ?? null;
}
// ========================================

// ========================================
// how long we wait for the wallet to answer a disconnect before we give
// up on it.
//
// connector.disconnect() awaits a round trip to the wallet. when no
// wallet is selected it throws right away, but when a wallet IS
// selected and never answers, the promise never settles — and a ui
// that awaits it hangs forever.
const DISCONNECT_TIMEOUT_MS = 5000;
// ========================================

// ========================================
// await a promise, but give up after `ms`.
//
// this is the guard against a wallet that never answers. it is
// deliberately NOT a race between the promise and a timer that we
// leave running: the timer is cleared, so nothing leaks.
async function with_timeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
// ========================================

// ========================================
// the wallet:signIn handler.
function on_sign_in(payload) {
  const id = read_account_id(payload);
  if (!id) {
    last_error = "the wallet did not return an account id";
    console.warn("[fastdata] wallet:signIn with no account id");
    notify_subscribers();
    return;
  }
  last_error = null;
  set_account_id(id);
  console.info("[fastdata] signed in as", id);
}
// ========================================

// ========================================
// the wallet:signOut handler.
function on_sign_out() {
  last_error = null;
  set_account_id(null);
  console.info("[fastdata] signed out");
}
// ========================================

// ========================================
// attach the wallet listeners to a connector.
//
// ORDERING MATTERS: connect() emits wallet:signIn BEFORE it resolves,
// so a listener attached after the connect call would never fire. that
// is why init() attaches them up front, before any connect happens.
// (the tool box says the same thing: "MUST run before any connect()")
//
// the guard is the set, so calling attach twice on the same connector
// is harmless and attaching to a NEW connector (after a network toggle)
// does happen.
function attach_wallet_listeners(connector) {
  if (!connector) return;
  if (attached_connectors.has(connector)) return;
  attached_connectors.add(connector);
  connector.on("wallet:signIn", on_sign_in);
  connector.on("wallet:signOut", on_sign_out);
}
// ========================================

// ========================================
// attach the wallet listeners to the connector of the CURRENT network.
//
// idempotent: calling it again does nothing, because the set already
// holds that connector.
export function init() {
  try {
    attach_wallet_listeners(near_connect_client());
  } catch (error) {
    console.warn("[fastdata] could not attach wallet listeners:", error);
  }
}
// ========================================

// ========================================
// open the wallet picker.
//
// the listeners are attached before we connect (init() and the
// attach below), because connect() emits wallet:signIn before it
// resolves.
//
// if the sign in fails or the user cancels, we clear the account id
// AND disconnect, so we never leave a stale account id on screen. a
// half-signed-in state is worse than a clean one: the ui would offer
// to upload with an account that is not actually connected.
export async function sign_in() {
  try {
    init();
    const connector = near_connect_client();
    attach_wallet_listeners(connector);

    last_error = null;
    await connector.connect();
    return get_account_id();
  } catch (error) {
    last_error = error?.message || "sign in failed";
    console.warn("[fastdata] sign in failed:", error);

    // roll back. the local state first, so the ui is never wrong, then
    // drop the connector's half-made session.
    set_account_id(null);
    try {
      await with_timeout(
        near_connect_client().disconnect(),
        DISCONNECT_TIMEOUT_MS,
      );
    } catch {
      // disconnect throws when no wallet is selected — which is exactly
      // the case here — and it can hang when the wallet is selected but
      // never answers. with_timeout handles both. nothing to clean up,
      // so we swallow it.
    }
    return null;
  }
}
// ========================================

// ========================================
// sign out.
//
// connector.disconnect() THROWS when no wallet is selected, and it can
// also HANG when a wallet is selected but never answers (the wallet
// round trip is awaited inside it).
//
// so the local clear happens FIRST, before we touch the wallet at all.
// the ui must show "not signed in" immediately and unconditionally —
// it must never depend on the wallet answering. the connector call is
// best effort and is given a timeout so a dead wallet cannot wedge the
// ui.
export async function sign_out() {
  last_error = null;
  set_account_id(null);

  try {
    await with_timeout(
      near_connect_client().disconnect(),
      DISCONNECT_TIMEOUT_MS,
    );
  } catch (error) {
    console.warn("[fastdata] sign out could not reach the wallet:", error);
  }
}
// ========================================

// ========================================
// subscribe to account changes. returns the unsubscribe function.
export function subscribe(listener) {
  subscribers.push(listener);
  return () => {
    const index = subscribers.indexOf(listener);
    if (index !== -1) subscribers.splice(index, 1);
  };
}
// ========================================

// ========================================
// the account id we are signed in as, or null.
export function get_account_id() {
  return account_id;
}
// ========================================

// ========================================
// are we signed in?
export function is_signed_in() {
  return account_id !== null;
}
// ========================================

// ========================================
// the last error message, or null.
export function get_error() {
  return last_error;
}
// ========================================

// ========================================
// the module's public surface, as one object.
//
// the components import this and destructure what they need:
//
//   import { FASTDATA_WALLET } from "./near/wallet.js";
//   const { sign_in, sign_out, subscribe, get_account_id } = FASTDATA_WALLET;
export const FASTDATA_WALLET = {
  init,
  sign_in,
  sign_out,
  subscribe,
  get_account_id,
  is_signed_in,
  get_error,
};
// ========================================
// copyright 2026 by sleet.near
