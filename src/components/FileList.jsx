// ========================================
// the file list: the staged files and the upload results.
//
// two lists:
//   - the staged files, waiting to be uploaded
//   - the results, one per uploaded file
//
// the results show the served url on success and the error on
// failure. a failure NEVER shows a success link.
//
// WHY THE ERROR MATTERS: the indexer drops a malformed action
// SILENTLY — the transaction succeeds and the file just never
// appears. the reference implementation swallows every error and
// marks the file "Success" anyway. we do not. see plan.md section 3b.
// ========================================
import { FASTDATA_UPLOAD } from "../fastfs/upload.js";

// ========================================
// format a byte count for display.
function format_bytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
// ========================================

// ========================================
// the staged files, before the upload.
export function StagedFiles({ files, on_remove, disabled }) {
  if (files.length === 0) return null;

  return (
    <div class="file-section">
      <h2 class="file-section-title">
        {files.length} file{files.length === 1 ? "" : "s"} to upload
      </h2>
      <ul class="file-list">
        {files.map((file, index) => (
          <li class="file-row" key={`staged-${index}`}>
            <code class="file-name">{file.name}</code>
            <code class="file-meta">{file.type}</code>
            <code class="file-meta">{format_bytes(file.size)}</code>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              title="remove"
              onClick={() => on_remove(index)}
              disabled={disabled}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
// ========================================

// ========================================
// the results, after the upload.
//
// each result is either a success (the url, and the tx hash) or a
// failure (the reason). the hash is always shown, so a failure can be
// looked up on a block explorer.
export function UploadResults({ results }) {
  if (results.length === 0) return null;

  return (
    <div class="file-section">
      <h2 class="file-section-title">uploaded files</h2>
      <ul class="file-list">
        {results.map((result, index) => (
          <li class="file-row" key={`result-${index}`}>
            {result.status === "success" ? (
              <>
                <a
                  class="file-url"
                  href={result.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {result.url}
                </a>
                <span class="badge badge-success">on chain</span>
              </>
            ) : (
              <>
                <span class="file-name">{result.path}</span>
                <span class="badge badge-error">failed</span>
                <p class="form-error">{result.error}</p>
              </>
            )}
            {result.hash !== null && (
              <a
                class="file-hash"
                href={`https://nearblocks.io/txns/${result.hash}`}
                target="_blank"
                rel="noreferrer"
                title={result.hash}
              >
                {result.hash.slice(0, 12)}…
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
// ========================================

// ========================================
// the relative path field.
//
// the path is part of the served url, so it is worth letting the
// user set it. the reference has the same field.
//
// NOTE the reference CONCATENATES the path and the file name with no
// separator, so "notes" + "a.txt" is "notesa.txt". the user has to
// type the trailing slash themselves. we mirror that exactly — a
// different path means a different url.
// ========================================
export function RelativePathField({ value, on_change, disabled }) {
  return (
    <div class="file-section">
      <h2 class="file-section-title">relative path (optional)</h2>
      <input
        type="text"
        class="path-input"
        onChange={(event) => on_change(event.target.value)}
        placeholder="/"
        value={value}
        disabled={disabled}
      />
      <p class="path-hint">
        the file is served at{" "}
        <code>
          https://&#123;account&#125;.fastfs.io/&#123;namespace&#125;/
          &#123;relative-path&#125;
        </code>
        . the path and the file name are joined with no separator, so end
        it with a slash.
      </p>
    </div>
  );
}
// ========================================
