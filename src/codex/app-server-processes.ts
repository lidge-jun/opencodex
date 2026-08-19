/**
 * Detect / optionally terminate long-lived Codex app-server processes that keep an
 * in-memory model catalog after `ocx sync` rewrites on-disk files (#476).
 *
 * Matching is intentionally narrow: require `app-server` as the Codex subcommand
 * (not merely as a substring in some later argument) or `codex-code-mode-host`.
 * Never match broad `*codex*` patterns that hit unrelated tools such as
 * `hermes-codex-bridge-mcp`.
 */
import { execFile, execFileSync, type ExecFileException } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isProcessAlive, waitForExit } from "../lib/process-control";
import {
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsTaskkillExe,
} from "../lib/windows-elevation";
import { readCodexCatalogPath } from "./catalog/parsing";

export const STALE_CODEX_APP_SERVER_HINT =
  "If Codex still shows an older model list, restart its long-lived app-server process after sync (ocx sync --restart-codex).";

/** Attach the shared dashboard hint only after a catalog or models_cache write. */
export function attachStaleAppServerHint<T extends {
  catalogWritten: boolean;
  cacheSynced: boolean;
}>(result: T): T & { staleAppServerHint?: string } {
  if (result.catalogWritten || result.cacheSynced) {
    return { ...result, staleAppServerHint: STALE_CODEX_APP_SERVER_HINT };
  }
  return { ...result };
}
/**
 * Rust-style target-triple body on official platform-baked Codex binaries
 * (e.g. `x86_64-unknown-linux-musl`, `aarch64-apple-darwin`,
 * `x86_64-pc-windows-msvc`). Requires arch-vendor-os with an optional env
 * segment — not a broad `codex-*` wildcard.
 */
const CODEX_TARGET_TRIPLE_BODY = "[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?";

/**
 * Narrow Win32_Process CommandLine pre-filter (JS + .NET compatible).
 * Allows an optional closing quote after the executable basename so paths like
 * `"C:\Program Files\...\codex.exe" app-server` still reach GetOwner.
 * Also admits official target-triple basenames such as
 * `codex-x86_64-pc-windows-msvc.exe`.
 */
export const WINDOWS_CODEX_BASENAME_CANDIDATE_RE = new RegExp(
  `(^|[/\\\\\\s'"=])codex(-${CODEX_TARGET_TRIPLE_BODY})?([.]exe|[.]cmd)?['"]?(\\s|$)`,
  "i",
);

export const WINDOWS_CODEX_CODE_MODE_HOST_CANDIDATE_RE = /codex-code-mode-host/i;

/** Basename of an official Codex release binary (plain or target-triple). */
const CODEX_TARGET_TRIPLE_BASENAME_RE = new RegExp(
  `^codex-${CODEX_TARGET_TRIPLE_BODY}(?:\\.exe|\\.cmd)?$`,
);

/** True when a Windows CommandLine is worth paying GetOwner for (current-user scoped later). */
export function isWindowsCodexCandidateCommandLine(commandLine: string): boolean {
  return WINDOWS_CODEX_BASENAME_CANDIDATE_RE.test(commandLine)
    || WINDOWS_CODEX_CODE_MODE_HOST_CANDIDATE_RE.test(commandLine);
}

/** Embed a regex source in a PowerShell single-quoted -match operand (`''` escapes `'`). */
function powerShellSingleQuotedIgnoreCaseMatch(patternSource: string): string {
  return `'(?i)${patternSource.replace(/'/g, "''")}'`;
}

export interface CodexAppServerProcess {
  pid: number;
  commandLine: string;
}

export interface ProcessSnapshot {
  pid: number;
  commandLine: string;
  executable?: string;
  uid?: number;
  owner?: string;
  startedAtMs?: number;
}

export interface CodexAppServerProcessIo {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  listSnapshots?: () => ProcessSnapshot[];
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Windows termination seam: drives the taskkill branch without a real exec. */
  execFile?: (file: string, args: readonly string[]) => void;
  /**
   * Signal seam for the Unix branch and the taskkill fallback. Without it,
   * injecting `kill` bypasses defaultKillCodexAppServer entirely, so the
   * fallback could never be observed.
   */
  processKill?: (pid: number, signal: NodeJS.Signals) => void;
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  now?: () => number;
  readStartMs?: (pid: number) => number | null;
  /** Async process-list seam used by the request-path Windows collector. */
  listSnapshotsAsync?: () => Promise<ProcessSnapshot[]>;
  /** Async batch start-time seam used by the request-path Windows collector. */
  readStartMsBatchAsync?: (pids: readonly number[]) => Promise<Map<number, number | null>>;
  catalogMtimeMs?: () => number | null;
}

function execFileTextAsync(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], {
      encoding: "utf-8",
      timeout: timeoutMs,
      windowsHide: true,
    }, (error: ExecFileException | null, stdout: string) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Split a process command line into argv-like tokens (handles simple quotes). */
export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function tokenBasename(token: string): string {
  return token.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "";
}

function isCodexExecutableToken(token: string): boolean {
  const base = tokenBasename(token);
  return base === "codex" || base === "codex.exe" || base === "codex.cmd"
    || CODEX_TARGET_TRIPLE_BASENAME_RE.test(base);
}

