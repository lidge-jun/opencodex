/**
 * In-process Windows process primitives for the checked service stop (#7771).
 *
 * Four questions the checked stop asks of the kernel and the SCM:
 *
 * - when was this process created (GetProcessTimes), so a PID that was reused between
 *   bind and terminate is told apart from the process that was bound;
 * - terminate exactly the bound process: verify its creation time and token user on
 *   the same handle passed to TerminateProcess, so PID reuse cannot redirect the stop;
 * - has a bound process exited (WaitForSingleObject with a zero timeout on a handle
 *   opened at bind time), so the wait needs neither an enumeration nor PowerShell;
 * - which process hosts the Task Scheduler service (QueryServiceStatusEx on "Schedule"),
 *   the parent the binding rule accepts for a launcher the scheduler started.
 *
 * Loading follows src/config/windows-process-command-line.ts: bun:ffi is required lazily
 * (every importer loads this module on every platform), the DLLs load from the
 * GetSystemDirectoryW path so the search order cannot substitute them, a failed load is
 * cached as null, and every handle is closed in a finally. Windows ARM64 and every other
 * platform get null here. A test that simulates a platform never reaches the real kernel.
 */
import { join } from "node:path";

import { resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";

const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
const SC_MANAGER_CONNECT = 0x0001;
const SERVICE_QUERY_STATUS = 0x0004;
const SC_STATUS_PROCESS_INFO = 0;
const SERVICE_RUNNING = 4;
/** SERVICE_STATUS_PROCESS is nine DWORDs; dwCurrentState is the second, dwProcessId the eighth. */
const SERVICE_STATUS_PROCESS_BYTES = 36;
const SERVICE_STATUS_STATE_OFFSET = 4;
const SERVICE_STATUS_PID_OFFSET = 28;
/** 100 ns intervals between 0001-01-01 (.NET) and 1601-01-01 (FILETIME). */
const FILETIME_DOTNET_EPOCH = 504_911_232_000_000_000n;
/** 100 ns intervals between 1601-01-01 and 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const TERMINATE_EXIT_CODE = 1;

/** Result of one checked terminate. Only "terminated" means this call ended the process. */
export type WindowsTerminateStatus = "terminated" | "gone" | "reused" | "denied" | "unavailable" | "owner-unverified";

export interface WindowsTerminateResult {
  status: WindowsTerminateStatus;
  /**
   * True when the primitive itself observed the process exit after terminating it.
   * The native primitive leaves exit confirmation to the bind-time watch.
   */
  exited?: boolean;
}

/** A bind-time handle the checked stop polls instead of enumerating processes again. */
export type WindowsProcessWatch =
  | { status: "open"; exited(): boolean | null; close(): void }
  | { status: "gone" | "reused" | "denied" | "unavailable" };

export interface WindowsProcessNativeApi {
  /** Creation time in epoch ms (FILETIME truncated to ms), or null when unreadable. */
  creationTime(pid: number): number | null;
  /** Same-user, live creation identity in CIM-compatible .NET ticks, read without a subprocess. */
  sameUserStartTicks?(pid: number): bigint | null;
  terminate(pid: number, boundStartTime: number | bigint): WindowsTerminateResult;
  openWatch(pid: number, boundStartTime: number): WindowsProcessWatch;
  /** PID of the running Task Scheduler service host, or null when it cannot be read. */
  scheduleServicePid(): number | null;
}

/** FILETIME (100 ns since 1601) to epoch ms, truncated. Zero or pre-1970 is unreadable. */
export function fileTimeToEpochMs(fileTime: bigint): number | null {
  if (fileTime <= FILETIME_UNIX_EPOCH) return null;
  const ms = (fileTime - FILETIME_UNIX_EPOCH) / 10_000n;
  return ms > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(ms);
}

/** Keep owner, lifetime and creation evidence on one process handle; never cache a PID proof. */
export function readSameUserWindowsStart(pid: number, io: {
  open: (pid: number) => number | bigint;
  close: (handle: number | bigint) => void;
  fileTime: (handle: number | bigint) => bigint | null;
  exited: (handle: number | bigint) => boolean | null;
  ownerSid: (handle: number | bigint) => string;
  currentSid: () => string;
}): bigint | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
  const handle = io.open(pid);
  if (!handle) return null;
  try {
    const created = io.fileTime(handle);
    if (created === null || created <= FILETIME_UNIX_EPOCH || io.exited(handle) !== false) return null;
    const owner = io.ownerSid(handle);
    if (!/^S-1-\d+(?:-\d+)+$/.test(owner) || owner !== io.currentSid() || io.exited(handle) !== false) return null;
    // Preserve the creation identity already stored by the CIM-based stop owner protocol.
    return (created + FILETIME_DOTNET_EPOCH) / 10n * 10n;
  } catch { return null; }
  finally { io.close(handle); }
}

