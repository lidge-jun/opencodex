/**
 * The opt-in service health sentinel process (#6671).
 *
 * The proxy spawns this with its stdin as a pipe whose write end only the proxy holds. When the
 * proxy exits for any reason the operating system closes that pipe and this process sees EOF and
 * leaves. It asks `/healthz` on the cadence in health-sentinel-policy.ts and, when the policy says
 * the proxy has stopped answering, records the recovery and terminates the proxy. The supervisor
 * that started the proxy — the Task Scheduler batch loop, launchd, systemd, WinSW — restarts it as
 * it would after any crash. Nothing is replayed.
 *
 * The kill is bound to the proxy, not to a number:
 * - Windows reuses ids quickly, so the sentinel opens a handle on its parent at startup, accepts it
 *   only if that process was created before the sentinel, and terminates through the handle
 *   (health-sentinel-windows.ts). While the handle is open the id cannot be reused.
 * - Linux holds a pidfd after rechecking the live parent relationship, and signals that fd.
 *   Only unsupported kernels/architectures retain the live-ppid fallback used by macOS.
 * - macOS checks the live parent id immediately before SIGKILL; PID reuse between those two
 *   syscalls remains a documented residual (structure/ops/service-health-recovery.md).
 *
 * SIGKILL rather than SIGTERM: a proxy whose event loop is stuck cannot run its own SIGTERM
 * handler, and systemd counts a SIGTERM death as a clean exit that `Restart=on-failure` does not
 * restart.
 *
 * The final checks and the `intent` write run under the service ownership mutation lease, so the
 * decision cannot interleave with a service install, repair, takeover or startup ownership
 * decision; a busy lease defers. The lease is released before the kill itself: on Windows the
 * sentinel can be terminated together with the proxy, and a lease it still held would block the
 * replacement's startup until reclaimed. Every history update takes the same lease. No synchronous
 * subprocess runs here: a sentinel that can hang protects nothing.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import {
  DEFAULT_HEALTH_SENTINEL_TIMING,
  createHealthSentinelPolicy,
  type HealthProbeOutcome,
  type HealthSentinelTiming,
} from "./health-sentinel-policy";
import { probeHealth, probeUrlHost, type HealthProbeTarget } from "./health-sentinel-probe";

export const HEALTH_SENTINEL_ENV = {
  targetPid: "OCX_HEALTH_SENTINEL_TARGET_PID",
  runtimePath: "OCX_HEALTH_SENTINEL_RUNTIME_PATH",
  historyPath: "OCX_HEALTH_SENTINEL_HISTORY_PATH",
  logPath: "OCX_HEALTH_SENTINEL_LOG_PATH",
  /** JSON array of the service-state paths whose ownership mutation lease guards the kill. */
  statePaths: "OCX_HEALTH_SENTINEL_STATE_PATHS",
  /** Test-only timing override (JSON, partial); production uses the policy defaults. */
  timing: "OCX_HEALTH_SENTINEL_TIMING",
} as const;

const HISTORY_LIMIT = 10;
const LOG_CAP_BYTES = 256 * 1024;
const EXIT_WAIT_MS = 10_000;
const LEASE_WAIT_MS = 500;

export type SentinelRuntimeRecord = { pid: number; port: number; hostname?: string; sibling: boolean };

/**
 * One recovery. `intent` is written before the kill; the entry is then settled as `terminated`
 * (exit observed), `unconfirmed` (no exit observed in time), `failed` (the kill was refused) or
 * `skipped` (the target had already gone). Every state but `skipped` counts toward the cap.
 */
export type RecoveryEntry = { at: number; pid: number; state: RecoveryState };
export type RecoveryState = "intent" | "terminated" | "unconfirmed" | "failed" | "skipped";
const RECOVERY_STATES: readonly RecoveryState[] = ["intent", "terminated", "unconfirmed", "failed", "skipped"];

export type TerminateResult = "terminated" | "not_target" | "failed";

