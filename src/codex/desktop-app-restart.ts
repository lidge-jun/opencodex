/**
 * Full restart of the Codex desktop app (the Electron shell) on macOS, Linux and
 * Windows.
 *
 * WHY THIS EXISTS AT ALL. `--restart-codex` used to signal only `codex app-server` /
 * `codex-code-mode-host` processes, and on every platform that turns out not to
 * refresh the model picker. The app-server it signals is a CHILD of the desktop app
 * (measured: pid 16733 under pid 15901 on macOS, 3285204 under 3284901 on Linux), so
 * the app simply respawns it while the renderer keeps the roster it built at launch.
 * The matcher was never the problem; the only thing that reliably refreshes the
 * picker is restarting the shell that owns it.
 *
 * WHY THE CONSENT CHANGED. This capability was deliberately kept behind a separate
 * Windows-only `--restart-desktop-app` flag, because quitting the app ends live
 * conversations and that is a larger consent than restarting a background helper.
 * That reasoning was sound and has been superseded by an explicit maintainer
 * decision: `--restart-codex` now means the app is fully stopped and started again.
 * The narrow behaviour did not disappear, it moved to `--restart-app-server-only`.
 *
 * WHAT IS SHARED AND WHAT IS NOT. The ladder below — discover, enumerate, find
 * shells, check self-ancestry, graceful, wait, re-verify identity, force, wait,
 * refuse-or-relaunch — is identical on all three platforms. Only identity,
 * discovery, membership, the two stop primitives and relaunch differ, and those live
 * behind DesktopAppAdapter. Re-deriving the PID-reuse and fail-closed reasoning once
 * per operating system is how two of the three end up subtly wrong.
 *
 * EVERYTHING FAILS CLOSED. A failed discovery, a failed enumeration, an unreadable
 * process identity or an unreadable ancestry chain never authorises a kill and is
 * never reported as "nothing to do". A stale picker is a much smaller problem than a
 * wrongly killed process.
 *
 * Design and audit history: devlog/_plan/260913_cross_platform_desktop_app_restart/.
 */
import {
  acquireDesktopRestartLock,
  releaseDesktopRestartLock,
  type DesktopRestartLockIo,
} from "./desktop-app/lock";
import { rootShells, type DesktopAppAdapter, type DesktopExec, type DesktopProcess } from "./desktop-app/types";
import { darwinDesktopAppAdapter, darwinDefaultExec } from "./desktop-app/darwin";
import { linuxDesktopAppAdapter, linuxDefaultExec } from "./desktop-app/linux";
import { windowsDesktopAppAdapter, windowsDefaultExec } from "./desktop-app/windows";

export type { DesktopAppExecOptions } from "./desktop-app/types";

/** How long a graceful close is given before the forced pass. */
const GRACEFUL_EXIT_TIMEOUT_MS = 15_000;
/** How long a forced kill is given before the target counts as surviving. */
const FORCED_EXIT_TIMEOUT_MS = 5_000;

export interface DesktopAppRestartHandoff {
  helperPid: number;
  logPath: string;
}

export interface DesktopAppRestartIo {
  platform?: NodeJS.Platform;
  /** Overrides the adapter chosen from `platform`. Tests drive every branch through this. */
  adapter?: DesktopAppAdapter;
  execFile?: DesktopExec;
  /** Process ancestry of the current process, innermost first. Used for the self-kill guard. */
  ancestryPids?: () => number[];
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => void;
  now?: () => number;
  lock?: DesktopRestartLockIo;
  /**
   * Hand the restart to a detached helper when this process is inside the tree.
   * Supplied by wp5; absent here means the ladder refuses instead, which is the
   * behaviour that shipped before the handoff existed.
   */
  startHandoff?: () => DesktopAppRestartHandoff | null;
  /**
   * False forbids a handoff. The helper passes it so recursion is structurally
   * impossible, and the management service passes it because it runs inside a proxy
   * that never exits — a handoff waiting for the caller to exit would always time out
   * after telling the operator it had been handed off.
   */
  allowHandoff?: boolean;
}

export type DesktopAppRestartReason =
  | "unsupported_platform"
  | "package_discovery_failed"
  | "process_probe_failed"
  | "no_targets"
  | "self_ancestry"
  | "restart_in_flight"
  | "handoff_started"
  | "targets_survived"
  | "relaunch_failed";

export interface DesktopAppRestartResult {
  attempted: boolean;
  stopped: number[];
  surviving: number[];
  relaunch: "started" | "skipped";
  reason?: DesktopAppRestartReason;
  handoff?: DesktopAppRestartHandoff;
}