function isCodeModeHostToken(token: string): boolean {
  const base = tokenBasename(token);
  return base === "codex-code-mode-host" || base === "codex-code-mode-host.exe";
}

function isInterpreterToken(token: string): boolean {
  const base = tokenBasename(token);
  return base === "node" || base === "node.exe"
    || base === "bun" || base === "bun.exe"
    || base === "deno" || base === "deno.exe";
}

/**
 * Codex global options that take a following value when written without `=`.
 * Keep this list explicit so unknown flags stay boolean (narrow matching).
 */
const CODEX_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--enable",
  "--disable",
  "--config",
  "-c",
  "--profile",
  "-p",
  "--model",
  "-m",
  "--sandbox",
  "-s",
  "--ask-for-approval",
  "-a",
  "--local-provider",
  "--add-dir",
  "--cd",
  "-C",
  "--color",
  "--image",
  "-i",
  "--output-schema",
  "--output-last-message",
  "-o",
]);

/** Parse a CLI option token into its flag name and whether a value is inline (`--opt=value`). */
function splitCliOptionToken(token: string): { name: string; hasInlineValue: boolean } | null {
  if (!token.startsWith("-") || token === "-" || token === "--") return null;
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    if (eq >= 0) return { name: token.slice(0, eq).toLowerCase(), hasInlineValue: true };
    return { name: token.toLowerCase(), hasInlineValue: false };
  }
  // Preserve short-option case: `-c` (config) vs `-C` (cd).
  const eq = token.indexOf("=");
  if (eq >= 0) return { name: token.slice(0, eq), hasInlineValue: true };
  return { name: token, hasInlineValue: false };
}

/** Advance past one argv token, consuming a value for known Codex global options. */
function advancePastCodexGlobalOption(tokens: readonly string[], index: number): number {
  const option = splitCliOptionToken(tokens[index]!);
  if (!option) return index + 1;
  let next = index + 1;
  if (
    !option.hasInlineValue
    && CODEX_GLOBAL_OPTIONS_WITH_VALUE.has(option.name)
    && next < tokens.length
    && !tokens[next]!.startsWith("-")
  ) {
    next += 1; // skip the option value
  }
  return next;
}

/** True when code-mode-host is the process executable or interpreter entrypoint, not a later arg. */
function isCodeModeHostProcess(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  if (isCodeModeHostToken(tokens[0]!)) return true;
  return isInterpreterToken(tokens[0]!) && tokens.length > 1 && isCodeModeHostToken(tokens[1]!);
}

/** Stable identity for PID reuse checks: pid + normalized command line. */
export function codexAppServerProcessIdentity(proc: Pick<CodexAppServerProcess, "pid" | "commandLine">): string {
  return `${proc.pid}\0${proc.commandLine.trim().replace(/\s+/g, " ")}`;
}

/** True when the command line is a Codex app-server (or code-mode host) worth restarting. */
export function isCodexAppServerCommandLine(commandLine: string, executable?: string): boolean {
  const trimmed = commandLine.trim();
  let tokens = tokenizeCommandLine(trimmed);
  if (executable) {
    if (isCodeModeHostToken(executable)) return true;
    if (isCodexExecutableToken(executable)) {
      let remainder = trimmed;
      if (remainder.startsWith(executable)) remainder = remainder.slice(executable.length).trimStart();
      else if (remainder.startsWith(`"${executable}"`)) remainder = remainder.slice(executable.length + 2).trimStart();
      tokens = [executable, ...tokenizeCommandLine(remainder)];
    }
  }
  if (tokens.length === 0) return false;
  if (isCodeModeHostProcess(tokens)) return true;
  if (!isCodexExecutableToken(tokens[0]!)) return false;

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      i = advancePastCodexGlobalOption(tokens, i);
      continue;
    }
    return token.toLowerCase() === "app-server";
  }
  return false;
}

function parseUnixProcStatusUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  if (!match) return undefined;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) ? uid : undefined;
}

function listUnixProcSnapshots(uid: number | undefined): ProcessSnapshot[] {
  // procfs missing on a Linux-shaped platform is an enumeration failure, not
  // "no processes" — the staleness collector must not read it as not_running.
  if (!existsSync("/proc")) throw new Error("procfs_unavailable");
  const out: ProcessSnapshot[] = [];
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const processUid = parseUnixProcStatusUid(status);
      if (uid !== undefined && processUid !== undefined && processUid !== uid) continue;
      const argv = readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      const commandLine = argv.join(" ").trim();
      if (!commandLine) continue;
      out.push({ pid, commandLine, executable: argv[0], uid: processUid });
    } catch {
      /* process exited mid-scan */
    }
  }
  return out;
}

