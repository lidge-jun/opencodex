/**
 * Restarting the Codex app you are running inside.
 *
 * The self-ancestry guard is correct to refuse a direct restart: terminating your own
 * tree kills the command mid-flight and leaves the operator with neither a restarted
 * app nor an explanation. But on a developer machine that refusal fires in the normal
 * case, not a corner case - the measured shell is
 * `zsh -> bundled codex app-server -> ChatGPT -> launchd`, so anything run from a Codex
 * terminal or agent session is inside the tree. Without a handoff, the merged
 * `--restart-codex` would refuse in exactly the situation that produced the original
 * "it does nothing" report.
 *
 * So the refusal becomes a handoff: a detached helper outlives the caller, waits for it
 * to exit, re-enumerates, and performs the restart from outside the tree.
 *
 * Two things make the helper safe to kill the app around:
 *
 * - It waits for the calling process to exit first. At that moment it is orphaned and
 *   reparented, so it is no longer reachable by a tree walk from the app root. This
 *   matters most on Windows, where `taskkill /T` follows live parent links and never
 *   reparents orphans.
 * - It re-runs the ancestry check itself rather than trusting the caller's finding, and
 *   it passes `allowHandoff: false` so it can only ever take the direct path or refuse.
 *   Recursion is structurally impossible rather than merely unlikely.
 *
 * Design: devlog/_plan/260913_cross_platform_desktop_app_restart/020_phase2_detached_self_handoff.md
 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getConfigDir } from "../../config/paths";
import {
  readDesktopRestartLockOwner,
  releaseDesktopRestartLock,
  transferDesktopRestartLock,
  type DesktopRestartLockIo,
} from "./lock";

/** How long the helper waits for its caller to exit before giving up. */
const CALLER_EXIT_TIMEOUT_MS = 20_000;
const CALLER_POLL_MS = 100;
/** A plan older than this is not ours to run. */
const PLAN_MAX_AGE_MS = 5 * 60_000;

export interface DesktopRestartHandoffPlan {
  schemaVersion: 1;
  /** Pid the helper waits on before acting. */
  callerPid: number;
  createdAtMs: number;
}

export type HandoffStartOutcome =
  | { kind: "started"; helperPid: number; logPath: string }
  | { kind: "failed"; reason: "no_executable" | "plan_write_failed" | "spawn_failed" | "lock_transfer_failed" };

export interface HandoffIo {
  now?: () => number;
  pid?: number;
  execPath?: string;
  argv?: readonly string[];
  homeDir?: string;
  lock?: DesktopRestartLockIo;
  spawnHelper?: (command: string, args: readonly string[]) => { pid?: number | undefined; unref(): void };
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => void;
}

export function handoffLogPath(io: HandoffIo = {}): string {
  return join(io.homeDir ?? getConfigDir(), "desktop-restart-handoff.log");
}

/**
 * How to re-invoke this CLI as the helper.
 *
 * `process.execPath` alone is not enough, because it differs between running from a
 * checkout, through the installed npm shim, and as a packaged binary. Resolution is
 * explicit and a failure to resolve is a REFUSAL rather than a guess: spawning the
 * wrong interpreter with a path that does not exist produces a helper that exits
 * immediately and an operator who was told the restart was handed off.
 */
export function resolveHelperCommand(io: HandoffIo = {}): { command: string; args: string[] } | null {
  const execPath = io.execPath ?? process.execPath;
  const argv = io.argv ?? process.argv;
  const entry = argv[1];
  if (entry && existsSync(entry)) return { command: execPath, args: [entry] };
  if (basename(execPath).replace(/\.exe$/i, "") === "ocx") return { command: execPath, args: [] };
  return null;
}

