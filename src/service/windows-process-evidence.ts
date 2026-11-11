/**
 * Process evidence for the checked Windows service stop (#7771): a process snapshot that
 * carries creation times, the Task Scheduler service PID, a checked terminate, and a
 * bind-time exit watch. Each facade uses the in-process primitive from
 * src/service/windows-process-native.ts where Bun's FFI runs (Windows x64) and a bounded
 * spawned fallback elsewhere on Windows (ARM64):
 *
 * - snapshot: one Get-CimInstance Win32_Process query with CreationDate. On x64 every
 *   creation time is re-read through GetProcessTimes and kept only when it agrees with
 *   CIM to the millisecond, so the bound value is the exact one the handle terminate
 *   compares later, and a PID reused between the CIM query and the native read is null
 *   (unreadable) instead of silently taking the new process's identity;
 * - Schedule PID: QueryServiceStatusEx on x64, else sc.exe queryex Schedule run from the
 *   trusted system directory with a cap; unreadable is null;
 * - terminate: the handle primitive on x64. ARM64 runs ONE trusted PowerShell script that
 *   re-reads Get-Process -Id StartTime, compares it with the bound CIM creation time
 *   (1 s tolerance, UTC), calls Kill() on the same Process object and reads the exit back.
 *   Kill() opens its own handle by PID, so a window between the in-script check and the
 *   kill remains; that, and the 1 s tolerance, are the accepted residuals of the fallback;
 * - watch: x64 only; elsewhere "unavailable", and the checked stop takes the exit from
 *   the terminate read-back.
 *
 * Only integers ever reach a script; paths and command lines are compared in TypeScript.
 * Nothing calls this module yet.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";
import type { WindowsProcessEntry } from "./windows-guarded-manager";
import {
  windowsProcessNative,
  windowsProcessPlatform,
  windowsProcessPlatformSimulated,
  type WindowsProcessWatch,
  type WindowsTerminateResult,
} from "./windows-process-native";

/** A spawned helper. "powershell" and "sc" resolve inside the trusted system directory. */
export interface WindowsEvidenceCommand {
  program: "powershell" | "sc";
  args: string[];
  timeoutMs: number;
  maxBufferBytes: number;
}

/** Runs a command and resolves stdout; rejects on a nonzero exit, a timeout or overflow. */
export type WindowsEvidenceRunner = (command: WindowsEvidenceCommand) => Promise<string>;

export interface WindowsEvidenceOptions {
  timeoutMs: number;
  /** Injected in tests. Unset on a simulated platform means no spawn at all. */
  run?: WindowsEvidenceRunner;
}

/** A process-table row with the creation time the binding rule requires (null = unreadable). */
export type WindowsStopProcessEntry = WindowsProcessEntry & { startTime: number | null };

const SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024;
const SMALL_MAX_BUFFER = 64 * 1024;
const NATIVE_CIM_TOLERANCE_MS = 1;
/** Kill() read-back inside the ARM64 script; the checked stop's wait covers the rest. */
export const FALLBACK_TERMINATE_EXIT_WAIT_MS = 1_000;

function trustedProgram(program: WindowsEvidenceCommand["program"]): string {
  if (program === "powershell") return resolveTrustedWindowsPowerShellExe();
  const sc = join(resolveTrustedWindowsSystemDirectory(), "sc.exe");
  if (!existsSync(sc)) throw new Error("sc.exe was not found in the trusted system directory.");
  return sc;
}