function listDarwinSnapshots(uid: number | undefined): ProcessSnapshot[] {
  const out: ProcessSnapshot[] = [];
  const commandOutput = uid !== undefined
    ? execFileSync("/bin/ps", ["-u", String(uid), "-o", "pid=,command="], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    })
    : execFileSync("/bin/ps", ["-axo", "pid=,uid=,command="], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
  const executableOutput = uid !== undefined
    ? execFileSync("/bin/ps", ["-u", String(uid), "-o", "pid=,comm="], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    })
    : execFileSync("/bin/ps", ["-axo", "pid=,comm="], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
  const executableByPid = new Map<number, string>();
  for (const raw of executableOutput.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(raw);
    if (!match) continue;
    const pid = Number(match[1]);
    const executable = match[2]?.trim() ?? "";
    if (Number.isSafeInteger(pid) && pid > 0 && executable) executableByPid.set(pid, executable);
  }
  for (const raw of commandOutput.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (uid !== undefined) {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const commandLine = match[2]?.trim() ?? "";
      if (!Number.isSafeInteger(pid) || pid <= 0 || !commandLine) continue;
      out.push({ pid, commandLine, executable: executableByPid.get(pid), uid });
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const processUid = Number(match[2]);
    const commandLine = match[3]?.trim() ?? "";
    if (!Number.isSafeInteger(pid) || pid <= 0 || !commandLine) continue;
    out.push({
      pid, commandLine, executable: executableByPid.get(pid),
      uid: Number.isSafeInteger(processUid) ? processUid : undefined,
    });
  }
  return out;
}

/**
 * Windows snapshots scoped to the invoking user via Win32_Process GetOwner.
 * PowerShell is the sole path: WMIC lacks reliable owner data and is disabled on
 * many Windows 11 installs; returning unscoped rows would contradict the
 * current-user restart contract.
 *
 * CIM instance methods must use Invoke-CimMethod (direct .GetOwner() calls fail).
 * Candidates are pre-filtered to Codex basename / code-mode-host command lines
 * so we do not pay GetOwner per every process on the machine.
 * Exported for the Windows integration regression that exercises the real
 * PowerShell enumeration.
 */
/**
 * Turn one PowerShell enumeration's stdout into snapshots.
 *
 * Split out from the spawn so the failure contract is testable off-Windows: the
 * sentinel path is the difference between "no Codex process is running" and "we could
 * not read the process list", and only one of those is safe to act on.
 */
export function parseWindowsSnapshotOutput(output: string): ProcessSnapshot[] {
  const out: ProcessSnapshot[] = [];
  for (const line of output.split(/\r?\n/)) {
    // A candidate whose owner could not be verified — or a top-level query that
    // failed outright — makes the whole enumeration incomplete. The staleness
    // collector must not read the partial result as "nothing running".
    if (line.trim() === "__OCX_ENUM_INCOMPLETE__") throw new Error("windows_enum_incomplete");
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const tab2 = line.indexOf("\t", tab + 1);
    if (tab2 <= tab) continue;
    const pid = Number(line.slice(0, tab));
    const commandLine = line.slice(tab + 1, tab2).trim();
    const owner = line.slice(tab2 + 1).trim();
    if (!Number.isSafeInteger(pid) || pid <= 1 || !commandLine || !owner) continue;
    out.push({ pid, commandLine, owner });
  }
  return out;
}

function windowsSnapshotPowerShellCommand(): string {
  // Newlines keep -Command as a real script (space-joined statements need ';').
  // Double-quoted format string so `t expands to a real tab.
  // Codex candidates only: basename token codex / codex.exe / codex.cmd /
  // official target-triple binaries (optional closing quote after the
  // basename), or code-mode-host — not incidental substrings like a repo
  // path with "opencodex".
  const basenameMatch = powerShellSingleQuotedIgnoreCaseMatch(WINDOWS_CODEX_BASENAME_CANDIDATE_RE.source);
  const codeModeMatch = powerShellSingleQuotedIgnoreCaseMatch(WINDOWS_CODEX_CODE_MODE_HOST_CANDIDATE_RE.source);
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    // -ErrorAction Stop plus the outer try is what makes a TOP-LEVEL query failure
    // observable. Under SilentlyContinue alone, a failing Get-CimInstance emits nothing
    // and the enumeration is indistinguishable from "no Codex process is running" —
    // the parse loop finds no rows, no sentinel is produced, and the staleness collector
    // reports not_running for a machine whose process list it never actually read.
    // The per-process catch below cannot cover this: it only runs once the pipeline has
    // objects to iterate.
    "try {",
    "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {",
    "  -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and (",
    `    $_.CommandLine -match ${basenameMatch} -or`,
    `    $_.CommandLine -match ${codeModeMatch}`,
    "  )",
    "} | ForEach-Object {",
    "  try {",
    "    $o=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop",
    "    if($null -eq $o -or $o.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($o.User)){\"__OCX_ENUM_INCOMPLETE__\"; return}",
    "    $owner=if($o.Domain){\"$($o.Domain)\\$($o.User)\"}else{$o.User}",
    "    if($owner -ine $me){return}",
    "    $cmd=($_.CommandLine -replace \"`t\",\" \")",
    "    \"{0}`t{1}`t{2}\" -f $_.ProcessId, $cmd, $owner",
    "  } catch { \"__OCX_ENUM_INCOMPLETE__\" }",
    "}",
    "} catch { \"__OCX_ENUM_INCOMPLETE__\" }",
  ].join("\n");
}

