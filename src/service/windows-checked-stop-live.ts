/**
 * Live dependencies of the checked Windows service stop (#7771, 060 "PR2: caller wiring").
 *
 * Part A (src/service/windows-checked-stop.ts) and Part B (src/service/windows-stop-confirm.ts)
 * take every effect injected. This module is the production side of those seams: capped
 * asynchronous schtasks and sc.exe calls, the evidence snapshot with native creation times
 * (src/service/windows-process-evidence.ts), the checked terminate, the bind-time exit watch,
 * the listening-port sampler and the listener identity check.
 *
 * The bind snapshot MUST be windowsProcessSnapshot: on x64 it overlays the native creation
 * time, which is the exact value the handle terminate compares. A CIM-only snapshot carries
 * a millisecond-truncated CIM time, the terminate then answers "reused" and Part A treats a
 * live wrapper as exited.
 *
 * Windows ARM64 ships the STRICT variant (050 "Rollout", step 3): no ARM64 device run has
 * happened, so a terminate there is "unavailable" and Part A reports unknown with
 * evidence-unreadable instead of killing through the bounded PowerShell fallback. The
 * fallback stays in the evidence module, unreachable until the constant below flips after
 * the 040 ARM64 device case is run.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { inspectOcxStartProcessIdentity, readPid, verifyPidIdentity, type OcxStartIdentityObservation } from "../config/process-state";
import { isProcessAlive } from "../lib/process-control";
import { isTestHomeGuardArmed } from "../lib/test-home-guard";
import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsSchtasksExe, resolveTrustedWindowsSystemDirectory, toWindowsSchtasksError } from "../lib/windows-elevation";
import { WINSW_SERVICE_ID, winswExePath, type WinswStatus } from "../lib/winsw";
import { decodeWindowsTextBytes } from "../lib/windows-text";
import { parseScQcBinaryPathName, scBinaryPathNamesExecutable } from "../service-manager-probe";
import { parseListenPidsFromNetstat, type ListenPidScan } from "../server/port-reclaim";
import { dropWindowsTcpRowsForLocalPort } from "../server/windows-tcp-drop";
import { TASK, windowsLauncherVbsPath, windowsServiceScriptPath } from "./state";
import { ancestorWrapperPids } from "./windows-guarded-manager";
import type { WindowsCheckedStopDeps, WindowsTaskEndResult, WindowsWinswScmState, WindowsWinswStopResult } from "./windows-checked-stop";
import {
  openWindowsProcessWatch,
  readScheduleServicePid,
  terminateWindowsProcessBound,
  windowsProcessSnapshot,
  type WindowsStopProcessEntry,
} from "./windows-process-evidence";
import { windowsProcessNative, type WindowsProcessNativeApi, type WindowsTerminateResult } from "./windows-process-native";
import type { WindowsListenerIdentity, WindowsPortSample, WindowsStopConfirmDeps } from "./windows-stop-confirm";
import { windowsSchedulerCsvIncludesTask } from "./windows-scheduler";

/**
 * 050: without an ARM64 device run, ARM64 ships strict. Flip only after the 040 ARM64 device
 * case passes; the bounded PowerShell terminate in windows-process-evidence.ts then runs.
 */
export const WINDOWS_ARM64_BOUNDED_TERMINATE_ENABLED = false;

export interface WindowsStopCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** One spawned helper; tests inject it, production runs execFile with a hard timeout. */
export type WindowsStopCommandRunner = (
  program: "schtasks" | "sc" | "powershell",
  args: string[],
  timeoutMs: number,
) => Promise<WindowsStopCommandResult>;

function programPath(program: "schtasks" | "sc" | "powershell"): string {
  if (program === "schtasks") return resolveTrustedWindowsSchtasksExe();
  if (program === "powershell") return resolveTrustedWindowsPowerShellExe();
  const file = join(resolveTrustedWindowsSystemDirectory(), "sc.exe");
  if (!existsSync(file)) throw new Error("sc.exe was not found in the trusted system directory.");
  return file;
}

