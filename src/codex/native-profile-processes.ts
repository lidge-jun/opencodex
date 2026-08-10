import { execFile } from "node:child_process";
import { basename } from "node:path";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";

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
      ? windowsProcessCount(run)
      : unixProcessCount(run, pid));
    return count > 0 ? { status: "busy", count } : { status: "clear", count: 0 };
  } catch {
    return { status: "unknown", count: 0 };
  }
}
