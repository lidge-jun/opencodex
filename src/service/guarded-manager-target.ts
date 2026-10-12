/** Read-only manager-to-proxy binding for consent-bound desktop stops. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { verifyPidIdentity } from "../config/process-state";
import { statusWinswRaw } from "../lib/winsw";
import { systemdProperty } from "../service-manager-probe";
import { expectedLaunchdCommand, launchdEvictionTargets, probeLaunchdLoadState, runLaunchctl } from "./launchd";
import { probeSystemdUnitInactive, unitPath } from "./systemd";
import {
  inspectWindowsGuardedManager,
  observeWindowsGuardedManagerStopped,
  type WindowsGuardedManagerDeps,
} from "./windows-guarded-manager";
import { probeWindowsSchedulerTask } from "./windows-scheduler";
import { TASK } from "./state";

export type GuardedManagerTarget =
  | { kind: "absent" }
  | {
      kind: "bound";
      pid: number;
      managerPid: number;
      backend: "launchd" | "systemd" | "scheduler" | "winsw";
      /**
       * Whether stopping this manager can leave the approved process alive.
       * launchd/systemd end their job's whole process tree; Windows Task
       * Scheduler's /end does not reliably cascade to the wrapper's child (#764),
       * so a bound scheduler or WinSW manager still needs the approved PID
       * signalled separately after the manager is stopped.
       */
      childNeedsSeparateStop: boolean;
    }
  | { kind: "unknown"; reason: string };

export type GuardedManagerStopped = "inactive" | "active" | "unknown";

export function managerOwnsApprovedPid(
  managerPid: number,
  approvedPid: number,
  parentOf: (pid: number) => number | null,
): boolean {
  let current = approvedPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (current === managerPid) return true;
    if (!Number.isSafeInteger(current) || current <= 0 || seen.has(current)) return false;
    seen.add(current);
    const parent = parentOf(current);
    if (parent === null || !Number.isSafeInteger(parent) || parent <= 0) return false;
    current = parent;
  }
  return false;
}

