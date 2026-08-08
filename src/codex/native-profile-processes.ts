import { execFile } from "node:child_process";
import { basename } from "node:path";
import {
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsWmicExe,
} from "../lib/windows-elevation";
import { parseWmicListRecords } from "../lib/windows-wmic";

const PROCESS_LIST_MAX_BUFFER = 16 * 1024 * 1024;
const DIRECT_CODEX_BASENAMES = new Set(["codex", "codex.exe"]);
const CODEX_INTERPRETER_BASENAMES = new Set(["node", "nodejs", "bun"]);
const CODEX_ENTRYPOINT_BASENAMES = new Set([
  "codex",
  "codex.js",
  "codex.mjs",
  "codex.cjs",
  "codex.ts",
]);

const WINDOWS_CODEX_NAME_RE = /^(?:codex|codex\.exe)$/i;
const WINDOWS_CODEX_CMDLINE_RE = /(?:^|[\\/"\s])codex(?:\.exe|\.cmd)?(?:["\s]|$)/i;

export interface NativeProcessExecOptions {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  windowsHide?: boolean;
  shell: false;
  killSignal: "SIGKILL";
}

export type NativeProcessExecutor = (
  file: string,
  args: string[],
  options: NativeProcessExecOptions,
) => Promise<string>;

export interface NativeCodexProcessProbeOptions {
  platform?: NodeJS.Platform;
  execFile?: NativeProcessExecutor;
  pid?: number;
}

export type NativeCodexProcessProbe =
  | { status: "clear"; count: 0 }
  | { status: "busy"; count: number }
  | { status: "unknown"; count: 0 };

/** Async, shell-free child execution with runtime-enforced timeout and output bounds. */
export const executeNativeProcess: NativeProcessExecutor = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, {
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide,
    shell: false,
    killSignal: options.killSignal,
  }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

/**
 * Count Codex processes on Windows. WMIC is preferred when present (faster
 * cold start, no .NET runtime); the hidden PowerShell CIM query is the
 * fallback for hosts without WMIC (a deprecated optional component on modern
 * Windows 11 images). Both paths run hidden (windowsHide) so a console-less
 * proxy never presents a child console window.
 */
async function windowsProcessCount(run: NativeProcessExecutor, selfPid: number): Promise<number> {
  const wmic = resolveTrustedWindowsWmicExe();
  return wmic
    ? windowsProcessCountViaWmic(run, wmic, selfPid)
    : windowsProcessCountViaPowerShell(run, selfPid);
}

async function windowsProcessCountViaWmic(
  run: NativeProcessExecutor,
  wmic: string,
  selfPid: number,
): Promise<number> {
  const output = await run(wmic, [
    "process", "where",
    "(Name like 'codex%' or CommandLine like '%codex%')",
    "get", "ProcessId,Name,CommandLine", "/format:list",
  ], {
    encoding: "utf8",
    timeout: 12_000,
    maxBuffer: PROCESS_LIST_MAX_BUFFER,
    windowsHide: true,
    shell: false,
    killSignal: "SIGKILL",
  });
  const records = parseWmicListRecords(output);
  // A valid enumeration always includes at least our own process (the proxy
  // command line contains "opencodex"), so an empty result is a failure.
  if (records.length === 0) throw new Error("invalid process list");
  let count = 0;
  for (const record of records) {
    if (record.processId === selfPid) continue;
    const nameMatch = record.name !== undefined && WINDOWS_CODEX_NAME_RE.test(record.name);
    const commandLineMatch = record.commandLine !== undefined
      && WINDOWS_CODEX_CMDLINE_RE.test(record.commandLine);
    if (nameMatch || commandLineMatch) count += 1;
  }
  return count;
}

async function windowsProcessCountViaPowerShell(
  run: NativeProcessExecutor,
  selfPid: number,
): Promise<number> {
  const powershell = resolveTrustedWindowsPowerShellExe();
  // The script text itself contains "codex", so the PowerShell host process
  // matches the candidate filter and must be excluded ($self). The probing
  // proxy (opencodex in its command line) is excluded by pid.
  const selfFilter = Number.isSafeInteger(selfPid) && selfPid > 0
    ? ` $_.ProcessId -ne ${selfPid} -and`
    : "";
  const script = [
    "$ErrorActionPreference='Stop';",
    "$self=$PID;",
    `$items=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and${selfFilter} ($_.Name -match '^(?i:codex)(?:\\.exe)?$' -or $_.CommandLine -match '(?i)(?:^|[\\\\/\"\\s])codex(?:\\.exe|\\.cmd)?(?:[\"\\s]|$)') };`,
    "@($items).Count",
  ].join(" ");
  const output = (await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 12_000,
    maxBuffer: PROCESS_LIST_MAX_BUFFER,
    windowsHide: true,
    shell: false,
    killSignal: "SIGKILL",
  })).trim();
  if (!/^\d+$/.test(output)) throw new Error("invalid process count");
  const count = Number(output);
  if (!Number.isSafeInteger(count)) throw new Error("invalid process count");
  return count;
}

async function unixProcessCount(run: NativeProcessExecutor, pid: number): Promise<number> {
  const output = await run("ps", ["-eo", "pid=,comm=,args="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: PROCESS_LIST_MAX_BUFFER,
    shell: false,
    killSignal: "SIGKILL",
  });
  let count = 0;
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!match || Number(match[1]) === pid) continue;
    const command = basename(match[2]!).toLowerCase();
    const [rawArgv0 = "", rawEntrypoint = ""] = match[3]!.trim().split(/\s+/, 2);
    const argv0 = basename(rawArgv0).toLowerCase();
    const entrypoint = basename(rawEntrypoint).toLowerCase();
    const isDirectCodex = DIRECT_CODEX_BASENAMES.has(command)
      || DIRECT_CODEX_BASENAMES.has(argv0);
    const isInterpreterWrappedCodex = CODEX_INTERPRETER_BASENAMES.has(argv0)
      && CODEX_ENTRYPOINT_BASENAMES.has(entrypoint);
    if (isDirectCodex || isInterpreterWrappedCodex) count += 1;
  }
  return count;
}

/** Best-effort, read-only process probe. It never terminates a user process. */
export async function probeNativeCodexProcesses({
  platform = process.platform,
  execFile: run = executeNativeProcess,
  pid = process.pid,
}: NativeCodexProcessProbeOptions = {}): Promise<NativeCodexProcessProbe> {
  try {
    const count = await (platform === "win32"
      ? windowsProcessCount(run, pid)
      : unixProcessCount(run, pid));
    return count > 0 ? { status: "busy", count } : { status: "clear", count: 0 };
  } catch {
    return { status: "unknown", count: 0 };
  }
}
