/**
 * A Windows process handle on the health sentinel's parent, held for the sentinel's lifetime
 * (#6671).
 *
 * Windows reuses process ids quickly, so "is pid N still my parent" checked just before a kill
 * cannot bind the kill to the proxy: the proxy may exit and its id be handed to another process in
 * between. An open handle can: while any handle to a process object is open, its id is not
 * reused, and `TerminateProcess` acts on exactly that object. The handle is opened once at
 * startup and accepted only if the process it names was created before this sentinel, which a
 * replacement holding a recycled id cannot satisfy. libuv's kill-on-close Job would otherwise be
 * the only tie between the two processes, and libuv ignores a failed Job assignment.
 *
 * Bun exposes no API for a handle on a process it did not spawn, so this calls kernel32 through
 * `bun:ffi`. Nothing here runs on other platforms.
 */
import { dlopen, FFIType } from "bun:ffi";

const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;

export type ParentProcessHandle = {
  /** TerminateProcess on the held handle; true when Windows accepted the request. */
  terminate(exitCode: number): boolean;
  /** True once the process has exited (non-blocking). */
  exited(): boolean;
  close(): void;
};

export type ParentHandleResult =
  | { ok: true; handle: ParentProcessHandle }
  | { ok: false; reason: string };

// HANDLEs travel as u64 (bigint), never as `ptr`: a JS number cannot carry every pointer-width
// value, and a truncated handle would name a different object.
function kernel32() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols;
}

/** Open the parent and prove it is the process that created this one. */
export function openParentProcessHandle(parentPid: number): ParentHandleResult {
  if (process.platform !== "win32") return { ok: false, reason: "not Windows" };
  let k32: ReturnType<typeof kernel32>;
  try {
    k32 = kernel32();
  } catch {
    return { ok: false, reason: "kernel32 is unavailable" };
  }
  const handle = BigInt(k32.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, parentPid));
  if (handle === 0n) return { ok: false, reason: "the parent process cannot be opened" };
  const close = () => { try { k32.CloseHandle(handle); } catch { /* already closed */ } };
  const created = (target: bigint): bigint | null => {
    const times = new BigUint64Array(4);
    const ok = k32.GetProcessTimes(target, times.subarray(0, 1), times.subarray(1, 2), times.subarray(2, 3), times.subarray(3, 4));
    return ok ? times[0]! : null;
  };
  // This process cannot be reused while it runs, so opening it by id is exact; the pseudo-handle
  // from GetCurrentProcess is avoided because it is -1.
  const self = BigInt(k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process.pid));
  const parentCreated = created(handle);
  const selfCreated = self === 0n ? null : created(self);
  if (self !== 0n) { try { k32.CloseHandle(self); } catch { /* already closed */ } }
  if (parentCreated === null || selfCreated === null || parentCreated === 0n || parentCreated >= selfCreated) {
    close();
    return { ok: false, reason: "the process holding the parent id was not created before this sentinel" };
  }
  if (k32.WaitForSingleObject(handle, 0) !== WAIT_TIMEOUT) {
    close();
    return { ok: false, reason: "the parent process has already exited" };
  }
  return {
    ok: true,
    handle: {
      terminate: exitCode => k32.TerminateProcess(handle, exitCode) !== 0,
      exited: () => k32.WaitForSingleObject(handle, 0) === WAIT_OBJECT_0,
      close,
    },
  };
}
