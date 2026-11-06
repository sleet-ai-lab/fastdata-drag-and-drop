// ========================================
// the fastfs borsh schema.
//
// copied from the reference implementation
// (fastnear/fastdata-drag-and-drop, src/hooks/fastfs.js) and from the
// format spec at https://hackmd.io/@fastnear/fastfs-docs.
//
// the schema is what the FastFS indexer reads out of the transaction
// args, so it has to match byte for byte. the regression test in
// verify/encoding.test.ts pins it against a real on-chain transaction.
//
// WHY the enum has two variants:
//   simple  — the whole file in one transaction. this is what the spec
//             documents.
//   partial — a 1 MiB chunk of a bigger file, with the offset, the
//             full size and a nonce. the reference ships this for files
//             over 1 MiB; the spec does not document it.
// ========================================
export const FastfsSchema = new (class BorshSchema {
  FastfsFileContent = {
    struct: {
      mimeType: "string",
      content: { array: { type: "u8" } },
    },
  };
  SimpleFastfs = {
    struct: {
      relativePath: "string",
      content: { option: this.FastfsFileContent },
    },
  };
  PartialFastfs = {
    struct: {
      relativePath: "string",
      // The offset has to be aligned to 1Mb (1048576 bytes).
      offset: "u32",
      // The full content size in bytes up to 32Mb (33554432 bytes).
      fullSize: "u32",
      mimeType: "string",
      // The content chunk up to 1Mb (1048576 bytes). We assume zero bytes tail if the chunk is
      // smaller than 1Mb, but inside the file.
      contentChunk: { array: { type: "u8" } },
      // A nonce to differentiate different uploads at the same relative path.
      // The nonce should match for all parts of the same file.
      // Max value is i32::MAX.
      // Min value should be 1, to differentiate from simple fastfs entries.
      nonce: "u32",
    },
  };
  FastfsData = {
    enum: [
      { struct: { simple: this.SimpleFastfs } },
      { struct: { partial: this.PartialFastfs } },
    ],
  };
})();
// ========================================
