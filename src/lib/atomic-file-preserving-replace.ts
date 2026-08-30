import { dlopen, ptr } from "bun:ffi";

const AT_FDCWD = -100;
const RENAME_EXCHANGE = 2;
const RENAME_SWAP = 0x00000002;

export class PreservingReplaceError extends Error {
  constructor() {
    super("Native credential publication could not complete.");
    this.name = "PreservingReplaceError";
  }
}

type Exchange = (source: string, target: string) => boolean;

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function unixExchange(symbol: "renameat2" | "renamex_np"): Exchange | null {
  try {
    const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      [symbol]: {
        args: symbol === "renameat2" ? ["i32", "cstring", "i32", "cstring", "u32"] : ["cstring", "cstring", "u32"],
        returns: "i32",
      },
    });
    const call = library.symbols[symbol] as (...args: unknown[]) => number;
    return (source, target) => symbol === "renameat2"
      ? call(AT_FDCWD, cString(source), AT_FDCWD, cString(target), RENAME_EXCHANGE) === 0
      : call(cString(source), cString(target), RENAME_SWAP) === 0;
  } catch {
    return null;
  }
}

function wide(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function windowsExchange(source: string, target: string, backup: string): boolean {
  try {
    const library = dlopen("kernel32.dll", {
      ReplaceFileW: { args: ["ptr", "ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    });
    const replacement = wide(source);
    const replaced = wide(target);
    const privateBackup = wide(backup);
    return (library.symbols.ReplaceFileW as (...args: unknown[]) => number)(
      ptr(replaced), ptr(replacement), ptr(privateBackup), 0, null, null,
    ) !== 0;
  } catch {
    return false;
  }
}

/**
 * Exchange a staged file with an existing canonical file without a missing-target window.
 * On Unix the displaced entry remains at `source`; Windows places it at `backup`.
 */
export function replaceFilePreservingTarget(source: string, target: string, backup: string): void {
  if (process.platform === "linux") {
    const exchange = unixExchange("renameat2");
    if (exchange?.(source, target)) return;
    throw new PreservingReplaceError();
  }
  if (process.platform === "darwin") {
    const exchange = unixExchange("renamex_np");
    if (exchange?.(source, target)) return;
    throw new PreservingReplaceError();
  }
  if (process.platform === "win32" && windowsExchange(source, target, backup)) return;
  // No rename fallback is safe: it can make auth.json absent between operations.
  throw new PreservingReplaceError();
}

/** Restore a verified displaced entry while preserving the canonical target. */
export function restoreFilePreservingTarget(source: string, target: string, backup: string): void {
  replaceFilePreservingTarget(source, target, backup);
}
