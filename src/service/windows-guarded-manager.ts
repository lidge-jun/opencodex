/**
 * Windows manager-to-proxy binding for consent-bound desktop stops.
 *
 * guarded-manager-target probes launchd and systemd registrations and proves the
 * running manager owns the approved PID through its parent chain. Windows had no
 * such proof: any registered Task Scheduler task or WinSW service made the whole
 * platform "unknown", so a consent-bound stop always answered approval-changed
 * while resolve still reported takeover supported — a promise the stop path could
 * not keep. This module performs the Windows half of the same contract: prove the
 * manager, or say exactly why it cannot be proven.
 *
 * The evidence mirrors what a careful operator checks by hand:
 *
 * - Task Scheduler: the task must be present, its registered definition must be a
 *   recognized OpenCodex layout (current healthy or the exact legacy shape — never
 *   a hand-edited or foreign task under the fixed name), it must be RUNNING, and
 *   the approved PID's ancestor chain must contain a wrapper process whose command
 *   line carries this home's canonical launcher/script path as a complete token.
 * - WinSW: the service must be started, its registered binary path must be this
 *   installation's WinSW executable, and the SCM-reported service PID must be an
 *   ancestor of the approved PID.
 * - Anything unreadable stays unknown: a manager that cannot be proven stays
 *   untouchable, exactly like a launchd job whose state cannot be read.
 */
import { execFileSync } from "node:child_process";

import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import { cachedCurrentWindowsIdentity, resolveCurrentWindowsPrincipal, WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS } from "../lib/windows-user-principal";
import { statusWinswRaw, winswExePath, WINSW_SERVICE_ID, type WinswStatus } from "../lib/winsw";
import type { GuardedManagerStopped, GuardedManagerTarget } from "./guarded-manager-target";
import { TASK, windowsLauncherVbsPath, windowsServiceScriptPath } from "./state";
import { probeWindowsSchedulerTask, querySchtasks, windowsWscript, type WindowsSchedulerTaskProbe } from "./windows-scheduler";
import { windowsTaskRegistrationHealthy, windowsTaskRegistrationRefreshableLegacy } from "./windows-taskxml";

/** Runtime table of one Win32 process; a null parent means the chain is unreadable. */
export interface WindowsProcessEntry {
  pid: number;
  parentPid: number | null;
  name: string | null;
  commandLine: string | null;
}

/** Get-ScheduledTask State, collapsed to what the stop decision needs. */
export type WindowsTaskState = "running" | "not-running" | "unknown";

/** SCM view of the WinSW service registration and its live process. */
export interface WindowsWinswServiceInfo {
  state: string;
  pid: number | null;
  pathName: string | null;
}

/**
 * Injectable seams for the Windows probes. Tests pass hermetic substitutes;
 * production callers leave everything unset so the live queries below run. Every
 * default implementation exits early off win32, mirroring probeWindowsSchedulerTask.
 */
export interface WindowsGuardedManagerDeps {
  winProcs?: () => WindowsProcessEntry[] | null;
  winTaskXml?: () => string;
  winTaskState?: () => WindowsTaskState;
  winService?: () => WindowsWinswServiceInfo | null;
  winRegistrationOurs?: (xml: string, expectedUserIds: readonly string[] | null) => boolean;
  winTaskUserIds?: () => readonly string[] | null;
  winScriptPath?: () => string;
  winLauncherPath?: () => string;
  winWinswExePath?: () => string;
}

type ResolvedWindowsDeps = Required<WindowsGuardedManagerDeps>;

const POWERSHELL_TIMEOUT_MS = 5_000;
const PROCESS_SNAPSHOT_BUFFER = 16 * 1024 * 1024;
const ANCESTOR_DEPTH_LIMIT = 32;

function runPowerShell(command: string): string {
  return execFileSync(resolveTrustedWindowsPowerShellExe(), [
    "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", command,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: PROCESS_SNAPSHOT_BUFFER,
  });
}

/**
 * One Win32_Process snapshot covering every identity question in this module:
 * parent chains for the bound proof, and names and command lines for the wrapper scan.
 * A null return means the enumeration itself could not run — callers fail closed,
 * because an unreadable process table is not evidence that no wrapper survives.
 */