const ADAPTERS: Partial<Record<NodeJS.Platform, { adapter: DesktopAppAdapter; exec: DesktopExec }>> = {
  darwin: { adapter: darwinDesktopAppAdapter, exec: darwinDefaultExec },
  linux: { adapter: linuxDesktopAppAdapter, exec: linuxDefaultExec },
  win32: { adapter: windowsDesktopAppAdapter, exec: windowsDefaultExec },
};

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
 * True when the pid still names the process we verified.
 *
 * Between listing and signalling there is a graceful-close window long enough for the
 * OS to recycle a pid, and the next step is a hard kill. A pid alone is not an
 * identity across that window; the start-time token is what distinguishes a process
 * from its replacement.
 */
type IdentityCheck = "same" | "gone" | "unknown";

function checkIdentity(
  adapter: DesktopAppAdapter,
  exec: DesktopExec,
  install: Parameters<DesktopAppAdapter["listProcesses"]>[1],
  target: DesktopProcess,
): IdentityCheck {
  const processes = adapter.listProcesses(exec, install);
  // THREE outcomes, not two. Collapsing them into a boolean is what made this ladder
  // claim a restart it never performed: a re-probe that could not RUN looked identical
  // to a process that had exited, and the caller recorded the pid as stopped, skipped
  // the forced pass, and relaunched into an app that was still running - reporting
  // success the whole way. Measured on a real Windows host, where the app kept its
  // original pid and start time through a restart that said it had stopped it.
  if (processes === null) return "unknown";
  const current = processes.find(entry => entry.pid === target.pid);
  if (current === undefined) return "gone";
  // Same pid, different start time: the pid was recycled and now belongs to somebody
  // else. Treated as gone, because the process we meant to stop no longer exists and
  // signalling this pid would hit an unrelated process.
  return current.createdAt === target.createdAt ? "same" : "gone";
}

/**
 * Pids of the running desktop-app tree, or null when discovery or the probe failed.
 *
 * Read-only. Used by the CLI to exclude app-servers the desktop restart is about to
 * take anyway, so an operator\u2019s in-flight turn is not interrupted twice in one command.
 */
/**
 * Poll the platform's own process list until it stops listing this process.
 *
 * A single post-kill enumeration is not enough. Measured on Windows: `taskkill /T /F`
 * succeeds, the process is genuinely dead a moment later, and yet the very next
 * `Win32_Process` query still lists it. Checking once turned that lag into a reported
 * survivor, which blocked the relaunch and left the machine with no app at all - the
 * failure mode is the mirror of claiming a stop that never happened, and just as bad.
 *
 * Liveness is polled first because it is cheap; the enumeration is what decides. A probe
 * that cannot run keeps the loop going rather than deciding either way, and if the
 * deadline passes without a clean "gone" the caller treats it as a survivor.
 */
function waitUntilGone(
  adapter: DesktopAppAdapter,
  exec: DesktopExec,
  install: Parameters<DesktopAppAdapter["listProcesses"]>[1],
  target: DesktopProcess,
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => void,
  now: () => number,
): boolean {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (!isAlive(target.pid) && checkIdentity(adapter, exec, install, target) === "gone") return true;
    if (now() >= deadline) break;
    sleep(250);
  }
  // One last look after the deadline, so a process that exited during the final sleep is
  // not reported as surviving purely because of poll timing.
  return checkIdentity(adapter, exec, install, target) === "gone";
}

export function listCodexDesktopAppPids(io: DesktopAppRestartIo = {}): number[] | null {
  const platform = io.platform ?? process.platform;
  const selected = ADAPTERS[platform];
  const adapter = io.adapter ?? selected?.adapter;
  if (!adapter) return null;
  const exec = io.execFile ?? selected?.exec;
  if (!exec) return null;
  const install = adapter.discover(exec);
  if (!install) return null;
  const processes = adapter.listProcesses(exec, install);
  return processes === null ? null : processes.map(entry => entry.pid);
}

