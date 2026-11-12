import { join } from "node:path";
import { resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";

// NtQueryInformationProcess(ProcessCommandLineInformation) fills the buffer with a
// UNICODE_STRING header (x64: USHORT Length, USHORT MaximumLength, four bytes of padding,
// PWSTR Buffer) whose Buffer points at the UTF-16 text later in the same allocation.
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_COMMAND_LINE_INFORMATION = 60;
const UNICODE_STRING_BYTES = 16;
// A Windows command line is at most 32767 UTF-16 units, so this always fits on the retry.
const MAX_BUFFER_BYTES = UNICODE_STRING_BYTES + 65_536;
const INITIAL_BUFFER_BYTES = 4_096;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;

type NativeReader = (pid: number) => string | undefined;
let nativeReader: NativeReader | null | undefined;

/**
 * Decode a ProcessCommandLineInformation result. `bufferAddress` is the native address of
 * `buffer`; a text pointer or length that leaves the buffer is refused rather than trusted.
 */
export function decodeProcessCommandLineInformation(
  buffer: Uint8Array,
  bufferAddress: bigint,
): string | undefined {
  if (buffer.byteLength < UNICODE_STRING_BYTES) return undefined;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const length = view.getUint16(0, true);
  if (length === 0 || length % 2 !== 0) return undefined;
  const offset = view.getBigUint64(8, true) - bufferAddress;
  if (offset < BigInt(UNICODE_STRING_BYTES) || offset + BigInt(length) > BigInt(buffer.byteLength)) {
    return undefined;
  }
  const start = Number(offset);
  const value = new TextDecoder("utf-16le").decode(buffer.subarray(start, start + length)).trim();
  return value || undefined;
}

/**
 * In-process read of another process's command line. Windows PowerShell's
 * Get-CimInstance Win32_Process takes seconds on a busy machine and WMIC is gone from
 * current Windows images, so the spawned probes could not answer inside their bound and
 * a live, unchanged runtime read as unverified. The DLLs load from the GetSystemDirectoryW
 * path so the search order cannot substitute them. Returns null where Bun's FFI cannot run
 * (non-Windows, Windows ARM64), leaving the spawned probes as the only path. bun:ffi is
 * required lazily because every process-state importer loads this module on every platform.
 */
function loadNativeReader(): NativeReader | null {
  if (nativeReader !== undefined) return nativeReader;
  nativeReader = null;
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  let ptr: typeof import("bun:ffi").ptr;
  let kernel32;
  let ntdll;
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { dlopen } = ffi;
    ptr = ffi.ptr;
    const systemDirectory = resolveTrustedWindowsSystemDirectory();
    kernel32 = dlopen(join(systemDirectory, "kernel32.dll"), {
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
      CloseHandle: { args: ["u64"], returns: "i32" },
    }).symbols;
    ntdll = dlopen(join(systemDirectory, "ntdll.dll"), {
      NtQueryInformationProcess: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    }).symbols;
  } catch {
    return null;
  }
  const { OpenProcess, CloseHandle } = kernel32;
  const { NtQueryInformationProcess } = ntdll;
  nativeReader = pid => {
    const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!handle) return undefined;
    try {
      let size = INITIAL_BUFFER_BYTES;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const buffer = new Uint8Array(size);
        const returned = new Uint32Array(1);
        const status = NtQueryInformationProcess(
          handle, PROCESS_COMMAND_LINE_INFORMATION, ptr(buffer), size, ptr(returned),
        ) >>> 0;
        if (status === 0) return decodeProcessCommandLineInformation(buffer, BigInt(ptr(buffer)));
        if (status !== STATUS_INFO_LENGTH_MISMATCH && status !== STATUS_BUFFER_OVERFLOW
          && status !== STATUS_BUFFER_TOO_SMALL) return undefined;
        const needed = returned[0]!;
        if (needed <= size || needed > MAX_BUFFER_BYTES) return undefined;
        size = needed;
      }
      return undefined;
    } finally {
      CloseHandle(handle);
    }
  };
  return nativeReader;
}

/** The command line of `pid`, or undefined whenever the native read cannot answer. */
export function readWindowsProcessCommandLineNative(pid: number): string | undefined {
  try {
    return loadNativeReader()?.(pid);
  } catch {
    return undefined;
  }
}
