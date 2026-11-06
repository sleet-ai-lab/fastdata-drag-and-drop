// ========================================
// pin the pre-flight validation rules.
//
// these rules are what keeps a bad file from becoming a SILENT
// on-chain failure. the fastfs indexer drops an invalid action without
// a trace: the transaction still succeeds, the file just never
// appears, and the url 404s.
//
// the path and mime limits come from the indexer's own source
// (fastnear/fastdata-indexer, fastfs-sub-indexer/src/fastfs.rs):
//
//   const MAX_RELATIVE_PATH_LENGTH: usize = 1024;
//   const MAX_MIME_TYPE_LENGTH: usize = 256;
//   // SimpleFastfs::is_valid:
//   //   relative_path.len() > 1024 -> false
//   //   if let Some(content) = &self.content {
//   //       content.mime_type.is_empty() || content.mime_type.len() > 256 -> false
//   //   }
//
// the size caps are ours: 1 MiB per file (we use the `simple` variant
// only, so a file is ONE transaction and the protocol's 1.5 MiB
// max_transaction_size applies), 32 MB per drop and 10 files per drop
// (same as the reference).
//
// the boundaries matter. "over the limit" means strictly greater, so a
// file of exactly MAX_FILE_SIZE is fine and one byte more is not. the
// tests below sit exactly on those boundaries.
//
// run: bun test verify/validate.test.ts
// ========================================
import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  MAX_DROP_SIZE,
  MAX_FILES_PER_DROP,
  MAX_FILE_SIZE,
  MAX_MIME_TYPE_LENGTH,
  MAX_RELATIVE_PATH_LENGTH,
  validate_drop,
  validate_file,
} from "../src/fastfs/validate";

// ========================================
// a fake File. we do not need a real browser File: the validator only
// reads `size`, `type` and `name`.
function make_file(size, type, name = "file.bin") {
  return { size, type, name };
}
// ========================================

