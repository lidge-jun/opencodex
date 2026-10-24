/**
 * The effective process token's SID, read in-process on Windows x64.
 *
 * The PowerShell helper this replaces is correct but slow to start: a cold
 * `powershell.exe` on a loaded runner spent more than the 30s lookup budget
 * before evaluating one constant of the process token, and `ocx service install`
 * refused (#7544). Widening that budget again would only move the line. The SID
 * itself costs three advapi32 calls, so the x64 path asks the OS directly and the
 * helper keeps running only where `bun:ffi` cannot (Windows ARM64).
 *
 * The answer is the PROCESS token's user. `WindowsIdentity.GetCurrent()` would
 * prefer a thread impersonation token, but nothing in this process impersonates,
 * so the two agree; the process token is also what Task Scheduler and the ACL
 * code grant to.
 *
 * Fail-closed is preserved: when the native API is available and fails, the
 * lookup throws and the caller refuses. It never falls back to the helper, whose
 * environment the native path exists to avoid depending on.
 */
import { dlopen, ptr, read, type Pointer } from "bun:ffi";
import { win32 } from "node:path";
import { resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";

const TOKEN_QUERY = 0x0008;
const TOKEN_USER_INFORMATION_CLASS = 1;
/**
 * TOKEN_USER is one SID_AND_ATTRIBUTES (an 8-byte SID pointer and a 4-byte
 * attribute word, padded to 16) followed by the SID it points at. A SID is at
 * most SECURITY_MAX_SID_SIZE (68) bytes, so 256 bytes always suffices and a
 * larger reported length is treated as a malformed answer.
 */
const TOKEN_USER_BUFFER_BYTES = 256;
const TOKEN_USER_HEADER_BYTES = 16;
/** "S-1-" plus at most 15 sub-authorities of up to 10 digits each, with room to spare. */
const MAX_SID_STRING_CODE_UNITS = 256;
const SID_PATTERN = /^S-1-(?:\d+-)+\d+$/i;

export interface WindowsTokenSidApi {
  /** OpenProcessToken(GetCurrentProcess(), access, &token). Non-zero BOOL is success. */
  openProcessToken(desiredAccess: number, token: BigUint64Array): number;
  /** GetTokenInformation(token, class, buffer, buffer.length, &returnLength). */
  getTokenInformation(
    token: bigint,
    informationClass: number,
    buffer: Uint8Array,
    returnLength: Uint32Array,
  ): number;
  /** ConvertSidToStringSidW(sid, &string). The string is LocalAlloc'd on success. */
  convertSidToStringSid(sidAddress: number, output: BigUint64Array): number;
  readCodeUnit(address: number, byteOffset: number): number;
  localFree(address: number): void;
  closeHandle(token: bigint): void;
}

function lookupError(detail: string): Error {
  return new Error(`Windows effective-account token lookup ${detail}.`);
}

function readSidString(api: WindowsTokenSidApi, address: number): string {
  const units: number[] = [];
  for (let index = 0; index < MAX_SID_STRING_CODE_UNITS; index += 1) {
    const unit = api.readCodeUnit(address, index * 2);
    if (unit === 0) return String.fromCharCode(...units);
    units.push(unit);
  }
  throw lookupError("returned an unterminated SID");
}

/** Same token user the PowerShell helper reports, without starting a process. */
export function readWindowsCurrentSid(api: WindowsTokenSidApi): string {
  const tokenOutput = new BigUint64Array(1);
  if (api.openProcessToken(TOKEN_QUERY, tokenOutput) === 0 || tokenOutput[0] === 0n) {
    throw lookupError("could not open the process token");
  }
  const token = tokenOutput[0]!;
  let stringAddress = 0;
  try {
    // Keep `buffer` referenced until the conversion returns: the SID pointer
    // inside it points back into this same allocation.
    const buffer = new Uint8Array(TOKEN_USER_BUFFER_BYTES);
    const returnLength = new Uint32Array(1);
    if (api.getTokenInformation(token, TOKEN_USER_INFORMATION_CLASS, buffer, returnLength) === 0) {
      throw lookupError("could not read the token user");
    }
    const length = returnLength[0]!;
    if (length <= TOKEN_USER_HEADER_BYTES || length > buffer.byteLength) {
      throw lookupError("returned a malformed token user");
    }
    const sidAddress = Number(
      new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getBigUint64(0, true),
    );
    if (!Number.isSafeInteger(sidAddress) || sidAddress <= 0) {
      throw lookupError("returned a null SID");
    }
    const stringOutput = new BigUint64Array(1);
    const converted = api.convertSidToStringSid(sidAddress, stringOutput);
    const candidate = Number(stringOutput[0]);
    if (converted === 0 || !Number.isSafeInteger(candidate) || candidate <= 0) {
      throw lookupError("could not format the SID");
    }
    stringAddress = candidate;
    const sid = readSidString(api, stringAddress);
    if (!SID_PATTERN.test(sid)) throw lookupError("returned an invalid SID");
    return sid.toUpperCase();
  } finally {
    if (stringAddress > 0) api.localFree(stringAddress);
    api.closeHandle(token);
  }
}

let nativeLookup: (() => string) | null | undefined;

function loadNativeLookup(): (() => string) | null {
  if (nativeLookup !== undefined) return nativeLookup;
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  try {
    const systemDirectory = resolveTrustedWindowsSystemDirectory();
    const advapi = dlopen(win32.join(systemDirectory, "advapi32.dll"), {
      OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
      GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
      ConvertSidToStringSidW: { args: ["ptr", "ptr"], returns: "i32" },
    });
    let kernel;
    try {
      kernel = dlopen(win32.join(systemDirectory, "kernel32.dll"), {
        GetCurrentProcess: { args: [], returns: "u64" },
        CloseHandle: { args: ["u64"], returns: "i32" },
        LocalFree: { args: ["ptr"], returns: "ptr" },
      });
    } catch (error) {
      advapi.close();
      throw error;
    }
    const api: WindowsTokenSidApi = {
      openProcessToken: (access, token) => advapi.symbols.OpenProcessToken(
        kernel.symbols.GetCurrentProcess(), access, ptr(token),
      ),
      getTokenInformation: (token, informationClass, buffer, returnLength) =>
        advapi.symbols.GetTokenInformation(
          token, informationClass, ptr(buffer), buffer.byteLength, ptr(returnLength),
        ),
      convertSidToStringSid: (sidAddress, output) => advapi.symbols.ConvertSidToStringSidW(
        sidAddress as Pointer, ptr(output),
      ),
      readCodeUnit: (address, offset) => read.u16(address as Pointer, offset),
      localFree: address => { kernel.symbols.LocalFree(address as Pointer); },
      closeHandle: token => { kernel.symbols.CloseHandle(token); },
    };
    nativeLookup = () => readWindowsCurrentSid(api);
  } catch {
    nativeLookup = null;
  }
  return nativeLookup;
}

/** Unsupported FFI keeps the bounded trusted helper; an OS API failure still refuses. */
export function resolveWindowsCurrentSid(
  powershellLookup: () => string,
  lookup: (() => string) | null = loadNativeLookup(),
): string {
  return lookup ? lookup() : powershellLookup();
}