/** Decode SERVICE_STATUS_PROCESS: the PID only while the service reports RUNNING. */
export function decodeServiceStatusProcess(buffer: Uint8Array): number | null {
  if (buffer.byteLength < SERVICE_STATUS_PROCESS_BYTES) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(SERVICE_STATUS_STATE_OFFSET, true) !== SERVICE_RUNNING) return null;
  const pid = view.getUint32(SERVICE_STATUS_PID_OFFSET, true);
  return pid > 0 ? pid : null;
}

let nativeApi: WindowsProcessNativeApi | null | undefined;
let nativeApiForTests: WindowsProcessNativeApi | null | undefined;
let platformForTests: NodeJS.Platform | null = null;

/** Replace the native API in tests; null forces "unavailable", undefined restores the real one. */
export function setWindowsProcessNativeForTests(next: WindowsProcessNativeApi | null | undefined): void {
  nativeApiForTests = next;
}

/**
 * Simulate a platform in tests. While set, the real kernel is never called: the native
 * API reads as unavailable unless a test API is installed as well.
 */
export function setWindowsProcessPlatformForTests(next: NodeJS.Platform | null): void {
  platformForTests = next;
}

/** The platform the Windows stop primitives act for (the simulated one in tests). */
export function windowsProcessPlatform(): NodeJS.Platform {
  return platformForTests ?? process.platform;
}

/** True while a test simulates the platform; nothing may then reach the real machine. */
export function windowsProcessPlatformSimulated(): boolean {
  return platformForTests !== null;
}

type Handle = number | bigint;

