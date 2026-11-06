// ========================================
// the drop zone.
//
// native html5 drag-and-drop. the reference uses the `react-files`
// package; we do not need it — the browser gives us the dropped files
// and we validate them ourselves.
//
// the drop zone is NOT a file input. we handle `dragover` and `drop`
// directly, and offer a click-to-browse fallback through a hidden
// <input type="file">.
//
// WHY WE VALIDATE ON DROP AND NOT ON UPLOAD:
// the indexer drops an action with a bad path or an empty mime type
// SILENTLY. the transaction still succeeds, the file just never
// appears, and the url 404s. so we check everything before we build a
// transaction. see src/fastfs/validate.js and plan.md section 2.
// ========================================
// aliased on import so the call sites follow this repo's snake_case rule.
import {
  useState as use_state,
  useRef as use_ref,
} from "preact/hooks";
import { FASTDATA_VALIDATE } from "../fastfs/validate.js";

// ========================================
// format a byte count for display.
function format_bytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
// ========================================

export function DropZone({ on_files, disabled }) {
  const [dragging, set_dragging] = use_state(false);
  const [error, set_error] = use_state(null);
  const input_ref = use_ref(null);

  function handle_files(file_list) {
    const files = Array.from(file_list ?? []);
    if (files.length === 0) return;

    // the drop-level check first: too many files, or the whole drop too
    // big. this is what the reference caps at 32 MB and 10 files.
    const drop_error = FASTDATA_VALIDATE.validate_drop(files);
    if (drop_error !== null) {
      set_error(drop_error.message);
      return;
    }

    // then each file on its own: size, mime type, and the relative
    // path length.
    const accepted = [];
    const rejected = [];
    for (const file of files) {
      const file_error = FASTDATA_VALIDATE.validate_file(file);
      if (file_error === null) {
        accepted.push(file);
      } else {
        rejected.push({ file, message: file_error.message });
      }
    }

    set_error(null);
    if (rejected.length > 0) {
      // the rejected files are reported, and the good ones still go
      // through. dropping five files where two are bad should not
      // lose the three that are fine.
      set_error(
        rejected
          .map((entry) => `${entry.file.name}: ${entry.message}`)
          .join(" · "),
      );
    }
    if (accepted.length > 0) {
      on_files(accepted);
    }
  }

  function handle_drag_over(event) {
    // we have to preventDefault on dragover, or the browser navigates
    // to the dropped file instead of firing `drop`.
    event.preventDefault();
    event.stopPropagation();
    if (!disabled) set_dragging(true);
  }

  function handle_drag_leave(event) {
    event.preventDefault();
    event.stopPropagation();
    set_dragging(false);
  }

  function handle_drop(event) {
    event.preventDefault();
    event.stopPropagation();
    set_dragging(false);
    if (disabled) return;
    handle_files(event.dataTransfer?.files);
  }

  function handle_input_change(event) {
    handle_files(event.target.files);
    // reset so picking the same file twice fires change again.
    event.target.value = "";
  }

  return (
    <div class="drop-zone-wrap">
      <div
        class={`drop-zone${dragging ? " drop-zone-active" : ""}${disabled ? " drop-zone-disabled" : ""}`}
        onDragOver={handle_drag_over}
        onDragLeave={handle_drag_leave}
        onDrop={handle_drop}
        onClick={() => {
          if (!disabled) input_ref.current?.click();
        }}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(event) => {
          if (!disabled && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            input_ref.current?.click();
          }
        }}
      >
        <p class="drop-zone-title">drop files here</p>
        <p class="drop-zone-sub">or click to browse</p>
        <p class="drop-zone-limits">
          up to {FASTDATA_VALIDATE.MAX_FILES_PER_DROP} files ·{" "}
          {format_bytes(FASTDATA_VALIDATE.MAX_FILE_SIZE)} each ·{" "}
          {format_bytes(FASTDATA_VALIDATE.MAX_DROP_SIZE)} per drop
        </p>
      </div>
      <input
        ref={input_ref}
        type="file"
        multiple
        class="hidden-input"
        onChange={handle_input_change}
      />
      {error !== null && (
        <div class="alert alert-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
// ========================================
