// ========================================
// the network toggle.
//
// the network id lives in localStorage under the key "network_id", and
// the tool box (@near-kit-tool-box/web) keeps a SEPARATE Near instance
// and a SEPARATE NearConnector per network:
//
//   near_kit_mainnet    / near_connect_mainnet
//   near_kit_testnet    / near_connect_testnet
//
// `near_kit_client()` and `near_connect_client()` read the stored id
// on every call and hand back the matching instance.
//
// WHY THERE IS NO PAGE RELOAD:
// because the instances for BOTH networks are pre-built at module
// load, switching is just a localStorage write plus a re-read. the
// very next near_kit_client() call returns the other network's client.
// a reload would throw away the wallet session and the staged files
// for nothing.
//
// the thing that DOES need care after a toggle is the wallet listener
// attachment, because the other network's connector is a different
// object that has never had listeners on it. see src/near/wallet.js.
//
// the receiver / namespace account also depends on the network, so the
// toggle moves both the chain we talk to and the namespace in the url.
// see plan.md section 2 and section 4.
// ========================================
import {
  get_stored_network_id,
  set_network_mainnet,
  set_network_testnet,
  toggle_network,
} from "@near-kit-tool-box/web";

// ========================================
// the receiver account (the "namespace") per network.
//
// fastfs.near / fastfs.testnet are plain accounts, NOT contracts —
// they have no contract code deployed. a fastfs upload is a function
// call action named "__fastdata_fastfs" whose receiver is this
// account, and the fastfs indexer is what turns the transaction into a
// served file.
//
// both accounts exist on their network (verified on chain).
const RECEIVER_IDS = {
  mainnet: "fastfs.near",
  testnet: "fastfs.testnet",
};

// ========================================
// the fastnear rpc endpoint per network. the fastfs server itself only
// serves mainnet files, but the rpc is reachable on both — which is
// what makes the testnet flow work.
const RPC_URLS = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://rpc.testnet.fastnear.com",
};
// ========================================

// ========================================
// the subscribers. a plain array in module scope: the network state has
// to survive re-renders, so it cannot live inside a component.
const subscribers = [];
// ========================================

// ========================================
// notify the subscribers.
//
// one broken listener must not stop the others, so we walk a COPY of
// the array and catch each one separately. a component that unmounted
// without unsubscribing would otherwise take the whole ui down.
function notify_subscribers() {
  for (const listener of [...subscribers]) {
    try {
      listener(get_network());
    } catch (error) {
      console.warn("[fastdata] network subscriber failed:", error);
    }
  }
}
// ========================================

// ========================================
// the current network: "mainnet" | "testnet".
//
// get_stored_network_id() normalizes whatever is in localStorage —
// anything that is not exactly "testnet" reads as "mainnet" — so
// every caller agrees on the current network.
export function get_network() {
  return get_stored_network_id();
}
// ========================================

// ========================================
// subscribe to network changes. returns the unsubscribe function.
export function subscribe(listener) {
  subscribers.push(listener);
  return () => {
    const index = subscribers.indexOf(listener);
    if (index !== -1) subscribers.splice(index, 1);
  };
}
// ========================================

// ========================================
// flip the network.
//
// toggle_network() writes the other id into localStorage. we do NOT
// reload the page — see the note at the top of this file.
//
// we re-read the stored id after the write (rather than assuming what
// it became) and then notify the subscribers so the ui updates.
export function toggle() {
  toggle_network();
  const network = get_network();
  console.info("[fastdata] network switched to", network);
  attach_wallet_listeners_for_current_network();
  notify_subscribers();
  return network;
}
// ========================================

// ========================================
// re-attach the wallet listeners to the connector of the CURRENT
// network.
//
// WHY: the tool box keeps one NearConnector per network, so after a
// toggle the current connector is a DIFFERENT instance that has never
// had listeners on it. without this, that network would go deaf to
// wallet:signIn / wallet:signOut — the exact trap the tool box's own
// auth_status.ts warns about.
//
// the import is DYNAMIC so the two modules do not form a cycle: the
// wallet module does not need to know about the network module.
//
// this is best effort. if the wallet module cannot be loaded we still
// want the network to have flipped.
async function attach_wallet_listeners_for_current_network() {
  try {
    const { FASTDATA_WALLET } = await import("./wallet.js");
    FASTDATA_WALLET.init();
  } catch (error) {
    console.warn("[fastdata] could not re-attach wallet listeners:", error);
  }
}
// ========================================

// ========================================
// the receiver / namespace account id for the current network.
//
// this is the account that RECEIVES the function call and the
// namespace segment of the served url:
//   https://{uploader}.fastfs.io/{receiver_id}/{relative_path}
export function get_receiver_id() {
  return RECEIVER_IDS[get_network()];
}
// ========================================

// ========================================
// the rpc url for the current network.
export function get_rpc_url() {
  return RPC_URLS[get_network()];
}
// ========================================

// ========================================
// the network the given account id belongs to.
//
// a `.testnet` suffix means testnet, everything else is mainnet.
// used by the ui to tell "signed in, but on the other network" apart
// from "signed in here".
export function get_account_network(account_id) {
  if (!account_id) return null;
  return account_id.endsWith(".testnet") ? "testnet" : "mainnet";
}
// ========================================

// ========================================
// switch to a specific network. the tool box writes the id; we notify
// the subscribers the same way toggle() does.
export function set_network(network) {
  if (network === "testnet") set_network_testnet();
  else if (network === "mainnet") set_network_mainnet();
  else return get_network();

  const current = get_network();
  console.info("[fastdata] network set to", current);
  attach_wallet_listeners_for_current_network();
  notify_subscribers();
  return current;
}
// ========================================

// ========================================
// the module's public surface, as one object.
//
// the components import this and destructure what they need, so the
// shape of the module is visible in one place:
//
//   import { FASTDATA_NETWORK } from "./near/network.js";
//   const { get_network, toggle, subscribe } = FASTDATA_NETWORK;
export const FASTDATA_NETWORK = {
  get_network,
  toggle,
  subscribe,
  get_receiver_id,
  get_rpc_url,
  get_account_network,
  set_network,
};
// ========================================
// copyright 2026 by sleet.near