function loadNativeApi(): WindowsProcessNativeApi | null {
  if (nativeApi !== undefined) return nativeApi;
  nativeApi = null;
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  let ffi: typeof import("bun:ffi");
  let readWindowsCurrentSid: typeof import("../codex/windows-current-sid").readWindowsCurrentSid;
  let kernel32;
  let advapi32;
  try {
    ffi = require("bun:ffi") as typeof import("bun:ffi");
    ({ readWindowsCurrentSid } = require("../codex/windows-current-sid") as typeof import("../codex/windows-current-sid"));
    const systemDirectory = resolveTrustedWindowsSystemDirectory();
    kernel32 = ffi.dlopen(join(systemDirectory, "kernel32.dll"), {
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
      CloseHandle: { args: ["u64"], returns: "i32" },
      GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
      TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
      WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
      GetLastError: { args: [], returns: "u32" },
      GetCurrentProcess: { args: [], returns: "u64" },
      LocalFree: { args: ["ptr"], returns: "ptr" },
    }).symbols;
    advapi32 = ffi.dlopen(join(systemDirectory, "advapi32.dll"), {
      OpenSCManagerW: { args: ["ptr", "ptr", "u32"], returns: "u64" },
      OpenServiceW: { args: ["u64", "ptr", "u32"], returns: "u64" },
      QueryServiceStatusEx: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
      CloseServiceHandle: { args: ["u64"], returns: "i32" },
      OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
      GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
      ConvertSidToStringSidW: { args: ["ptr", "ptr"], returns: "i32" },
    }).symbols;
  } catch {
    return null;
  }
  const k = kernel32;
  const a = advapi32;
  const { ptr, read } = ffi;

  const handleUserSid = (handle: Handle): string => readWindowsCurrentSid({
    openProcessToken: (access, token) => a.OpenProcessToken(handle, access, ptr(token)),
    getTokenInformation: (token, kind, buffer, length) =>
      a.GetTokenInformation(token, kind, ptr(buffer), buffer.byteLength, ptr(length)),
    convertSidToStringSid: (sid, output) => a.ConvertSidToStringSidW(sid as import("bun:ffi").Pointer, ptr(output)),
    readCodeUnit: (address, offset) => read.u16(address as import("bun:ffi").Pointer, offset),
    localFree: address => { k.LocalFree(address as import("bun:ffi").Pointer); },
    closeHandle: token => { k.CloseHandle(token); },
  });

  const handleFileTime = (handle: Handle): bigint | null => {
    const times = new BigUint64Array(4);
    const base = ptr(times);
    const ok = k.GetProcessTimes(handle, base, base + 8, base + 16, base + 24);
    return ok && times[0]! > FILETIME_UNIX_EPOCH ? times[0]! : null;
  };
  const handleCreationTime = (handle: Handle): number | null => {
    const ticks = handleFileTime(handle);
    return ticks === null ? null : fileTimeToEpochMs(ticks);
  };
  // true = exited, false = running, null = unreadable.
  const handleExited = (handle: Handle): boolean | null => {
    const wait = Number(k.WaitForSingleObject(handle, 0)) >>> 0;
    if (wait === WAIT_OBJECT_0) return true;
    if (wait === WAIT_TIMEOUT) return false;
    return null;
  };
  // GetLastError is read immediately after the failed call. If the runtime ever clobbers
  // it, the answer degrades to "unavailable", which the checked stop reports as unknown.
  const openFailure = (): "gone" | "denied" | "unavailable" => {
    const error = Number(k.GetLastError()) >>> 0;
    if (error === ERROR_INVALID_PARAMETER) return "gone";
    if (error === ERROR_ACCESS_DENIED) return "denied";
    return "unavailable";
  };

  nativeApi = {
    creationTime(pid) {
      const handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!handle) return null;
      try {
        return handleCreationTime(handle);
      } finally {
        k.CloseHandle(handle);
      }
    },
    sameUserStartTicks(pid) {
      return readSameUserWindowsStart(pid, {
        open: target => k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, target),
        close: handle => { k.CloseHandle(handle); },
        fileTime: handleFileTime,
        exited: handleExited,
        ownerSid: handleUserSid,
        currentSid: () => handleUserSid(k.GetCurrentProcess()),
      });
    },
    terminate(pid, boundStartTime) {
      const handle = k.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
      if (!handle) return { status: openFailure() };
      try {
        const fileTime = handleFileTime(handle);
        if (fileTime === null) return { status: "unavailable" };
        // Stop-owner identities retain .NET ticks at microsecond precision.
        const created = typeof boundStartTime === "number" ? fileTimeToEpochMs(fileTime)
          : (fileTime + FILETIME_DOTNET_EPOCH) / 10n * 10n;
        if (created !== boundStartTime) return { status: "reused" };
        const before = handleExited(handle);
        if (before === true) return { status: "gone" };
        if (before === null) return { status: "unavailable" };
        try {
          if (handleUserSid(handle) !== handleUserSid(k.GetCurrentProcess())) return { status: "owner-unverified" };
        } catch {
          return { status: handleExited(handle) === true ? "gone" : "owner-unverified" };
        }
        if (k.TerminateProcess(handle, TERMINATE_EXIT_CODE)) return { status: "terminated" };
        const error = Number(k.GetLastError()) >>> 0;
        // TerminateProcess on a process that exited meanwhile also fails with access denied.
        if (handleExited(handle) === true) return { status: "gone" };
        return { status: error === ERROR_ACCESS_DENIED ? "denied" : "unavailable" };
      } finally {
        k.CloseHandle(handle);
      }
    },
    openWatch(pid, boundStartTime) {
      const handle = k.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!handle) return { status: openFailure() };
      let keep = false;
      try {
        const created = handleCreationTime(handle);
        if (created === null) return { status: "unavailable" };
        if (created !== boundStartTime) return { status: "reused" };
        keep = true;
        let closed = false;
        return {
          status: "open",
          exited: () => (closed ? null : handleExited(handle)),
          close: () => {
            if (closed) return;
            closed = true;
            k.CloseHandle(handle);
          },
        };
      } finally {
        if (!keep) k.CloseHandle(handle);
      }
    },
    scheduleServicePid() {
      const manager = a.OpenSCManagerW(null, null, SC_MANAGER_CONNECT);
      if (!manager) return null;
      try {
        const name = Buffer.from("Schedule\0", "utf16le");
        const service = a.OpenServiceW(manager, ptr(name), SERVICE_QUERY_STATUS);
        if (!service) return null;
        try {
          const buffer = new Uint8Array(SERVICE_STATUS_PROCESS_BYTES);
          const needed = new Uint32Array(1);
          const ok = a.QueryServiceStatusEx(
            service, SC_STATUS_PROCESS_INFO, ptr(buffer), SERVICE_STATUS_PROCESS_BYTES, ptr(needed),
          );
          return ok ? decodeServiceStatusProcess(buffer) : null;
        } finally {
          a.CloseServiceHandle(service);
        }
      } finally {
        a.CloseServiceHandle(manager);
      }
    },
  };
  return nativeApi;
}

/**
 * The native API, or null where it cannot run: non-Windows, Windows ARM64, a failed DLL
 * load, or a test that simulates a platform without installing a test API.
 */
export function windowsProcessNative(): WindowsProcessNativeApi | null {
  if (nativeApiForTests !== undefined) return nativeApiForTests;
  if (platformForTests !== null) return null;
  try {
    return loadNativeApi();
  } catch {
    return null;
  }
}
