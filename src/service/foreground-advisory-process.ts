import { spawn } from "node:child_process";
import { join } from "node:path";
import { startWindowsCliChild, type WindowsCliChild } from "../codex/windows-cli-child";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";

export const FOREGROUND_ADVISORY_ARG = "__foreground-service-advisory";
const TIMEOUT_MS = 3_000;
const REAP_MS = 1_000;
const POLL_MS = 5;
const SETTLE_POLL_MS = 250;
const MAX_BYTES = 8_192;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const JOB_EXTENDED_LIMIT_BYTES = 144;
const JOB_LIMIT_FLAGS_OFFSET = 16;

export interface ForegroundAdvisoryEligibility {
  cleaned: boolean;
  shuttingDown: boolean;
  siblingStart: boolean;
  ownerLive: boolean;
  supervisedServiceChild: boolean;
  restartParentPid: number | null;
  stderrIsTTY: boolean | undefined;
}

export interface ContainedWindowsAdvisoryChild {
  readonly setupFailure: string | null;
  readonly job: bigint;
  readonly process: bigint;
  readonly pipe: {
    readonly eof: boolean;
    readonly error: boolean;
    pump(onBytes: (chunk: Buffer) => void): void;
    dispose(): Promise<void>;
  };
  readonly native: {
    readonly k: {
      TerminateJobObject?: (job: bigint, code: number) => number;
    };
    close(handle: bigint): void;
    dispose(): boolean;
  };
  observe(): { terminal: boolean; exitCode: number | null; unknown: boolean };
  reapUnstarted(): boolean;
}

export interface ForegroundAdvisoryDeps {
  /** POSIX probe launcher override for tests. */
  launch?: () => ReturnType<typeof spawn>;
  /**
   * Windows pre-resume Job-contained launcher override for tests. Defaults to
   * `startWindowsCliChild`, which creates the probe `CREATE_SUSPENDED`, assigns it to an
   * unnamed Job Object before `ResumeThread`, and fails closed if containment cannot be established.
   */
  launchWindows?: () => ContainedWindowsAdvisoryChild;
  /** Override for applying `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` to the Windows job in tests. */
  setKillOnJobClose?: (job: bigint) => boolean;
  timeoutMs?: number;
  reapMs?: number;
  pollMs?: number;
  settlePollMs?: number;
  platform?: NodeJS.Platform;
}

export type StopForegroundAdvisory = (sync?: boolean) => void;

/** True only for an eligible interactive foreground owner after readiness. */
export function shouldStartForegroundAdvisory(state: ForegroundAdvisoryEligibility): boolean {
  return !state.cleaned
    && !state.shuttingDown
    && !state.siblingStart
    && !state.ownerLive
    && !state.supervisedServiceChild
    && state.restartParentPid === null
    && Boolean(state.stderrIsTTY);
}

/** Start the background advisory probe only when foreground eligibility holds. */
export function maybeStartForegroundAdvisory(
  state: ForegroundAdvisoryEligibility,
  warn: (line: string) => void,
  deps?: ForegroundAdvisoryDeps,
): StopForegroundAdvisory | undefined {
  if (!shouldStartForegroundAdvisory(state)) return undefined;
  return startForegroundAdvisory(warn, deps);
}

/** Private child entrypoint executed by `startForegroundAdvisory`. */
export async function runForegroundAdvisoryEntrypoint(): Promise<number> {
  const { diagnoseService, foregroundStartServiceAdvisoryLines } = await import("./diagnostics");
  let lines: readonly string[] = [];
  try { lines = foregroundStartServiceAdvisoryLines(diagnoseService()); } catch { /* best effort */ }
  // Await the write, so an explicit CLI exit cannot truncate the pipe.
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(lines), error => error ? reject(error) : resolve()),
  );
  return 0;
}

function publishAdvisoryOutput(raw: string, warn: (line: string) => void): void {
  try {
    const lines: unknown = JSON.parse(raw);
    if (!Array.isArray(lines) || lines.length > 2 || !lines.every(line => typeof line === "string")) return;
    for (const line of lines) warn(line);
  } catch { /* optional output */ }
}

