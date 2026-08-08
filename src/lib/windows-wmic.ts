/**
 * Console-free Windows process introspection via WMIC.
 *
 * These helpers replace PowerShell Win32_Process queries where WMIC is
 * available: WMIC starts far faster than PowerShell 5.1 and, spawned with
 * `windowsHide: true` (CREATE_NO_WINDOW), never presents a console window.
 * WMIC is a deprecated optional component and is absent on many modern
 * Windows images, so callers must treat a missing WMIC as an enumeration
 * failure (fail closed), never as "nothing is running", and keep a hidden
 * PowerShell fallback for hosts without it.
 */
import { execFileSync } from "node:child_process";
import { resolveTrustedWindowsWmicExe, resolveTrustedWindowsWhoamiExe } from "./windows-elevation";

/** Resolve the trusted WMIC executable, or null when absent on the host. */
export function resolveWmicExe(): string | null {
  return resolveTrustedWindowsWmicExe();
}

export interface WmicProcessRecord {
  processId: number;
  name?: string;
  commandLine?: string;
  creationDate?: string;
}

/**
 * Parse `wmic ... /format:list` output. Records are KEY=VALUE blocks separated
 * by blank lines. WMIC emits the requested keys in ALPHABETICAL order
 * (CommandLine, CreationDate, Name, ProcessId), so ProcessId typically closes
 * a record rather than opening it: keys are collected per block in any order
 * and the record is materialized at the block boundary. CommandLine may
 * contain embedded newlines, so a continuation line that does not look like a
 * known key is appended to the running value.
 */
export function parseWmicListRecords(output: string): WmicProcessRecord[] {
  const records: WmicProcessRecord[] = [];
  let current: Partial<WmicProcessRecord> | null = null;
  const flush = (): void => {
    if (current && Number.isSafeInteger(current.processId) && (current.processId ?? 0) > 1) {
      records.push({
        processId: current.processId as number,
        name: current.name,
        commandLine: current.commandLine,
        creationDate: current.creationDate,
      });
    }
    current = null;
  };
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) {
      flush();
      continue;
    }
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (match) {
      const [, key, value] = match;
      if (!current) current = {};
      if (key === "ProcessId") current.processId = Number(value.trim());
      else if (key === "Name") current.name = value.trim();
      else if (key === "CommandLine") current.commandLine = value;
      else if (key === "CreationDate") current.creationDate = value.trim();
      continue;
    }
    if (current?.commandLine !== undefined) {
      current.commandLine += `\n${line}`;
    }
  }
  flush();
  return records;
}

const WMIC_CREATION_DATE_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,7}))?([+-]\d{1,4})?$/;

/**
 * Convert a WMIC CreationDate value (`YYYYMMDDHHMMSS.microseconds±offset`)
 * to epoch milliseconds, or null when unparseable.
 */
export function parseWmicCreationDate(value: string | undefined): number | null {
  if (!value) return null;
  const match = WMIC_CREATION_DATE_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ? Number(match[7].slice(0, 3).padEnd(3, "0")) : 0;
  const offsetMinutes = match[8] ? Number(match[8]) : 0;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
  return Number.isFinite(utcMs) ? utcMs - offsetMinutes * 60_000 : null;
}

export interface WmicOwner {
  domain: string;
  user: string;
}

/** Resolve the owner of one process via `wmic ... call getowner`, or null. */
export function wmicGetOwner(pid: number): WmicOwner | null {
  const wmic = resolveWmicExe();
  if (!wmic) return null;
  let output: string;
  try {
    output = execFileSync(
      wmic,
      ["process", "where", `ProcessId=${pid}`, "call", "getowner"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true },
    );
  } catch {
    return null;
  }
  const returnValue = /ReturnValue\s*=\s*(\d+)/.exec(output);
  if (!returnValue || returnValue[1] !== "0") return null;
  const user = /User\s*=\s*"([^"]*)"/.exec(output);
  const domain = /Domain\s*=\s*"([^"]*)"/.exec(output);
  if (!user || !user[1]) return null;
  return { domain: domain?.[1] ?? "", user: user[1] };
}

/** Current account name in `DOMAIN\user` form via `whoami`, or null. */
export function currentWindowsAccount(): string | null {
  const whoami = resolveTrustedWindowsWhoamiExe();
  let output: string;
  try {
    output = execFileSync(
      whoami,
      [],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true },
    );
  } catch {
    return null;
  }
  const line = output.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return line && /\\/.test(line) ? line : null;
}
