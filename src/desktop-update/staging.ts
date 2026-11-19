/**
 * Where `ocx update --desktop` stages the verified MSI and the installer log (#8246).
 *
 * msiexec opens the package by path after this process has verified it. When the command runs
 * elevated, a directory in the user's TEMP would let any non-elevated process of the same user
 * swap the package, plant a link at the log path, or move the directory away between that
 * verification and msiexec opening the file, and the elevated installer would act on the
 * substitute. So an elevated run stages under the Windows directory's Temp, in a fresh directory
 * created with a protected security descriptor that lets only SYSTEM and Administrators write.
 * Non-elevated processes may create entries in that Temp but cannot delete or rename another
 * account's, and cannot write inside this one. A run that is not elevated keeps its own TEMP: its
 * msiexec has no more rights than a process that could change the file there.
 */
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import { trustedWindowsSystemDirectory } from "../service/desktop-supervision.mjs";

/**
 * Protected (no inherited entries); full access for SYSTEM and Administrators, inherited by the
 * files inside; the owner's implicit right to rewrite the descriptor reduced to reading it.
 */
export const PROTECTED_STAGING_SDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;RC;;;OW)";
export const STAGING_PREFIX = "ocx-desktop-update-";

export interface StagingDirectoryDeps {
  /** Whether this process runs with an elevated token; a throw counts as elevated. */
  elevated(): boolean;
  windowsDirectory(): string;
  /** Create a new directory with this descriptor; throws when the path already exists. */
  createProtectedDirectory(path: string, sddl: string): void;
  createPrivateTempDirectory(): string;
  randomSuffix(): string;
}

export function createStagingDirectory(deps: StagingDirectoryDeps): string {
  let elevated = true;
  try { elevated = deps.elevated(); } catch { /* unknown: stage as if elevated */ }
  if (!elevated) return deps.createPrivateTempDirectory();
  const path = win32.join(deps.windowsDirectory(), "Temp", `${STAGING_PREFIX}${deps.randomSuffix()}`);
  deps.createProtectedDirectory(path, PROTECTED_STAGING_SDDL);
  return path;
}

const TOKEN_QUERY = 0x0008;
const TOKEN_ELEVATION_CLASS = 20;
const SDDL_REVISION_1 = 1;

function loadSystemLibraries<A extends Parameters<typeof dlopen>[1], K extends Parameters<typeof dlopen>[1]>(advapiSymbols: A, kernelSymbols: K) {
  const directory = trustedWindowsSystemDirectory();
  const advapi = dlopen(win32.join(directory, "advapi32.dll"), advapiSymbols);
  try {
    const kernel = dlopen(win32.join(directory, "kernel32.dll"), kernelSymbols);
    return { advapi, kernel, close: () => { kernel.close(); advapi.close(); } };
  } catch (error) {
    advapi.close();
    throw error;
  }
}

function processIsElevated(): boolean {
  const lib = loadSystemLibraries({
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
  }, {
    GetCurrentProcess: { args: [], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  try {
    const token = new BigUint64Array(1);
    if (!lib.advapi.symbols.OpenProcessToken(lib.kernel.symbols.GetCurrentProcess(), TOKEN_QUERY, ptr(token))) throw new Error("OpenProcessToken failed");
    try {
      const elevation = new Uint32Array(1);
      const length = new Uint32Array(1);
      if (!lib.advapi.symbols.GetTokenInformation(token[0]!, TOKEN_ELEVATION_CLASS, ptr(elevation), 4, ptr(length))) throw new Error("GetTokenInformation failed");
      return elevation[0] !== 0;
    } finally { lib.kernel.symbols.CloseHandle(token[0]!); }
  } finally { lib.close(); }
}

function createProtectedDirectoryWin32(path: string, sddl: string): void {
  const lib = loadSystemLibraries({
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
  }, {
    CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
    LocalFree: { args: ["u64"], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
  });
  try {
    const descriptor = new BigUint64Array(1);
    const text = Buffer.from(`${sddl}\0`, "utf16le");
    if (!lib.advapi.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(text), SDDL_REVISION_1, ptr(descriptor), null)) {
      throw new Error(`the staging security descriptor was rejected (Windows error ${lib.kernel.symbols.GetLastError()})`);
    }
    try {
      // SECURITY_ATTRIBUTES on x64: DWORD nLength, (pad), LPVOID lpSecurityDescriptor, BOOL bInheritHandle, (pad).
      const attributes = Buffer.alloc(24);
      attributes.writeUInt32LE(24, 0);
      attributes.writeBigUInt64LE(descriptor[0]!, 8);
      attributes.writeInt32LE(0, 16);
      const wide = Buffer.from(`${path}\0`, "utf16le");
      if (!lib.kernel.symbols.CreateDirectoryW(ptr(wide), ptr(attributes))) {
        throw new Error(`could not create the protected staging directory ${path} (Windows error ${lib.kernel.symbols.GetLastError()})`);
      }
    } finally { lib.kernel.symbols.LocalFree(descriptor[0]!); }
  } finally { lib.close(); }
}

export const windowsStagingDeps: StagingDirectoryDeps = {
  elevated: processIsElevated,
  windowsDirectory: () => win32.dirname(trustedWindowsSystemDirectory()),
  createProtectedDirectory: createProtectedDirectoryWin32,
  createPrivateTempDirectory: () => mkdtempSync(join(tmpdir(), STAGING_PREFIX)),
  randomSuffix: () => randomBytes(16).toString("hex"),
};