export const liveWindowsStopCommandRunner: WindowsStopCommandRunner = (program, args, timeoutMs) => new Promise(resolve => {
  // execFile reads a 0 timeout as "no timeout": a deadline-derived fraction is floored, and a
  // timeout that floors to 0 spawns nothing (the same rule as terminateWindowsProcessBound).
  const timeout = Math.floor(timeoutMs);
  if (!(timeout > 0)) {
    resolve({ status: null, stdout: "", stderr: "", timedOut: true });
    return;
  }
  // Task Scheduler and the SCM are machine-global: an armed test process may only observe.
  // `sc query` and `sc qc` only read the SCM row and its registration.
  const mutating = program === "schtasks"
    ? args[0]?.toLowerCase() !== "/query"
    : program === "sc" && !["query", "qc"].includes((args[0] ?? "").toLowerCase());
  if (isTestHomeGuardArmed() && mutating) {
    resolve({ status: null, stdout: "", stderr: "refusing a machine-global service mutation from an armed test process", timedOut: false });
    return;
  }
  let file: string;
  try {
    file = programPath(program);
  } catch (error) {
    resolve({ status: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });
    return;
  }
  execFile(file, args, { encoding: "buffer", timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      const text = (value: Buffer | string | undefined): string =>
        value === undefined ? "" : typeof value === "string" ? value : decodeWindowsTextBytes(value);
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
      resolve({
        status: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
        stdout: text(stdout),
        stderr: text(stderr),
        timedOut: !!failure?.killed && failure.signal !== null,
      });
    });
});

/** schtasks /end, mapped: already stopped is not-running; access denied is denied. */
export function classifyTaskEnd(result: WindowsStopCommandResult): WindowsTaskEndResult {
  if (result.timedOut) return "failed";
  if (result.status === 0) return "ended";
  const error = Object.assign(new Error(result.stderr || result.stdout), { status: result.status, stderr: result.stderr, stdout: result.stdout });
  const detail = (result.stderr + "\n" + result.stdout).toLowerCase();
  if (detail.includes("no running instance") || detail.includes("not currently running") || detail.includes("0x41330")) return "not-running";
  return toWindowsSchtasksError(error, ["/end", "/tn", TASK]).reason === "access-denied" ? "denied" : "failed";
}

/** schtasks /query /fo CSV /nh status column. Localized values fall back to PowerShell. */
export function parseTaskCsvState(csv: string): "running" | "not-running" | "unknown" {
  for (const line of csv.split(/\r?\n/)) {
    if (!windowsSchedulerCsvIncludesTask(line, TASK)) continue;
    const fields = [...line.matchAll(/"([^"]*)"/g)].map(match => match[1]!.trim());
    const status = fields[fields.length - 1] ?? "";
    if (/^running$/i.test(status)) return "running";
    if (/^(ready|disabled|queued)$/i.test(status)) return "not-running";
    return "unknown";
  }
  return "unknown";
}

/** sc.exe query: the numeric STATE and the 1060 "does not exist" code are not localized. */
export function parseScQueryState(result: WindowsStopCommandResult): WindowsWinswScmState {
  const text = result.stdout + "\n" + result.stderr;
  if (/\b1060\b/.test(text)) return "nonexistent";
  if (result.timedOut || result.status !== 0) return "unknown";
  const state = /^\s*STATE\s*:\s*(\d+)/m.exec(text);
  if (!state) return "unknown";
  const value = Number(state[1]);
  if (value === 1) return "stopped";
  if (value === 4) return "running";
  if (value >= 2 && value <= 7) return "pending";
  return "unknown";
}

/** sc.exe stop without waiting: 1062 (not started) is fine, 5 is denied. */
export function classifyScStop(result: WindowsStopCommandResult): WindowsWinswStopResult {
  if (result.timedOut) return "failed";
  const text = result.stdout + "\n" + result.stderr;
  if (result.status === 0 || /\b1062\b/.test(text) || /\b1060\b/.test(text)) return "sent";
  if (/\bFAILED 5\b/.test(text) || result.status === 5) return "denied";
  return "failed";
}

export function winswStatusFromScState(state: WindowsWinswScmState): WinswStatus {
  if (state === "nonexistent") return "nonexistent";
  if (state === "stopped") return "stopped";
  // A pending service is still an active manager: Part A stops it and polls.
  if (state === "running" || state === "pending") return "started";
  return "unknown";
}

export function windowsStopCanonicalPaths(): string[] {
  return [windowsLauncherVbsPath(), windowsServiceScriptPath()];
}

/**
 * The terminate Part A uses. terminateWindowsProcessBound runs the PowerShell fallback by
 * itself whenever the native API is missing (ARM64, or an x64 whose DLL load failed), so the
 * strict variant is enforced HERE (060 "ARM64 decision for PR2"): without the native
 * primitive the answer is "unavailable" and the fallback is never reached.
 */