export function listWindowsSnapshots(runPowerShell?: (psCommand: string) => string): ProcessSnapshot[] {
  // Top-level exec failure propagates (see listDarwinSnapshots note). The
  // executable resolves from the trusted System32 directory (never PATH), and
  // windowsHide keeps the enumeration console-less on desktop sessions (#1278).
  const psCommand = windowsSnapshotPowerShellCommand();
  const output = runPowerShell
    ? runPowerShell(psCommand)
    : execFileSync(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile", "-NoLogo", "-NonInteractive",
      "-Command",
      psCommand,
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 8_000, windowsHide: true });
  return parseWindowsSnapshotOutput(output);
}

async function listWindowsSnapshotsAsync(): Promise<ProcessSnapshot[]> {
  const output = await execFileTextAsync(resolveTrustedWindowsPowerShellExe(), [
    "-NoProfile", "-NoLogo", "-NonInteractive",
    "-Command",
    windowsSnapshotPowerShellCommand(),
  ], 8_000);
  return parseWindowsSnapshotOutput(output);
}

function defaultListSnapshots(platform: NodeJS.Platform, getuid: () => number | undefined): ProcessSnapshot[] {
  if (platform === "win32") return listWindowsSnapshots();
  if (platform === "darwin") return listDarwinSnapshots(getuid());
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
  let snapshots: ProcessSnapshot[];
  if (io.listSnapshots) {
    snapshots = io.listSnapshots();
  } else {
    // Restart/kill contract (#476): enumeration failure means no targets —
    // never signal a process we could not verify.
    try {
      snapshots = defaultListSnapshots(platform, getuid);
    } catch {
      snapshots = [];
    }
  }
  const seen = new Set<number>();
  const matched: CodexAppServerProcess[] = [];
  for (const snapshot of snapshots) {
    if (seen.has(snapshot.pid)) continue;
    if (!isCodexAppServerCommandLine(snapshot.commandLine, snapshot.executable)) continue;
    seen.add(snapshot.pid);
    matched.push({ pid: snapshot.pid, commandLine: snapshot.commandLine });
  }
  return matched;
}

export function formatStaleCodexAppServerWarning(
  processes: readonly { pid: number }[],
): string {
  const pids = processes.map(process => process.pid).join(", ");
  return (
    `WARNING: ${processes.length} Codex app-server process(es) still running (PID${processes.length === 1 ? "" : "s"}: ${pids}). `
    + "Disk catalog/cache were updated, but Codex may keep showing the old model list until those processes restart. "
    + "Re-run with `ocx sync --restart-codex` (or `ocx sync-cache --restart-codex`) to send SIGTERM only to matching app-server processes. "
    + "Active turns may be interrupted."
  );
}

/** /proc/<pid>/stat starttime (clock ticks since boot) → epoch ms, or null. */
function readLinuxProcStartMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime) follows the comm field, which may contain spaces
    // inside parentheses — split after the final ")".
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).split(/\s+/);
    const startTicks = Number(fields[19]); // field 22 = index 19 after comm
    const boot = /^btime\s+(\d+)/m.exec(readFileSync("/proc/stat", "utf8"));
    if (!Number.isFinite(startTicks) || !boot) return null;
    const hertz = 100; // USER_HZ on every supported Linux target
    return (Number(boot[1]) + startTicks / hertz) * 1000;
  } catch {
    return null;
  }
}

/** `ps` lstart → epoch ms, or null (macOS). */
function readDarwinProcStartMs(pid: number): number | null {
  try {
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4_000,
    }).trim();
    if (!out) return null;
    const parsed = Date.parse(out);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Win32_Process.CreationDate → epoch ms, or null (Windows). */
function readWindowsProcStartMs(pid: number): number | null {
  try {
    const out = execFileSync(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile", "-NoLogo", "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString("o")`,
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 8_000, windowsHide: true }).trim();
    if (!out) return null;
    const parsed = Date.parse(out);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort process start time; null when the platform source is unreadable. */
export function readProcessStartMs(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  if (platform === "win32") return readWindowsProcStartMs(pid);
  if (platform === "darwin") return readDarwinProcStartMs(pid);
  return readLinuxProcStartMs(pid);
}

function windowsProcessStartPowerShellCommand(pids: readonly number[]): string {
  const filter = pids.map(pid => `ProcessId=${pid}`).join(" OR ");
  return `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\t$($_.CreationDate.ToUniversalTime().ToString("o"))" }`;
}

function parseWindowsProcessStartTimes(
  stdout: string,
  pids: readonly number[],
): Map<number, number | null> {
  const byPid = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const pid = Number(line.slice(0, tab));
    const parsed = Date.parse(line.slice(tab + 1).trim());
    if (Number.isSafeInteger(pid) && Number.isFinite(parsed)) byPid.set(pid, parsed);
  }
  return new Map(pids.map(pid => [pid, byPid.get(pid) ?? null]));
}

async function readWindowsProcessStartMsBatchAsync(
  pids: readonly number[],
): Promise<Map<number, number | null>> {
  try {
    const stdout = await execFileTextAsync(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile", "-NoLogo", "-NonInteractive",
      "-Command",
      windowsProcessStartPowerShellCommand(pids),
    ], 5_000);
    return parseWindowsProcessStartTimes(stdout, pids);
  } catch {
    return new Map(pids.map(pid => [pid, null]));
  }
}