export type HealthSentinelDeps = {
  targetPid: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  probe(target: HealthProbeTarget, timeoutMs: number): Promise<HealthProbeOutcome>;
  readRuntime(): SentinelRuntimeRecord | null;
  /** Resolves when the target's pipe closes: the target has exited. */
  targetExited: Promise<void>;
  isTargetGone(): boolean;
  /** Bind to the target once at startup; a failure stands the sentinel down. */
  bindTarget(): { ok: true } | { ok: false; reason: string };
  /** Release the process owner on every exit, refusal, cancellation or exception. */
  closeTarget(): void;
  /** Terminate the bound target, re-proving it is still the target at the last moment. */
  terminateTarget(): TerminateResult;
  /** Run under the ownership mutation lease, released on return; "busy" when it could not be taken promptly. */
  withOwnershipLease<T>(run: () => T): T | "busy";
  /** Earlier recoveries that count toward the cap, or null when the history is unreadable. */
  readHistory(): number[] | null;
  /** Durably write or settle one entry; false when it could not be written. */
  writeHistory(entry: RecoveryEntry): boolean;
  log(line: string): void;
  timing?: Partial<HealthSentinelTiming>;
};

export type HealthSentinelResult =
  | { outcome: "target_exited" }
  | { outcome: "stood_down"; reason: string }
  | { outcome: "recovered"; state: RecoveryState };

const GONE = Symbol("gone");

/**
 * How late this process's own event loop has run, measured on the wall clock so that a machine
 * sleep counts too. The policy discards a timeout observed while the sentinel itself was late.
 */
export function startLagMonitor(tickMs = 250, now: () => number = Date.now) {
  let last = now();
  let max = 0;
  const timer = setInterval(() => {
    const at = now();
    max = Math.max(max, at - last - tickMs);
    last = at;
  }, tickMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    reset(): void { max = 0; last = now(); },
    read(): number { return Math.max(max, now() - last - tickMs); },
    stop(): void { clearInterval(timer); },
  };
}

/**
 * Race `work` against the target's exit. The exit is one AbortSignal subscribed once per run, and
 * each race detaches its listener when it settles: a sentinel that probes a healthy proxy for
 * months must not accumulate a handler per probe on one never-settling promise.
 */
async function raceGone<T>(work: Promise<T>, exited: AbortSignal): Promise<T | typeof GONE> {
  if (exited.aborted) return GONE;
  let onExit: () => void = () => {};
  const gone = new Promise<typeof GONE>(resolve => {
    onExit = () => resolve(GONE);
    exited.addEventListener("abort", onExit, { once: true });
  });
  try {
    return await Promise.race([work, gone]);
  } finally {
    exited.removeEventListener("abort", onExit);
  }
}

type Attempt =
  | { kind: "stand_down"; reason: string }
  | { kind: "gone" }
  | { kind: "intent"; entry: RecoveryEntry };

function matchesProbeTarget(runtime: SentinelRuntimeRecord | null, pid: number, target: HealthProbeTarget): boolean {
  return runtime !== null && runtime.pid === pid && !runtime.sibling
    && runtime.port === target.port && probeUrlHost(runtime.hostname) === target.hostname;
}

export async function runHealthSentinel(deps: HealthSentinelDeps): Promise<HealthSentinelResult> {
  try { return await observeHealthSentinel(deps); }
  finally { deps.closeTarget(); }
}