export async function windowsStopTerminate(
  pid: number,
  startTime: number,
  timeoutMs: number,
  io: { native?: () => WindowsProcessNativeApi | null; terminate?: typeof terminateWindowsProcessBound } = {},
): Promise<WindowsTerminateResult> {
  if ((io.native ?? windowsProcessNative)() === null && !WINDOWS_ARM64_BOUNDED_TERMINATE_ENABLED) return { status: "unavailable" };
  return (io.terminate ?? terminateWindowsProcessBound)(pid, startTime, { timeoutMs });
}

/** Floor a deadline-derived timeout; null when it floors to 0 (nothing may be spawned). */
export function wholeTimeoutMs(timeoutMs: number): number | null {
  const floored = Math.floor(timeoutMs);
  return floored > 0 ? floored : null;
}

/** The evidence snapshot with a floored timeout; 0 ms reads nothing (null, unreadable). */
export function windowsStopSnapshot(timeoutMs: number): Promise<WindowsStopProcessEntry[] | null> {
  const whole = wholeTimeoutMs(timeoutMs);
  return whole === null ? Promise.resolve(null) : windowsProcessSnapshot({ timeoutMs: whole });
}

/**
 * Does the stopping process descend from a wrapper carrying this home's launcher or
 * service-script path? The binding rule excludes the stopper itself but not its ancestors,
 * so such a stop would end its own supervision chain (structure/ops/windows-checked-stop.md,
 * "Who may run Part A").
 */
export function stopperUnderHomeWrapper(
  processes: readonly WindowsStopProcessEntry[],
  canonicalPaths: readonly string[],
  selfPid: number = process.pid,
): boolean {
  return ancestorWrapperPids(selfPid, processes, canonicalPaths).length > 0;
}

export interface WindowsCheckedStopLiveOptions {
  run?: WindowsStopCommandRunner;
  /**
   * The `sc.exe qc` query that proves the registered WinSW service runs THIS installation's
   * executable. Defaults to the capped runner; tests inject it.
   */
  scQcRun?: (timeoutMs: number) => Promise<WindowsStopCommandResult>;
  /** Checked before every manager command (the route's cap, the updater's authorizer). */
  gate?: () => boolean;
  snapshot?: (timeoutMs: number) => Promise<readonly WindowsStopProcessEntry[] | null>;
}

/**
 * Is the registered WinSW service this installation's?
 *
 * `sc stop opencodex-proxy-native` names a fixed ID, so a successful `sc query` is evidence
 * that SOMETHING is registered, not that it is ours: another installation's WinSW service
 * under the same ID would be stopped by this home's Part A. The registered
 * `BINARY_PATH_NAME` must name this home's WinSW executable, the same proof the guarded
 * manager path uses (`windowsWinswServiceInfo` + `commandLineHasPathToken`). Unreadable is
 * unknown; a foreign executable is `nonexistent`, which keeps Part A from stopping it.
 */
export function classifyWinswOwnership(
  qc: WindowsStopCommandResult | null,
  winswExe: string = winswExePath(),
): WinswStatus | "foreign" {
  if (qc === null || qc.timedOut || qc.status !== 0) return "unknown";
  const binaryPathName = parseScQcBinaryPathName(qc.stdout);
  if (binaryPathName === null) return "unknown";
  return scBinaryPathNamesExecutable(binaryPathName, winswExe) ? "started" : "foreign";
}

/** The identity-checked proxy child, or null. */
export function windowsStopChildPid(): number | null {
  try {
    const pid = readPid();
    return pid !== null && verifyPidIdentity(pid) === pid ? pid : null;
  } catch {
    return null;
  }
}

