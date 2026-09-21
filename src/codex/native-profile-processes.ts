import { execFile } from "node:child_process";
import { basename } from "node:path";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import {
  listProcessSnapshots,
  tokenizeCommandLine,
  type ProcessSnapshot,
} from "./app-server-processes";

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

export interface CodexClientProcess {
  pid: number;
  commandLine: string;
}

/**
 * Synchronous Codex-CLI process list for routing-adoption (#4550).
 *
 * "enumerated" is a successful read, including the empty list, which means
 * no matching client is running. "unavailable" means we could not name PIDs:
 * a failed snapshot walk. The two must not collapse. An empty array is
 * "none running" and would otherwise produce a false adopted. Windows is
 * enumerable here: listProcessSnapshots already returns CLI command lines.
 * Do not route through listCodexAppServerProcesses; that maps a failed
 * walk to [] for the #476 kill contract.
 */
export type CodexClientProcessList =
  | { status: "enumerated"; processes: CodexClientProcess[] }
  | { status: "unavailable" };

export interface ListCodexClientProcessesOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  getuid?: () => number | undefined;
  /** Test seam: raw snapshots. Enumeration failure is thrown, not []. */
  listSnapshots?: () => ProcessSnapshot[];
}

/**
 * True when a ps comm field plus args string is a Codex CLI client.
 *
 * Direct "codex" / "codex.exe" basenames, or a known interpreter whose
 * immediate entrypoint is a Codex CLI script. The busy-count probe and the
 * routing-adoption lister both call this so the rules cannot drift (#2457).
 */
export function isCodexClientProcess(command: string, args: string): boolean {
  const comm = basename(command).toLowerCase();
  const [rawArgv0 = "", rawEntrypoint = ""] = args.trim().split(/\s+/, 2);
  const argv0 = basename(rawArgv0).toLowerCase();
  const entrypoint = basename(rawEntrypoint).toLowerCase();
  const isDirectCodex = DIRECT_CODEX_BASENAMES.has(comm)
    || DIRECT_CODEX_BASENAMES.has(argv0);
  const isInterpreterWrappedCodex = CODEX_INTERPRETER_BASENAMES.has(argv0)
    && CODEX_ENTRYPOINT_BASENAMES.has(entrypoint);
  return isDirectCodex || isInterpreterWrappedCodex;
}

function parseUnixPsLine(line: string): { pid: number; command: string; args: string } | null {
  const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) return null;
  return { pid, command: match[2]!, args: match[3]! };
}

function unixCodexClientsFromPs(output: string, selfPid: number): CodexClientProcess[] {
  const processes: CodexClientProcess[] = [];
  for (const line of output.split("\n")) {
    const parsed = parseUnixPsLine(line);
    if (!parsed || parsed.pid === selfPid) continue;
    if (!isCodexClientProcess(parsed.command, parsed.args)) continue;
    processes.push({
      pid: parsed.pid,
      commandLine: parsed.args.trim() || parsed.command,
    });
  }
  return processes;
}

/**
 * Name running Codex CLI processes so status can tell a pre-injection client
 * from one that had a chance to read the injected route (#4550).
 *
 * probeNativeCodexProcesses is async and count-only; collectStartupHealth is
 * synchronous, so this path cannot reuse it. Snapshots come from
 * listProcessSnapshots so Windows CLI PIDs are named too; a thrown walk
 * stays unavailable rather than an empty adopted list.
 */
export function listCodexClientProcesses({
  platform = process.platform,
  pid = process.pid,
  getuid,
  listSnapshots,
}: ListCodexClientProcessesOptions = {}): CodexClientProcessList {
  try {
    const snapshots = listSnapshots
      ? listSnapshots()
      : listProcessSnapshots({ platform, getuid });
    const seen = new Set<number>();
    const processes: CodexClientProcess[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.pid === pid || seen.has(snapshot.pid)) continue;
      if (!snapshotIsCodexClient(snapshot)) continue;
      seen.add(snapshot.pid);
      processes.push({ pid: snapshot.pid, commandLine: snapshot.commandLine });
    }
    return { status: "enumerated", processes };
  } catch {
    return { status: "unavailable" };
  }
}

function snapshotIsCodexClient(snapshot: ProcessSnapshot): boolean {
  if (isCodexClientProcess(snapshot.executable ?? "", snapshot.commandLine)) return true;
  const argv0 = tokenizeCommandLine(snapshot.commandLine)[0] ?? "";
  return argv0 !== "" && isCodexClientProcess(argv0, snapshot.commandLine);
}

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

async function windowsProcessCount(run: NativeProcessExecutor): Promise<number> {
  const powershell = resolveTrustedWindowsPowerShellExe();
  const script = [
    "$ErrorActionPreference='Stop';",
    "$self=$PID;",
    "$items=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and ($_.Name -match '^(?i:codex)(?:\\.exe)?$' -or $_.CommandLine -match '(?i)(?:^|[\\\\/\"\\s])codex(?:\\.exe|\\.cmd)?(?:[\"\\s]|$)') };",
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
  return unixCodexClientsFromPs(output, pid).length;
}

/** Best-effort, read-only process probe. It never terminates a user process. */
export async function probeNativeCodexProcesses({
  platform = process.platform,
  execFile: run = executeNativeProcess,
  pid = process.pid,
}: NativeCodexProcessProbeOptions = {}): Promise<NativeCodexProcessProbe> {
  try {
    const count = await (platform === "win32"
      ? windowsProcessCount(run)
      : unixProcessCount(run, pid));
    return count > 0 ? { status: "busy", count } : { status: "clear", count: 0 };
  } catch {
    return { status: "unknown", count: 0 };
  }
}
