import { win32 } from "node:path";
import { ptr } from "bun:ffi";
import { securityAttributes, wide, WIN64_CHILD_ABI, WindowsChildNative } from "./windows-cli-child-native";
import { WindowsChildPipe } from "./windows-cli-child-pipe";
import { startWindowsCliRecoveryGuardian } from "./windows-cli-recovery-guardian";
import type { CodexCliUpdateNativeRecoveryProof } from "./cli-update-recovery";

export type WindowsCliChildPolicy = "installer" | "pack" | "version";
export function windowsCliChildPolicy(policy: WindowsCliChildPolicy) {
  switch (policy) {
    case "installer": return { captureBytes: 0, deadlineMs: null, reapMs: null, terminate: false } as const;
    case "pack": return { captureBytes: 1024 * 1024, deadlineMs: null, reapMs: null, terminate: false } as const;
    case "version": return { captureBytes: 16 * 1024, deadlineMs: 8000, reapMs: 1000, terminate: true } as const;
  }
}
export interface WindowsCliChildInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly policy: WindowsCliChildPolicy;
  /** Private durable recovery identity, selected before native creation. */
  readonly recoveryJobName?: string;
  readonly recoveryProof?: CodexCliUpdateNativeRecoveryProof;
}
export interface WindowsCliChildResult {
  readonly terminal: boolean;
  /** Terminal process/Job accounting does not establish successful handle disposal. */
  readonly cleanupComplete: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly overflow: boolean;
  readonly failed: boolean;
  readonly reason: string | null;
}
/** CRT argv quoting, with explicit lpApplicationName; never cmd.exe or PATH lookup. */
export function quoteWindowsChildArg(arg: string): string {
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function validate(invocation: WindowsCliChildInvocation): void {
  const localAbsolute = (value: string) => typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value)
    && win32.isAbsolute(value) && !value.includes("\0");
  if (!localAbsolute(invocation.executable) || !/\.exe$/i.test(invocation.executable)
    || !localAbsolute(invocation.cwd) || !Array.isArray(invocation.args)
    || invocation.args.some(arg => typeof arg !== "string" || arg.includes("\0"))
    || !windowsCliChildPolicy(invocation.policy)
    || (invocation.recoveryJobName !== undefined && !/^Global\\ocx-cli-[0-9a-f-]{36}$/.test(invocation.recoveryJobName))) throw new Error("windows_child_invalid_invocation");
}
function environmentBlock(env: Readonly<NodeJS.ProcessEnv>, native: WindowsChildNative): Buffer {
  const entries = Object.keys(env).filter(key => env[key] !== undefined).map(key => {
    const value = env[key]!;
    if (!key || /[=\0]/.test(key) || value.includes("\0")) throw new Error("windows_child_invalid_environment");
    return { key: wide(key), entry: `${key}=${value}` };
  });
  // Windows requires case-insensitive ordinal sorting, independent of JS/host locale.
  const compare = (a: typeof entries[number], b: typeof entries[number]) => {
    const result = Number(native.k.CompareStringOrdinal!(ptr(a.key), -1, ptr(b.key), -1, 1));
    if (!result) throw new Error("windows_child_environment_compare_failed");
    return result - 2;
  };
  entries.sort(compare);
  for (let i = 1; i < entries.length; i++) if (compare(entries[i - 1]!, entries[i]!) === 0) throw new Error("windows_child_invalid_environment");
  return Buffer.from(entries.map(item => item.entry).join("\0") + "\0\0", "utf16le");
}

/**
 * Owns an unnamed non-inheritable Job and the original primary process handle.
 * No KILL_ON_JOB_CLOSE, active-process limit, BREAKAWAY, PID reopen, or running abort.
 * A caller must adopt lease/staging ownership BEFORE calling start, and retain this
 * object and those resources whenever wait() returns terminal:false.
 */
