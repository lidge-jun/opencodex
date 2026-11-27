import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const MAX_TRANSCRIPT_FILE_BYTES = 4 * 1024 * 1024;

/** Read at most the configured bound plus one byte, even if a transcript grows after discovery. */
export function readBoundedTranscriptFile(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.allocUnsafe(MAX_TRANSCRIPT_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return length > MAX_TRANSCRIPT_FILE_BYTES ? undefined : buffer.toString("utf8", 0, length);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
