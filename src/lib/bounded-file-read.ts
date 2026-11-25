import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { sameFileIdentity } from "./file-identity";

const MAX_BOUNDED_READ_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface BoundedRegularFileReadOptions {
  /** Follow the final symlink while still requiring its opened target to be bounded regular data. */
  followFinalSymlink?: boolean;
}

export function readBoundedRegularFileSync(
  path: string,
  limit: number,
  options: BoundedRegularFileReadOptions = {},
): Buffer {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOUNDED_READ_BYTES) {
    throw new RangeError("invalid bounded file read limit");
  }

  const windows = process.platform === "win32";
  const followFinalSymlink = options.followFinalSymlink === true;
  const posixFlags = constants.O_NONBLOCK | (followFinalSymlink ? 0 : constants.O_NOFOLLOW);
  const flags = constants.O_RDONLY | (windows ? 0 : posixFlags);
  const inspectEntry = followFinalSymlink ? statSync : lstatSync;
  const entryBefore = windows || followFinalSymlink ? inspectEntry(path, { bigint: true }) : undefined;
  if (entryBefore && !entryBefore.isFile()) {
    throw new Error("not a regular file");
  }
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(limit)) throw new Error("file is not bounded regular data");
    if (entryBefore && (!sameFileIdentity(entryBefore, opened) || opened.ino === 0n)) {
      throw new Error("file entry changed while opening");
    }

    // Start near the observed size, but keep probing up to limit + 1 if the file grows.
    let bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < limit + 1) {
      if (length === bytes.length) {
        const capacity = Math.min(limit + 1, Math.max(bytes.length * 2, bytes.length + READ_CHUNK_BYTES));
        const next = Buffer.alloc(capacity);
        bytes.copy(next, 0, 0, length);
        bytes = next;
      }
      const count = readSync(fd, bytes, length, Math.min(READ_CHUNK_BYTES, bytes.length - length), null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error("file exceeds byte limit");

    if (entryBefore) {
      const entryAfter = inspectEntry(path, { bigint: true });
      if (!entryAfter.isFile() || !sameFileIdentity(opened, entryAfter)) {
        throw new Error("file entry changed while reading");
      }
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