export class WindowsCliChild {
  readonly pipe: WindowsChildPipe;
  readonly policy: ReturnType<typeof windowsCliChildPolicy>;
  readonly startedAt = Date.now();
  private readonly clockStartedAt = performance.now();
  pid: number | null = null;
  creationTime: string | null = null;
  process = 0n;
  job = 0n;
  recoveryGuardian = 0n;
  setupFailure: string | null = null;
  private stopAt: number | null = null;
  private terminationFailed = false;
  private failed = false;
  private reason: string | null = null;
  private overflow = false;
  private chunks: Buffer[] = [];
  private captured = 0;
  private waiting = false;
  private finished: WindowsCliChildResult | undefined;
  private observedTerminal: { terminal: true; exitCode: number; unknown: false } | undefined;
  private prestartTerminationFailed = false;
  constructor(readonly native: WindowsChildNative, policy: WindowsCliChildPolicy) {
    this.policy = windowsCliChildPolicy(policy); this.pipe = new WindowsChildPipe(native);
  }
  private fail(reason: string): void { this.failed = true; this.reason ??= reason; }
  private consume = (bytes: Buffer): void => {
    const remaining = this.policy.captureBytes - this.captured;
    if (bytes.length > remaining && this.policy.captureBytes) this.overflow = true;
    if (remaining > 0) { const chunk = Buffer.from(bytes.subarray(0, remaining)); this.chunks.push(chunk); this.captured += chunk.length; }
    // Overflow still drains/discards. Only the separate version policy may stop a Job.
    if (this.overflow && this.policy.terminate) this.stop("output_limit");
  };
  private stop(reason: string): void {
    this.fail(reason);
    if (this.stopAt !== null || !this.policy.terminate) return;
    this.stopAt = performance.now();
    if (!this.native.k.TerminateJobObject!(this.job, 1)) this.terminationFailed = true;
  }
  private result(terminal: boolean, exitCode: number | null): WindowsCliChildResult {
    return { terminal, cleanupComplete: terminal && this.native.handles.size === 0 && this.native.borrowedMemory.size === 0,
      exitCode, stdout: Buffer.concat(this.chunks, this.captured).toString("utf8"),
      overflow: this.overflow, failed: this.failed || !!this.setupFailure, reason: this.setupFailure ?? this.reason };
  }
  /** A successful accounting query plus a signaled original process handle, never PID absence or STILL_ACTIVE. */
  observe(): { terminal: boolean; exitCode: number | null; unknown: boolean } {
    if (this.observedTerminal) return this.observedTerminal;
    const k = this.native.k, accounting = Buffer.alloc(WIN64_CHILD_ABI.jobAccounting), code = Buffer.alloc(4);
    const wait = Number(k.WaitForSingleObject!(this.process, 0));
    if (wait !== 0 && wait !== 258) { this.fail("process_wait_failed"); return { terminal: false, exitCode: null, unknown: true }; }
    if (!k.QueryInformationJobObject!(this.job, 1, ptr(accounting), accounting.length, null)) {
      this.fail("job_query_failed"); return { terminal: false, exitCode: null, unknown: true };
    }
    if (wait !== 0 || accounting.readUInt32LE(40) !== 0) return { terminal: false, exitCode: null, unknown: false };
    if (!k.GetExitCodeProcess!(this.process, ptr(code))) {
      this.fail("process_exit_query_failed"); return { terminal: false, exitCode: null, unknown: true };
    }
    return this.observedTerminal = { terminal: true, exitCode: code.readUInt32LE(), unknown: false };
  }
  async wait(): Promise<WindowsCliChildResult> {
    if (this.finished) return this.finished;
    if (!this.process) throw new Error("windows_child_not_created_use_cleanup");
    if (this.waiting) throw new Error("windows_child_wait_already_owned");
    this.waiting = true;
    try {
      for (;;) {
        this.pipe.pump(this.consume);
        if (this.pipe.error) { this.fail("pipe_read_failed"); if (this.policy.terminate) this.stop("pipe_read_failed"); }
        const observed = this.observe();
        if (observed.terminal && this.pipe.eof) {
          if (this.recoveryGuardian) {
            const wait = Number(this.native.k.WaitForSingleObject!(this.recoveryGuardian, 0));
            if (wait === 258) {
              if (this.policy.deadlineMs !== null && performance.now() - this.clockStartedAt
                >= this.policy.deadlineMs + this.policy.reapMs!) {
                this.fail("recovery_observer_state_unknown"); return this.result(false, null);
              }
              await Bun.sleep(5); continue;
            }
            if (wait !== 0) { this.fail("recovery_observer_wait_failed"); return this.result(false, null); }
            this.native.close(this.recoveryGuardian);
          }
          await this.pipe.dispose();
          this.native.close(this.process); this.native.close(this.job);
          const released = this.native.dispose();
          if (!released) this.fail("handle_close_failed");
          return this.finished = this.result(true, observed.exitCode);
        }
        if (observed.unknown || this.terminationFailed || this.prestartTerminationFailed
          || (this.pipe.error && this.pipe.pending)) return this.result(false, null);
        if (this.policy.deadlineMs !== null && performance.now() - this.clockStartedAt >= this.policy.deadlineMs) this.stop("deadline");
        if (this.stopAt !== null && performance.now() - this.stopAt >= this.policy.reapMs!) return this.result(false, null);
        await Bun.sleep(5);
      }
    } finally { this.waiting = false; }
  }
  /** Not a running-child disposal API: only pre-user-code setup failures may call it. */
  reapUnstarted(): boolean {
    if (!this.setupFailure || !this.process || this.finished || !this.native.handles.has(this.process)) return false;
    this.prestartTerminationFailed = !this.native.k.TerminateProcess!(this.process, 1);
    return !this.prestartTerminationFailed;
  }
}

