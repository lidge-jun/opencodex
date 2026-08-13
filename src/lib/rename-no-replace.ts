import { cc, ptr } from "bun:ffi";
import { isAbsolute, normalize, toNamespacedPath } from "node:path";

type NativeRenameNoReplace = (source: string, destination: string) => number;

export type RenameNoReplaceErrorCode =
  | "EACCES"
  | "EEXIST"
  | "EINVAL"
  | "EIO"
  | "ENAMETOOLONG"
  | "ENOENT"
  | "ENOTSUP"
  | "EXDEV";

let nativeRenameNoReplace: NativeRenameNoReplace | null | undefined;
let nativeLibrary: unknown;
let nativeOverrideForTests: NativeRenameNoReplace | null | undefined;

function utf8(path: string): Buffer {
  return Buffer.from(`${path}\0`, "utf8");
}

function windowsPath(path: string): string {
  if (!isAbsolute(path)) return path;
  return toNamespacedPath(normalize(path));
}

function utf16(path: string): Buffer {
  return Buffer.from(`${windowsPath(path)}\0`, "utf16le");
}

function loadNative(): NativeRenameNoReplace | null {
  if (nativeOverrideForTests !== undefined) return nativeOverrideForTests;
  if (nativeRenameNoReplace !== undefined) return nativeRenameNoReplace;
  try {
    const compiled = cc({
      source: new URL("./rename-no-replace.c", import.meta.url),
      library: process.platform === "win32" ? ["kernel32"] : [],
      symbols: {
        ocx_rename_noreplace: { args: ["ptr", "ptr"] as const, returns: "i32" as const },
      },
    });
    nativeLibrary = compiled;
    const native = compiled.symbols.ocx_rename_noreplace;
    nativeRenameNoReplace = (source, destination) => {
      const from = process.platform === "win32" ? utf16(source) : utf8(source);
      const to = process.platform === "win32" ? utf16(destination) : utf8(destination);
      return Number(native(ptr(from), ptr(to)));
    };
  } catch {
    nativeRenameNoReplace = null;
  }
  return nativeRenameNoReplace;
}

/** @internal Deterministic backend seam for focused fail-closed/error tests. */
export function setRenameNoReplaceBackendForTests(
  backend: NativeRenameNoReplace | null | undefined,
): void {
  nativeOverrideForTests = backend;
}

export function portableRenameNoReplaceErrorCode(
  platform: NodeJS.Platform,
  nativeCode: number,
): RenameNoReplaceErrorCode {
  if (nativeCode === -1) return "ENOTSUP";
  if (platform === "win32") {
    if (nativeCode === 80 || nativeCode === 183) return "EEXIST";
    if (nativeCode === 2 || nativeCode === 3) return "ENOENT";
    if (nativeCode === 5) return "EACCES";
    // Win32 ERROR_NOT_SAME_DEVICE; POSIX errno 17 below means EEXIST.
    if (nativeCode === 17) return "EXDEV";
    if (nativeCode === 50) return "ENOTSUP";
    if (nativeCode === 87) return "EINVAL";
    if (nativeCode === 206) return "ENAMETOOLONG";
    return "EIO";
  }
  if (nativeCode === 17) return "EEXIST";
  if (nativeCode === 2) return "ENOENT";
  if (nativeCode === 13) return "EACCES";
  if (nativeCode === 18) return "EXDEV";
  if (nativeCode === 36 || nativeCode === 63) return "ENAMETOOLONG";
  // Linux EINVAL/ENOSYS/EOPNOTSUPP and Darwin ENOTSUP/EOPNOTSUPP.
  if ([22, 38, 45, 78, 95, 102].includes(nativeCode)) return "ENOTSUP";
  return "EIO";
}

function nativeRenameError(
  source: string,
  destination: string,
  nativeCode: number,
): NodeJS.ErrnoException & { dest?: string } {
  const code = portableRenameNoReplaceErrorCode(process.platform, nativeCode);
  const error = new Error(`Atomic no-replace rename failed (${code})`) as NodeJS.ErrnoException & { dest?: string };
  error.code = code;
  error.errno = nativeCode;
  error.path = source;
  error.dest = destination;
  return error;
}

/** Atomically rename one directory entry while refusing to replace another. */
export function renameNoReplace(source: string, destination: string): void {
  if (source.includes("\0") || destination.includes("\0")) {
    throw Object.assign(new Error("Path contains a NUL byte"), {
      code: "EINVAL",
      path: source,
      dest: destination,
    });
  }
  const native = loadNative();
  const nativeCode = native ? native(source, destination) : -1;
  if (nativeCode === 0) return;
  throw nativeRenameError(source, destination, nativeCode);
}
