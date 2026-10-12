/**
 * Spawning the detached `ocx start` that replaces this process: the parent side of a restart handoff.
 *
 * Shared by the dashboard drain-and-restart (`src/server/management/system-restart.ts`, which is also
 * how a join into a Child restarts) and the client runtime's standalone recycle
 * (`src/client/runtime.ts`). Deliberately lean: the client runtime loads it only at recycle time and
 * must not pull the server lifecycle graph in with it.
 *
 * Every replacement carries `OCX_RESTART_PARENT_PID`, so a replacement that still finds this process
 * answering on the port waits for it instead of refusing it (`src/cli/restart-handoff.ts`).
 *
 * A handoff that waits for health (the drain completed) retries a replacement that exits before it
 * answers, at most {@link REPLACEMENT_EARLY_EXIT_RETRIES} more times inside the one readiness
 * budget: the port a restart hands over can still be draining, and one refused start used to end the
 * whole handoff. A parent-exit handoff resolves once the child spawned and is never retried; the
 * replacement's own parent wait and port reclaim cover it. A spawn error is not retried; it does not
 * change between attempts.
 *
 * The replacement's stdout and stderr go to `<configDir>/restart-handoff.log` instead of nowhere, so
 * a switch that failed can be diagnosed. The file is private (0600, created in the private config
 * directory, never opened through a symlink) and bounded at {@link RESTART_HANDOFF_LOG_MAX_BYTES} on
 * both sides: a handoff empties it before it opens it, and the replacement, which keeps writing to
 * it for its whole life, checks it once a minute ({@link RESTART_HANDOFF_LOG_ENV},
 * {@link armRestartHandoffLogCap}). The parent writes only timestamps, pids, ports, attempt counts,
 * exit codes and errno codes, never an environment value; the replacement writes what an `ocx start`
 * prints to a terminal. A log that cannot be opened never blocks the handoff: the output is
 * discarded as before.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { REPLACEMENT_READY_TIMEOUT_MS, withRestartParentMarker } from "../lib/system-restart-contract";
import { findLiveProxy } from "./proxy-liveness";

export const RESTART_HANDOFF_LOG_FILENAME = "restart-handoff.log";
export const RESTART_HANDOFF_LOG_MAX_BYTES = 256 * 1024;
/**
 * Set to `1` on a replacement whose stdout and stderr are the handoff log. `handleStart` consumes it
 * and arms {@link armRestartHandoffLogCap}, so the file stays bounded after the parent that opened it
 * is gone. A hand-set value only makes that start cap the private handoff log.
 */
export const RESTART_HANDOFF_LOG_ENV = "OCX_RESTART_HANDOFF_LOG";
/** How often a replacement writing into the handoff log checks its size: one lstat per tick. */
export const RESTART_HANDOFF_LOG_CHECK_MS = 60_000;
/** Respawns after an early exit, on top of the first attempt. */
export const REPLACEMENT_EARLY_EXIT_RETRIES = 2;
const REPLACEMENT_RETRY_DELAY_MS = 1_000;
const REPLACEMENT_READY_POLL_MS = 150;

export interface ReplacementReadinessIo {
  findLive?: typeof findLiveProxy;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One absolute deadline for every attempt of a handoff; defaults to now + the readiness budget. */
  deadlineAt?: number;
  /** Stops polling once the attempt it serves has already settled (the replacement exited). */
  cancelled?: () => boolean;
}

export async function waitForReplacementReady(
  expectedPid: number | undefined,
  parentPid: number,
  expectedPort: number | undefined,
  io: ReplacementReadinessIo = {},
): Promise<boolean> {
  const findLive = io.findLive ?? findLiveProxy;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? Bun.sleep;
  const deadline = io.deadlineAt ?? now() + REPLACEMENT_READY_TIMEOUT_MS;
  while (now() < deadline) {
    if (io.cancelled?.()) return false;
    try {
      const live = await findLive({
        deadlineAt: deadline,
        nowFn: now,
        sleepFn: sleep,
      });
      // A probe that began within budget can still return after it. Never accept
      // delayed health as proof once the shared absolute handoff budget expired.
      if (now() >= deadline) return false;
      if (
        live
        && live.pid !== null
        && live.pid !== parentPid
        && (expectedPid === undefined || live.pid === expectedPid)
        && (expectedPort === undefined || live.port === expectedPort)
      ) {
        return true;
      }
    } catch {
      // A not-yet-bound replacement is indistinguishable from a transient
      // liveness failure here; keep polling inside the one bounded window.
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(REPLACEMENT_READY_POLL_MS, remainingMs));
  }
  return false;
}

export interface RestartHandoffLog {
  readonly fd: number;
  note(line: string): void;
  close(): void;
}