function writePlan(path: string, plan: DesktopRestartHandoffPlan): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Exclusive create: the path is handed to another process, so it must not be
    // possible to hand over a file somebody else authored.
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(plan));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function startDesktopRestartHandoff(io: HandoffIo = {}): HandoffStartOutcome {
  const resolved = resolveHelperCommand(io);
  if (!resolved) return { kind: "failed", reason: "no_executable" };

  const now = io.now ?? Date.now;
  const callerPid = io.pid ?? process.pid;
  const home = io.homeDir ?? getConfigDir();
  const planPath = join(home, `desktop-restart-handoff-${callerPid}-${Math.random().toString(36).slice(2)}.json`);
  const plan: DesktopRestartHandoffPlan = { schemaVersion: 1, callerPid, createdAtMs: now() };
  if (!writePlan(planPath, plan)) return { kind: "failed", reason: "plan_write_failed" };

  const args = [...resolved.args, "internal", "desktop-restart-handoff", "--plan", planPath];
  let child: { pid?: number | undefined; unref(): void };
  try {
    child = (io.spawnHelper ?? defaultSpawnHelper)(resolved.command, args);
  } catch {
    try { unlinkSync(planPath); } catch { /* best effort */ }
    return { kind: "failed", reason: "spawn_failed" };
  }
  if (child.pid === undefined) {
    // A detached child reports a failed launch asynchronously, to a parent that is about
    // to exit. An absent pid is the only synchronous evidence the spawn happened.
    try { unlinkSync(planPath); } catch { /* best effort */ }
    return { kind: "failed", reason: "spawn_failed" };
  }
  child.unref();

  // Hand the lock over only AFTER a successful spawn. Doing it earlier would strand the
  // lock on a pid that never came into being, and the next restart would have to wait
  // out the staleness window for nothing.
  //
  // A FAILED transfer is not cosmetic. The lock would still name this process, which is
  // about to exit, so it reads as stale for the whole helper wait and a concurrent
  // restart could reclaim it and run a second ladder - the dual-kill the lock exists to
  // prevent. Reporting failure here is safe because the helper independently refuses to
  // act unless the lock names IT, so the spawned process becomes a no-op rather than an
  // unsupervised restart.
  if (!transferDesktopRestartLock(child.pid, io.lock)) {
    return { kind: "failed", reason: "lock_transfer_failed" };
  }
  return { kind: "started", helperPid: child.pid, logPath: handoffLogPath(io) };
}

const defaultSpawnHelper = (command: string, args: readonly string[]): { pid?: number | undefined; unref(): void } =>
  spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });

export type HandoffRunOutcome =
  | "restarted"
  | "caller_still_running"
  | "plan_unreadable"
  | "plan_expired"
  | "not_lock_owner"
  | "restart_incomplete";

function readPlan(path: string): DesktopRestartHandoffPlan | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const view = parsed as Record<string, unknown>;
    if (view.schemaVersion !== 1) return null;
    const callerPid = view.callerPid;
    const createdAtMs = view.createdAtMs;
    if (typeof callerPid !== "number" || !Number.isSafeInteger(callerPid) || callerPid <= 0) return null;
    if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return null;
    return { schemaVersion: 1, callerPid, createdAtMs };
  } catch {
    return null;
  }
}

/** True when the path is inside the opencodex home AND named like a plan this CLI writes. */
export function isOwnPlanPath(planPath: string, io: HandoffIo = {}): boolean {
  const home = io.homeDir ?? getConfigDir();
  let resolvedPlan: string;
  let resolvedHome: string;
  try {
    resolvedHome = resolve(home);
    resolvedPlan = resolve(planPath);
  } catch {
    return false;
  }
  if (dirname(resolvedPlan) !== resolvedHome) return false;
  return /^desktop-restart-handoff-\d+-[a-z0-9]+\.json$/.test(basename(resolvedPlan));
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Append one JSON line per run. Counts, never command lines or OS error text: the same
 * projection the management restart response already applies, for the same reason.
 */
function appendLog(io: HandoffIo, entry: Record<string, unknown>): void {
  try {
    const path = handoffLogPath(io);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: new Date((io.now ?? Date.now)()).toISOString(), ...entry }) + "\n");
  } catch {
    /* the restart matters more than the record of it */
  }
}

