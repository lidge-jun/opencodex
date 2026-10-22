import { execFile } from "node:child_process";
import { join } from "node:path";
import { dlopen, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsSystemDirectory } from "../../lib/windows-elevation";

const MAX_INPUT = 65_536;
const MAX_OUTPUT = 131_072;
const PURPOSE = "opencodex/codex-desktop-compatibility/authority/v1";
const ENTROPY = new TextEncoder().encode(PURPOSE);
// Only the PowerShell fallback is bounded by a clock. A cold Windows PowerShell that must also load
// System.Security has been measured past 10s on a loaded machine (Windows CI run 38591626343).
const DPAPI_TIMEOUT_MS = 20_000;
// Cmdlet-free on purpose. The first cmdlet a PowerShell session runs (Add-Type, ConvertFrom-Json)
// sends it through command discovery and module auto-loading, which without a module-analysis cache
// for the profile scans the modules on PSModulePath. The test runner gives every run a fresh profile
// and CI images carry large module sets, so that scan, not DPAPI, is what cold runs waited on.
// Assembly loading, string splitting and base64 are plain .NET calls outside command discovery.
// The request is "<operation>\n<base64 data>" on stdin.
const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')",
  "$r=[Console]::In.ReadToEnd().Split([char]10)",
  "if($r.Length -ne 2){throw 'Invalid request'}",
  "$data=[Convert]::FromBase64String($r[1])",
  `if($data.Length -eq 0 -or $data.Length -gt ${MAX_INPUT}){throw 'Invalid data size'}`,
  `$entropy=[Text.Encoding]::UTF8.GetBytes('${PURPOSE}')`,
  "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
  "if($r[0] -ceq 'protect'){",
  " $out=[Security.Cryptography.ProtectedData]::Protect($data,$entropy,$scope)",
  "}elseif($r[0] -ceq 'unprotect'){",
  " $out=[Security.Cryptography.ProtectedData]::Unprotect($data,$entropy,$scope)",
  "}else{throw 'Invalid operation'}",
  "[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("\n");

type Operation = "protect" | "unprotect";

export interface AuthorityKeyProtection {
  protect(cleartext: Uint8Array): Promise<Uint8Array>;
  unprotect(ciphertext: Uint8Array): Promise<Uint8Array>;
}

