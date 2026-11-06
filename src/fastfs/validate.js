// ========================================
// the pre-flight validation layer.
//
// every file is checked BEFORE we build a transaction, because the
// fastfs indexer DROPS an invalid action SILENTLY: the transaction
// still succeeds, the file just never appears, and the url 404s. the
// user would have no idea why. this module is what turns that silent
// failure into a clear message naming the limit that was hit.
//
// the rules come from the indexer's own source, not from the prose
// spec (fastnear/fastdata-indexer, fastfs-sub-indexer/src/fastfs.rs):
//
//   const MAX_RELATIVE_PATH_LENGTH: usize = 1024;
//   const MAX_MIME_TYPE_LENGTH: usize = 256;
//   // SimpleFastfs::is_valid:
//   //   relative_path.len() > 1024 -> false
//   //   if let Some(content) = &self.content {
//   //       content.mime_type.is_empty() || content.mime_type.len() > 256 -> false
//   //   }
//
// the size caps are ours:
//
//   MAX_FILE_SIZE     — the protocol's 1.5 MiB max_transaction_size
//                        minus the envelope (signer id, public key,
//                        nonce, receiver id, block hash, signature) and
//                        the borsh header, rounded down to the
//                        reference's own 1 MiB chunk boundary. we use
//                        the `simple` variant only, so a file is ONE
//                        transaction carrying the whole file, and
//                        anything bigger cannot be sent at all.
//
//                        the reference's 32 MB per-file cap does NOT
//                        work for us: it chunks at 1 MiB and uses the
//                        `partial` variant. we do not chunk, so the
//                        transaction would be rejected by the network
//                        before it is ever signed.
//
//   MAX_DROP_SIZE     — the reference's outer drop-zone cap. it stops
//                        a drag that includes a huge file from
//                        silently failing.
//
//   MAX_FILES_PER_DROP — the reference's cap.
//
// EVERY rejection message NAMES the limit that was hit, with both the
// limit and the actual value. the ui shows it as is.
// ========================================

// ========================================
// the limits.
export const MAX_FILE_SIZE = 1048576; // 1 MiB
export const MAX_DROP_SIZE = 32000000; // 32 MB
export const MAX_FILES_PER_DROP = 10;
export const MAX_RELATIVE_PATH_LENGTH = 1024; // from the indexer
export const MAX_MIME_TYPE_LENGTH = 256; // from the indexer
// ========================================

// ========================================
// the error codes. the ui switches on these to decide what to show,
// so they are part of the module's contract.
export const ERROR_CODES = {
  FILE_TOO_LARGE: "file_too_large",
  MIME_TYPE_MISSING: "mime_type_missing",
  MIME_TYPE_TOO_LONG: "mime_type_too_long",
  RELATIVE_PATH_TOO_LONG: "relative_path_too_long",
  TOO_MANY_FILES: "too_many_files",
  DROP_TOO_LARGE: "drop_too_large",
};
// ========================================

// ========================================
// the byte length of a string, the way rust counts it.
//
// rust's String::len() is the number of BYTES in the utf-8 encoding,
// not the number of characters. a path with 300 emoji is 1200 bytes,
// so we must measure bytes and not use .length.
function byte_length(text) {
  return new TextEncoder().encode(text ?? "").length;
}
// ========================================