export function windowsProcessList(): WindowsProcessEntry[] | null {
  if (process.platform !== "win32") return null;
  try {
    const output = runPowerShell(
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    );
    const trimmed = output.trim();
    if (!trimmed) return [];
    const parsed: unknown = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const entries: WindowsProcessEntry[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const record = row as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
      const pid = Number(record.ProcessId);
      const parent = Number(record.ParentProcessId);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      entries.push({
        pid,
        parentPid: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
        name: typeof record.Name === "string" ? record.Name : null,
        commandLine: typeof record.CommandLine === "string" ? record.CommandLine : null,
      });
    }
    return entries;
  } catch {
    return null;
  }
}

/**
 * The registered task's RUNNING state, read through Get-ScheduledTask whose State
 * values are enum names and therefore locale-independent — parsing schtasks table
 * output was rejected earlier because its values are localized.
 */
export function windowsScheduledTaskState(taskName = TASK): WindowsTaskState {
  if (process.platform !== "win32") return "unknown";
  try {
    const output = runPowerShell(
      "(Get-ScheduledTask -TaskName '" + taskName.replace(/'/g, "''") + "' -ErrorAction Stop).State",
    ).trim();
    if (/^running$/i.test(output)) return "running";
    if (/^(ready|disabled)$/i.test(output)) return "not-running";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** The registered task XML, decoded exactly like every other scheduler reader. */
export function windowsScheduledTaskXml(taskName = TASK): string {
  return querySchtasks(["/query", "/tn", taskName, "/xml"]);
}

/**
 * The WinSW service's SCM row. state "absent" means the query ran and the service
 * is genuinely not installed; a null return means the query itself failed — the
 * difference between "no manager" and "unproven manager".
 */
export function windowsWinswServiceInfo(serviceName = WINSW_SERVICE_ID): WindowsWinswServiceInfo | null {
  if (process.platform !== "win32") return null;
  try {
    const output = runPowerShell(
      "Get-CimInstance Win32_Service | Where-Object { $_.Name -eq '" + serviceName.replace(/'/g, "''") + "' } "
      + "| Select-Object ProcessId,State,PathName | ConvertTo-Json -Compress",
    ).trim();
    if (!output) return { state: "absent", pid: null, pathName: null };
    const parsed: unknown = JSON.parse(output);
    const record = (Array.isArray(parsed) ? parsed[0] : parsed) as {
      ProcessId?: unknown; State?: unknown; PathName?: unknown;
    } | null | undefined;
    if (typeof record !== "object" || record === null) return null;
    const pid = Number(record.ProcessId);
    return {
      state: typeof record.State === "string" && record.State.trim() ? record.State.trim() : "unknown",
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      pathName: typeof record.PathName === "string" && record.PathName.trim() ? record.PathName.trim() : null,
    };
  } catch {
    return null;
  }
}

/** The two OpenCodex task shapes this stop may legitimately end. */
export function windowsTaskRegistrationIsOurs(
  xml: string,
  expectedUserIds: readonly string[] | null,
  launcher = windowsLauncherVbsPath(),
): boolean {
  if (expectedUserIds === null) return false;
  return windowsTaskRegistrationHealthy(xml, windowsWscript(), launcher, expectedUserIds)
    || windowsTaskRegistrationRefreshableLegacy(xml, windowsWscript(), launcher);
}

export function currentWindowsTaskUserIds(): readonly string[] | null {
  try {
    let identity = cachedCurrentWindowsIdentity();
    if (!identity) {
      resolveCurrentWindowsPrincipal(WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS);
      identity = cachedCurrentWindowsIdentity();
    }
    return identity ? [identity.sid, identity.name] : null;
  } catch {
    return null;
  }
}

/**
 * True when path appears in commandLine as a COMPLETE token — the same boundary
 * rule the windows-service-wrappers kill list uses, ported so the read-only proof
 * cannot accept a substring hit. A quoted path inside an argument string counts;
 * a suffix or prefix glued to it does not.
 */
export function commandLineHasPathToken(commandLine: string | null | undefined, path: string): boolean {
  if (!commandLine || !path) return false;
  const haystack = commandLine.toLowerCase();
  const needle = path.toLowerCase();
  const boundary = (ch: string | undefined): boolean => ch === undefined || /[\s"']/.test(ch);
  let index = 0;
  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index < 0) return false;
    const end = index + needle.length;
    if (boundary(haystack[index - 1]) && boundary(haystack[end])) return true;
    index = end;
  }
}

function resolveWindowsDeps(deps: WindowsGuardedManagerDeps, live: boolean): ResolvedWindowsDeps {
  // "live" is false whenever the caller simulated platform win32 (tests or a future
  // cross-platform probe): every unset probe then returns its least-proving answer
  // instead of silently querying the host the simulation did not mean to touch.
  return {
    winProcs: deps.winProcs ?? (live ? windowsProcessList : () => null),
    winTaskXml: deps.winTaskXml ?? (live ? () => windowsScheduledTaskXml() : () => {
      throw new Error("Windows task query is unavailable in this context");
    }),
    winTaskState: deps.winTaskState ?? (live ? () => windowsScheduledTaskState() : () => "unknown"),
    winService: deps.winService ?? (live ? () => windowsWinswServiceInfo() : () => null),
    winRegistrationOurs: deps.winRegistrationOurs ?? ((xml, expectedUserIds) =>
      windowsTaskRegistrationIsOurs(xml, expectedUserIds, (deps.winLauncherPath ?? windowsLauncherVbsPath)())),
    winTaskUserIds: deps.winTaskUserIds ?? (live ? currentWindowsTaskUserIds : () => null),
    winScriptPath: deps.winScriptPath ?? windowsServiceScriptPath,
    winLauncherPath: deps.winLauncherPath ?? windowsLauncherVbsPath,
    winWinswExePath: deps.winWinswExePath ?? winswExePath,
  };
}

function wrapperPaths(io: ResolvedWindowsDeps): string[] {
  return [io.winLauncherPath(), io.winScriptPath()];
}

/** Ancestor chain via the snapshot table — same depth cap as the POSIX walk. */
export function isDescendantOf(
  ancestorPid: number,
  pid: number,
  processes: readonly WindowsProcessEntry[],
): boolean {
  const parents = new Map(processes.map(entry => [entry.pid, entry.parentPid]));
  let current = pid;
  const seen = new Set<number>();
  for (let depth = 0; depth < ANCESTOR_DEPTH_LIMIT; depth += 1) {
    if (current === ancestorPid) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const parent = parents.get(current);
    if (parent === undefined || parent === null || parent <= 0) return false;
    current = parent;
  }
  return false;
}

/**
 * Every ancestor of pid whose own command line carries a canonical wrapper path,
 * nearest first. A hit means the wscript/cmd supervision chain between the task
 * action and the proxy is intact for THIS home — not just that some OpenCodex
 * process exists somewhere on the box.
 */
export function ancestorWrapperPids(
  pid: number,
  processes: readonly WindowsProcessEntry[],
  canonicalPaths: readonly string[],
): number[] {
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));
  const found: number[] = [];
  const seen = new Set<number>();
  let current = pid;
  for (let depth = 0; depth < ANCESTOR_DEPTH_LIMIT; depth += 1) {
    const entry = byPid.get(current);
    if (!entry || seen.has(current)) break;
    seen.add(current);
    const parent = entry.parentPid;
    if (parent === null || parent <= 0) break;
    const parentEntry = byPid.get(parent);
    if (parentEntry?.commandLine
      && canonicalPaths.some(path => commandLineHasPathToken(parentEntry.commandLine, path))) {
      found.push(parent);
    }
    current = parent;
  }
  return found;
}