export function restartCodexDesktopApp(io: DesktopAppRestartIo = {}): DesktopAppRestartResult {
  const skipped = (reason: DesktopAppRestartReason): DesktopAppRestartResult => ({
    attempted: false, stopped: [], surviving: [], relaunch: "skipped", reason,
  });

  const platform = io.platform ?? process.platform;
  const selected = ADAPTERS[platform];
  const adapter = io.adapter ?? selected?.adapter;
  const exec = io.execFile ?? selected?.exec;
  if (!adapter || !exec) return skipped("unsupported_platform");

  // Step 0. Two restarts at once are destructive rather than merely wasteful: the
  // first quits and relaunches, the second sees the freshly started shell as a target
  // and kills it. Own-pid reentrancy means the wp5 helper runs this same step and
  // finds the lock its caller made out to it.
  const acquisition = acquireDesktopRestartLock(io.lock);
  if (!acquisition.acquired) return skipped("restart_in_flight");

  let handedOff = false;
  try {
    const install = adapter.discover(exec);
    if (!install) return skipped("package_discovery_failed");

    const processes = adapter.listProcesses(exec, install);
    // A probe that could not run is not evidence of absence. Reporting it as no_targets
    // told users the app was not running and silently skipped the restart they asked
    // for (#2557).
    if (processes === null) return skipped("process_probe_failed");

    const shells = rootShells(processes, install, adapter);
    if (shells.length === 0) return skipped("no_targets");

    const ancestryPids = io.ancestryPids ? io.ancestryPids() : adapter.ancestryPids(exec);
    // An empty chain means "could not establish that we are outside the tree", which
    // covers both an unreadable hop and a walk that hit its bound.
    const insideTree = ancestryPids.length === 0
      || processes.some(entry => ancestryPids.includes(entry.pid));
    if (insideTree) {
      if (io.allowHandoff === false || !io.startHandoff) return skipped("self_ancestry");
      const handoff = io.startHandoff();
      if (!handoff) return skipped("self_ancestry");
      handedOff = true;
      return {
        attempted: false, stopped: [], surviving: [],
        relaunch: "skipped", reason: "handoff_started", handoff,
      };
    }

    // Captured while the tree is still ALIVE. On Linux the relaunch needs the
    // graphical session variables, and after termination there is nothing to read them
    // from. Ordering this wrongly works on macOS and Windows and produces a Linux app
    // that cannot reach the compositor.
    const context = adapter.captureRelaunchContext(exec, install, processes);

    const isAlive = io.isAlive ?? defaultIsAlive;
    const sleep = io.sleep ?? defaultSleep;
    const now = io.now ?? (() => Date.now());
    const stopped: number[] = [];
    const surviving: number[] = [];

    for (const shell of shells) {
      const pid = shell.pid;
      // The listing is already one probe old.
      const before = checkIdentity(adapter, exec, install, shell);
      if (before === "gone") {
        stopped.push(pid);
        continue;
      }
      if (before === "unknown") {
        // We could not look, so we cannot claim this exited and we must not signal a
        // process we failed to re-verify. Reporting it as surviving is the honest answer:
        // it blocks the relaunch, which is exactly right when the tree state is unknown.
        surviving.push(pid);
        continue;
      }
      try {
        adapter.requestQuit(exec, install, shell);
      } catch {
        /* a refused graceful close still gets the forced pass below */
      }
      // Liveness AND enumeration have to agree before a stop is claimed. A pid-based
      // liveness probe is a weaker instrument than the platform's own process list, and
      // on a packaged app the two disagree in BOTH directions.
      if (waitUntilGone(adapter, exec, install, shell, GRACEFUL_EXIT_TIMEOUT_MS, isAlive, sleep, now)) {
        stopped.push(pid);
        continue;
      }
      // The wait window is long enough for a pid to be recycled, and the next step is a
      // hard kill. Confirm it is still the process we verified, or leave it alone.
      const afterGraceful = checkIdentity(adapter, exec, install, shell);
      if (afterGraceful === "gone") {
        stopped.push(pid);
        continue;
      }
      if (afterGraceful === "unknown") {
        surviving.push(pid);
        continue;
      }
      try {
        adapter.forceStop(exec, shell);
      } catch {
        /* the process state decides, not the exit code */
      }
      // Same rule after the forced pass: only an enumeration that no longer contains this
      // process proves it stopped. Everything else is a survivor, and a survivor blocks
      // the relaunch rather than producing a second shell beside a live one.
      if (waitUntilGone(adapter, exec, install, shell, FORCED_EXIT_TIMEOUT_MS, isAlive, sleep, now)) {
        stopped.push(pid);
      } else {
        surviving.push(pid);
      }
    }

    if (surviving.length > 0) {
      // Launching a second shell beside a stuck one is worse than leaving the operator
      // to restart it.
      return { attempted: true, stopped, surviving, relaunch: "skipped", reason: "targets_survived" };
    }

    try {
      adapter.relaunch(exec, install, context);
    } catch {
      // Distinct from targets_survived on purpose. Everything DID die and the relaunch
      // is what failed; the old code reported the two as one and sent operators looking
      // for processes that were not there.
      return { attempted: true, stopped, surviving, relaunch: "skipped", reason: "relaunch_failed" };
    }
    return { attempted: true, stopped, surviving: [], relaunch: "started" };
  } finally {
    // On the handoff path ownership was transferred to the helper, so releasing here
    // would drop a lock that is still protecting a restart about to happen.
    if (!handedOff) releaseDesktopRestartLock(io.lock);
  }
}

