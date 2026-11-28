import { spawn } from "node:child_process";
import { startWindowsCliChild, type WindowsCliChild } from "../codex/windows-cli-child";
import { selfLaunchArgv } from "../lib/self-launch-argv";

export const FOREGROUND_ADVISORY_ARG = "__foreground-service-advisory";
const TIMEOUT_MS = 3_000;
const REAP_MS = 1_000;
const POLL_MS = 5;
const SETTLE_POLL_MS = 250;
const MAX_BYTES = 8_192;

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
      WaitForSingleObject?: (handle: bigint, ms: number) => number;
    };
    close(handle: bigint): void;
    dispose(): boolean;
  };
  observe(): { terminal: boolean; exitCode: number | null; unknown: boolean };
  reapUnstarted(): boolean;
}

export interface ForegroundAdvisoryDeps {
  /** Probe launcher override for tests, including on Windows. */
  launch?: () => ReturnType<typeof spawn>;
  /**
   * Windows pre-resume Job-contained launcher override for tests. Defaults to
   * `startWindowsCliChild` with `killOnJobClose: true`, which configures
   * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and `PROC_THREAD_ATTRIBUTE_JOB_LIST` before
   * `CreateProcessW` (atomic job assignment at process creation) so no unassigned or
   * unprotected process can exist even if setup fails before `ResumeThread`.
   */
  launchWindows?: () => ContainedWindowsAdvisoryChild;
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

function disposeWindowsHandlesAsync(child: ContainedWindowsAdvisoryChild): void {
  void child.pipe.dispose().then(() => {
    if (child.process) child.native.close(child.process);
    if (child.job) child.native.close(child.job);
    child.native.dispose();
  }).catch(() => { /* best-effort async handle cleanup */ });
}

function isWindowsProcessSignaled(child: ContainedWindowsAdvisoryChild): boolean {
  if (!child.process) return true;
  try {
    return Number(child.native.k.WaitForSingleObject?.(child.process, 0)) === 0;
  } catch {
    return false;
  }
}

function reapFailedSetupWindowsChild(
  child: ContainedWindowsAdvisoryChild,
  pollMs: number,
  reapMs: number,
  settlePollMs: number,
): StopForegroundAdvisory {
  if (!child.process) {
    disposeWindowsHandlesAsync(child);
    return () => { /* setup failed before CreateProcessW; nothing running */ };
  }

  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = performance.now();

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

  const tryReap = (): boolean => {
    if (disposed) return true;
    if (isWindowsProcessSignaled(child)) return true;
    try { child.reapUnstarted(); } catch { /* retry until process handle signals */ }
    if (isWindowsProcessSignaled(child)) return true;
    if (child.job) {
      try { child.native.k.TerminateJobObject?.(child.job, 1); } catch { /* kernel kill-on-close backs up exit */ }
    }
    return isWindowsProcessSignaled(child);
  };

  const schedulePoll = (delayMs: number) => {
    if (disposed) return;
    clearPoll();
    pollTimer = setTimeout(tick, delayMs);
    pollTimer.unref();
  };

  const tick = () => {
    pollTimer = undefined;
    if (disposed) return;
    if (tryReap()) {
      finalizeAsync();
      return;
    }
    schedulePoll(performance.now() - startedAt >= reapMs ? settlePollMs : pollMs);
  };

  // Check WaitForSingleObject first: startWindowsCliChild's catch block already ran reapUnstarted()
  // once, and a second TerminateProcess on an already-terminated process can return false.
  // Gate handle disposal strictly on WaitForSingleObject(child.process, 0) === 0, retaining the
  // original process handle and retrying reapUnstarted() until termination is confirmed.
  if (tryReap()) {
    finalizeAsync();
    return () => { /* failed-setup process already confirmed terminal and disposed */ };
  }

  schedulePoll(pollMs);
  return (sync = false) => {
    if (disposed) return;
    if (tryReap()) {
      if (sync) {
        clearPoll();
        disposed = true;
      } else {
        finalizeAsync();
      }
      return;
    }
    if (sync) {
      clearPoll();
      return;
    }
    if (pollTimer === undefined) schedulePoll(pollMs);
  };
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
      killOnJobClose: true,
    })))();
  } catch {
    // Fail closed when kernel Job Object containment is unavailable (e.g. Windows ARM64):
    // never launch an uncontained probe or fall back to PID-only termination.
    return () => { /* containment unavailable; no probe was started */ };
  }

  if (child.setupFailure || !child.process || !child.job) {
    return reapFailedSetupWindowsChild(child, pollMs, reapMs, settlePollMs);
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
      // was armed on child.job before CreateProcessW/ResumeThread, so Windows terminates the
      // entire probe tree on parent exit even if TerminateJobObject returned false; retain
      // child.job open until process exit when termination was not confirmed.
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

  schedulePoll();
  return stop;
}

/** Run an optional OS diagnostic without blocking the listener or keeping the CLI alive. */
export function startForegroundAdvisory(
  warn: (line: string) => void,
  deps: ForegroundAdvisoryDeps = {},
): StopForegroundAdvisory {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32" && !deps.launch) {
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
      if (process.platform !== "win32" && pid && Number.isInteger(pid) && pid > 0) {
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