// CRYPTPROTECT_UI_FORBIDDEN and no CRYPTPROTECT_LOCAL_MACHINE: the CurrentUser scope that
// ProtectedData.Protect(..., CurrentUser) requests, so blobs written by either path read in the other.
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
// DATA_BLOB on x64: DWORD cbData, four bytes of padding, BYTE* pbData.
const DATA_BLOB_BYTES = 16;
const DPAPI_SIGNATURE = { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" } as const;

type NativeDpapi = (operation: Operation, data: Uint8Array) => Uint8Array;
let nativeDpapi: NativeDpapi | undefined;

function dataBlob(bytes: Uint8Array): Buffer {
  const blob = Buffer.alloc(DATA_BLOB_BYTES);
  blob.writeUInt32LE(bytes.byteLength, 0);
  blob.writeBigUInt64LE(BigInt(ptr(bytes)), 8);
  return blob;
}

/**
 * In-process CryptProtectData/CryptUnprotectData. Spawning Windows PowerShell for every call cost
 * seconds of cold start (past 20s on a loaded CI runner) for a call that takes milliseconds.
 * crypt32 is loaded from the GetSystemDirectoryW path so the DLL search order cannot substitute it.
 * Returns null where Bun's FFI is unavailable (Windows ARM64), leaving the PowerShell helper.
 */
function loadNativeDpapi(): NativeDpapi | null {
  if (nativeDpapi) return nativeDpapi;
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  let crypt32;
  let kernel32;
  try {
    const systemDirectory = resolveTrustedWindowsSystemDirectory();
    crypt32 = dlopen(join(systemDirectory, "crypt32.dll"), {
      CryptProtectData: DPAPI_SIGNATURE,
      CryptUnprotectData: DPAPI_SIGNATURE,
    }).symbols;
    kernel32 = dlopen(join(systemDirectory, "kernel32.dll"), {
      LocalFree: { args: ["ptr"], returns: "ptr" },
      // Wipes by address, so clearing never depends on a JS view having been created.
      RtlZeroMemory: { args: ["ptr", "u64"], returns: "void" },
    }).symbols;
  } catch {
    return null;
  }
  const { CryptProtectData, CryptUnprotectData } = crypt32;
  const { LocalFree, RtlZeroMemory } = kernel32;
  nativeDpapi = (operation, data) => {
    const input = dataBlob(data);
    const entropy = dataBlob(ENTROPY);
    const output = Buffer.alloc(DATA_BLOB_BYTES);
    const call = operation === "protect" ? CryptProtectData : CryptUnprotectData;
    // Description, reserved and prompt are null; Windows reports no detail worth propagating.
    if (!call(ptr(input), null, ptr(entropy), null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(output))) {
      throw new Error("desktop_compatibility_key_protection_failed");
    }
    const length = output.readUInt32LE(0);
    const address = Number(output.readBigUInt64LE(8)) as Pointer;
    // Every step after a successful call sits inside try so the native buffer is always
    // released, even if creating the view over it throws.
    let view: Uint8Array | null = null;
    try {
      view = length > 0 ? new Uint8Array(toArrayBuffer(address, 0, length)) : null;
      if (length === 0 || length > MAX_INPUT) throw new Error("desktop_compatibility_key_size");
      return Uint8Array.from(view!);
    } finally {
      // The unprotected buffer is cleartext key material; wipe it natively before LocalFree
      // releases it, including when the size check or view creation fails. LocalFree still
      // runs if wiping throws.
      try {
        if (operation === "unprotect" && length > 0) RtlZeroMemory(address, length);
      } finally {
        LocalFree(address);
      }
    }
  };
  return nativeDpapi;
}

/** The payload travels on stdin, never in process arguments, environment or logs. */
function runPowerShellDpapi(operation: Operation, data: Uint8Array, timeoutMs = DPAPI_TIMEOUT_MS): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = execFile(resolveTrustedWindowsPowerShellExe(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
      timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: "utf8",
    }, (error, stdout) => {
      // Do not include PowerShell stderr, command output or the input in a propagated error.
      if (error || !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout.trim())) {
        reject(new Error("desktop_compatibility_key_protection_failed")); return;
      }
      const bytes = Buffer.from(stdout.trim(), "base64");
      if (bytes.length === 0 || bytes.length > MAX_INPUT) {
        reject(new Error("desktop_compatibility_key_size")); return;
      }
      resolve(bytes);
    });
    child.stdin?.on("error", () => { /* execFile's completion reports the failed child. */ });
    child.stdin?.end(`${operation}\n${Buffer.from(data).toString("base64")}`);
  });
}

function validated(data: Uint8Array): Uint8Array {
  if (process.platform !== "win32") throw new Error("desktop_compatibility_windows_required");
  if (data.byteLength === 0 || data.byteLength > MAX_INPUT) throw new Error("desktop_compatibility_key_size");
  return data;
}

async function runDpapi(operation: Operation, data: Uint8Array): Promise<Uint8Array> {
  validated(data);
  const native = loadNativeDpapi();
  return native ? native(operation, data) : runPowerShellDpapi(operation, data);
}

/** CurrentUser protects against other OS identities, not other processes of the same user. */
export const windowsAuthorityKeyProtection: AuthorityKeyProtection = {
  protect: bytes => runDpapi("protect", bytes),
  unprotect: bytes => runDpapi("unprotect", bytes),
};

/**
 * Test-only: the PowerShell helper (Windows ARM64, and every key stored before the native path).
 * The caller owns the bound because a compatibility check must not depend on cold-start latency.
 */
export function powerShellAuthorityKeyProtectionForTests(timeoutMs: number): AuthorityKeyProtection {
  return {
    protect: async bytes => runPowerShellDpapi("protect", validated(bytes), timeoutMs),
    unprotect: async bytes => runPowerShellDpapi("unprotect", validated(bytes), timeoutMs),
  };
}

/** Test-only: whether this process protects keys in-process rather than through PowerShell. */
export function usesNativeDpapiForTests(): boolean {
  return process.platform === "win32" && loadNativeDpapi() !== null;
}

/** Test-only: the PowerShell helper's script, so its cmdlet-free contract can be checked anywhere. */
export function powerShellDpapiScriptForTests(): string {
  return SCRIPT;
}