/**
 * Start times for many pids in ONE platform call where possible, so the
 * staleness check does not serialize per-process ps/PowerShell invocations
 * on the request path (#857). Missing entries come back as null.
 */
export function readProcessStartMsBatch(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform,
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  if (pids.length === 0) return out;
  if (platform === "darwin") {
    try {
      const stdout = execFileSync("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
      });
      const byPid = new Map<number, number>();
      for (const raw of stdout.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(raw);
        if (!match) continue;
        const pid = Number(match[1]);
        const parsed = Date.parse(match[2]!.trim());
        if (Number.isSafeInteger(pid) && Number.isFinite(parsed)) byPid.set(pid, parsed);
      }
      for (const pid of pids) out.set(pid, byPid.get(pid) ?? null);
      return out;
    } catch {
      for (const pid of pids) out.set(pid, null);
      return out;
    }
  }
  if (platform === "win32") {
    try {
      const stdout = execFileSync(resolveTrustedWindowsPowerShellExe(), [
        "-NoProfile", "-NoLogo", "-NonInteractive",
        "-Command",
        windowsProcessStartPowerShellCommand(pids),
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true });
      return parseWindowsProcessStartTimes(stdout, pids);
    } catch {
      for (const pid of pids) out.set(pid, null);
      return out;
    }
  }
  for (const pid of pids) out.set(pid, readLinuxProcStartMs(pid));
  return out;
}

export type CodexAppServerCatalogState = "fresh" | "stale" | "not_running" | "unknown";

export interface CodexAppServerCatalogStatus {
  state: CodexAppServerCatalogState;
  processes: Array<{ pid: number; startedAtMs: number | null }>;
  catalogMtimeMs: number | null;
}

/** Resolve the catalog file Codex app-servers loaded at startup, for staleness checks. */
function defaultCatalogMtimeMs(): number | null {
  try {
    return statSync(readCodexCatalogPath()).mtimeMs;
  } catch {
    return null;
  }
}

function codexAppServerProcessesFromSnapshots(
  snapshots: readonly ProcessSnapshot[],
): CodexAppServerProcess[] {
  const processes: CodexAppServerProcess[] = [];
  const seen = new Set<number>();
  for (const snapshot of snapshots) {
    if (seen.has(snapshot.pid)) continue;
    if (!isCodexAppServerCommandLine(snapshot.commandLine, snapshot.executable)) continue;
    seen.add(snapshot.pid);
    processes.push({ pid: snapshot.pid, commandLine: snapshot.commandLine });
  }
  return processes;
}

function catalogStatusFromProcesses(
  processes: readonly CodexAppServerProcess[],
  catalogMtimeMs: number | null,
  starts: ReadonlyMap<number, number | null>,
): CodexAppServerCatalogStatus {
  const withStarts = processes.map(proc => ({
    pid: proc.pid,
    startedAtMs: starts.get(proc.pid) ?? null,
  }));
  if (catalogMtimeMs === null || withStarts.some(proc => proc.startedAtMs === null)) {
    return { state: "unknown", processes: withStarts, catalogMtimeMs };
  }
  // `<=` is deliberate: coarse clocks (ps lstart is second-granularity) can
  // report equal values when the catalog actually changed after startup.
  const stale = withStarts.some(proc => proc.startedAtMs! <= catalogMtimeMs);
  return { state: stale ? "stale" : "fresh", processes: withStarts, catalogMtimeMs };
}

// Short TTL: process listing + stat run once per window even under per-turn
// guidance calls (#857).
let catalogStateCache: { atMs: number; status: CodexAppServerCatalogStatus } | null = null;
interface RequestCatalogStateIdentity {
  platform: NodeJS.Platform;
  listSnapshots?: CodexAppServerProcessIo["listSnapshots"];
  listSnapshotsAsync?: CodexAppServerProcessIo["listSnapshotsAsync"];
  readStartMs?: CodexAppServerProcessIo["readStartMs"];
  readStartMsBatchAsync?: CodexAppServerProcessIo["readStartMsBatchAsync"];
  catalogMtimeMs?: CodexAppServerProcessIo["catalogMtimeMs"];
  now?: CodexAppServerProcessIo["now"];
}

interface RequestCatalogStateFlight {
  generation: number;
  identity: RequestCatalogStateIdentity;
  promise: Promise<CodexAppServerCatalogStatus>;
}

let requestCatalogStateGeneration = 0;
let requestCatalogStateCache: {
  generation: number;
  identity: RequestCatalogStateIdentity;
  atMs: number;
  status: CodexAppServerCatalogStatus;
} | null = null;
let requestCatalogStateFlight: RequestCatalogStateFlight | null = null;
const CATALOG_STATE_TTL_MS = 5_000;
/**
 * `unknown` is a failure to observe, not an observation, so it gets a much shorter
 * window than a real reading. At the full 5s a single transient enumeration failure
 * suppresses guidance for every call in that window, and the retry that would have
 * succeeded never runs. Keeping a brief window still collapses a burst of per-turn
 * calls into one probe, which is what the cache is for.
 */