export function restartHandoffLogPath(configDir: string = getConfigDir()): string {
  return join(configDir, RESTART_HANDOFF_LOG_FILENAME);
}

/**
 * Empty the handoff log once it has reached the cap; below the cap this is one lstat. The truncation
 * goes through a fresh non-append descriptor, never through a symlink, so it also works where an
 * append handle cannot truncate (Windows). Every writer's append descriptor carries on at the new end.
 * Returns true when it emptied the file.
 */
export function emptyRestartHandoffLogIfFull(path: string, now: () => number = Date.now): boolean {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < RESTART_HANDOFF_LOG_MAX_BYTES) return false;
    fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return false;
    ftruncateSync(fd, 0);
    writeSync(fd, `[${new Date(now()).toISOString()}] log emptied at the ${RESTART_HANDOFF_LOG_MAX_BYTES / 1024} KiB cap\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Open the handoff log for appending: private, never through a symlink, and emptied first when it
 * has reached the cap. Returns null when it cannot be opened safely.
 */
export function openRestartHandoffLog(path: string, now: () => number = Date.now): RestartHandoffLog | null {
  emptyRestartHandoffLogIfFull(path, now);
  let fd: number | undefined;
  try {
    // O_NOFOLLOW turns a planted symlink into an open error instead of a write somewhere else.
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(path, flags, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      return null;
    }
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    const handle = fd;
    return {
      fd: handle,
      note(line: string) {
        try { writeSync(handle, `[${new Date(now()).toISOString()}] ${line}\n`); } catch { /* diagnostics only */ }
      },
      close() {
        try { closeSync(handle); } catch { /* already closed */ }
      },
    };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    return null;
  }
}

export interface RestartHandoffLogCapIo {
  /** The log to bound; default: the config-dir handoff log. */
  path?: string;
  intervalMs?: number;
}

/**
 * The replacement side of the log bound. A replacement whose parent sent its output to the handoff
 * log keeps writing there for its whole life, long after that parent exited, so it checks the file
 * itself from one low-frequency, unref'd timer and empties it at the cap. Consumes
 * {@link RESTART_HANDOFF_LOG_ENV} so no later child inherits it; a start without the flag (every
 * ordinary start) arms nothing. Returns a stop function, or null when nothing was armed.
 */
export function armRestartHandoffLogCap(
  env: Record<string, string | undefined>,
  io: RestartHandoffLogCapIo = {},
): (() => void) | null {
  const flagged = env[RESTART_HANDOFF_LOG_ENV] === "1";
  delete env[RESTART_HANDOFF_LOG_ENV];
  if (!flagged) return null;
  const path = io.path ?? restartHandoffLogPath();
  const timer = setInterval(() => { emptyRestartHandoffLogIfFull(path); }, io.intervalMs ?? RESTART_HANDOFF_LOG_CHECK_MS);
  timer.unref?.();
  return () => { clearInterval(timer); };
}

function openDefaultRestartHandoffLog(now: () => number): RestartHandoffLog | null {
  const configDir = getConfigDir();
  const path = restartHandoffLogPath(configDir);
  // Owned like crash.log, so uninstall removes it with the rest of the config directory.
  try { recordOwnedConfigPath(configDir, path); } catch { /* the log is optional */ }
  return openRestartHandoffLog(path, now);
}

export type ReplacementSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ReplacementStartIo extends ReplacementReadinessIo {
  spawnChild?: ReplacementSpawn;
  /** The handoff log file; `null` discards the replacement's output. Default: the config-dir log. */
  logPath?: string | null;
  parentPid?: number;
  retryDelayMs?: number;
}

export interface ReplacementStartRequest {
  /** The port the replacement must bind; anything that is not a TCP port starts it unpinned. */
  port?: number;
  /**
   * Wait until the replacement answers before resolving, retrying an early exit. Without it the
   * promise resolves once the child spawned, so the parent can exit and release what the
   * replacement is waiting for.
   */
  waitForHealth: boolean;
  /** The replacement's environment, already prepared by the caller; the parent marker is added here. */
  env: NodeJS.ProcessEnv;
}

type AttemptOutcome =
  | { kind: "spawned" | "ready" | "not-ready"; pid: number | undefined }
  | { kind: "early-exit"; pid: number | undefined; code: number | null; signal: NodeJS.Signals | null };

function pinnedPort(port: number | undefined): number | undefined {
  return typeof port === "number" && Number.isFinite(port) && port > 0 && port <= 65535
    ? Math.trunc(port)
    : undefined;
}

function handoffError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Stable, path-free label for a spawn failure (an errno message can carry the OS username). */
function failureLabel(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) return code;
  }
  return "spawn_failed";
}

function runReplacementAttempt(
  launchArgs: string[],
  env: NodeJS.ProcessEnv,
  logFd: number | undefined,
  waitForHealth: boolean,
  expectedPort: number | undefined,
  parentPid: number,
  io: ReplacementStartIo,
): Promise<AttemptOutcome> {
  return new Promise<AttemptOutcome>((resolve, reject) => {
    let child: ChildProcess;
    try {
      const output = logFd ?? "ignore";
      const options: SpawnOptions = {
        detached: true,
        stdio: ["ignore", output, output],
        windowsHide: true,
        env: withProcessRuntimeProvenance(env),
      };
      child = io.spawnChild
        ? io.spawnChild(process.execPath, launchArgs, options)
        : spawn(process.execPath, launchArgs, options);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("spawn", onSpawn);
    };
    const settle = (outcome: AttemptOutcome | { error: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("error" in outcome) {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill(); } catch { /* best-effort failed-start cleanup */ }
        }
        try { child.unref(); } catch { /* best-effort */ }
        reject(outcome.error);
        return;
      }
      try { child.unref(); } catch { /* best-effort */ }
      resolve(outcome);
    };
    const onError = (err: Error) => { settle({ error: err }); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle({ kind: "early-exit", pid: child.pid, code, signal });
    };
    const onSpawn = () => {
      if (!waitForHealth) {
        // The replacement may be waiting for resources only this parent's exit releases.
        settle({ kind: "spawned", pid: child.pid });
        return;
      }
      void waitForReplacementReady(child.pid, parentPid, expectedPort, { ...io, cancelled: () => settled }).then(
        // Never kill a live ordinary start at its valid reclaim boundary. Parent exit is the
        // final resource release the child may still be waiting for.
        ready => { settle({ kind: ready ? "ready" : "not-ready", pid: child.pid }); },
        err => { settle({ error: err }); },
      );
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("spawn", onSpawn);
  });
}

/**
 * Spawn this process's replacement `ocx start` and, when asked, wait until it answers. Rejects with
 * the spawn error, or with code `child_exit` once every attempt exited before it was ready.
 */
export async function spawnReplacementStart(
  request: ReplacementStartRequest,
  io: ReplacementStartIo = {},
): Promise<void> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? Bun.sleep;
  const parentPid = io.parentPid ?? process.pid;
  const expectedPort = pinnedPort(request.port);
  const launchArgs = selfLaunchArgv(expectedPort === undefined ? ["start"] : ["start", "--port", String(expectedPort)]);
  const deadlineAt = io.deadlineAt ?? now() + REPLACEMENT_READY_TIMEOUT_MS;
  const attempts = request.waitForHealth ? 1 + REPLACEMENT_EARLY_EXIT_RETRIES : 1;
  const target = expectedPort === undefined ? "an unpinned port" : `port ${expectedPort}`;
  const mode = request.waitForHealth ? "waiting for it to answer" : "exiting first";
  const log = io.logPath === null
    ? null
    : io.logPath === undefined ? openDefaultRestartHandoffLog(now) : openRestartHandoffLog(io.logPath, now);
  const env: NodeJS.ProcessEnv = withRestartParentMarker(request.env, parentPid);
  // Only a replacement that really writes into the log keeps it bounded after this parent is gone.
  if (log) env[RESTART_HANDOFF_LOG_ENV] = "1";
  else delete env[RESTART_HANDOFF_LOG_ENV];
  try {
    for (let attempt = 1; ; attempt += 1) {
      log?.note(`parent pid ${parentPid} starts a replacement on ${target} (attempt ${attempt}/${attempts}, ${mode})`);
      let outcome: AttemptOutcome;
      try {
        outcome = await runReplacementAttempt(
          launchArgs, env, log?.fd, request.waitForHealth, expectedPort, parentPid, { ...io, deadlineAt },
        );
      } catch (error) {
        log?.note(`replacement spawn failed (${failureLabel(error)})`);
        throw error;
      }
      const pid = outcome.pid ?? "unknown";
      if (outcome.kind === "early-exit") {
        log?.note(`replacement pid ${pid} exited before it answered (code ${outcome.code ?? "none"}, signal ${outcome.signal ?? "none"})`);
        const retryDelayMs = io.retryDelayMs ?? REPLACEMENT_RETRY_DELAY_MS;
        if (attempt >= attempts || now() + retryDelayMs >= deadlineAt) throw handoffError("child_exit");
        await sleep(retryDelayMs);
        continue;
      }
      if (outcome.kind === "not-ready") {
        console.warn("Restart replacement is still starting after the readiness window; handing off to it anyway");
        log?.note(`replacement pid ${pid} is still starting after the readiness window; handing off anyway`);
      } else {
        log?.note(outcome.kind === "ready" ? `replacement pid ${pid} is serving ${target}` : `replacement pid ${pid} started`);
      }
      return;
    }
  } finally {
    log?.close();
  }
}
