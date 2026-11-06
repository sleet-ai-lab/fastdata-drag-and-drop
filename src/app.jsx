// ========================================
// the app shell.
//
// this replaces the vite boilerplate. the structure follows the
// reference (fastnear/fastdata-drag-and-drop):
//
//   header      -> account + network
//   drop zone   -> the files
//   relative path
//   upload button
//   staged files
//   results
//
// but the wallet and the network come from @near-kit-tool-box/web
// instead of @near-wallet-selector, and the upload is verified against
// the chain instead of trusted. see plan.md.
// ========================================
// aliased on import so the call sites follow this repo's snake_case rule.
import {
  useState as use_state,
  useEffect as use_effect,
} from "preact/hooks";
import { Header } from "./components/Header.jsx";
import { DropZone } from "./components/DropZone.jsx";
import {
  RelativePathField,
  StagedFiles,
  UploadResults,
} from "./components/FileList.jsx";
import { FASTDATA_WALLET } from "./near/wallet.js";
import { FASTDATA_NETWORK } from "./near/network.js";
import { FASTDATA_UPLOAD } from "./fastfs/upload.js";
import { FASTDATA_VALIDATE } from "./fastfs/validate.js";
import "./app.css";

// ========================================
// the app.
//
// the upload area is gated behind a signed-in account, like the
// reference does.
// ========================================
export function App() {
  const [account_id, set_account_id] = use_state(
    FASTDATA_WALLET.get_account_id(),
  );
  const [network, set_network] = use_state(FASTDATA_NETWORK.get_network());
  const [files, set_files] = use_state([]);
  const [relative_path, set_relative_path] = use_state("/");
  const [uploading, set_uploading] = use_state(false);
  const [results, set_results] = use_state([]);

  // the wallet listeners have to be attached before any connect() —
  // connect() emits wallet:signIn before it resolves.
  use_effect(() => {
    FASTDATA_WALLET.init();
    const unsubscribe = FASTDATA_WALLET.subscribe((id) => {
      set_account_id(id);
    });
    return unsubscribe;
  }, []);

  use_effect(() => {
    const unsubscribe = FASTDATA_NETWORK.subscribe((next) => {
      set_network(next);
    });
    return unsubscribe;
  }, []);

  const signed_in = account_id !== null;
  const account_network = FASTDATA_NETWORK.get_account_network(account_id);
  const on_other_network =
    signed_in && account_network !== null && account_network !== network;

  async function handle_upload() {
    if (files.length === 0 || uploading) return;

    // the relative path is checked here too, not only on drop: the
    // user can edit it AFTER dropping the files, so the drop-time
    // check may no longer hold.
    const path_error = FASTDATA_VALIDATE.validate_relative_path(
      relative_path,
    );
    if (path_error !== null) {
      set_results([
        {
          status: "failed",
          path: relative_path,
          url: "",
          hash: null,
          signer_id: account_id,
          bytes: 0,
          error: path_error.message,
        },
      ]);
      return;
    }

    set_uploading(true);
    try {
      const upload_results = await FASTDATA_UPLOAD.upload_files(files, relative_path, {
        account_id,
      });
      set_results(upload_results);
      // only the files that landed are cleared from the staged list.
      const failed = upload_results.filter((r) => r.status !== "success");
      if (failed.length === 0) {
        set_files([]);
      }
    } catch (error) {
      set_results([
        {
          status: "failed",
          path: relative_path,
          url: "",
          hash: null,
          signer_id: account_id,
          bytes: 0,
          error: `the upload failed: ${error?.message ?? String(error)}`,
        },
      ]);
    } finally {
      set_uploading(false);
    }
  }

  return (
    <div class="app-shell">
      <Header />

      <main class="app-main">
        {!signed_in && (
          <div class="alert alert-info" role="alert">
            connect a wallet to upload files to FastFS.
          </div>
        )}

        {signed_in && on_other_network && (
          <div class="alert alert-warning" role="alert">
            you are signed in as <code>{account_id}</code>, which is a{" "}
            {account_network} account, but the app is on {network}. sign out
            and connect the {network} account, or switch the network back.
          </div>
        )}

        {signed_in && !on_other_network && (
          <>
            <DropZone
              on_files={(incoming) => {
                set_files((previous) => [...previous, ...incoming]);
                set_results([]);
              }}
              disabled={uploading}
            />

            <RelativePathField
              value={relative_path}
              on_change={(next) => {
                set_relative_path(next);
                set_results([]);
              }}
              disabled={uploading}
            />

            <div class="upload-actions">
              <button
                type="button"
                class="btn btn-primary btn-lg"
                onClick={handle_upload}
                disabled={uploading || files.length === 0}
              >
                {uploading ? "uploading…" : "upload!"}
              </button>
              {files.length > 0 && (
                <span class="upload-count">
                  {files.length} file{files.length === 1 ? "" : "s"} ready
                </span>
              )}
            </div>

            <StagedFiles
              files={files}
              on_remove={(index) => {
                set_files((previous) => previous.filter((_, i) => i !== index));
              }}
              disabled={uploading}
            />

            <UploadResults results={results} />
          </>
        )}
      </main>

      <footer class="app-footer">
        <p>
          files go on chain with the fastfs standard —{" "}
          <code>__fastdata_fastfs</code> on{" "}
          <code>{FASTDATA_NETWORK.get_receiver_id()}</code>. every upload is
          checked against the transaction on chain before it is called a
          success.
        </p>
      </footer>
    </div>
  );
}
// ========================================
