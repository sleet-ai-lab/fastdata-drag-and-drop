// ========================================
// the header: the account button and the network toggle.
//
// two things live here:
//   - the connect / sign out button
//   - the network toggle
//
// the network toggle does NOT reload the page. the tool box keeps a
// separate Near and NearConnector per network, so the next call
// returns the right one. see plan.md section 4.
//
// WHY THE ACCOUNT BUTTON CHECKS THE NETWORK:
// near-connect's signOut() wipes the wallet's whole storage namespace
// regardless of network. so a session can survive a network switch
// and leave us showing an account that belongs to the OTHER network.
// get_account_network() spots that by the .testnet suffix, and the ui
// says so rather than offering to upload with the wrong account.
// ========================================
// aliased on import so the call sites follow this repo's snake_case rule.
import {
  useState as use_state,
  useEffect as use_effect,
} from "preact/hooks";
import { FASTDATA_WALLET } from "../near/wallet.js";
import { FASTDATA_NETWORK } from "../near/network.js";

// ========================================
// the account button.
//
// three states:
//   - not signed in  -> "connect"
//   - signed in on the current network -> the account id + "sign out"
//   - signed in on the OTHER network -> a warning, because the upload
//     would go to the wrong chain
// ========================================
export function AccountButton() {
  const [account_id, set_account_id] = use_state(
    FASTDATA_WALLET.get_account_id(),
  );
  const [error, set_error] = use_state(FASTDATA_WALLET.get_error());
  const [busy, set_busy] = use_state(false);
  const [network, set_network] = use_state(FASTDATA_NETWORK.get_network());

  use_effect(() => {
    const unsubscribe = FASTDATA_WALLET.subscribe((id) => {
      set_account_id(id);
      set_error(FASTDATA_WALLET.get_error());
    });
    return unsubscribe;
  }, []);

  use_effect(() => {
    const unsubscribe = FASTDATA_NETWORK.subscribe((next) => {
      set_network(next);
    });
    return unsubscribe;
  }, []);

  const account_network = FASTDATA_NETWORK.get_account_network(account_id);
  const on_other_network =
    account_id !== null && account_network !== null && account_network !== network;

  async function handle_sign_in() {
    set_busy(true);
    set_error(null);
    try {
      await FASTDATA_WALLET.sign_in();
    } finally {
      set_busy(false);
    }
  }

  async function handle_sign_out() {
    set_busy(true);
    try {
      await FASTDATA_WALLET.sign_out();
    } finally {
      set_busy(false);
    }
  }

  if (account_id === null) {
    return (
      <div class="account-button">
        <button
          type="button"
          class="btn btn-primary"
          onClick={handle_sign_in}
          disabled={busy}
        >
          {busy ? "connecting…" : "connect"}
        </button>
        {error !== null && <p class="form-error">{error}</p>}
      </div>
    );
  }

  if (on_other_network) {
    return (
      <div class="account-button">
        <span class="account-id" title={account_id}>
          {account_id}
        </span>
        <span class="badge badge-warning">signed in on {account_network}</span>
        <button
          type="button"
          class="btn btn-secondary"
          onClick={handle_sign_out}
          disabled={busy}
        >
          sign out
        </button>
      </div>
    );
  }

  return (
    <div class="account-button">
      <span class="account-id" title={account_id}>
        {account_id}
      </span>
      <button
        type="button"
        class="btn btn-secondary"
        onClick={handle_sign_out}
        disabled={busy}
      >
        sign out
      </button>
    </div>
  );
}
// ========================================

// ========================================
// the network toggle.
//
// one button that flips between mainnet and testnet. the label says
// which network you would switch TO, so the button is never a
// surprise.
// ========================================
export function NetworkToggle() {
  const [network, set_network] = use_state(FASTDATA_NETWORK.get_network());

  use_effect(() => {
    const unsubscribe = FASTDATA_NETWORK.subscribe((next) => {
      set_network(next);
    });
    return unsubscribe;
  }, []);

  const other = network === "mainnet" ? "testnet" : "mainnet";

  return (
    <button
      type="button"
      class="btn btn-ghost network-toggle"
      onClick={() => FASTDATA_NETWORK.toggle()}
      title={`switch to ${other} — ${FASTDATA_NETWORK.get_receiver_id()}`}
    >
      <span class={`network-dot network-${network}`} />
      {network}
    </button>
  );
}
// ========================================

// ========================================
// the header bar.
export function Header() {
  return (
    <header class="app-header">
      <div class="app-header-inner">
        <a class="app-brand" href="/">
          FastData
          <span class="app-brand-sub">drag &amp; drop</span>
        </a>
        <div class="app-header-actions">
          <NetworkToggle />
          <AccountButton />
        </div>
      </div>
    </header>
  );
}
// ========================================
