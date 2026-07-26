/**
 * Detect / optionally terminate long-lived Codex app-server processes that keep an
 * in-memory model catalog after `ocx sync` rewrites on-disk files (#476).
 *
 * Matching is intentionally narrow: require `app-server` (with a `codex` argv token)
 * or `codex-code-mode-host`. Never match broad `*codex*` patterns that hit unrelated
 * tools such as `hermes-codex-bridge-mcp`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isProcessAlive, waitForExit } from "../lib/process-control";

export const STALE_CODEX_APP_SERVER_HINT =
  "If Codex still shows an older model list, restart its long-lived app-server process after sync (ocx sync --restart-codex).";

export interface CodexAppServerProcess {
  pid: number;
  commandLine: string;
}

export interface CodexAppServerProcessIo {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  listSnapshots?: () => Array<{ pid: number; commandLine: string; uid?: number }>;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  now?: () => number;
}

/** True when the command line is a Codex app-server (or code-mode host) worth restarting. */
export function isCodexAppServerCommandLine(commandLine: string): boolean {
  const normalized = commandLine.toLowerCase().replace(/\\/g, "/");
  if (normalized.includes("codex-code-mode-host")) return true;
  if (!normalized.includes("app-server")) return false;
  // Require a codex executable token so we do not match unrelated "*codex*" names that
  // happen to embed the substring "app-server" in some other argument.
  return /(?:^|[\s/"'])codex(?:\.cmd|\.exe)?(?:$|[\s"'])/.test(normalized)
    || /\/codex(?:\.cmd|\.exe)?(?:\s|$|"|')/.test(normalized);
}

function parseUnixProcStatusUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  if (!match) return undefined;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) ? uid : undefined;
}

function listUnixProcSnapshots(uid: number | undefined): Array<{ pid: number; commandLine: string; uid?: number }> {
  if (!existsSync("/proc")) return [];
  const out: Array<{ pid: number; commandLine: string; uid?: number }> = [];
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const processUid = parseUnixProcStatusUid(status);
      if (uid !== undefined && processUid !== undefined && processUid !== uid) continue;
      const commandLine = readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8")
        .replace(/\0/g, " ")
        .trim();
      if (!commandLine) continue;
      out.push({ pid, commandLine, uid: processUid });
    } catch {
      /* process exited mid-scan */
    }
  }
  return out;
}

function listWindowsSnapshots(): Array<{ pid: number; commandLine: string }> {
  const out: Array<{ pid: number; commandLine: string }> = [];
  const wmic = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\wbem\\WMIC.exe`;
  try {
    const output = execFileSync(wmic, [
      "process", "get", "ProcessId,CommandLine", "/FORMAT:LIST",
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 8_000, windowsHide: true });
    const blocks = output.replace(/\r/g, "").split(/\n\n+/);
    for (const block of blocks) {
      const commandLine = /^CommandLine=(.*)$/m.exec(block)?.[1]?.trim();
      const pidRaw = /^ProcessId=(\d+)$/m.exec(block)?.[1];
      if (!commandLine || !pidRaw) continue;
      const pid = Number(pidRaw);
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      out.push({ pid, commandLine });
    }
    if (out.length > 0) return out;
  } catch {
    /* WMIC missing — fall through */
  }
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0}`t{1}' -f $_.ProcessId, $_.CommandLine }",
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 12_000, windowsHide: true });
    for (const line of output.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const pid = Number(line.slice(0, tab));
      const commandLine = line.slice(tab + 1).trim();
      if (!Number.isSafeInteger(pid) || pid <= 1 || !commandLine) continue;
      out.push({ pid, commandLine });
    }
  } catch {
    return out;
  }
  return out;
}

function defaultListSnapshots(platform: NodeJS.Platform, getuid: () => number | undefined) {
  if (platform === "win32") return listWindowsSnapshots();
  return listUnixProcSnapshots(getuid());
}