const CATALOG_STATE_UNKNOWN_TTL_MS = 250;

export function catalogStateTtlMs(state: CodexAppServerCatalogState): number {
  return state === "unknown" ? CATALOG_STATE_UNKNOWN_TTL_MS : CATALOG_STATE_TTL_MS;
}

function sameRequestCatalogStateIdentity(
  left: RequestCatalogStateIdentity,
  right: RequestCatalogStateIdentity,
): boolean {
  return left.platform === right.platform
    && left.listSnapshots === right.listSnapshots
    && left.listSnapshotsAsync === right.listSnapshotsAsync
    && left.readStartMs === right.readStartMs
    && left.readStartMsBatchAsync === right.readStartMsBatchAsync
    && left.catalogMtimeMs === right.catalogMtimeMs
    && left.now === right.now;
}

/**
 * Compare the on-disk catalog mtime against the start time of running Codex
 * app-servers (#857): a server that started before the catalog changed keeps
 * an in-memory copy that disagrees with what ocx advertises.
 *
 * Cost note: a cold call synchronously runs the platform listing plus ONE
 * batched start-time query (hard bounds: ~5s+3s macOS, ~8s+5s Windows,
 * microseconds on Linux); the 5s TTL then serves repeats. Typical cold cost
 * is tens of milliseconds; fully-async background refresh is deliberately
 * out of scope for this slice.
 *
 * - not_running: no app-server process → nothing can disagree.
 * - unknown: catalog unreadable, or any server's start time is unreadable —
 *   callers must treat this conservatively (suppress positive model claims).
 * - stale: at least one server predates the catalog mtime.
 */
export function collectCodexAppServerCatalogState(
  io: CodexAppServerProcessIo = {},
): CodexAppServerCatalogStatus {
  const now = (io.now ?? Date.now)();
  const fullyDefault = !io.listSnapshots && !io.readStartMs && !io.catalogMtimeMs
    && !io.platform && !io.getuid && !io.now;
  if (fullyDefault
    && catalogStateCache
    && now - catalogStateCache.atMs < catalogStateTtlMs(catalogStateCache.status.state)) {
    return catalogStateCache.status;
  }
  const compute = (): CodexAppServerCatalogStatus => {
    const platform = io.platform ?? process.platform;
    const getuid = io.getuid ?? (() => {
      try {
        return typeof process.getuid === "function" ? process.getuid() : undefined;
      } catch {
        return undefined;
      }
    });
    let snapshots: ProcessSnapshot[];
    let enumerationFailed = false;
    const enumerate = io.listSnapshots ?? (() => defaultListSnapshots(platform, getuid));
    try {
      snapshots = enumerate();
    } catch {
      // Enumeration failure must never read as "nothing running" — that would let
      // positive model guidance through on guesswork (#857). The injected seam gets
      // the same contract as the default path: whoever enumerates, a failure to read
      // the process list is unknown, not an empty machine.
      snapshots = [];
      enumerationFailed = true;
    }
    const processes = codexAppServerProcessesFromSnapshots(snapshots);
    if (processes.length === 0) {
      return enumerationFailed
        ? { state: "unknown", processes: [], catalogMtimeMs: null }
        : { state: "not_running", processes: [], catalogMtimeMs: null };
    }
    const catalogMtimeMs = (io.catalogMtimeMs ?? defaultCatalogMtimeMs)();
    const starts = io.readStartMs
      ? new Map(processes.map(proc => [proc.pid, io.readStartMs!(proc.pid)] as const))
      : readProcessStartMsBatch(processes.map(proc => proc.pid), platform);
    return catalogStatusFromProcesses(processes, catalogMtimeMs, starts);
  };
  const status = compute();
  if (fullyDefault) {
    catalogStateCache = { atMs: now, status };
  }
  return status;
}

/**
 * Request-path catalog state collector.
 *
 * [Decision Log]
 * - 목적과 의도: keep Windows CIM discovery from blocking Bun's event loop while v2 guidance is built.
 * - 기존 구현 및 제약 조건: CLI/service operations still need the synchronous, fail-closed collector; the request path needs only advisory state.
 * - 검토한 주요 대안: remove stale-catalog guidance, move all process work to workers, or add a Windows-only async boundary.
 * - 선택한 방식: retain the synchronous API and use async PowerShell plus an identity-scoped in-flight refresh, short cache, and invalidation generation only for Windows requests.
 * - 다른 대안 대신 이 방식을 선택한 이유: it fixes unrelated `/healthz` starvation without widening the process-matching or restart contract.
 * - 장점, 단점 및 영향: concurrent turns share one CIM walk, invalidated pre-write results cannot repopulate the cache, and the event loop stays responsive; a cold v2 turn can still await the bounded advisory probe.
 */
