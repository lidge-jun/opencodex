import { dlopen, ptr, read } from "bun:ffi";

const AT_FDCWD = -100;
const RENAME_EXCHANGE = 2;
const RENAME_SWAP = 0x00000002;

type ReplaceOperation = "renameat2" | "renamex_np" | "ReplaceFileW" | "unsupported";
type NativeExchangeResult =
  | { ok: true }
  | { ok: false; nativeCode?: number; cause?: unknown };

type FailedReplacementDetails = {
  operation: ReplaceOperation;
  sourcePath: string;
  targetPath: string;
  backupPath: string;
  result: Extract<NativeExchangeResult, { ok: false }>;
};

export class PreservingReplaceError extends Error {
  readonly operation: ReplaceOperation;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly backupPath: string;
  readonly platform: NodeJS.Platform;
  readonly nativeCode?: number;

  constructor(details: {
    operation: ReplaceOperation;
    sourcePath: string;
    targetPath: string;
    backupPath: string;
    platform: NodeJS.Platform;
    nativeCode?: number;
    cause?: unknown;
  }) {
    super("Native credential publication could not complete.", details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "PreservingReplaceError";
    this.operation = details.operation;
    this.sourcePath = details.sourcePath;
    this.targetPath = details.targetPath;
    this.backupPath = details.backupPath;
    this.platform = details.platform;
    this.nativeCode = details.nativeCode;
  }
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function unixExchange(symbol: "renameat2" | "renamex_np"): (source: string, target: string) => NativeExchangeResult {
  try {
    const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
    const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      [symbol]: {
        args: symbol === "renameat2" ? ["i32", "cstring", "i32", "cstring", "u32"] : ["cstring", "cstring", "u32"],
        returns: "i32",
      },
      [errnoSymbol]: { args: [], returns: "ptr" },
    });
    const call = library.symbols[symbol] as (...args: unknown[]) => number;
    const errnoLocation = library.symbols[errnoSymbol] as () => number;
    return (source, target) => {
      const status = symbol === "renameat2"
        ? call(AT_FDCWD, cString(source), AT_FDCWD, cString(target), RENAME_EXCHANGE)
        : call(cString(source), cString(target), RENAME_SWAP);
      if (status === 0) return { ok: true };
      return { ok: false, nativeCode: read.i32(errnoLocation()) };
    };
  } catch (cause) {
    return () => ({ ok: false, cause });
  }
}

function wide(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function windowsExchange(source: string, target: string, backup: string): NativeExchangeResult {
  try {
    const library = dlopen("kernel32.dll", {
      ReplaceFileW: { args: ["ptr", "ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
      GetLastError: { args: [], returns: "u32" },
    });
    const replacement = wide(source);
    const replaced = wide(target);
    const privateBackup = wide(backup);
    const status = (library.symbols.ReplaceFileW as (...args: unknown[]) => number)(
      ptr(replaced), ptr(replacement), ptr(privateBackup), 0, null, null,
    );
    if (status !== 0) return { ok: true };
    return { ok: false, nativeCode: (library.symbols.GetLastError as () => number)() };
  } catch (cause) {
    return { ok: false, cause };
  }
}

function failedReplacement(details: FailedReplacementDetails): PreservingReplaceError {
  return new PreservingReplaceError({
    operation: details.operation,
    sourcePath: details.sourcePath,
    targetPath: details.targetPath,
    backupPath: details.backupPath,
    platform: process.platform,
    ...(details.result.nativeCode === undefined ? {} : { nativeCode: details.result.nativeCode }),
    ...(details.result.cause === undefined ? {} : { cause: details.result.cause }),
  });
}

/**
 * Exchange a staged file with an existing canonical file without a missing-target window.
 * On Unix the displaced entry remains at `source`; Windows places it at `backup`.
 */
export function replaceFilePreservingTarget(source: string, target: string, backup: string): void {
  if (process.platform === "linux") {
    const result = unixExchange("renameat2")(source, target);
    if (result.ok) return;
    throw failedReplacement({ operation: "renameat2", sourcePath: source, targetPath: target, backupPath: backup, result });
  }
  if (process.platform === "darwin") {
    const result = unixExchange("renamex_np")(source, target);
    if (result.ok) return;
    throw failedReplacement({ operation: "renamex_np", sourcePath: source, targetPath: target, backupPath: backup, result });
  }
  if (process.platform === "win32") {
    const result = windowsExchange(source, target, backup);
    if (result.ok) return;
    throw failedReplacement({ operation: "ReplaceFileW", sourcePath: source, targetPath: target, backupPath: backup, result });
  }
  // No rename fallback is safe: it can make auth.json absent between operations.
  throw failedReplacement({ operation: "unsupported", sourcePath: source, targetPath: target, backupPath: backup, result: { ok: false } });
}

/** Restore a verified displaced entry while preserving the canonical target. */
export function restoreFilePreservingTarget(source: string, target: string, backup: string): void {
  replaceFilePreservingTarget(source, target, backup);
}