export function startWindowsCliChild(invocation: WindowsCliChildInvocation): WindowsCliChild {
  validate(invocation);
  return startWindowsCliChildWithNative(invocation, new WindowsChildNative());
}

/** Internal native dispatch seam; fixtures use the real APIs with single-call faults. */
export function startWindowsCliChildWithNative(invocation: WindowsCliChildInvocation, native: WindowsChildNative): WindowsCliChild {
  validate(invocation);
  const child = new WindowsCliChild(native, invocation.policy), k = native.k;
  let stdin = 0n, stderr = 0n, thread = 0n, attributes: Buffer | undefined, initialized = false;
  let inheritedHandles: Buffer | undefined;
  try {
    if (invocation.recoveryJobName) {
      const name = wide(invocation.recoveryJobName), descriptor = native.privateDescriptor();
      try {
        const security = securityAttributes(false, descriptor);
        k.SetLastError!(0);
        child.job = native.keep(k.CreateJobObjectW!(ptr(security), ptr(name)));
        // Never adopt a pre-existing object, even inside the current-user boundary.
        if (k.GetLastError!() === 183) throw new Error("windows_child_job_exists");
      } finally { k.LocalFree!(descriptor); }
    } else child.job = native.keep(k.CreateJobObjectW!(null, null));
    child.pipe.open();
    const inheritable = securityAttributes(true), nul = wide("NUL");
    stdin = native.keep(k.CreateFileW!(ptr(nul), 0x80000000, 3, ptr(inheritable), 3, 0, 0n));
    stderr = native.keep(k.CreateFileW!(ptr(nul), 0x40000000, 3, ptr(inheritable), 3, 0, 0n));
    const handles = inheritedHandles = Buffer.alloc(24);
    [stdin, child.pipe.child, stderr].forEach((handle, index) => handles.writeBigUInt64LE(handle, index * 8));
    const size = Buffer.alloc(8);
    k.InitializeProcThreadAttributeList!(null, 1, 0, ptr(size));
    const length = Number(size.readBigUInt64LE());
    if (length < 24 || length > 1024 * 1024) throw new Error("attribute_size");
    attributes = Buffer.alloc(length);
    native.borrowedMemory.add(attributes); native.borrowedMemory.add(handles);
    if (!k.InitializeProcThreadAttributeList!(ptr(attributes), 1, 0, ptr(size))) throw new Error("attribute_init");
    initialized = true;
    if (!k.UpdateProcThreadAttribute!(ptr(attributes), 0, 0x20002n, ptr(handles), 24n, null, null)) throw new Error("attribute_handles");
    const startup = Buffer.alloc(WIN64_CHILD_ABI.startupInfoEx), info = Buffer.alloc(WIN64_CHILD_ABI.processInformation);
    startup.writeUInt32LE(startup.length); startup.writeUInt32LE(0x100, 60);
    [stdin, child.pipe.child, stderr].forEach((handle, index) => startup.writeBigUInt64LE(handle, 80 + index * 8));
    startup.writeBigUInt64LE(BigInt(ptr(attributes)), 104);
    const executable = wide(invocation.executable), command = wide([invocation.executable, ...invocation.args].map(quoteWindowsChildArg).join(" "));
    const cwd = wide(invocation.cwd), env = environmentBlock(invocation.env, native);
    if (command.length > 65534) throw new Error("command_length");
    // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW.
    // All buffers above remain strongly reachable through CreateProcessW and attribute deletion.
    if (!k.CreateProcessW!(ptr(executable), ptr(command), null, null, 1, 0x08080404, ptr(env), ptr(cwd), ptr(startup), ptr(info))) {
      throw new Error(`create_process_${k.GetLastError!()}`);
    }
    child.process = native.keep(info.readBigUInt64LE(0)); thread = native.keep(info.readBigUInt64LE(8));
    child.pid = info.readUInt32LE(16);
    // Separate FILETIME buffers: creating Buffer subarrays while evaluating FFI
    // arguments can materialize a new backing store in bundled Bun on Windows.
    const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
    if (!k.GetProcessTimes!(child.process, ptr(creation), ptr(exit), ptr(kernel), ptr(user))) throw new Error("process_times");
    child.creationTime = creation.readBigUInt64LE().toString();
    if (child.creationTime === "0") throw new Error("process_creation_time_unknown");
    if (!k.AssignProcessToJobObject!(child.job, child.process)) throw new Error("job_assignment");
    if (invocation.recoveryProof) child.recoveryGuardian = startWindowsCliRecoveryGuardian(native, child.job, invocation.recoveryProof, invocation.cwd);
    if (Number(k.ResumeThread!(thread)) !== 1) throw new Error("resume_thread");
  } catch (error) {
    child.setupFailure = error instanceof Error ? error.message : "setup_failed";
    if (child.process) child.reapUnstarted();
  } finally {
    if (initialized) k.DeleteProcThreadAttributeList!(ptr(attributes!));
    if (attributes) native.borrowedMemory.delete(attributes);
    if (inheritedHandles) native.borrowedMemory.delete(inheritedHandles);
    child.pipe.closeChild();
    if (stdin) native.close(stdin); if (stderr) native.close(stderr); if (thread) native.close(thread);
  }
  // No await has occurred while any parent-owned inheritable stdio handle was open.
  if (!child.process) {
    // No I/O read is issued until wait(). The connect call is the only possible pending operation.
    // Caller receives the owner for async cancellation/settlement via cleanupUnstartedWindowsChild.
    return child;
  }
  return child;
}

/** Setup never launched user code. Preserve owner until pending connect I/O is settled. */
export async function cleanupUnstartedWindowsChild(child: WindowsCliChild): Promise<boolean> {
  if (child.process || !child.setupFailure) return false;
  await child.pipe.dispose(); if (child.job) child.native.close(child.job);
  return child.native.dispose();
}
