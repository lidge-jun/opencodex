/**
 * Platform contract for the Codex desktop-app restart.
 *
 * One ladder in `../desktop-app-restart.ts` drives every platform; the only things
 * that actually differ are identity, discovery, membership, the two stop primitives
 * and relaunch. Keeping those seven behind this interface is what stopped the
 * PID-reuse and fail-closed reasoning from being re-derived three times, once per
 * operating system, with two of the three getting it subtly wrong.
 *
 * Design and audit history: `devlog/_plan/260913_cross_platform_desktop_app_restart/`.
 */
import { sep } from "node:path";

/** Bounded subprocess options. A hung probe must never wedge `ocx sync`. */
export interface DesktopAppExecOptions {
  timeout?: number;
  windowsHide?: boolean;
}

/** Returns stdout. Options are part of the seam so the timeout is testable. */
export type DesktopExec = (
  file: string,
  args: readonly string[],
  options?: DesktopAppExecOptions,
) => string;

/** One discovered installation of the Codex desktop app. */
export interface DesktopAppInstall {
  /** Stable platform-specific identity, used in messages and for relaunch. */
  id: string;
  /**
   * Absolute, ALREADY `realpath`-RESOLVED directory every member executable must
   * live under. Resolution happens once here rather than per candidate so that
   * {@link isUnderRoot} is a pure string comparison against a trusted value.
   */
  root: string;
  /** Opaque relaunch descriptor only the owning adapter interprets. */
  relaunch: string;
}

export interface DesktopProcess {
  pid: number;
  parentPid: number;
  /**
   * Platform-native start-time token, compared verbatim and never parsed.
   *
   * This is the field that distinguishes a process from a replacement that reused
   * its pid. A pid alone is not an identity across a graceful-close window long
   * enough for the OS to recycle one.
   */
  createdAt: string;
  /** Absolute executable path, used for membership and the shell predicate. */
  executable: string;
}

export interface DesktopAppAdapter {
  /** `null` means discovery failed. Never throws. */
  discover(exec: DesktopExec): DesktopAppInstall | null;
  /**
   * `null` means the probe could not RUN. `[]` means it ran and found nothing.
   *
   * The distinction is not pedantic: collapsing them told users the app was not
   * running and silently skipped a restart they had explicitly asked for (#2557).
   */
  listProcesses(exec: DesktopExec, install: DesktopAppInstall): DesktopProcess[] | null;
  /**
   * True when this member is the app shell rather than a helper.
   *
   * "Parent is not a member" is not sufficient on its own. macOS crashpad handlers
   * are launchd children, so they sit at ppid 1 and would otherwise be classified
   * as roots — including stale ones left by an instance that already exited, which
   * would be signalled and could never be made to "survive" cleanly.
   */
  isShell(process: DesktopProcess, install: DesktopAppInstall): boolean;
  /**
   * Ancestry of the current process, innermost first.
   *
   * `[]` means "could not establish that we are outside the tree" and the ladder
   * fails closed on it. A parent pid naming no live process is NOT that case: it is
   * a clean end of chain, which is the normal state of the detached handoff helper
   * on Windows, where orphans are never reparented.
   */
  ancestryPids(exec: DesktopExec): number[];
  /** Ask the app to quit. Best effort; the ladder decides what happens next. */
  requestQuit(exec: DesktopExec, install: DesktopAppInstall, root: DesktopProcess): void;
  /** Unconditional termination of one shell and its tree. */
  forceStop(exec: DesktopExec, root: DesktopProcess): void;
  /**
   * Capture what the relaunch will need, from the LIVE tree, before anything stops.
   *
   * This is on the contract rather than inside the Linux adapter because of its
   * ordering obligation. A ladder that called it after termination would work on
   * macOS and Windows and produce a Linux app that cannot reach the compositor —
   * the failure would look platform-specific when it is really an ordering bug.
   */
  captureRelaunchContext(
    exec: DesktopExec,
    install: DesktopAppInstall,
    processes: readonly DesktopProcess[],
  ): Record<string, string>;
  /** Start the app again. THROWS on failure; the ladder reports `relaunch_failed`. */
  relaunch(
    exec: DesktopExec,
    install: DesktopAppInstall,
    context: Record<string, string>,
  ): void;
}

/**
 * Path-boundary membership test.
 *
 * A raw `startsWith` admits siblings: an install root of `/usr/lib/chatgpt` would
 * also match `/usr/lib/chatgpt-evil/ChatGPT`, and `/Applications/ChatGPT.app` would
 * match `/Applications/ChatGPT.app-evil/...`. Both are plantable by the same user
 * whose processes are about to be signalled, so same-uid scoping does not cover it.
 *
 * `root` is expected to be `realpath`-resolved by discovery already.
 */
export function isUnderRoot(executable: string, root: string): boolean {
  if (!executable || !root) return false;
  if (executable === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return executable.startsWith(prefix);
}

/**
 * Shells whose parent is not itself a member of the tree.
 *
 * Helpers are deliberately enumerated but never returned here: they are what
 * {@link DesktopAppAdapter.captureRelaunchContext} reads on Linux, and terminating
 * the shell takes them anyway.
 */
export function rootShells(
  processes: readonly DesktopProcess[],
  install: DesktopAppInstall,
  adapter: Pick<DesktopAppAdapter, "isShell">,
): DesktopProcess[] {
  const memberPids = new Set(processes.map(entry => entry.pid));
  return processes.filter(entry =>
    adapter.isShell(entry, install) && !memberPids.has(entry.parentPid));
}
