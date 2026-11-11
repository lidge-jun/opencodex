import {
  LINK_DIAGNOSTICS_DEFAULT_LIMIT, LINK_DIAGNOSTICS_MAX_LIMIT, LINK_DIAGNOSTICS_SCHEMA, linkDiagnosticsPath, readLinkDiagnostics,
  type LinkDiagnosticEntry, type LinkDiagnosticsReadResult,
} from "../link/diagnostics-read";
import { CliUsageError, printData, rejectArgs, takeIntegerOption, takeJsonFlag, takeOption } from "./runtime-api";

export const LINK_DIAGNOSTICS_USAGE = "ocx link diagnostics [--limit <n>] [--since <iso-time|epoch-ms>] [--json]";

/** What --json prints: the reader's sanitized result plus the schema and the local path. */
export type LinkDiagnosticsDocument = { schema: typeof LINK_DIAGNOSTICS_SCHEMA; path: string } & LinkDiagnosticsReadResult;

function parseSince(raw: string | undefined, usage: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = /^\d+$/.test(raw) ? Number(raw) : /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new CliUsageError("--since must be an ISO time or epoch milliseconds", usage);
  return value;
}

const HEADER = ["TIME", "EVENT", "OUTCOME", "STATE", "ATTEMPT", "PORT"] as const;

function row(record: LinkDiagnosticEntry): string[] {
  const state = record.previousState && record.state ? record.previousState + " -> " + record.state : record.state ?? "-";
  return [
    record.timestamp !== undefined ? new Date(record.timestamp).toISOString() : "-",
    record.event,
    record.suppressed ? record.outcome + " (+" + record.suppressed + " suppressed)" : record.outcome,
    state,
    record.attempt !== undefined ? String(record.attempt) : "-",
    record.tunnelPort !== undefined ? String(record.tunnelPort) : "-",
  ];
}

function table(records: readonly LinkDiagnosticEntry[]): string[] {
  const cells = [[...HEADER], ...records.map(row)];
  const widths = HEADER.map((_, column) => Math.max(...cells.map(cellsOfRow => cellsOfRow[column]!.length)));
  return cells.map(cellsOfRow => cellsOfRow.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
}

function humanLines(document: LinkDiagnosticsDocument): string[] {
  const { files, records, matched, skipped, path } = document;
  const lines: string[] = [];
  if (files.every(file => file.state === "absent")) return ["No Remote Link diagnostics recorded yet: " + path];
  if (records.length === 0) lines.push("No matching Remote Link diagnostics in " + path);
  else lines.push(...table(records), "", "Showing " + records.length + " of " + matched + " records from " + path);
  for (const file of files) {
    if (file.state === "refused") lines.push(file.name + " was not read: it is not a regular file in a regular link directory.");
    else if (file.state === "unreadable") lines.push(file.name + " could not be read.");
    else if (file.truncated) lines.push(file.name + " is larger than 256 KiB; only its newest 256 KiB were read.");
  }
  if (skipped > 0) lines.push(skipped + " unreadable or unrecognized line" + (skipped === 1 ? " was" : "s were") + " skipped.");
  return lines;
}

/**
 * `ocx link diagnostics`: read this computer's bounded link diagnostics file directly. It never
 * contacts the proxy, loads the config, creates or hardens a directory, or writes anything.
 */
export async function runLinkDiagnostics(args: string[], deps: { linkConfigDir?: string }, usage: string): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const limit = takeIntegerOption(args, "--limit", { min: 1, max: LINK_DIAGNOSTICS_MAX_LIMIT }) ?? LINK_DIAGNOSTICS_DEFAULT_LIMIT;
  const since = parseSince(takeOption(args, "--since"), usage);
  rejectArgs(args, usage);
  const result = await readLinkDiagnostics({ configDir: deps.linkConfigDir, limit, since });
  const document: LinkDiagnosticsDocument = { schema: LINK_DIAGNOSTICS_SCHEMA, path: linkDiagnosticsPath(deps.linkConfigDir), ...result };
  // The human lines are built only when shown, so nothing in them can fail a --json read.
  printData(document, wantsJson, wantsJson ? [] : humanLines(document));
}
