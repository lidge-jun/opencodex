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
 * - terminate and watch: native process handles are required. No PID-only termination
 *   is attempted when the native API is unavailable.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";
import { windowsLauncherVbsPath, windowsServiceScriptPath } from "./state";
import { commandLineHasPathToken } from "./windows-command-line-token";
import type { WindowsProcessEntry } from "./windows-guarded-manager";
import { windowsWrapperImage } from "./windows-stop-binding";
import {
  windowsProcessNative,
  windowsProcessPlatform,
  windowsProcessPlatformSimulated,
  type WindowsProcessNativeApi,
  type WindowsProcessWatch,
  type WindowsTerminateResult,
} from "./windows-process-native";

/** A spawned helper. "powershell" and "sc" resolve inside the trusted system directory. */
export interface WindowsEvidenceCommand {
  program: "powershell" | "sc";
  args: string[];
  timeoutMs: number;
  maxBufferBytes: number;
  /** Snapshot framing can preserve a complete table if later optional enrichment fails. */
  allowPartialOutput?: boolean;
}

/** Runs a command; only framed snapshots may retain stdout after a later command failure. */
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
const OWNER_READ_LIMIT = 32;
const OWNER_READ_BUDGET_MS = 1_500;
/**
 * Owner reads stop being admitted this long before the snapshot's cap, counted from the
 * helper's own process start. It covers one in-flight 1 s CIM call plus serialization and
 * exit, so optional owner evidence cannot turn a readable table into a timed-out one.
 */
export const SNAPSHOT_OWNER_RESERVE_MS = 2_000;

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
    if (error && (!command.allowPartialOutput || !stdout.startsWith("OCX_PROCESS_SNAPSHOT "))) reject(error);
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

/**
 * Owner enrichment admits at most 32 candidates within 1.5 s including enumeration;
 * individual CIM calls have a 1 s cap. A complete baseline precedes optional owner reads.
 * The earlier cutoff from the helper's process start also accounts for cold PowerShell startup.
 * Owner reads prioritize this home's complete launcher/script tokens before other possible
 * wrapper candidates. A fresh CIM read after GetOwnerSid binds that owner to the original
 * creation time; a reused PID cannot prove a foreign owner.
 */
export function windowsProcessSnapshotScript(timeoutMs: number): string {
  // A cap that is not a finite number admits no owner read; it never reaches the script text.
  const ownerCutoffMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs) - SNAPSHOT_OWNER_RESERVE_MS) : 0;
  // The helper's own command line must not contain either installation path as a token.
  const paths = [windowsLauncherVbsPath(), windowsServiceScriptPath()]
    .map(path => Buffer.from(path, "utf8").toString("base64"));
  return [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);",
    `$ownerBudget = @{ Remaining = ${OWNER_READ_LIMIT}; Clock = [Diagnostics.Stopwatch]::StartNew();`,
    "  Until = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().AddMilliseconds(" + ownerCutoffMs + ") };",
    "$currentSid = $null; try { $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { $currentSid = $null };",
    "$tokens = @('" + paths.join("','") + "') | ForEach-Object { [regex]::Escape([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))) };",
    "$homePath = '(?:^|[\\s\\x22\\x27])(?:' + ($tokens -join '|') + ')(?=$|[\\s\\x22\\x27])';",
    "$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop);",
    "function Write-ProcessSnapshot($owners) {",
    "  $projected = @($rows | Select-Object ProcessId,ParentProcessId,Name,CommandLine,",
    "    @{Name='CreationDate';Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }},",
    "    @{Name='CurrentUserSid';Expression={ $currentSid }}, @{Name='Owner';Expression={ $owners[$_.ProcessId] }});",
    "  'OCX_PROCESS_SNAPSHOT ' + (ConvertTo-Json -InputObject $projected -Depth 3 -Compress) };",
    "Write-ProcessSnapshot @{}; [Console]::Out.Flush();",
    "$priority = @($rows | Where-Object { $_.CommandLine -match $homePath });",
    "$fallback = @($rows | Where-Object { $_.CommandLine -notmatch $homePath -and",
    "  (($_.Name -match '^(wscript|cscript|cmd)\\.exe$') -or (-not $_.Name) -or ($_.CommandLine -like '*opencodex-service*')) });",
    "$owners = @{};",
    "foreach ($process in ($priority + $fallback)) {",
    `  if (!$currentSid -or $ownerBudget.Remaining -le 0 -or $ownerBudget.Clock.ElapsedMilliseconds -ge ${OWNER_READ_BUDGET_MS}`,
    "    -or [DateTime]::UtcNow -ge $ownerBudget.Until) { break };",
    "  $ownerBudget.Remaining--;",
    "  try {",
    "    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -OperationTimeoutSec 1 -ErrorAction Stop;",
    `    if ($ownerBudget.Clock.ElapsedMilliseconds -ge ${OWNER_READ_BUDGET_MS} -or [DateTime]::UtcNow -ge $ownerBudget.Until) { break };`,
    "    $after = Get-CimInstance -InputObject $process -OperationTimeoutSec 1 -ErrorAction Stop;",
    `    if ($ownerBudget.Clock.ElapsedMilliseconds -ge ${OWNER_READ_BUDGET_MS} -or [DateTime]::UtcNow -ge $ownerBudget.Until) { break };`,
    "    $owners[$process.ProcessId] = @{ Sid = $owner.Sid; ReturnValue = $owner.ReturnValue;",
    "      CreationDate = if ($after.CreationDate) { $after.CreationDate.ToUniversalTime().ToString('o') } else { $null } };",
    "  } catch { continue }",
    "};",
    "Write-ProcessSnapshot $owners",
  ].join(" ");
}