/**
 * Any live process whose command line carries a canonical wrapper path. A wrapper
 * that survived schtasks /end keeps respawning the proxy, so the post-stop probe
 * treats one as an ACTIVE manager even when the task itself reports not running.
 * The enumerating probe cannot match itself — the patterns are compared in
 * TypeScript, never embedded in the PowerShell text — but excluding the current
 * process costs nothing if that ever changes.
 */
export function wrapperProcessesAlive(
  processes: readonly WindowsProcessEntry[],
  canonicalPaths: readonly string[],
): number[] {
  return processes
    .filter(entry => entry.pid !== process.pid && entry.commandLine
      && canonicalPaths.some(path => commandLineHasPathToken(entry.commandLine, path)))
    .map(entry => entry.pid);
}

/**
 * A wscript/cscript/cmd process whose command line could not be read. It may be this home's
 * wrapper, and nothing can prove otherwise. Only processes tied to the approved proxy by
 * ancestry count: a non-admin CIM query returns no command line for other users' and elevated
 * processes, so treating every unreadable cmd.exe on the machine as a wrapper would make the
 * guarded stop unreachable on an ordinary desktop.
 */
function isUnreadableWrapperCandidate(entry: WindowsProcessEntry): boolean {
  return !entry.commandLine?.trim() && /^(?:wscript|cscript|cmd)\.exe$/i.test(entry.name ?? "");
}