export function windowsCheckedStopLiveDeps(options: WindowsCheckedStopLiveOptions = {}): WindowsCheckedStopDeps {
  const run = options.run ?? liveWindowsStopCommandRunner;
  const gate = options.gate ?? (() => true);
  const scQuery = async (timeoutMs: number) => parseScQueryState(await run("sc", ["query", WINSW_SERVICE_ID], timeoutMs));
  const scQcRun = options.scQcRun ?? (async (timeoutMs: number) => run("sc", ["qc", WINSW_SERVICE_ID], timeoutMs));
  return {
    canonicalPaths: windowsStopCanonicalPaths(),
    childPid: windowsStopChildPid(),
    async probeScheduler(timeoutMs) {
      const started = Date.now();
      const direct = await run("schtasks", ["/query", "/tn", TASK], timeoutMs);
      if (direct.status === 0 && direct.stdout.includes(TASK)) return { status: "present" };
      const listing = await run("schtasks", ["/query", "/fo", "CSV"], Math.max(1, timeoutMs - (Date.now() - started)));
      if (listing.status !== 0 || listing.timedOut) return { status: "unknown", detail: "the Task Scheduler query did not answer" };
      return windowsSchedulerCsvIncludesTask(listing.stdout, TASK) ? { status: "present" } : { status: "absent" };
    },
    async probeWinsw(timeoutMs) {
      // One cap covers both reads: the ownership query gets only what the state query left.
      const started = Date.now();
      const state = await scQuery(timeoutMs);
      const status = winswStatusFromScState(state);
      // Absence, and anything already unreadable, needs no ownership read.
      if (status !== "started") return status;
      const remaining = Math.floor(timeoutMs - (Date.now() - started));
      if (remaining < 1) return "unknown";
      const qc = await scQcRun(remaining);
      const ownership = classifyWinswOwnership(qc);
      // Foreign is `nonexistent` for Part A: a manager this home must not stop.
      if (ownership === "foreign") return "nonexistent";
      return ownership === "unknown" ? "unknown" : status;
    },
    enumerate: timeoutMs => (options.snapshot ?? windowsStopSnapshot)(timeoutMs),
    scheduleServicePid: timeoutMs => {
      const whole = wholeTimeoutMs(timeoutMs);
      return whole === null ? null : readScheduleServicePid({ timeoutMs: whole });
    },
    async endTask(timeoutMs) {
      if (!gate()) return "failed";
      return classifyTaskEnd(await run("schtasks", ["/end", "/tn", TASK], timeoutMs));
    },
    async taskState(timeoutMs) {
      const started = Date.now();
      const csv = await run("schtasks", ["/query", "/tn", TASK, "/fo", "CSV", "/nh"], timeoutMs);
      const parsed = csv.status === 0 ? parseTaskCsvState(csv.stdout) : "unknown";
      if (parsed !== "unknown") return parsed;
      // A localized status word: ask Get-ScheduledTask, whose State is an enum name.
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) return "unknown";
      const ps = await run("powershell", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command",
        "(Get-ScheduledTask -TaskName '" + TASK + "' -TaskPath '\\' -ErrorAction Stop).State"], left);
      const state = ps.stdout.trim();
      if (/^running$/i.test(state)) return "running";
      if (/^(ready|disabled|queued)$/i.test(state)) return "not-running";
      return "unknown";
    },
    async winswStop(timeoutMs) {
      if (!gate()) return "failed";
      return classifyScStop(await run("sc", ["stop", WINSW_SERVICE_ID], timeoutMs));
    },
    winswState: scQuery,
    proxyAlive: () => {
      const pid = windowsStopChildPid();
      return pid === null ? false : isProcessAlive(pid);
    },
    openWatch: (pid, startTime) => openWindowsProcessWatch(pid, startTime),
    terminate: (pid, startTime, timeoutMs) => windowsStopTerminate(pid, startTime, timeoutMs),
  };
}

/** One listener scan, bounded by the caller's timeout; a scan that misses it is unreadable. */
export type WindowsStopPortScan = (port: number, timeoutMs: number) => ListenPidScan | Promise<ListenPidScan>;

const WINDOWS_STOP_SCAN_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The production listener scan: netstat -ano through execFile with the caller's timeout.
 *
 * `netstat -ano` is asked directly rather than through `cmd /c chcp 437`: the locale-safe
 * wildcard-foreign rule in parseListenEntriesFromNetstat already recognizes a listen row, and
 * running the program itself means the timeout terminates the only helper spawned. The table
 * is read from the trusted System32 path — SystemRoot is caller-controlled.
 */
export function scanWindowsStopListenPids(port: number, timeoutMs: number): Promise<ListenPidScan> {
  const whole = wholeTimeoutMs(timeoutMs);
  if (whole === null) return Promise.resolve({ ok: false, error: "no positive timeout to sample with" });
  let netstat: string;
  try {
    netstat = join(resolveTrustedWindowsSystemDirectory(), "netstat.exe");
  } catch (error) {
    return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return new Promise(resolve => {
    // execFile's timeout terminates the helper; the callback then answers unreadable.
    execFile(netstat, ["-ano", "-p", "tcp"], {
      encoding: "buffer",
      timeout: whole,
      killSignal: "SIGKILL",
      windowsHide: true,
      maxBuffer: WINDOWS_STOP_SCAN_MAX_BUFFER,
    }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      const text = typeof stdout === "string" ? stdout : decodeWindowsTextBytes(stdout);
      resolve({ ok: true, pids: parseListenPidsFromNetstat(text, port) });
    });
  });
}