let winJobLimitApi: {
  readonly lib: { close(): void };
  setInformationJobObject: (job: bigint, infoClass: number, infoPtr: number, length: number) => number;
  ptr: typeof import("bun:ffi").ptr;
} | null | undefined;

function enableWindowsKillOnJobClose(job: bigint): boolean {
  if (winJobLimitApi === undefined) {
    winJobLimitApi = null;
    if (process.platform === "win32" && process.arch === "x64") {
      try {
        const ffi = require("bun:ffi") as typeof import("bun:ffi");
        const lib = ffi.dlopen(join(resolveTrustedWindowsSystemDirectory(), "kernel32.dll"), {
          SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
        });
        winJobLimitApi = {
          lib,
          setInformationJobObject: (handle, cls, infoPtr, len) => lib.symbols.SetInformationJobObject(handle, cls, infoPtr, len),
          ptr: ffi.ptr,
        };
      } catch { /* kernel32 SetInformationJobObject unavailable */ }
    }
  }
  if (!winJobLimitApi) return false;
  try {
    const info = Buffer.alloc(JOB_EXTENDED_LIMIT_BYTES);
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_LIMIT_FLAGS_OFFSET);
    return Boolean(winJobLimitApi.setInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      winJobLimitApi.ptr(info),
      JOB_EXTENDED_LIMIT_BYTES,
    ));
  } catch {
    return false;
  }
}

function disposeWindowsHandlesAsync(child: ContainedWindowsAdvisoryChild): void {
  void child.pipe.dispose().then(() => {
    if (child.process) child.native.close(child.process);
    if (child.job) child.native.close(child.job);
    child.native.dispose();
  }).catch(() => { /* best-effort async handle cleanup */ });
}

