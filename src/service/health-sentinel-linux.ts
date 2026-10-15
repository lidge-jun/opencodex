/** Linux pidfd ownership for the opt-in sentinel. Loaded only on Linux. */
import { dlopen, FFIType, read } from "bun:ffi";
import type { TerminateResult } from "./health-sentinel-main";

const ESRCH = 3;
const ENOSYS = 38;
// Syscalls from 424 onward share one number on every Linux architecture. Binding is limited to
// x64/arm64 because the FFI signature below assumes their LP64 integer-register calling convention.
const SYS_PIDFD_OPEN = 434;
const SYS_PIDFD_SEND_SIGNAL = 424;

type CallResult = { value: number; errno: number };
export type PidfdSyscalls = {
  open(pid: number): CallResult;
  signal(fd: number, signal: number): CallResult;
  close(fd: number): void;
  dispose(): void;
};
export type ParentPidfd = { terminate(): TerminateResult; close(): void };
export type ParentPidfdResult =
  | { kind: "bound"; handle: ParentPidfd }
  | { kind: "unsupported"; reason: string }
  | { kind: "refused"; reason: string };

function nativeSyscalls(): PidfdSyscalls {
  const symbols = {
    // syscall is variadic, but these syscalls use integer/pointer arguments only. All supplied
    // slots are machine-word integers (including zero for siginfo and flags), on these LP64 ABIs.
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    __errno_location: { args: [], returns: FFIType.ptr },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  } as const;
  const load = (path: string) => dlopen(path, symbols);
  let libc: ReturnType<typeof load>;
  try {
    libc = load("libc.so.6");
  } catch {
    // musl exports libc symbols through its loader; it has no glibc soname or pidfd wrappers.
    libc = load(`/lib/ld-musl-${process.arch === "x64" ? "x86_64" : "aarch64"}.so.1`);
  }
  const call = (nr: number, a: number, b: number, c = 0, d = 0): CallResult => {
    const value = Number(libc.symbols.syscall(nr, a, b, c, d));
    return { value, errno: value === -1 ? read.i32(libc.symbols.__errno_location()!) : 0 };
  };
  return {
    open: pid => call(SYS_PIDFD_OPEN, pid, 0),
    signal: (fd, signal) => call(SYS_PIDFD_SEND_SIGNAL, fd, signal),
    // Never retry close on Linux: even an EINTR has released the descriptor.
    close: fd => { libc.symbols.close(fd); },
    dispose: () => libc.close(),
  };
}

/** Acquire before arming; reparenting during acquisition invalidates even a successfully opened fd. */
export function openParentPidfd(
  pid: number,
  isParent: () => boolean,
  options: { arch?: string; load?: () => PidfdSyscalls } = {},
): ParentPidfdResult {
  if (!isParent()) return { kind: "refused", reason: "the sentinel is not the watched process's child" };
  const arch = options.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") return { kind: "unsupported", reason: `pidfd syscall ABI is unsupported on ${arch}` };
  let api: PidfdSyscalls;
  try { api = (options.load ?? nativeSyscalls)(); }
  catch { return { kind: "refused", reason: "Linux pidfd libc binding is unavailable" }; }
  let fd: number | null = null;
  let closed = false;
  let signalled = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { if (fd !== null) api.close(fd); } finally { api.dispose(); }
  };
  const refuse = (reason: string): ParentPidfdResult => { close(); return { kind: "refused", reason }; };
  try {
    const opened = api.open(pid);
    if (opened.value < 0) {
      close();
      return opened.errno === ENOSYS
        ? { kind: "unsupported", reason: "pidfd_open is unsupported by this kernel" }
        : { kind: "refused", reason: `pidfd_open failed (errno ${opened.errno})` };
    }
    fd = opened.value;
    if (!isParent()) return refuse("the watched parent exited during pidfd acquisition");
    // Check both syscall support and permission before arming, without sending a signal.
    const probe = api.signal(fd, 0);
    if (probe.value < 0) {
      close();
      return probe.errno === ENOSYS
        ? { kind: "unsupported", reason: "pidfd_send_signal is unsupported by this kernel" }
        : { kind: "refused", reason: `pidfd signal check failed (errno ${probe.errno})` };
    }
    if (!isParent()) return refuse("the watched parent exited during pidfd verification");
    return {
      kind: "bound",
      handle: {
        close,
        terminate: () => {
          if (closed || signalled) return "not_target";
          // A throwing binding must settle the recorded intent as "failed", like process.kill does.
          let sent: CallResult;
          try { sent = api.signal(fd!, 9); } catch { return "failed"; }
          if (sent.value < 0) return sent.errno === ESRCH ? "not_target" : "failed";
          signalled = true;
          return "terminated";
        },
      },
    };
  } catch {
    return refuse("Linux pidfd binding failed");
  }
}