/** Unreadable wrapper candidates among pid's ancestors, nearest first. */
export function unreadableAncestorWrapperPids(pid: number, processes: readonly WindowsProcessEntry[]): number[] {
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));
  const found: number[] = [];
  const seen = new Set<number>();
  let current = pid;
  for (let depth = 0; depth < ANCESTOR_DEPTH_LIMIT; depth += 1) {
    const entry = byPid.get(current);
    if (!entry || seen.has(current)) break;
    seen.add(current);
    const parent = entry.parentPid;
    if (parent === null || parent <= 0) break;
    const parentEntry = byPid.get(parent);
    if (parentEntry && isUnreadableWrapperCandidate(parentEntry)) found.push(parent);
    current = parent;
  }
  return found;
}

/**
 * Unreadable wrapper candidates that are the former manager process or descend from it. After
 * the approved child exits, such a survivor can still respawn it, so post-stop it is unknown.
 */
export function unreadableWrappersOfManager(managerPid: number, processes: readonly WindowsProcessEntry[]): number[] {
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));
  return processes.filter(entry => {
    if (!isUnreadableWrapperCandidate(entry)) return false;
    let current: number | null = entry.pid;
    for (let depth = 0; current !== null && current > 0 && depth < ANCESTOR_DEPTH_LIMIT; depth += 1) {
      if (current === managerPid) return true;
      current = byPid.get(current)?.parentPid ?? null;
    }
    return false;
  }).map(entry => entry.pid);
}

function unknown(reason: string): GuardedManagerTarget {
  return { kind: "unknown", reason };
}

function inspectWindowsSchedulerManager(
  approvedPid: number,
  io: ResolvedWindowsDeps,
): GuardedManagerTarget {
  let xml: string;
  try {
    xml = io.winTaskXml();
  } catch {
    return unknown("the Task Scheduler registration could not be read");
  }
  const processes = io.winProcs();
  if (processes === null) return unknown("the Windows process list could not be read");
  const paths = wrapperPaths(io);
  const ancestors = ancestorWrapperPids(approvedPid, processes, paths);
  const strays = wrapperProcessesAlive(processes, paths);
  if (unreadableAncestorWrapperPids(approvedPid, processes).length > 0) {
    return unknown("a possible scheduler wrapper has an unreadable command line");
  }
  const state = io.winTaskState();
  if (state === "unknown") return unknown("the registered task's running state could not be proven");
  if (state === "not-running") {
    // A task with no running instance owes nothing ONLY when no wrapper survives.
    // A live wrapper outside a task instance — whether it parents the approved
    // PID or not — is unaccounted supervision: schtasks /end would report success
    // on the inert task while the wrapper stayed alive to respawn the proxy.
    return strays.length === 0
      ? { kind: "absent" }
      : unknown("a surviving scheduler wrapper could not be tied to the registered task");
  }
  if (!io.winRegistrationOurs(xml, io.winTaskUserIds())) {
    return unknown("the registered task is not a recognized OpenCodex definition");
  }
  if (ancestors.length === 0) {
    return unknown(strays.length === 0
      ? "the scheduler task is running but does not own the approved process"
      : "a surviving scheduler wrapper does not own the approved process");
  }
  // schtasks /end does not reliably cascade to the wrapper's child, so the bound
  // manager stop cannot be trusted to end the proxy — the approved PID still gets
  // its own graceful signal afterwards.
  return {
    kind: "bound", pid: approvedPid, managerPid: ancestors[0]!,
    backend: "scheduler", childNeedsSeparateStop: true,
  };
}

function inspectWindowsWinswManager(
  approvedPid: number,
  io: ResolvedWindowsDeps,
): GuardedManagerTarget {
  const info = io.winService();
  if (info === null) return unknown("the native service could not be queried");
  if (info.state !== "Running" && info.state !== "Started") {
    return unknown("the native service is registered but not running (" + info.state + ")");
  }
  if (!info.pathName || !commandLineHasPathToken(info.pathName, io.winWinswExePath())) {
    return unknown("the native service binary is not this installation's WinSW executable");
  }
  if (info.pid === null) return unknown("the native service PID could not be proven");
  const processes = io.winProcs();
  if (processes === null) return unknown("the Windows process list could not be read");
  return isDescendantOf(info.pid, approvedPid, processes)
    ? {
        kind: "bound", pid: approvedPid, managerPid: info.pid,
        backend: "winsw", childNeedsSeparateStop: true,
      }
    : unknown("the native service does not own the approved process");
}