// ========================================
// validate one file.
//
// `file` is a browser File (or anything with `size`, `type` and `name`).
// `relative_path` is optional — when given, it is the path that will
// be written on chain, so the path limit can be checked here too.
//
// returns null when the file is fine, otherwise { code, message }.
//
// WHY WE REJECT AN EMPTY MIME TYPE AND NEVER GUESS IT:
// the browser leaves `file.type` empty for a file it cannot classify.
// the indexer requires a non-empty mime type, so the reference's
// "pass file.type straight through" approach sends an empty string and
// the transaction is dropped on chain with no explanation.
//
// we could guess from the extension. we do not, because a WRONG guess
// is worse than a clear rejection: the guessed type becomes the
// Content-Type on the served file, so a browser would download it as
// the wrong type or refuse to render it. the user would rather be
// told "the browser cannot classify this file".
export function validate_file(file, relative_path) {
  if (!file) {
    return {
      code: ERROR_CODES.MIME_TYPE_MISSING,
      message: "no file was given",
    };
  }

  // --- the size cap ---
  if (file.size > MAX_FILE_SIZE) {
    return {
      code: ERROR_CODES.FILE_TOO_LARGE,
      message: `file is too large: ${file.size} bytes, the limit is ${MAX_FILE_SIZE} bytes (1 MiB)`,
    };
  }

  // --- the mime type must exist ---
  const mime_type = file.type ?? "";
  if (mime_type.length === 0) {
    return {
      code: ERROR_CODES.MIME_TYPE_MISSING,
      message: `the browser cannot classify "${file.name ?? "this file"}" (no mime type), so it cannot be uploaded`,
    };
  }

  // --- the mime type must fit ---
  const mime_length = byte_length(mime_type);
  if (mime_length > MAX_MIME_TYPE_LENGTH) {
    return {
      code: ERROR_CODES.MIME_TYPE_TOO_LONG,
      message: `the mime type is too long: ${mime_length} bytes, the limit is ${MAX_MIME_TYPE_LENGTH} bytes`,
    };
  }

  // --- the relative path must fit ---
  // the path is part of the served url, so it is worth letting the user
  // edit it — but the indexer drops anything over 1024 bytes.
  if (relative_path !== undefined && relative_path !== null) {
    const path_length = byte_length(relative_path);
    if (path_length > MAX_RELATIVE_PATH_LENGTH) {
      return {
        code: ERROR_CODES.RELATIVE_PATH_TOO_LONG,
        message: `the relative path is too long: ${path_length} bytes, the limit is ${MAX_RELATIVE_PATH_LENGTH} bytes`,
      };
    }
  }

  return null;
}
// ========================================

// ========================================
// validate a whole drop.
//
// the per-file rules run first, in order, so the user is told about a
// bad FILE before they are told about the size of the whole drop. the
// drop-level rules (too many files, too many bytes) only matter once
// every file is individually fine.
//
// returns null when the drop is fine, otherwise { code, message }.
export function validate_drop(files) {
  const list = Array.isArray(files) ? files : [];

  if (list.length === 0) {
    return {
      code: ERROR_CODES.MIME_TYPE_MISSING,
      message: "the drop is empty",
    };
  }

  // --- how many files ---
  if (list.length > MAX_FILES_PER_DROP) {
    return {
      code: ERROR_CODES.TOO_MANY_FILES,
      message: `too many files: ${list.length}, the limit is ${MAX_FILES_PER_DROP} files per drop`,
    };
  }

  // --- how many bytes in total ---
  let total = 0;
  for (const file of list) {
    total += file?.size ?? 0;
  }
  if (total > MAX_DROP_SIZE) {
    return {
      code: ERROR_CODES.DROP_TOO_LARGE,
      message: `the drop is too large: ${total} bytes, the limit is ${MAX_DROP_SIZE} bytes (32 MB)`,
    };
  }

  // --- each file on its own ---
  for (const file of list) {
    const error = validate_file(file);
    if (error) return error;
  }

  return null;
}
// ========================================

// ========================================
// validate the relative path on its own.
//
// WHY THIS EXISTS SEPARATELY: the relative path is EDITABLE, so the
// user can make it too long AFTER the files are dropped. the drop-time
// check would have passed. so the path is checked again right before
// we build the transaction.
//
// returns null when the path is fine, otherwise { code, message }.
export function validate_relative_path(relative_path) {
  if (relative_path === undefined || relative_path === null) return null;
  const path_length = byte_length(relative_path);
  if (path_length > MAX_RELATIVE_PATH_LENGTH) {
    return {
      code: ERROR_CODES.RELATIVE_PATH_TOO_LONG,
      message: `the relative path is too long: ${path_length} bytes, the limit is ${MAX_RELATIVE_PATH_LENGTH} bytes`,
    };
  }
  return null;
}
// ========================================

// ========================================
// the module's public surface, as one object.
//
// the drop zone imports this and calls what it needs:
//
//   import { FASTDATA_VALIDATE } from "./fastfs/validate.js";
//   const error = FASTDATA_VALIDATE.validate_drop(files);
export const FASTDATA_VALIDATE = {
  MAX_FILE_SIZE,
  MAX_DROP_SIZE,
  MAX_FILES_PER_DROP,
  MAX_RELATIVE_PATH_LENGTH,
  MAX_MIME_TYPE_LENGTH,
  ERROR_CODES,
  validate_file,
  validate_drop,
  validate_relative_path,
};
// ========================================
// copyright 2026 by sleet.near