export async function collectCodexAppServerCatalogStateForRequest(
  io: CodexAppServerProcessIo = {},
): Promise<CodexAppServerCatalogStatus> {
  const platform = io.platform ?? process.platform;
  if (platform !== "win32") return collectCodexAppServerCatalogState(io);

  const now = (io.now ?? Date.now)();
  const generation = requestCatalogStateGeneration;
  const identity: RequestCatalogStateIdentity = {
    platform,
    listSnapshots: io.listSnapshots,
    listSnapshotsAsync: io.listSnapshotsAsync,
    readStartMs: io.readStartMs,
    readStartMsBatchAsync: io.readStartMsBatchAsync,
    catalogMtimeMs: io.catalogMtimeMs,
    now: io.now,
  };
  if (requestCatalogStateCache
    && requestCatalogStateCache.generation === generation
    && sameRequestCatalogStateIdentity(requestCatalogStateCache.identity, identity)
    && now - requestCatalogStateCache.atMs < catalogStateTtlMs(requestCatalogStateCache.status.state)) {
    return requestCatalogStateCache.status;
  }
  if (requestCatalogStateFlight
    && requestCatalogStateFlight.generation === generation
    && sameRequestCatalogStateIdentity(requestCatalogStateFlight.identity, identity)) {
    return requestCatalogStateFlight.promise;
  }

  const refresh = async (): Promise<CodexAppServerCatalogStatus> => {
    let snapshots: ProcessSnapshot[];
    try {
      snapshots = io.listSnapshotsAsync
        ? await io.listSnapshotsAsync()
        : io.listSnapshots
          ? io.listSnapshots()
          : await listWindowsSnapshotsAsync();
    } catch {
      return { state: "unknown", processes: [], catalogMtimeMs: null };
    }
    const processes = codexAppServerProcessesFromSnapshots(snapshots);
    if (processes.length === 0) {
      return { state: "not_running", processes: [], catalogMtimeMs: null };
    }
    let catalogMtimeMs: number | null;
    try {
      catalogMtimeMs = (io.catalogMtimeMs ?? defaultCatalogMtimeMs)();
    } catch {
      catalogMtimeMs = null;
    }
    const pids = processes.map(proc => proc.pid);
    const starts = io.readStartMsBatchAsync
      ? await io.readStartMsBatchAsync(pids)
      : io.readStartMs
        ? new Map(pids.map(pid => [pid, io.readStartMs!(pid)] as const))
        : await readWindowsProcessStartMsBatchAsync(pids);
    return catalogStatusFromProcesses(processes, catalogMtimeMs, starts);
  };

  const pending = refresh().catch(() => ({
    state: "unknown" as const,
    processes: [],
    catalogMtimeMs: null,
  }));
  let flight: RequestCatalogStateFlight;
  const promise = pending.then(status => {
    // A catalog write can invalidate while slow CIM is still running. The result
    // describes the PRE-write world, so it must neither repopulate the post-write
    // cache nor reach the caller.
    //
    // Suppressing only the cache write is not enough. The awaiting request still
    // received `fresh`, and `fresh` is the one state that authorizes positive
    // guidance (`src/server/responses/collaboration.ts:279-280` returns null for
    // `stale`/`unknown` but describes the catalog for `fresh`). So the request
    // would advertise the newly written disk catalog to an app-server whose
    // in-memory copy the write just made stale — a wrong answer, which is worse
    // than the slow answer this whole change exists to fix.
    //
    // Degrade to `unknown` instead: it is the honest description of what an
    // invalidated observation knows, and the guidance path already treats it as
    // "say nothing positive".
    if (requestCatalogStateGeneration !== generation) {
      return { state: "unknown" as const, processes: [], catalogMtimeMs: null };
    }
    if (requestCatalogStateFlight === flight) {
      requestCatalogStateCache = {
        generation,
        identity,
        atMs: (io.now ?? Date.now)(),
        status,
      };
    }
    return status;
  }).finally(() => {
    if (requestCatalogStateFlight === flight) requestCatalogStateFlight = null;
  });
  flight = { generation, identity, promise };
  requestCatalogStateFlight = flight;
  return flight.promise;
}

/**
 * Drop memoized catalog state after a relevant catalog/cache write and before
 * the post-write state read. Advancing the generation prevents an older
 * in-flight Windows CIM refresh from publishing its pre-write result after the
 * write has completed.
 */
export function resetCodexAppServerCatalogStateCache(): void {
  catalogStateCache = null;
  requestCatalogStateGeneration += 1;
  requestCatalogStateCache = null;
  requestCatalogStateFlight = null;
}

export interface RestartCodexAppServersResult {
  requested: number[];
  stopped: number[];
  surviving: number[];
  failed: Array<{ pid: number; error: string }>;
}

/**
 * Platform-appropriate termination for a matched app-server.
 *
 * On Windows `process.kill(pid, "SIGTERM")` is not a graceful signal — it is an
 * unconditional terminate of that one process, and it leaves the process tree
 * behind. `taskkill /T /F` is therefore not an escalation there: the kill was
 * hard either way, and `/T` adds the child cleanup that keeps an app-server's
 * children from being orphaned when the window is closed without a quit
 * affordance. That matters most on Windows precisely because there is no Ctrl+Q.
 *
 * The asymmetry with Unix is deliberate and must not be "fixed" into symmetry:
 * on Unix, SIGTERM really is graceful, and following it with SIGKILL would ask a
 * harsher consent than a restart click gives. Survivors are reported instead.
 *
 * The executable is resolved from a trusted system directory rather than PATH,
 * matching how this file already resolves PowerShell — an unqualified
 * `taskkill` is a hijack surface.
 */