export function listCodexAppServerProcesses(io: CodexAppServerProcessIo = {}): CodexAppServerProcess[] {
  const platform = io.platform ?? process.platform;
  const getuid = io.getuid ?? (() => {
    try {
      return typeof process.getuid === "function" ? process.getuid() : undefined;
    } catch {
      return undefined;
    }
  });
  const snapshots = io.listSnapshots?.() ?? defaultListSnapshots(platform, getuid);
  const seen = new Set<number>();
  const matched: CodexAppServerProcess[] = [];
  for (const snapshot of snapshots) {
    if (seen.has(snapshot.pid)) continue;
    if (!isCodexAppServerCommandLine(snapshot.commandLine)) continue;
    seen.add(snapshot.pid);
    matched.push({ pid: snapshot.pid, commandLine: snapshot.commandLine });
  }
  return matched;
}

export function formatStaleCodexAppServerWarning(processes: readonly CodexAppServerProcess[]): string {
  const pids = processes.map(process => process.pid).join(", ");
  return (
    `WARNING: ${processes.length} Codex app-server process(es) still running (PID${processes.length === 1 ? "" : "s"}: ${pids}). `
    + "Disk catalog/cache were updated, but Codex may keep showing the old model list until those processes restart. "
    + "Re-run with `ocx sync --restart-codex` (or `ocx sync-cache --restart-codex`) to send SIGTERM only to matching app-server processes. "
    + "Active turns may be interrupted."
  );
}

export interface RestartCodexAppServersResult {
  requested: number[];
  stopped: number[];
  surviving: number[];
  failed: Array<{ pid: number; error: string }>;
}

/** Send SIGTERM to matched processes and wait briefly; never escalates to SIGKILL. */
export function restartCodexAppServers(
  processes: readonly CodexAppServerProcess[] = listCodexAppServerProcesses(),
  io: CodexAppServerProcessIo = {},
): RestartCodexAppServersResult {
  const isAlive = io.isAlive ?? isProcessAlive;
  const kill = io.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const wait = io.waitExit ?? waitForExit;
  const requested = processes.map(process => process.pid);
  const stopped: number[] = [];
  const surviving: number[] = [];
  const failed: Array<{ pid: number; error: string }> = [];

  for (const proc of processes) {
    try {
      kill(proc.pid, "SIGTERM");
    } catch (error) {
      failed.push({
        pid: proc.pid,
        error: error instanceof Error ? error.message : String(error),
      });
      if (isAlive(proc.pid)) surviving.push(proc.pid);
      continue;
    }
    if (wait(proc.pid, 2_000) || !isAlive(proc.pid)) stopped.push(proc.pid);
    else surviving.push(proc.pid);
  }

  return { requested, stopped, surviving, failed };
}

export interface AfterCatalogWriteAppServerOptions {
  restart: boolean;
  log?: Pick<Console, "log" | "error"> | null;
  io?: CodexAppServerProcessIo;
}

export interface AfterCatalogWriteAppServerResult {
  processes: CodexAppServerProcess[];
  warned: boolean;
  restart?: RestartCodexAppServersResult;
  hint: string;
}

/** Warn about stale app-servers after catalog/cache writes, or restart them when requested. */
export function afterCatalogWriteHandleAppServers(
  options: AfterCatalogWriteAppServerOptions,
): AfterCatalogWriteAppServerResult {
  const processes = listCodexAppServerProcesses(options.io);
  const hint = STALE_CODEX_APP_SERVER_HINT;
  if (processes.length === 0) {
    return { processes, warned: false, hint };
  }
  if (!options.restart) {
    options.log?.error(formatStaleCodexAppServerWarning(processes));
    return { processes, warned: true, hint };
  }
  options.log?.log(
    `Stopping Codex app-server process(es): ${processes.map(process => process.pid).join(", ")} `
    + "(active turns may be interrupted).",
  );
  const restart = restartCodexAppServers(processes, options.io);
  if (restart.stopped.length > 0) {
    options.log?.log(`Stopped Codex app-server PID(s): ${restart.stopped.join(", ")}`);
  }
  for (const failure of restart.failed) {
    options.log?.error(`Failed to stop Codex app-server PID ${failure.pid}: ${failure.error}`);
  }
  if (restart.surviving.length > 0) {
    options.log?.error(
      `Codex app-server PID(s) still running after SIGTERM: ${restart.surviving.join(", ")}. `
      + "Stop them manually if the model list stays stale.",
    );
  }
  return { processes, warned: false, restart, hint };
}