function startWindowsContainedAdvisory(
  warn: (line: string) => void,
  deps: ForegroundAdvisoryDeps,
): StopForegroundAdvisory {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const reapMs = deps.reapMs ?? REAP_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  const settlePollMs = deps.settlePollMs ?? SETTLE_POLL_MS;
  const expires = performance.now() + timeoutMs;

  let child: ContainedWindowsAdvisoryChild;
  try {
    child = (deps.launchWindows ?? ((): WindowsCliChild => startWindowsCliChild({
      executable: process.execPath,
      args: selfLaunchArgv([FOREGROUND_ADVISORY_ARG]),
      cwd: process.cwd(),
      env: process.env,
      policy: "version",
    })))();
  } catch {
    // Fail closed when kernel Job Object containment is unavailable (e.g. Windows ARM64):
    // never launch an uncontained probe or fall back to PID-only termination.
    return () => { /* containment unavailable; no probe was started */ };
  }

  if (child.setupFailure || !child.process || !child.job) {
    const reaped = !child.process || (() => {
      try { return child.reapUnstarted(); } catch { return false; }
    })();
    if (reaped) disposeWindowsHandlesAsync(child);
    return () => { /* setup failed before ResumeThread; nothing running */ };
  }

  let settled = false;
  let terminated = false;
  let disposed = false;
  let stopAt: number | null = null;
  let bytes = 0;
  const chunks: Buffer[] = [];
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const clearPoll = () => {
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const finalizeAsync = () => {
    if (disposed) return;
    disposed = true;
    clearPoll();
    disposeWindowsHandlesAsync(child);
  };

  const terminateJob = (): boolean => {
    if (disposed || terminated) return true;
    let ok = false;
    try { ok = Boolean(child.native.k.TerminateJobObject?.(child.job, 1)); } catch { ok = false; }
    if (ok) terminated = true;
    return ok;
  };

  const schedulePoll = (delayMs = pollMs) => {
    if (disposed) return;
    clearPoll();
    pollTimer = setTimeout(tick, delayMs);
    pollTimer.unref();
  };

  const stop: StopForegroundAdvisory = (sync = false) => {
    if (disposed) return;
    settled = true;
    const ok = terminateJob();
    if (sync) {
      // Synchronous exit path: stop any pending timer. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      // guarantees the kernel terminates the probe tree on parent exit even if TerminateJobObject
      // returned false; retain the job handle until process exit when termination was not confirmed.
      clearPoll();
      if (ok) disposed = true;
      return;
    }
    stopAt ??= performance.now();
    if (!disposed && pollTimer === undefined) schedulePoll();
  };

  const tick = () => {
    pollTimer = undefined;
    if (disposed) return;
    try {
      child.pipe.pump(chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          stop(false);
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
    } catch {
      stop(false);
    }

    let observed: { terminal: boolean; exitCode: number | null; unknown: boolean };
    try {
      observed = child.observe();
    } catch {
      observed = { terminal: false, exitCode: null, unknown: true };
    }

    if (observed.terminal && (settled || child.pipe.eof)) {
      const shouldPublish = !settled && observed.exitCode === 0 && performance.now() < expires;
      settled = true;
      finalizeAsync();
      if (shouldPublish) {
        publishAdvisoryOutput(Buffer.concat(chunks).toString("utf8"), warn);
      }
      return;
    }

    if (observed.unknown || child.pipe.error) {
      stop(false);
    }

    const now = performance.now();
    if (!settled && now >= expires) {
      stop(false);
    }
    if (stopAt !== null) {
      // Slow-to-settle job or failed termination: never leak handles by abandoning polling, and
      // never close child.job while nonterminal. Retry TerminateJobObject if needed, backing off
      // to an unreferenced poll interval after reapMs until the job is observed terminal.
      if (!terminated) terminateJob();
      schedulePoll(now - stopAt >= reapMs ? settlePollMs : pollMs);
      return;
    }
    schedulePoll(pollMs);
  };

  // Enforce JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE on the probe's job so even if TerminateJobObject
  // fails during shutdown or the parent crashes, Windows terminates the entire probe tree on exit.
  const killOnCloseApplied = (() => {
    try { return (deps.setKillOnJobClose ?? enableWindowsKillOnJobClose)(child.job); }
    catch { return false; }
  })();
  if (!killOnCloseApplied) {
    stop(false);
    return stop;
  }

  schedulePoll();
  return stop;
}

/** Run an optional OS diagnostic without blocking the listener or keeping the CLI alive. */
export function startForegroundAdvisory(
  warn: (line: string) => void,
  deps: ForegroundAdvisoryDeps = {},
): StopForegroundAdvisory {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return startWindowsContainedAdvisory(warn, deps);
  }

  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const expires = performance.now() + timeoutMs;
  let child: ReturnType<typeof spawn>;
  try {
    child = (deps.launch ?? (() => spawn(process.execPath, selfLaunchArgv([FOREGROUND_ADVISORY_ARG]), {
      detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    })))();
  } catch { return () => { /* launch failed; nothing to clean up */ }; }

  let settled = false;
  let stopped = false;
  let bytes = 0;
  const chunks: Buffer[] = [];
  const stop: StopForegroundAdvisory = () => {
    settled = true;
    clearTimeout(timer);
    if (!stopped) {
      stopped = true;
      const pid = child.pid;
      if (pid && Number.isInteger(pid) && pid > 0) {
        // Detached POSIX process group `-pid` is assigned atomically before exec and is never
        // reused while any descendant remains alive, so this reaps exited-root descendants too.
        try { process.kill(-pid, "SIGKILL"); } catch {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL"); } catch { /* best effort */ }
          }
        }
      } else if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
    }
    child.stdout?.destroy();
  };
  const timer = setTimeout(() => stop(false), timeoutMs);
  timer.unref();
  child.once("error", () => stop(false));
  child.stdout?.once("error", () => stop(false));
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) { stop(false); return; }
    if (!settled) chunks.push(chunk);
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    stopped = true;
    clearTimeout(timer);
    if (code !== 0 || performance.now() >= expires) return;
    publishAdvisoryOutput(Buffer.concat(chunks).toString("utf8"), warn);
  });
  child.unref();
  // Node's pipe handle has unref(); its public Readable type doesn't expose it.
  (child.stdout as (typeof child.stdout & { unref?(): void }))?.unref?.();
  return stop;
}