async function observeHealthSentinel(deps: HealthSentinelDeps): Promise<HealthSentinelResult> {
  const timing: HealthSentinelTiming = { ...DEFAULT_HEALTH_SENTINEL_TIMING, ...deps.timing };
  const standDown = (reason: string): HealthSentinelResult => {
    deps.log(`standing down: ${reason} (pid ${deps.targetPid})`);
    return { outcome: "stood_down", reason };
  };
  const exit = new AbortController();
  void deps.targetExited.then(() => exit.abort());
  const exitSignal = exit.signal;
  const bound = deps.bindTarget();
  if (!bound.ok) return standDown(bound.reason);
  const history = deps.readHistory();
  if (history === null) return standDown("the recovery history cannot be read");
  const policy = createHealthSentinelPolicy({
    targetPid: deps.targetPid,
    startedAt: deps.now(),
    recoveryHistory: history,
    timing,
  });
  let pinnedTarget: HealthProbeTarget | null = null;
  for (;;) {
    if (deps.isTargetGone()) return { outcome: "target_exited" };
    const runtime = deps.readRuntime();
    if (!runtime || runtime.pid !== deps.targetPid) return standDown("the runtime record no longer names the watched process");
    if (runtime.sibling) return standDown("the watched process is a sibling proxy");
    const hostname = probeUrlHost(runtime.hostname);
    if (hostname === null) return standDown("the recorded bind address is not numeric; DNS names cannot authorize recovery");
    const target: HealthProbeTarget = pinnedTarget ?? { hostname, port: runtime.port };
    if (!matchesProbeTarget(runtime, deps.targetPid, target)) return standDown("the recorded probe endpoint changed");
    pinnedTarget = target;
    const outcome = await raceGone(deps.probe(target, timing.probeTimeoutMs), exitSignal);
    if (outcome === GONE) return { outcome: "target_exited" };
    const wasArmed = policy.state().armed;
    const decision = policy.observe(outcome);
    if (!wasArmed && policy.state().armed) deps.log(`watching pid ${deps.targetPid} on port ${runtime.port}`);
    if (decision.action === "stand_down") return standDown(decision.reason);
    if (decision.action === "recover") {
      const attempt = deps.withOwnershipLease((): Attempt => {
        // Everything that could have changed during the probe is re-read under the lease.
        if (deps.isTargetGone()) return { kind: "gone" };
        const current = deps.readRuntime();
        if (!matchesProbeTarget(current, deps.targetPid, target)) {
          return { kind: "stand_down", reason: "the runtime record changed while the target was unresponsive" };
        }
        // Persist first: an attempted recovery must count toward the cap, and on Windows this
        // process may be terminated together with the target.
        const entry: RecoveryEntry = { at: deps.now(), pid: deps.targetPid, state: "intent" };
        if (!deps.writeHistory(entry)) return { kind: "stand_down", reason: "the recovery history cannot be written" };
        deps.log(`recovering pid ${deps.targetPid} on port ${runtime.port}: ${decision.reason}; terminating it so its supervisor restarts it (in-flight requests are not replayed)`);
        return { kind: "intent", entry };
      });
      const settle = (entry: RecoveryEntry) => {
        // Best-effort: an unsettled entry stays `intent`, which still counts toward the cap.
        if (deps.withOwnershipLease(() => deps.writeHistory(entry)) === "busy") deps.log("could not settle the recovery entry: the service ownership lease is busy");
      };
      if (attempt === "busy") {
        deps.log("recovery deferred: the service ownership lease is busy");
      } else if (attempt.kind === "gone") {
        return { outcome: "target_exited" };
      } else if (attempt.kind === "stand_down") {
        return standDown(attempt.reason);
      } else {
        const { entry } = attempt;
        // The lease, history and log work above takes time. Re-check that the evidence is still
        // fresh right before the irreversible step: a proxy that recovered meanwhile must not be
        // killed on old observations. A clock that ran backwards makes the evidence stale too. The
        // final runtime-record read is included before the freshness check so time spent on it
        // cannot authorize termination on stale observations.
        const finalRuntime = deps.readRuntime();
        const evidenceAge = deps.now() - outcome.endedAt;
        if (evidenceAge < 0 || evidenceAge > timing.maxEvidenceAgeMs || deps.isTargetGone()) {
          settle({ ...entry, state: "skipped" });
          if (deps.isTargetGone()) return { outcome: "target_exited" };
          deps.log(`discarding stale evidence (${Math.round(evidenceAge / 1000)}s old) for pid ${deps.targetPid}; observing again`);
          if (await raceGone(deps.sleep(policy.nextDelayMs()), exitSignal) === GONE) return { outcome: "target_exited" };
          continue;
        }
        if (!matchesProbeTarget(finalRuntime, deps.targetPid, target)) {
          settle({ ...entry, state: "skipped" });
          return standDown("the recorded probe endpoint changed before termination");
        }
        const result = deps.terminateTarget();
        if (result === "not_target") {
          settle({ ...entry, state: "skipped" });
          return { outcome: "target_exited" };
        }
        if (result === "failed") {
          settle({ ...entry, state: "failed" });
          return standDown("termination was refused");
        }
        const exited = (await raceGone(deps.sleep(EXIT_WAIT_MS), exitSignal)) === GONE || deps.isTargetGone();
        const state: RecoveryState = exited ? "terminated" : "unconfirmed";
        settle({ ...entry, state });
        deps.log(exited ? `pid ${deps.targetPid} exited` : `pid ${deps.targetPid} did not exit within ${EXIT_WAIT_MS / 1000}s`);
        return { outcome: "recovered", state };
      }
    }
    if (await raceGone(deps.sleep(policy.nextDelayMs()), exitSignal) === GONE) return { outcome: "target_exited" };
  }
}

function isRecoveryEntry(value: unknown): value is RecoveryEntry {
  const entry = value as RecoveryEntry | null;
  return typeof entry === "object" && entry !== null
    && typeof entry.at === "number" && Number.isFinite(entry.at)
    && typeof entry.pid === "number" && Number.isSafeInteger(entry.pid)
    && RECOVERY_STATES.includes(entry.state);
}

