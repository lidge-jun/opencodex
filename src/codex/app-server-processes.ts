/**
 * Detect / optionally terminate long-lived Codex app-server processes that keep an
 * in-memory model catalog after `ocx sync` rewrites on-disk files (#476).
 *
 * Matching is intentionally narrow: require `app-server` as the Codex subcommand
 * (not merely as a substring in some later argument) or `codex-code-mode-host`.
 * Never match broad `*codex*` patterns that hit unrelated tools such as
 * `hermes-codex-bridge-mcp`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isProcessAlive, waitForExit } from "../lib/process-control";
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
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  now?: () => number;
  readStartMs?: (pid: number) => number | null;
  catalogMtimeMs?: () => number | null;
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
export function isCodexAppServerCommandLine(commandLine: string): boolean {
  const tokens = tokenizeCommandLine(commandLine.trim());
  if (tokens.length === 0) return false;
  if (isCodeModeHostProcess(tokens)) return true;

  // Require Codex as argv0 so later-argument occurrences stay unmatched
  // (e.g. `node worker.js codex app-server`).
  if (!isCodexExecutableToken(tokens[0]!)) return false;

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      i = advancePastCodexGlobalOption(tokens, i);
      continue;
    }
    // First non-option after globals is the Codex subcommand.
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

function listDarwinSnapshots(uid: number | undefined): ProcessSnapshot[] {
  const out: ProcessSnapshot[] = [];
  // Top-level exec failure propagates: callers decide their own safe default
  // (restart flow → treat as none; staleness check → unknown, never "fresh").
  const output = uid !== undefined
    ? execFileSync("ps", ["-u", String(uid), "-o", "pid=,command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
    : execFileSync("ps", ["-axo", "pid=,uid=,command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (uid !== undefined) {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const commandLine = match[2]?.trim() ?? "";
      if (!Number.isSafeInteger(pid) || pid <= 1 || !commandLine) continue;
      out.push({ pid, commandLine, uid });
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const processUid = Number(match[2]);
    const commandLine = match[3]?.trim() ?? "";
    if (!Number.isSafeInteger(pid) || pid <= 1 || !commandLine) continue;
    out.push({ pid, commandLine, uid: Number.isSafeInteger(processUid) ? processUid : undefined });
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
export function listWindowsSnapshots(): ProcessSnapshot[] {
  const out: ProcessSnapshot[] = [];
  // Newlines keep -Command as a real script (space-joined statements need ';').
  // Double-quoted format string so `t expands to a real tab.
  // Codex candidates only: basename token codex / codex.exe / codex.cmd /
  // official target-triple binaries (optional closing quote after the
  // basename), or code-mode-host — not incidental substrings like a repo
  // path with "opencodex".
  const basenameMatch = powerShellSingleQuotedIgnoreCaseMatch(WINDOWS_CODEX_BASENAME_CANDIDATE_RE.source);
  const codeModeMatch = powerShellSingleQuotedIgnoreCaseMatch(WINDOWS_CODEX_CODE_MODE_HOST_CANDIDATE_RE.source);
  const psCommand = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "Get-CimInstance Win32_Process | Where-Object {",
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
  ].join("\n");
  // Top-level exec failure propagates (see listDarwinSnapshots note).
  const output = execFileSync("powershell.exe", [
    "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
    "-Command",
    psCommand,
  ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 8_000, windowsHide: true });
  for (const line of output.split(/\r?\n/)) {
    // A candidate whose owner could not be verified makes the whole
    // enumeration incomplete — the staleness collector must not read the
    // partial result as "nothing running".
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
    if (!isCodexAppServerCommandLine(snapshot.commandLine)) continue;
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
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
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
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
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
      const stdout = execFileSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
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
      const filter = pids.map(pid => `ProcessId=${pid}`).join(" OR ");
      const stdout = execFileSync("powershell.exe", [
        "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\t$($_.CreationDate.ToUniversalTime().ToString("o"))" }`,
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true });
      const byPid = new Map<number, number>();
      for (const line of stdout.split(/\r?\n/)) {
        const tab = line.indexOf("\t");
        if (tab <= 0) continue;
        const pid = Number(line.slice(0, tab));
        const parsed = Date.parse(line.slice(tab + 1).trim());
        if (Number.isSafeInteger(pid) && Number.isFinite(parsed)) byPid.set(pid, parsed);
      }
      for (const pid of pids) out.set(pid, byPid.get(pid) ?? null);
      return out;
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

// Short TTL: process listing + stat run once per window even under per-turn
// guidance calls (#857).
let catalogStateCache: { atMs: number; status: CodexAppServerCatalogStatus } | null = null;
const CATALOG_STATE_TTL_MS = 5_000;

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
    && catalogStateCache && now - catalogStateCache.atMs < CATALOG_STATE_TTL_MS) {
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
    if (io.listSnapshots) {
      snapshots = io.listSnapshots();
    } else {
      try {
        snapshots = defaultListSnapshots(platform, getuid);
      } catch {
        // Enumeration failure must never read as "nothing running" — that
        // would let positive model guidance through on guesswork (#857).
        snapshots = [];
        enumerationFailed = true;
      }
    }
    const processes: CodexAppServerProcess[] = [];
    const seen = new Set<number>();
    for (const snapshot of snapshots) {
      if (seen.has(snapshot.pid)) continue;
      if (!isCodexAppServerCommandLine(snapshot.commandLine)) continue;
      seen.add(snapshot.pid);
      processes.push({ pid: snapshot.pid, commandLine: snapshot.commandLine });
    }
    if (processes.length === 0) {
      return enumerationFailed
        ? { state: "unknown", processes: [], catalogMtimeMs: null }
        : { state: "not_running", processes: [], catalogMtimeMs: null };
    }
    const catalogMtimeMs = (io.catalogMtimeMs ?? defaultCatalogMtimeMs)();
    const withStarts = io.readStartMs
      ? processes.map(proc => ({ pid: proc.pid, startedAtMs: io.readStartMs!(proc.pid) }))
      : (() => {
        const batch = readProcessStartMsBatch(processes.map(proc => proc.pid), platform);
        return processes.map(proc => ({ pid: proc.pid, startedAtMs: batch.get(proc.pid) ?? null }));
      })();
    if (catalogMtimeMs === null || withStarts.some(proc => proc.startedAtMs === null)) {
      return { state: "unknown", processes: withStarts, catalogMtimeMs };
    }
    // `<=` is deliberate: coarse clocks (ps lstart is second-granularity) can
    // report equal values when the catalog actually changed after startup.
    const stale = withStarts.some(proc => proc.startedAtMs! <= catalogMtimeMs);
    return { state: stale ? "stale" : "fresh", processes: withStarts, catalogMtimeMs };
  };
  const status = compute();
  if (fullyDefault) {
    catalogStateCache = { atMs: now, status };
  }
  return status;
}

/** Test hook: drop the memoized catalog state. */
export function resetCodexAppServerCatalogStateCache(): void {
  catalogStateCache = null;
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