const defaultRunner: WindowsEvidenceRunner = command => new Promise((resolve, reject) => {
  let file: string;
  try {
    file = trustedProgram(command.program);
  } catch (error) {
    reject(error);
    return;
  }
  execFile(file, command.args, {
    encoding: "utf8",
    timeout: command.timeoutMs,
    maxBuffer: command.maxBufferBytes,
    windowsHide: true,
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

function runnerFor(options: WindowsEvidenceOptions): WindowsEvidenceRunner | null {
  if (options.run) return options.run;
  if (windowsProcessPlatformSimulated() || windowsProcessPlatform() !== "win32") return null;
  return defaultRunner;
}

function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", script];
}

/** The snapshot query. CreationDate is emitted as an ISO UTC string, never as a JSON date. */
export const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = "Get-CimInstance Win32_Process | Select-Object "
  + "ProcessId,ParentProcessId,Name,CommandLine,"
  + "@{Name='CreationDate';Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }} "
  + "| ConvertTo-Json -Compress";

/** Parse the snapshot JSON. Unparseable output is null: an unread table proves nothing. */
export function parseWindowsProcessSnapshot(output: string): WindowsStopProcessEntry[] | null {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const entries: WindowsStopProcessEntry[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    const parent = Number(record.ParentProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const created = typeof record.CreationDate === "string" ? Date.parse(record.CreationDate) : Number.NaN;
    entries.push({
      pid,
      parentPid: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
      name: typeof record.Name === "string" ? record.Name : null,
      commandLine: typeof record.CommandLine === "string" ? record.CommandLine : null,
      startTime: Number.isFinite(created) ? created : null,
    });
  }
  return entries;
}

/**
 * Replace each CIM creation time with the native one when both agree to the millisecond.
 * A disagreement (or a missing side) is null: the binding rule then treats the process as
 * unreadable rather than binding an identity the terminate check would not reproduce.
 */
export function overlayNativeCreationTimes(
  entries: readonly WindowsStopProcessEntry[],
  creationTime: (pid: number) => number | null,
): WindowsStopProcessEntry[] {
  return entries.map(entry => {
    if (entry.startTime === null) return entry;
    let native: number | null;
    try {
      native = creationTime(entry.pid);
    } catch {
      native = null;
    }
    const agrees = native !== null && Math.abs(native - entry.startTime) <= NATIVE_CIM_TOLERANCE_MS;
    return { ...entry, startTime: agrees ? native : null };
  });
}

/** Every process with its creation time, or null when the table cannot be read. */
export async function windowsProcessSnapshot(options: WindowsEvidenceOptions): Promise<WindowsStopProcessEntry[] | null> {
  const run = runnerFor(options);
  if (!run) return null;
  let entries: WindowsStopProcessEntry[] | null;
  try {
    entries = parseWindowsProcessSnapshot(await run({
      program: "powershell",
      args: powershellArgs(WINDOWS_PROCESS_SNAPSHOT_SCRIPT),
      timeoutMs: options.timeoutMs,
      maxBufferBytes: SNAPSHOT_MAX_BUFFER,
    }));
  } catch {
    return null;
  }
  if (entries === null) return null;
  const native = windowsProcessNative();
  return native ? overlayNativeCreationTimes(entries, pid => native.creationTime(pid)) : entries;
}

/**
 * sc.exe queryex Schedule: the PID only while STATE is 4 (RUNNING). The field names and
 * the numeric state are not localized; the trailing state word is ignored.
 */
export function parseScQueryexPid(output: string): number | null {
  const state = /^\s*STATE\s*:\s*(\d+)/m.exec(output);
  if (!state || Number(state[1]) !== 4) return null;
  const pid = /^\s*PID\s*:\s*(\d+)\s*$/m.exec(output);
  if (!pid) return null;
  const value = Number(pid[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The Task Scheduler service host's PID, or null when it cannot be proven. */
export async function readScheduleServicePid(options: WindowsEvidenceOptions): Promise<number | null> {
  const native = options.run ? null : windowsProcessNative();
  if (native) {
    try {
      return native.scheduleServicePid();
    } catch {
      return null;
    }
  }
  const run = runnerFor(options);
  if (!run) return null;
  try {
    return parseScQueryexPid(await run({
      program: "sc",
      args: ["queryex", "Schedule"],
      timeoutMs: options.timeoutMs,
      maxBufferBytes: SMALL_MAX_BUFFER,
    }));
  } catch {
    return null;
  }
}

/**
 * The ARM64 terminate script. pid and the bound time must be safe integers; nothing else
 * is interpolated. One status word is printed on the last line.
 */
export function windowsFallbackTerminateScript(pid: number, boundStartTime: number, exitWaitMs: number): string {
  for (const value of [pid, boundStartTime, exitWaitMs]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("terminate script inputs must be non-negative integers");
  }
  return [
    "$ErrorActionPreference = 'Stop';",
    "try { $p = Get-Process -Id " + pid + " -ErrorAction Stop } catch { 'gone'; exit 0 };",
    "try { $start = $p.StartTime.ToUniversalTime() } catch {",
    "  try { if ($p.HasExited) { 'gone' } else { 'denied' } } catch { 'denied' }; exit 0 };",
    "$bound = [DateTimeOffset]::FromUnixTimeMilliseconds(" + boundStartTime + ").UtcDateTime;",
    "if ([Math]::Abs(($start - $bound).TotalMilliseconds) -gt 1000) { 'reused'; exit 0 };",
    "try { $p.Kill() }",
    "catch [System.InvalidOperationException] { 'gone'; exit 0 }",
    "catch [System.ComponentModel.Win32Exception] { 'denied'; exit 0 }",
    "catch { 'unavailable'; exit 0 };",
    "if ($p.WaitForExit(" + exitWaitMs + ")) { 'terminated-exited' } else { 'terminated' }",
  ].join(" ");
}

/** Map the script's last line; anything unexpected is "unavailable", never success. */
export function parseFallbackTerminateOutput(output: string): WindowsTerminateResult {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const word = lines[lines.length - 1] ?? "";
  if (word === "terminated-exited") return { status: "terminated", exited: true };
  if (word === "terminated") return { status: "terminated", exited: false };
  if (word === "gone" || word === "reused" || word === "denied") return { status: word };
  return { status: "unavailable" };
}

/** Terminate pid only if it is still the process created at boundStartTime. */
export async function terminateWindowsProcessBound(
  pid: number,
  boundStartTime: number,
  options: WindowsEvidenceOptions,
): Promise<WindowsTerminateResult> {
  const native = options.run ? null : windowsProcessNative();
  if (native) {
    try {
      return native.terminate(pid, boundStartTime);
    } catch {
      return { status: "unavailable" };
    }
  }
  const run = runnerFor(options);
  if (!run) return { status: "unavailable" };
  // A timeout derived from a deadline can be fractional, and both execFile and the script
  // take whole milliseconds. A timeout that floors to 0 would mean no timeout at all.
  const timeoutMs = Math.floor(options.timeoutMs);
  if (!(timeoutMs > 0)) return { status: "unavailable" };
  const exitWaitMs = Math.max(0, Math.min(FALLBACK_TERMINATE_EXIT_WAIT_MS, timeoutMs - 500));
  try {
    return parseFallbackTerminateOutput(await run({
      program: "powershell",
      args: powershellArgs(windowsFallbackTerminateScript(pid, boundStartTime, exitWaitMs)),
      timeoutMs,
      maxBufferBytes: SMALL_MAX_BUFFER,
    }));
  } catch {
    return { status: "unavailable" };
  }
}

/** A bind-time exit watch; "unavailable" wherever the handle primitive cannot run. */
export function openWindowsProcessWatch(pid: number, boundStartTime: number): WindowsProcessWatch {
  const native = windowsProcessNative();
  if (!native) return { status: "unavailable" };
  try {
    return native.openWatch(pid, boundStartTime);
  } catch {
    return { status: "unavailable" };
  }
}
