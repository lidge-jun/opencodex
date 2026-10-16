import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// CRLF normalization can halve the byte count. Every body within 64 KiB
// therefore fits this raw ceiling; title bytes stay outside the body budget.
const MAX_IMPORT_SOURCE_BYTES = 2 * 64 * 1024;

/** The prompt-text-probe descriptor pattern: nonblocking, regular, bounded. */
export function readBaseImportSource(path: string): string {
  const nonBlocking = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | nonBlocking);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("prompt source is not a regular file");
    const parts: Buffer[] = [];
    const view = Buffer.allocUnsafe(8192);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, view, 0, Math.min(view.length, MAX_IMPORT_SOURCE_BYTES + 1 - total), total);
      if (count === 0) return Buffer.concat(parts).toString("utf8");
      total += count;
      if (total > MAX_IMPORT_SOURCE_BYTES) {
        const error = new Error("prompt source exceeds the import byte ceiling") as NodeJS.ErrnoException;
        error.code = "EFBIG";
        throw error;
      }
      parts.push(Buffer.from(view.subarray(0, count)));
    }
  } finally {
    closeSync(descriptor);
  }
}