/**
 * One port sample, capped by `timeoutMs`. A listener whose owner has exited is cleared like
 * reclaimListenPort does.
 *
 * A scan that does not answer within the budget is "unknown": Part B's closing sample is
 * bounded (030 "Time budget"), and a synchronous scan both ignored that cap and could stall
 * the stop for the helper's own 5 s. The timeout is floored and a value below 1 ms samples
 * nothing, because execFile reads 0 as unlimited — the same rule as the command runner.
 */
export async function sampleWindowsStopPort(
  port: number,
  timeoutMs: number,
  io: {
    scan?: WindowsStopPortScan;
    alive?: (pid: number) => boolean;
    /** Clears the ghost rows of the exited owners only; never another program's rows. */
    drop?: (port: number, ownerPids: readonly number[]) => unknown;
    selfPid?: number;
  } = {},
): Promise<WindowsPortSample> {
  const whole = wholeTimeoutMs(timeoutMs);
  if (whole === null) return { state: "unknown" };
  const scan = await runBoundedScan(port, whole, io.scan ?? scanWindowsStopListenPids);
  if (scan === null || !scan.ok) return { state: "unknown" };
  const pids = scan.pids.filter(pid => pid !== (io.selfPid ?? process.pid));
  if (pids.length === 0) return { state: "free" };
  const alive = io.alive ?? isProcessAlive;
  const live = pids.filter(pid => alive(pid));
  if (live.length === 0) {
    // Clear only the ghost rows the exited PID(s) left: a program that took the port after
    // the scan owns its rows, and resetting them would break a connection this stop does not own.
    try {
      (io.drop ?? ((target: number, owners: readonly number[]) => dropWindowsTcpRowsForLocalPort(target, undefined, owners)))(port, pids);
    } catch { /* the next sample decides */ }
  }
  return { state: "listening", ownerPid: live[0] ?? pids[0] ?? null };
}

/** Resolve null once the budget is spent; a scan that never answers cannot hold the stop. */
function runBoundedScan(port: number, timeoutMs: number, scan: WindowsStopPortScan): Promise<ListenPidScan | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: ListenPidScan | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    let pending: ListenPidScan | Promise<ListenPidScan>;
    try {
      pending = scan(port, timeoutMs);
    } catch {
      finish(null);
      return;
    }
    Promise.resolve(pending).then(finish, () => finish(null));
  });
}

/**
 * ours = an opencodex process (the respawned proxy); exited = its owner is gone.
 *
 * Tri-state (#7771): only a positive "mismatch" is foreign. `verifyPidIdentity` collapses
 * "not an ocx process" and "the probe could not answer" into the same null, and a probe that
 * cannot read another account's or an elevated process's command line is not evidence that
 * another program holds the port — Part B would then report portHeldByForeign and let the
 * caller restore shared config with the proxy possibly still alive. Unreadable stays unknown.
 */
export function identifyWindowsStopListener(
  ownerPid: number | null,
  io: {
    alive?: (pid: number) => boolean;
    identity?: (pid: number) => OcxStartIdentityObservation;
  } = {},
): WindowsListenerIdentity {
  if (ownerPid === null) return "unknown";
  if (!(io.alive ?? isProcessAlive)(ownerPid)) return "exited";
  try {
    const observed = (io.identity ?? inspectOcxStartProcessIdentity)(ownerPid);
    if (observed === "match") return "ours";
    return observed === "mismatch" ? "foreign" : "unknown";
  } catch {
    return "unknown";
  }
}

export function windowsStopConfirmLiveDeps(
  port: number,
  remainingMs: number,
  options: { snapshot?: (timeoutMs: number) => Promise<readonly WindowsStopProcessEntry[] | null> } = {},
): WindowsStopConfirmDeps {
  return {
    port,
    remainingMs,
    canonicalPaths: windowsStopCanonicalPaths(),
    samplePort: (samplePort, timeoutMs) => sampleWindowsStopPort(samplePort, timeoutMs),
    identifyListener: (_port, ownerPid) => identifyWindowsStopListener(ownerPid),
    enumerate: timeoutMs => (options.snapshot ?? windowsStopSnapshot)(timeoutMs),
  };
}