export interface HandoffRunIo extends HandoffIo {
  restart?: (allowHandoff: false) => { relaunch: "started" | "skipped"; reason?: string; stopped: number[]; surviving: number[] };
  readLockOwner?: () => number | null;
}

export async function runDesktopRestartHandoff(
  planPath: string,
  io: HandoffRunIo = {},
): Promise<HandoffRunOutcome> {
  const now = io.now ?? Date.now;
  const self = io.pid ?? process.pid;
  // Only ever touch a file this CLI could have written. Unlinking whatever --plan points
  // at turned a hidden helper command into an unlink oracle: a same-uid caller could pass
  // a config path and have it deleted on the way to being told the plan was unreadable.
  if (!isOwnPlanPath(planPath, io)) {
    appendLog(io, { outcome: "plan_unreadable" });
    releaseDesktopRestartLock(io.lock);
    return "plan_unreadable";
  }
  const plan = readPlan(planPath);
  // Unlink only AFTER the shape is confirmed, so a file that merely lives in the right
  // directory under the right name is still not destroyed by a malformed read.
  if (plan) {
    try { unlinkSync(planPath); } catch { /* the plan is single-use either way */ }
  }
  if (!plan) {
    appendLog(io, { outcome: "plan_unreadable" });
    releaseDesktopRestartLock(io.lock);
    return "plan_unreadable";
  }
  if (now() - plan.createdAtMs > PLAN_MAX_AGE_MS) {
    // A plan left behind by a crash must not restart the app hours later.
    appendLog(io, { outcome: "plan_expired" });
    releaseDesktopRestartLock(io.lock);
    return "plan_expired";
  }

  const isAlive = io.isAlive ?? defaultIsAlive;
  const sleep = io.sleep ?? defaultSleep;
  const deadline = now() + CALLER_EXIT_TIMEOUT_MS;
  // Bounded by polls as well as by the clock. The clock alone is not enough: if sleep
  // does not actually advance time - a frozen clock, a no-op sleep - this becomes a hot
  // spin that never exits, inside a detached process nobody is watching.
  const maxPolls = Math.ceil(CALLER_EXIT_TIMEOUT_MS / CALLER_POLL_MS) + 1;
  for (let poll = 0; poll < maxPolls && now() < deadline && isAlive(plan.callerPid); poll++) {
    sleep(CALLER_POLL_MS);
  }
  if (isAlive(plan.callerPid)) {
    // A caller that outlives the window is not the short-lived `ocx sync` this was built
    // for, and quitting the app out from under an unknown long-running process is not
    // something to guess about.
    appendLog(io, { outcome: "caller_still_running", callerPid: plan.callerPid });
    releaseDesktopRestartLock(io.lock);
    return "caller_still_running";
  }

  // The lock must name THIS process. It was made out to us by the caller; if it names
  // anybody else, the transfer failed or somebody reclaimed it, and acting now would be
  // the unsynchronised second ladder the lock exists to prevent.
  const owner = (io.readLockOwner ?? (() => readDesktopRestartLockOwner(io.lock)))();
  if (owner !== self) {
    appendLog(io, { outcome: "not_lock_owner" });
    return "not_lock_owner";
  }

  try {
    const restart = io.restart
      ? io.restart(false)
      : (await import("../desktop-app-restart")).restartCodexDesktopApp({
        allowHandoff: false,
        lock: io.lock,
      });
    const ok = restart.relaunch === "started";
    appendLog(io, {
      outcome: ok ? "restarted" : "restart_incomplete",
      reason: restart.reason,
      stopped: restart.stopped.length,
      surviving: restart.surviving.length,
    });
    return ok ? "restarted" : "restart_incomplete";
  } finally {
    releaseDesktopRestartLock(io.lock);
  }
}

