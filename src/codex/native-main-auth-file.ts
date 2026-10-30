import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { readBoundedLocalFile } from "./orca-auth-source";
import { atomicWriteFile, type AtomicWriteHooks } from "../config/atomic-write";

export const MAX_AUTH_BYTES = 4 * 1024 * 1024;

export interface BoundedReadTestSeam {
  beforeOpen?: (path: string) => void;
  afterValidatedOpen?: (path: string, fd: number) => void;
  onBufferAllocated?: (byteLength: number) => void;
  onRead?: (requestedBytes: number, bytesRead: number, totalBytesRead: number) => void;
}

export type NativeMainAuthReadMode = "plain" | "bounded" | "local-bounded";

/** Reads the raw bytes of a native-main login file. Throws the error of the underlying read unchanged. */
export function readNativeMainAuthBytes(path: string, mode: NativeMainAuthReadMode, limit?: number): Buffer {
  if (mode === "plain") return readFileSync(path);
  if (mode === "bounded") return readBounded(path, limit ?? MAX_AUTH_BYTES);
  return Buffer.from(readBoundedLocalFile(path, limit ?? MAX_AUTH_BYTES), "utf8");
}

export function nativeAuthStatStamp(value: BigIntStats): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}

/** Reads with a stat before and after, as the desktop identity reader did. */
export function readNativeMainAuthBytesStable(path: string, maxBytes: bigint): { bytes: Buffer; stat: BigIntStats } {
  const before = statSync(path, { bigint: true });
  if (before.size > maxBytes) throw new Error('Unexpected native auth size');
  const bytes = readFileSync(path);
  const after = statSync(path, { bigint: true });
  if (nativeAuthStatStamp(before) !== nativeAuthStatStamp(after)) throw new Error('Native credentials changed during read');
  return { bytes, stat: after };
}

/** The only sync writer of a native-main login file. */
export function writeNativeMainAuthFile(path: string, content: string, hooks: AtomicWriteHooks): void {
  atomicWriteFile(path, content, undefined, hooks);
}

/** The only async writer of a native-main login file. `write` keeps the caller's injected writer (a test seam of NativeProfileManager). */
export async function writeNativeMainAuthFileAsync(path: string, content: string, write: (path: string, content: string) => Promise<void>): Promise<void> {
  await write(path, content);
}

export function readBounded(path: string, limit: number, testSeam?: BoundedReadTestSeam): Buffer {
  let fd: number | undefined;
  let failed = false;
  try {
    testSeam?.beforeOpen?.(path);
    const flags = process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    fd = openSync(path, flags);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(limit)) throw new Error("invalid bounded file");

    if (process.platform === "win32") {
      const pathEntry = lstatSync(path, { bigint: true });
      if (
        !pathEntry.isFile()
        || pathEntry.isSymbolicLink()
        || pathEntry.dev !== opened.dev
        || pathEntry.ino !== opened.ino
      ) throw new Error("invalid bounded file");
    }

    testSeam?.afterValidatedOpen?.(path, fd);
    const buffer = Buffer.allocUnsafe(limit + 1);
    testSeam?.onBufferAllocated?.(buffer.byteLength);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.byteLength) {
      const requestedBytes = buffer.byteLength - totalBytesRead;
      const bytesRead = readSync(fd, buffer, totalBytesRead, requestedBytes, totalBytesRead);
      totalBytesRead += bytesRead;
      testSeam?.onRead?.(requestedBytes, bytesRead, totalBytesRead);
      if (bytesRead === 0) break;
    }
    if (totalBytesRead > limit) throw new Error("invalid bounded file");
    return buffer.subarray(0, totalBytesRead);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        if (!failed) throw error;
      }
    }
  }
}
