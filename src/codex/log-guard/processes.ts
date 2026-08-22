import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import {
  listWindowsSnapshots,
  tokenizeCommandLine,
  type ProcessSnapshot,
} from "../app-server-processes";

export interface CodexWriterProcess {
  pid: number;
  commandLine: string;
}

export type CodexWriterProcessCheck =
  | { state: "ok"; processes: CodexWriterProcess[] }
  | { state: "unknown"; reason: "enumeration_failed" };

export interface CodexWriterProcessIo {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  listSnapshots?: () => ProcessSnapshot[];
}

const TARGET_TRIPLE = /^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?$/i;

function basename(token: string): string {
  return token.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isOfficialCodexExecutable(token: string): boolean {
  const base = basename(token);
  if (base === "codex" || base === "codex.exe" || base === "codex.cmd") return true;
  const withoutSuffix = base.replace(/\.(?:exe|cmd)$/i, "");
  if (!withoutSuffix.startsWith("codex-")) return false;
  return TARGET_TRIPLE.test(withoutSuffix.slice("codex-".length));
}

function isCodeModeHostExecutable(token: string): boolean {
  const base = basename(token);
  return base === "codex-code-mode-host" || base === "codex-code-mode-host.exe";
}

function isInterpreterExecutable(token: string): boolean {
  const base = basename(token);
  return base === "node" || base === "node.exe"
    || base === "bun" || base === "bun.exe"
    || base === "deno" || base === "deno.exe";
}

function looksLikePathPrefix(token: string): boolean {
  return token.startsWith("/") || token.startsWith("./") || token.startsWith("../")
    || token.startsWith("~") || /^[a-z]:[\\/]/i.test(token);
}

function flattenedPathPrefix(
  commandLine: string,
  predicate: (candidate: string) => boolean,
): { executable: string; remainder: string } | null {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);
  for (let end = parts.length; end >= 1; end -= 1) {
    const executable = parts.slice(0, end).join(" ");
    if (!predicate(executable)) continue;
    return { executable, remainder: parts.slice(end).join(" ") };
  }
  return null;
}

function interpreterHostWithFlattenedPath(commandLine: string, tokens: readonly string[]): boolean {
  if (tokens.length < 2 || !isInterpreterExecutable(tokens[0]!)) return false;
  const trimmed = commandLine.trim();
  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) return false;
  const remainder = trimmed.slice(firstWhitespace).trim();
  return flattenedPathPrefix(remainder, isCodeModeHostExecutable) !== null;
}

/**
 * Match official Codex writer executables at argv0 plus the repository's
 * established interpreter-entrypoint form for code-mode-host.
 *
 * OS process listings can flatten argv into a display string. When an unquoted
 * executable path contains spaces, recover only a leading path-shaped executable
 * prefix; arbitrary later argv tokens still never turn a process into Codex.
 */
export function isCodexWriterCommandLine(commandLine: string, executable?: string): boolean {
  if (executable && (isOfficialCodexExecutable(executable) || isCodeModeHostExecutable(executable))) return true;
  const tokens = tokenizeCommandLine(commandLine.trim());
  if (tokens.length === 0) return false;
  if (isOfficialCodexExecutable(tokens[0]!) || isCodeModeHostExecutable(tokens[0]!)) return true;
  return tokens.length > 1
    && isInterpreterExecutable(tokens[0]!)
    && isCodeModeHostExecutable(tokens[1]!);
}

function statusUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function listLinuxSnapshots(uid: number | undefined): ProcessSnapshot[] {
  if (!existsSync("/proc")) throw new Error("procfs_unavailable");
  const rows: ProcessSnapshot[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      const procUid = statusUid(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (uid !== undefined && procUid !== undefined && procUid !== uid) continue;
      const argv = readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      const commandLine = argv.join(" ").trim();
      if (commandLine) rows.push({ pid, commandLine, executable: argv[0], uid: procUid });
    } catch {
      // A process disappearing mid-enumeration is normal. A top-level procfs
      // failure is handled before the loop and fails closed.
    }
  }
  return rows;
}

function listDarwinSnapshots(uid: number | undefined): ProcessSnapshot[] {
  const commandOutput = uid !== undefined
    ? execFileSync("/bin/ps", ["-u", String(uid), "-o", "pid=,command="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    })
    : execFileSync("/bin/ps", ["-axo", "pid=,uid=,command="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
  const executableOutput = uid !== undefined
    ? execFileSync("/bin/ps", ["-u", String(uid), "-o", "pid=,comm="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    })
    : execFileSync("/bin/ps", ["-axo", "pid=,comm="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
  const executableByPid = new Map<number, string>();
  for (const raw of executableOutput.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(raw);
    if (!match) continue;
    const pid = Number(match[1]);
    const executable = match[2]?.trim() ?? "";
    if (Number.isSafeInteger(pid) && pid > 0 && executable) executableByPid.set(pid, executable);
  }
  const rows: ProcessSnapshot[] = [];
  for (const raw of commandOutput.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = uid !== undefined
      ? /^(\d+)\s+(.*)$/.exec(line)
      : /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = (uid !== undefined ? match[2] : match[3])?.trim() ?? "";
    if (!Number.isSafeInteger(pid) || pid <= 0 || !commandLine) continue;
    rows.push({
      pid, commandLine, executable: executableByPid.get(pid),
      uid: uid ?? (Number.isSafeInteger(Number(match[2])) ? Number(match[2]) : undefined),
    });
  }
  return rows;
}

function effectiveUid(getuid?: () => number | undefined): number | undefined {
  try {
    return getuid ? getuid() : process.getuid?.();
  } catch {
    return undefined;
  }
}

function defaultSnapshots(platform: NodeJS.Platform, uid: number | undefined): ProcessSnapshot[] {
  if (platform === "win32") return listWindowsSnapshots();
  if (platform === "darwin") return listDarwinSnapshots(uid);
  if (platform === "linux") return listLinuxSnapshots(uid);
  throw new Error("unsupported_process_enumeration_platform");
}

export function listRunningCodexProcesses(io: CodexWriterProcessIo = {}): CodexWriterProcessCheck {
  const platform = io.platform ?? process.platform;
  let snapshots: ProcessSnapshot[];
  try {
    snapshots = io.listSnapshots?.() ?? defaultSnapshots(platform, effectiveUid(io.getuid));
  } catch {
    return { state: "unknown", reason: "enumeration_failed" };
  }

  const byPid = new Map<number, CodexWriterProcess>();
  for (const snapshot of snapshots) {
    if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 0) continue;
    if (!isCodexWriterCommandLine(snapshot.commandLine, snapshot.executable)) continue;
    if (!byPid.has(snapshot.pid)) {
      byPid.set(snapshot.pid, { pid: snapshot.pid, commandLine: snapshot.commandLine });
    }
  }
  return {
    state: "ok",
    processes: [...byPid.values()].sort((a, b) => a.pid - b.pid),
  };
}