describe("fastfs validation", () => {
  // --- WHY --- the per-file size cap is the protocol's 1.5 MiB
  // max_transaction_size minus the envelope and the borsh header,
  // rounded down to the reference's own 1 MiB chunk boundary. the
  // reference's 32 MB per-file cap does NOT work for us because we do
  // not chunk — a 32 MB file would be one transaction and the network
  // would reject it before it was ever signed.
  describe("the file size limit", () => {
    test("a file of exactly MAX_FILE_SIZE is accepted", () => {
      const file = make_file(MAX_FILE_SIZE, "text/plain");
      expect(validate_file(file)).toBe(null);
    });

    test("a file one byte over MAX_FILE_SIZE is rejected", () => {
      const file = make_file(MAX_FILE_SIZE + 1, "text/plain");
      const error = validate_file(file);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.FILE_TOO_LARGE);
    });

    // --- WHY --- the message has to NAME the limit and show both
    // numbers, because the ui shows it as is. a user who is told
    // "file too large" and nothing else cannot act on it.
    test("the rejection names the limit and the actual size", () => {
      const file = make_file(MAX_FILE_SIZE + 1, "text/plain");
      const error = validate_file(file);
      expect(error.message).toContain(String(MAX_FILE_SIZE));
      expect(error.message).toContain(String(MAX_FILE_SIZE + 1));
    });
  });

  // --- WHY --- an empty `file.type` means the browser cannot classify
  // the file. the indexer requires a non-empty mime type, so the
  // reference's "pass file.type straight through" approach produces a
  // dropped transaction and no explanation.
  //
  // we do NOT guess from the extension either: a wrong guess becomes
  // the Content-Type on the served file, which is worse than a clear
  // rejection.
  describe("the mime type limit", () => {
    test("a file with an empty type is rejected", () => {
      const file = make_file(1024, "");
      const error = validate_file(file);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.MIME_TYPE_MISSING);
    });

    test("a file with a missing type is rejected", () => {
      const file = make_file(1024, undefined);
      const error = validate_file(file);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.MIME_TYPE_MISSING);
    });

    // --- WHY --- "over the limit" is strictly greater, so a mime type
    // of exactly 256 bytes is fine.
    test("a mime type of exactly MAX_MIME_TYPE_LENGTH is accepted", () => {
      const file = make_file(1024, "a".repeat(MAX_MIME_TYPE_LENGTH));
      expect(validate_file(file)).toBe(null);
    });

    test("a mime type one byte over MAX_MIME_TYPE_LENGTH is rejected", () => {
      const file = make_file(
        1024,
        "a".repeat(MAX_MIME_TYPE_LENGTH + 1),
      );
      const error = validate_file(file);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.MIME_TYPE_TOO_LONG);
    });

    test("the mime rejection names the limit", () => {
      const file = make_file(1024, "a".repeat(MAX_MIME_TYPE_LENGTH + 1));
      const error = validate_file(file);
      expect(error.message).toContain(String(MAX_MIME_TYPE_LENGTH));
    });
  });

  // --- WHY --- the path is part of the served url, so it is worth
  // letting the user edit it. but the indexer drops anything over
  // 1024 bytes, so we check it before we build the transaction.
  describe("the relative path limit", () => {
    test("a relative path of exactly MAX_RELATIVE_PATH_LENGTH is accepted", () => {
      const file = make_file(1024, "text/plain");
      const path = "a".repeat(MAX_RELATIVE_PATH_LENGTH);
      expect(validate_file(file, path)).toBe(null);
    });

    test("a relative path one byte over MAX_RELATIVE_PATH_LENGTH is rejected", () => {
      const file = make_file(1024, "text/plain");
      const path = "a".repeat(MAX_RELATIVE_PATH_LENGTH + 1);
      const error = validate_file(file, path);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.RELATIVE_PATH_TOO_LONG);
    });

    // --- WHY --- rust counts a string's length in BYTES, not in
    // characters. a path of 300 emoji is 1200 bytes, so a .length
    // check would let it through and the indexer would drop it.
    test("the path length is counted in bytes, not characters", () => {
      const file = make_file(1024, "text/plain");
      // 300 four-byte emoji. in javascript they are surrogate PAIRS,
      // so .length counts 600 code units — but the utf-8 encoding is
      // 1200 bytes, which is what rust's String::len() sees.
      const path = "\u{1F600}".repeat(300);
      expect(new TextEncoder().encode(path).length).toBe(1200);
      const error = validate_file(file, path);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.RELATIVE_PATH_TOO_LONG);
    });
  });

  // --- WHY --- the drop caps are the reference's own: 32 MB for the
  // drop zone and 10 files per drop. a drag that includes a huge file
  // is rejected with a clear message instead of silently failing.
  describe("the drop limits", () => {
    test("exactly MAX_FILES_PER_DROP files are accepted", () => {
      const files = Array.from({ length: MAX_FILES_PER_DROP }, () =>
        make_file(1024, "text/plain"),
      );
      expect(validate_drop(files)).toBe(null);
    });

    test("one file over MAX_FILES_PER_DROP is rejected", () => {
      const files = Array.from({ length: MAX_FILES_PER_DROP + 1 }, () =>
        make_file(1024, "text/plain"),
      );
      const error = validate_drop(files);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.TOO_MANY_FILES);
    });

    test("the too-many-files rejection names the limit", () => {
      const files = Array.from({ length: MAX_FILES_PER_DROP + 1 }, () =>
        make_file(1024, "text/plain"),
      );
      const error = validate_drop(files);
      expect(error.message).toContain(String(MAX_FILES_PER_DROP));
    });

    // --- WHY --- the 32 MB drop cap is the reference's outer drop-zone
    // cap: it catches a drag that carries a huge file, so the user gets
    // a clear message instead of a silent failure.
    //
    // NOTE the caps interact. with the 1 MiB per-file cap, 10 files can
    // only carry 10 MiB, so the file-count rule is the one that fires
    // first in practice. the drop-size rule is still checked, and still
    // bites when a drop carries fewer but larger files.
    test("a drop over MAX_DROP_SIZE is rejected", () => {
      const files = [make_file(MAX_DROP_SIZE + 1, "text/plain")];
      const error = validate_drop(files);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.DROP_TOO_LARGE);
    });

    test("the drop-too-large rejection names the limit", () => {
      const files = [make_file(MAX_DROP_SIZE + 1, "text/plain")];
      const error = validate_drop(files);
      expect(error.message).toContain(String(MAX_DROP_SIZE));
    });
  });

  // --- WHY --- the drop check has to run the per-file rules too. a
  // drop of ten files where one has no mime type is still a bad drop,
  // and the user needs to know WHICH file is the problem.
  describe("the drop runs the per-file rules", () => {
    test("a drop with a file that has no mime type is rejected", () => {
      const files = [
        make_file(1024, "text/plain"),
        make_file(1024, ""),
      ];
      const error = validate_drop(files);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.MIME_TYPE_MISSING);
    });

    test("a drop with a file that is too large is rejected", () => {
      const files = [
        make_file(1024, "text/plain"),
        make_file(MAX_FILE_SIZE + 1, "text/plain"),
      ];
      const error = validate_drop(files);
      expect(error).not.toBe(null);
      expect(error.code).toBe(ERROR_CODES.FILE_TOO_LARGE);
    });

    test("an empty drop is rejected", () => {
      const error = validate_drop([]);
      expect(error).not.toBe(null);
    });
  });
});
// ========================================