const SID_PATTERN = /^S-1-\d+(?:-\d+){1,15}$/i;
const USER_ACCOUNT_SID_PATTERN = /^S-1-(?:5-21|12-1)(?:-\d{1,10}){4}$/i;

function sid(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 && SID_PATTERN.test(value)
    && value.split("-").slice(3).every(part => Number(part) <= 0xffff_ffff)
    ? value.toUpperCase() : null;
}

function foreignProcessOwner(record: Record<string, unknown>, startTime: number | null): boolean | null {
  const current = sid(record.CurrentUserSid);
  const owner = record.Owner;
  if (startTime === null || current === null || typeof owner !== "object" || owner === null) return null;
  const evidence = owner as Record<string, unknown>;
  const observed = sid(evidence.Sid);
  if (evidence.ReturnValue !== 0 || observed === null || evidence.CreationDate !== record.CreationDate) return null;
  if (observed === current && USER_ACCOUNT_SID_PATTERN.test(current)) return false;
  // Supported installs run as the current account: local/domain or Entra ID. Other SID
  // namespaces, including built-in and virtual service accounts, remain conservative.
  // This exclusion never adds authority to terminate a candidate.
  return USER_ACCOUNT_SID_PATTERN.test(current) && USER_ACCOUNT_SID_PATTERN.test(observed) ? true : null;
}

/** Parse the snapshot JSON. Unparseable output is null: an unread table proves nothing. */
export function parseWindowsProcessSnapshot(output: string): WindowsStopProcessEntry[] | null {
  return decodeSnapshot(output);
}

type ObserveEntry = (entry: WindowsStopProcessEntry, record: Record<string, unknown>) => WindowsStopProcessEntry;

function decodeSnapshot(output: string, observe?: ObserveEntry): WindowsStopProcessEntry[] | null {
  let trimmed = output.trim();
  if (!trimmed) return [];
  const prefix = "OCX_PROCESS_SNAPSHOT ";
  if (trimmed.startsWith(prefix)) {
    const frames = trimmed.split(/\r?\n/).filter(line => line.startsWith(prefix));
    let complete: string | undefined;
    for (const frame of frames.reverse()) {
      try {
        const candidate = frame.slice(prefix.length);
        if (Array.isArray(JSON.parse(candidate))) { complete = candidate; break; }
      } catch { /* incomplete enrichment */ }
    }
    if (complete === undefined) return null;
    trimmed = complete;
  }
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
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) continue;
    const created = typeof record.CreationDate === "string" ? Date.parse(record.CreationDate) : Number.NaN;
    const entry = {
      pid,
      parentPid: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
      name: typeof record.Name === "string" ? record.Name : null,
      commandLine: typeof record.CommandLine === "string" ? record.CommandLine : null,
      startTime: Number.isFinite(created) ? created : null,
      foreignOwner: foreignProcessOwner(record, Number.isFinite(created) ? created : null),
    };
    entries.push(observe ? observe(entry, record) : entry);
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
  return entries.map(entry => overlayNativeCreationTime(entry, creationTime));
}