/** Recovery entries, `[]` when no history exists, null when one exists but cannot be read. */
export function readRecoveryEntries(path: string): RecoveryEntry[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  try {
    const parsed = JSON.parse(raw) as { recoveries?: unknown };
    if (!Array.isArray(parsed.recoveries) || !parsed.recoveries.every(isRecoveryEntry)) return null;
    return parsed.recoveries.slice(-HISTORY_LIMIT);
  } catch {
    return null;
  }
}

/** Times of recoveries that count toward the cap. */
export function countedRecoveryTimes(entries: readonly RecoveryEntry[]): number[] {
  return entries.filter(entry => entry.state !== "skipped").map(entry => entry.at);
}

/**
 * Durably write `entry`, replacing the entry with the same time and pid. The temp file is synced
 * before the rename, so a crash leaves either the old history or the new one. Writers are
 * serialized by the ownership lease the runner holds around the intent write.
 */
export function writeRecoveryEntry(path: string, entry: RecoveryEntry): boolean {
  const existing = readRecoveryEntries(path);
  if (existing === null) return false;
  const others = existing.filter(item => item.at !== entry.at || item.pid !== entry.pid);
  const recoveries = [...others, entry].sort((a, b) => a.at - b.at).slice(-HISTORY_LIMIT);
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor: number | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    descriptor = openSync(temporary, "w", 0o600);
    writeSync(descriptor, `${JSON.stringify({ recoveries })}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    // The rename is the publication; a storage error here means it may not survive a crash.
    return syncDirectory(dirname(path));
  } catch {
    if (descriptor !== null) { try { closeSync(descriptor); } catch { /* already closed */ } }
    try { unlinkSync(temporary); } catch { /* absent */ }
    return false;
  }
}

/** Codes that mean "this filesystem does not sync directories", not "the write may be lost". */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EBADF"]);

/**
 * Publish a rename durably. Windows cannot open a directory for fsync, and some filesystems
 * refuse it; both are treated as supported-as-far-as-possible. Any other failure (EIO, ENOSPC...)
 * is a storage error and is reported, so no termination follows an intent that may be lost.
 */
export function syncDirectory(path: string, io: { open?: typeof openSync; fsync?: typeof fsyncSync } = {}): boolean {
  if (process.platform === "win32") return true;
  let descriptor: number | null = null;
  try {
    descriptor = (io.open ?? openSync)(path, "r");
    (io.fsync ?? fsyncSync)(descriptor);
    return true;
  } catch (error) {
    return DIRECTORY_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "");
  } finally {
    if (descriptor !== null) { try { closeSync(descriptor); } catch { /* already closed */ } }
  }
}

export function appendBoundedLog(path: string, line: string, now = new Date()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    let size = 0;
    try { size = statSync(path).size; } catch { /* absent */ }
    const entry = `[${now.toISOString()}] ${line}\n`;
    if (size + entry.length > LOG_CAP_BYTES) writeFileSync(path, entry, "utf8");
    else writeFileSync(path, entry, { encoding: "utf8", flag: "a" });
  } catch {
    // Logging must never stop the sentinel.
  }
}

export function readSentinelRuntime(path: string): SentinelRuntimeRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { pid, port, hostname } = parsed;
    if (hostname !== undefined && typeof hostname !== "string") return null;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
    if (typeof port !== "number" || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) return null;
    return { pid, port, ...(typeof hostname === "string" ? { hostname } : {}), sibling: parsed.siblingOfPort !== undefined };
  } catch {
    return null;
  }
}

/** Partial timing from the test override; anything malformed is ignored. */
export function parseTimingOverride(raw: string | undefined): Partial<HealthSentinelTiming> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const timing: Partial<HealthSentinelTiming> = {};
    for (const key of Object.keys(DEFAULT_HEALTH_SENTINEL_TIMING) as (keyof HealthSentinelTiming)[]) {
      const value = parsed[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) timing[key] = value;
    }
    return timing;
  } catch {
    return {};
  }
}

function parseStatePaths(raw: string | undefined): string[] | null {
  try {
    const parsed = JSON.parse(raw ?? "") as unknown;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(item => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/** Entry used by `bun health-sentinel-main.ts` and by the compiled binary's private entrypoint. */
export async function runHealthSentinelProcess(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const targetPid = Number(env[HEALTH_SENTINEL_ENV.targetPid]);
  const runtimePath = env[HEALTH_SENTINEL_ENV.runtimePath];
  const historyPath = env[HEALTH_SENTINEL_ENV.historyPath];
  const logPath = env[HEALTH_SENTINEL_ENV.logPath];
  const statePaths = parseStatePaths(env[HEALTH_SENTINEL_ENV.statePaths]);
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0 || !runtimePath || !historyPath || !logPath || !statePaths) return 2;
  let gone = false;
  const targetExited = new Promise<void>(resolve => {
    const done = () => { gone = true; resolve(); };
    process.stdin.on("end", done);
    process.stdin.on("close", done);
    process.stdin.on("error", done);
    process.stdin.on("data", () => { /* the proxy never writes; drain anything */ });
    process.stdin.resume();
  });
  const { acquireOwnershipMutationLease } = await import("./ownership-mutation-lease.mjs");
  let windowsHandle: import("./health-sentinel-windows").ParentProcessHandle | null = null;
  let windowsBindFailure: string | null = null;
  if (process.platform === "win32") {
    const { openParentProcessHandle } = await import("./health-sentinel-windows");
    const opened = openParentProcessHandle(targetPid);
    if (opened.ok) windowsHandle = opened.handle;
    else windowsBindFailure = opened.reason;
  }
  let linuxHandle: import("./health-sentinel-linux").ParentPidfd | null = null;
  let linuxBindFailure: string | null = null;
  if (process.platform === "linux") {
    const { openParentPidfd } = await import("./health-sentinel-linux");
    const opened = openParentPidfd(targetPid, () => !gone && process.ppid === targetPid);
    if (opened.kind === "bound") linuxHandle = opened.handle;
    else if (opened.kind === "refused") linuxBindFailure = opened.reason;
    else appendBoundedLog(logPath, `pidfd unavailable: ${opened.reason}; using live parent PID check`);
  }
  const lag = startLagMonitor();
  try {
    await runHealthSentinel({
      targetPid,
      now: Date.now,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      probe: async (target, timeoutMs) => {
        lag.reset();
        const outcome = await probeHealth(target, timeoutMs);
        return outcome.kind === "timeout" ? { ...outcome, sentinelLagMs: lag.read() } : outcome;
      },
      readRuntime: () => readSentinelRuntime(runtimePath),
      targetExited,
      closeTarget: () => { linuxHandle?.close(); windowsHandle?.close(); },
      isTargetGone: () => gone || (windowsHandle?.exited() ?? false),
      bindTarget: () => {
        // POSIX: Bun reads the parent id live, and it stops naming the proxy once the proxy exits.
        // Windows: it is the creating parent's id, so the handle below carries the identity.
        if (process.ppid !== targetPid) return { ok: false, reason: "the sentinel is not the watched process's child" };
        if (linuxBindFailure) return { ok: false, reason: linuxBindFailure };
        if (process.platform !== "win32") return { ok: true };
        return windowsHandle ? { ok: true } : { ok: false, reason: windowsBindFailure ?? "the parent process cannot be opened" };
      },
      terminateTarget: () => {
        if (process.platform === "win32") {
          if (!windowsHandle) return "failed";
          return windowsHandle.terminate(1) ? "terminated" : "failed";
        }
        if (gone || process.ppid !== targetPid) return "not_target";
        if (linuxHandle) return linuxHandle.terminate();
        try {
          process.kill(targetPid, "SIGKILL");
          return "terminated";
        } catch {
          return "failed";
        }
      },
      withOwnershipLease: run => {
        let lease: { release(): void };
        try {
          lease = acquireOwnershipMutationLease(statePaths, { waitMs: LEASE_WAIT_MS, processImage: () => null });
        } catch {
          return "busy";
        }
        try { return run(); } finally { lease.release(); }
      },
      readHistory: () => {
        const entries = readRecoveryEntries(historyPath);
        return entries === null ? null : countedRecoveryTimes(entries);
      },
      writeHistory: entry => writeRecoveryEntry(historyPath, entry),
      log: line => appendBoundedLog(logPath, linuxHandle && line.startsWith("watching pid ") ? `${line} (pidfd)` : line),
      timing: parseTimingOverride(env[HEALTH_SENTINEL_ENV.timing]),
    });
  } finally {
    lag.stop();
  }
  return 0;
}

if (import.meta.main) process.exit(await runHealthSentinelProcess());