function parentPid(pid: number): number | null {
  try {
    const raw = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const value = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

function positivePid(raw: string | null | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export interface GuardedManagerDeps {
  platform?: NodeJS.Platform;
  launchctl?: typeof runLaunchctl;
  expectedCommand?: (port: number) => string;
  systemdShow?: () => string;
  parentOf?: (pid: number) => number | null;
  verifyPid?: (pid: number) => number | null;
  scheduler?: typeof probeWindowsSchedulerTask;
  winsw?: typeof statusWinswRaw;
  win?: WindowsGuardedManagerDeps;
}

/** Only one current manager with a verified parent chain may be stopped by name. */
export function inspectGuardedManagerTarget(
  approvedPid: number,
  approvedPort: number,
  deps: GuardedManagerDeps = {},
): GuardedManagerTarget {
  const platform = deps.platform ?? process.platform;
  if ((deps.verifyPid ?? verifyPidIdentity)(approvedPid) !== approvedPid) {
    return { kind: "unknown", reason: "approved process identity could not be verified" };
  }
  const parentOf = deps.parentOf ?? parentPid;
  if (platform === "darwin") {
    const run = deps.launchctl ?? runLaunchctl;
    let managerPid: number | null = null;
    try {
      const expected = (deps.expectedCommand ?? expectedLaunchdCommand)(approvedPort);
      for (const target of launchdEvictionTargets()) {
        const result = run(["print", target]);
        if (result.status === 112 || result.status === 113) continue;
        if (result.status !== 0) return { kind: "unknown", reason: "launchd state is unreadable" };
        if (managerPid !== null) return { kind: "unknown", reason: "multiple launchd jobs are loaded" };
        const output = `${result.stdout}\n${result.stderr}`;
        if (!output.includes(expected)) return { kind: "unknown", reason: "launchd command differs from registration" };
        const pids = [...output.matchAll(/^\s*pid\s*=\s*(\d+)\s*$/gm)];
        if (pids.length !== 1) return { kind: "unknown", reason: "launchd PID is ambiguous" };
        managerPid = positivePid(pids[0]?.[1]);
        if (managerPid === null) return { kind: "unknown", reason: "launchd PID is invalid" };
      }
    } catch { return { kind: "unknown", reason: "launchd state could not be verified" }; }
    if (managerPid === null) return { kind: "absent" };
    return managerOwnsApprovedPid(managerPid, approvedPid, parentOf)
      ? { kind: "bound", pid: approvedPid, managerPid, backend: "launchd", childNeedsSeparateStop: false }
      : { kind: "unknown", reason: "launchd job does not own the approved process" };
  }
  if (platform === "linux") {
    try {
      const output = (deps.systemdShow ?? (() => execFileSync("systemctl", ["--user", "show", "-p", "LoadState", "-p", "ActiveState", "-p", "MainPID", "-p", "FragmentPath", "-p", "NeedDaemonReload", TASK], {
        encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
      })))();
      const loaded = systemdProperty(output, "LoadState");
      const active = systemdProperty(output, "ActiveState");
      const pid = positivePid(systemdProperty(output, "MainPID"));
      if (loaded === "not-found" && active === "inactive") return { kind: "absent" };
      if (loaded === "loaded" && active === "inactive" && systemdProperty(output, "MainPID") === "0") return { kind: "absent" };
      if (loaded !== "loaded" || active !== "active" || pid === null
        || systemdProperty(output, "NeedDaemonReload") !== "no"
        || resolve(systemdProperty(output, "FragmentPath") ?? "") !== resolve(unitPath())) {
        return { kind: "unknown", reason: "systemd unit state is not current and active" };
      }
      return managerOwnsApprovedPid(pid, approvedPid, parentOf)
        ? { kind: "bound", pid: approvedPid, managerPid: pid, backend: "systemd", childNeedsSeparateStop: false }
        : { kind: "unknown", reason: "systemd unit does not own the approved process" };
    } catch { return { kind: "unknown", reason: "systemd state could not be verified" }; }
  }
  if (platform === "win32") {
    const scheduler = (deps.scheduler ?? probeWindowsSchedulerTask)();
    const native = (deps.winsw ?? statusWinswRaw)();
    // A simulated win32 (deps.platform injected) must not run real schtasks or
    // process-list queries at the host; the module degrades every unset probe to
    // its least-proving answer then, which is exactly the old fail-closed shape.
    return inspectWindowsGuardedManager(
      approvedPid, scheduler, native, deps.win ?? {}, deps.platform === undefined,
    );
  }
  return { kind: "unknown", reason: "unsupported service manager platform" };
}

/** A guarded success needs manager absence after settlement and once more at publication. */
export async function observeGuardedManagerStopped(
  manager: Exclude<GuardedManagerTarget, { kind: "unknown" }>,
  deps: Pick<GuardedManagerDeps, "platform" | "scheduler" | "winsw" | "win"> & {
    launchd?: typeof probeLaunchdLoadState;
    systemd?: typeof probeSystemdUnitInactive;
  } = {},
): Promise<GuardedManagerStopped> {
  try {
    const platform = deps.platform ?? process.platform;
    if (platform === "darwin") {
      const state = (deps.launchd ?? probeLaunchdLoadState)().state;
      return state === "not-loaded" ? "inactive" : state === "unknown" ? "unknown" : "active";
    }
    if (platform === "linux") return (deps.systemd ?? probeSystemdUnitInactive)();
    if (platform === "win32") {
      // Registration presence is not the question: schtasks /end leaves the task
      // registered forever, so the Windows check is RUNNING state + surviving
      // wrapper processes + WinSW status, never mere presence.
      return observeWindowsGuardedManagerStopped({
        scheduler: deps.scheduler,
        winsw: deps.winsw,
        ...(deps.win ?? {}),
        ...(manager.kind === "bound" ? { formerManagerPid: manager.managerPid } : {}),
      }, deps.platform === undefined);
    }
  } catch { return "unknown"; }
  return "unknown";
}