function overlayNativeCreationTime(
  entry: WindowsStopProcessEntry, creationTime: (pid: number) => number | null,
): WindowsStopProcessEntry {
  if (entry.startTime === null) return { ...entry, foreignOwner: null };
  let native: number | null;
  try {
    native = creationTime(entry.pid);
  } catch {
    native = null;
  }
  const agrees = native !== null && Math.abs(native - entry.startTime) <= NATIVE_CIM_TOLERANCE_MS;
  return { ...entry, startTime: agrees ? native : null, foreignOwner: agrees ? entry.foreignOwner : null };
}

/** The helper emits UTC .NET round-trip dates. Preserve the four sub-ms digits discarded by Date.parse. */
function cimCreationTicks(created: unknown, ms: number): bigint | null {
  if (typeof created !== "string" || created.length !== 28 || ms < 0) return null;
  const fraction = created.slice(23, 27);
  if (!/^\d{3}0$/.test(fraction) || created !== new Date(ms).toISOString().slice(0, -1) + fraction + "Z") return null;
  return 621_355_968_000_000_000n + BigInt(ms) * 10_000n + BigInt(fraction);
}

function observeNativeSnapshot(native: WindowsProcessNativeApi, deadline: number): ObserveEntry {
  const paths = [windowsLauncherVbsPath(), windowsServiceScriptPath()];
  const until = Math.min(deadline, performance.now() + OWNER_READ_BUDGET_MS);
  let remaining = OWNER_READ_LIMIT;
  const creationTime = (pid: number) => {
    if (performance.now() >= deadline) return null;
    const created = native.creationTime(pid);
    return performance.now() < deadline ? created : null;
  };
  return (entry, record) => {
    const checked = overlayNativeCreationTime(entry, creationTime);
    // A returned CIM owner whose validation failed remains unknown. Supplement only an absent sample.
    if (record.Owner !== null || record.ProcessId !== entry.pid || checked.startTime === null
      || checked.startTime !== entry.startTime || !windowsWrapperImage(entry.name)
      || !paths.some(path => commandLineHasPathToken(entry.commandLine, path))) return checked;
    const current = sid(record.CurrentUserSid);
    const ticks = cimCreationTicks(record.CreationDate, checked.startTime);
    if (!current || !USER_ACCOUNT_SID_PATTERN.test(current) || ticks === null || remaining <= 0 || performance.now() >= until) return checked;
    remaining--;
    try {
      if (native.sameUserIdentity(entry.pid, false, current)?.ticks === ticks && performance.now() < until) {
        return { ...checked, foreignOwner: false };
      }
    } catch { /* Inaccessible, exited and unverified processes cannot gain ownership evidence. */ }
    return checked;
  };
}

/** Every process with its creation time, or null when the table cannot be read. */
export async function windowsProcessSnapshot(options: WindowsEvidenceOptions): Promise<WindowsStopProcessEntry[] | null> {
  const run = runnerFor(options);
  if (!run) return null;
  const deadline = Number.isFinite(options.timeoutMs) ? performance.now() + options.timeoutMs : 0;
  try {
    const output = await run({
      program: "powershell",
      args: powershellArgs(windowsProcessSnapshotScript(options.timeoutMs)),
      timeoutMs: options.timeoutMs,
      maxBufferBytes: SNAPSHOT_MAX_BUFFER,
      allowPartialOutput: true,
    });
    const native = windowsProcessNative();
    return decodeSnapshot(output, native ? observeNativeSnapshot(native, deadline) : undefined);
  } catch {
    return null;
  }
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

/** Terminate only through a handle that verifies creation identity and token ownership. */
export async function terminateWindowsProcessBound(
  pid: number,
  boundStartTime: number,
  options: WindowsEvidenceOptions,
): Promise<WindowsTerminateResult> {
  const native = options.run ? null : windowsProcessNative();
  if (!native) return { status: "unavailable" };
  try {
    return native.terminate(pid, boundStartTime);
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