function defaultKillCodexAppServer(
  pid: number,
  signal: NodeJS.Signals,
  io: CodexAppServerProcessIo = {},
): void {
  const platform = io.platform ?? process.platform;
  const signalProcess = io.processKill ?? ((target: number, sig: NodeJS.Signals) => {
    process.kill(target, sig);
  });
  if (platform !== "win32") {
    signalProcess(pid, signal);
    return;
  }
  const exec = io.execFile ?? ((file: string, args: readonly string[]) => {
    execFileSync(file, [...args], { stdio: "ignore", timeout: 5_000, windowsHide: true });
  });
  try {
    exec(resolveTrustedWindowsTaskkillExe(), ["/PID", String(pid), "/T", "/F"]);
  } catch {
    // Fall back to the previous behavior rather than reporting a failure the old
    // code would not have reported.
    signalProcess(pid, signal);
  }
}


/** Send SIGTERM to matched processes and wait briefly; never escalates to SIGKILL. */
export function restartCodexAppServers(
  processes: readonly CodexAppServerProcess[] = listCodexAppServerProcesses(),
  io: CodexAppServerProcessIo = {},
): RestartCodexAppServersResult {
  const isAlive = io.isAlive ?? isProcessAlive;
  const kill = io.kill ?? ((pid, signal) => { defaultKillCodexAppServer(pid, signal, io); });
  const wait = io.waitExit ?? waitForExit;
  const now = io.now ?? Date.now;
  const requested = processes.map(process => process.pid);
  const stopped: number[] = [];
  const surviving: number[] = [];
  const failed: Array<{ pid: number; error: string }> = [];

  // Re-resolve immediately before signaling so a recycled PID is never killed.
  // Require the same pid+command-line identity as the original match — a new
  // Codex-shaped process that reused the PID must not receive SIGTERM.
  const liveByPid = new Map(
    listCodexAppServerProcesses(io).map(process => [process.pid, process] as const),
  );
  const signaled: CodexAppServerProcess[] = [];

  for (const proc of processes) {
    const live = liveByPid.get(proc.pid);
    if (!live || codexAppServerProcessIdentity(live) !== codexAppServerProcessIdentity(proc)) {
      // Original target exited (or identity changed); do not signal a replacement.
      if (!isAlive(proc.pid)) stopped.push(proc.pid);
      continue;
    }
    try {
      kill(proc.pid, "SIGTERM");
      signaled.push(proc);
    } catch (error) {
      if (isAlive(proc.pid)) {
        failed.push({
          pid: proc.pid,
          error: error instanceof Error ? error.message : String(error),
        });
        surviving.push(proc.pid);
      } else {
        stopped.push(proc.pid);
      }
    }
  }

  // Shared deadline so N survivors wait ~2s total, not N×2s.
  const deadline = now() + 2_000;
  for (const proc of signaled) {
    const remaining = Math.max(0, deadline - now());
    if (wait(proc.pid, remaining) || !isAlive(proc.pid)) stopped.push(proc.pid);
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

/**
 * Startup-safe counterpart to {@link afterCatalogWriteHandleAppServers} (#1046).
 *
 * Service startup rewrites the catalog and the models cache, but an app-server
 * that booted earlier keeps an in-memory model list — Codex builds a static
 * manager from the catalog once and never rereads the file — so the picker shows
 * a roster that no longer exists on disk. Every check a user runs reads the file;
 * the picker renders memory.
 *
 * Two things this deliberately does NOT do, both of which the `--restart-codex`
 * path does:
 *
 * - It never signals anything. Killing an app-server on an unattended boot would
 *   interrupt whatever turn the user has in flight. A human typing
 *   `ocx sync --restart-codex` is consenting to that; a login is not.
 * - It never warns about a merely-running app-server. It asks the mtime
 *   classifier whether one is actually stale, so a boot with Codex open and a
 *   current catalog stays quiet.
 *
 * Failure is swallowed: startup synchronization is best-effort and must not stop
 * the proxy from coming up.
 *
 * The memoized state is dropped first. {@link collectCodexAppServerCatalogState}
 * caches for 5s when every io field is defaulted, so a `fresh` reading taken
 * before the write would otherwise be replayed after it and this would stay
 * silent about the very staleness it exists to report.
 */
export function warnIfStaleCodexAppServersAfterStartupWrite(
  options: { log?: Pick<Console, "error">; io?: CodexAppServerProcessIo } = {},
): { warned: boolean } {
  try {
    resetCodexAppServerCatalogStateCache();
    const status = collectCodexAppServerCatalogState(options.io ?? {});
    if (status.state !== "stale") return { warned: false };
    options.log?.error(formatStaleCodexAppServerWarning(status.processes));
    return { warned: true };
  } catch {
    return { warned: false };
  }
}