/**
 * Windows half of inspectGuardedManagerTarget. The "live" flag tells the default
 * probes whether the platform is real Windows: a simulated win32 must never fire a
 * real schtasks/PowerShell query at the host, so absent probes then degrade to
 * their least-proving answer — the same fail-closed shape the platform showed
 * before this module existed.
 */
export function inspectWindowsGuardedManager(
  approvedPid: number,
  scheduler: WindowsSchedulerTaskProbe,
  native: WinswStatus,
  deps: WindowsGuardedManagerDeps,
  live: boolean,
): GuardedManagerTarget {
  const io = resolveWindowsDeps(deps, live);
  if (scheduler.status === "unknown") {
    return unknown("the Task Scheduler state could not be read (" + scheduler.detail + ")");
  }
  if (native === "unknown") {
    return unknown("the native WinSW service state could not be read");
  }
  if (scheduler.status === "present" && native !== "nonexistent") {
    // Same dual-backend conflict the install verification already refuses: either
    // manager could respawn the proxy, so neither may be stopped by name alone.
    return unknown("the Task Scheduler task and the native WinSW service are both registered");
  }
  if (scheduler.status === "present") {
    return inspectWindowsSchedulerManager(approvedPid, io);
  }
  if (native === "started") {
    return inspectWindowsWinswManager(approvedPid, io);
  }
  if (native === "stopped") {
    // A stopped service cannot respawn anything, but a detached wrapper can.
    const processes = io.winProcs();
    if (processes === null) return unknown("the Windows process list could not be read");
    if (unreadableAncestorWrapperPids(approvedPid, processes).length > 0) {
      return unknown("a possible scheduler wrapper has an unreadable command line");
    }
    return wrapperProcessesAlive(processes, wrapperPaths(io)).length === 0
      ? { kind: "absent" }
      : unknown("a surviving scheduler wrapper could not be tied to an installed manager");
  }
  // scheduler absent + winsw nonexistent — still have to rule out a detached wrapper.
  const processes = io.winProcs();
  if (processes === null) return unknown("the Windows process list could not be read");
  if (unreadableAncestorWrapperPids(approvedPid, processes).length > 0) {
    return unknown("a possible scheduler wrapper has an unreadable command line");
  }
  return wrapperProcessesAlive(processes, wrapperPaths(io)).length === 0
    ? { kind: "absent" }
    : unknown("a surviving scheduler wrapper could not be tied to an installed manager");
}

export interface WindowsGuardedStopDeps {
  scheduler?: () => WindowsSchedulerTaskProbe;
  winsw?: () => WinswStatus;
  winProcs?: () => WindowsProcessEntry[] | null;
  winTaskState?: () => WindowsTaskState;
  winScriptPath?: () => string;
  winLauncherPath?: () => string;
  /** The bound manager process the pre-stop proof tied to the approved proxy, when there was one. */
  formerManagerPid?: number;
}

/**
 * Post-stop manager check for Windows. Registration PRESENCE is the wrong question —
 * schtasks /end leaves the task registered forever — so inactivity means: the task
 * is not running, no wrapper process carrying this home's canonical paths survives,
 * and no WinSW service is started. An unreadable probe is unknown, never inactive.
 */
export function observeWindowsGuardedManagerStopped(
  deps: WindowsGuardedStopDeps = {},
  live = process.platform === "win32",
): GuardedManagerStopped {
  const scheduler = (deps.scheduler ?? probeWindowsSchedulerTask)();
  const native = (deps.winsw ?? statusWinswRaw)();
  if (scheduler.status === "unknown" || native === "unknown") return "unknown";
  const procs = (deps.winProcs ?? (live ? windowsProcessList : () => null))();
  if (procs === null) return "unknown";
  const paths = [
    (deps.winLauncherPath ?? windowsLauncherVbsPath)(),
    (deps.winScriptPath ?? windowsServiceScriptPath)(),
  ];
  if (wrapperProcessesAlive(procs, paths).length > 0) return "active";
  if (native === "started") return "active";
  if (scheduler.status === "present") {
    const state = (deps.winTaskState ?? (live ? () => windowsScheduledTaskState() : () => "unknown"))();
    if (state === "unknown") return "unknown";
    if (state === "running") return "active";
  }
  if (deps.formerManagerPid !== undefined && unreadableWrappersOfManager(deps.formerManagerPid, procs).length > 0) {
    return "unknown";
  }
  return "inactive";
}
