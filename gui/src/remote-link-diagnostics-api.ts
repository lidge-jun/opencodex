import { requestLinkJson } from "./remote-link-api";

/*
 * The dashboard's view of GET /api/link/diagnostics. The server already re-sanitizes every record
 * against the writer's allowlist; this parser checks the same closed vocabulary again and keeps only
 * the fields the table shows, so no response can put free text into the page.
 */
export const LINK_DIAGNOSTIC_EVENTS = ["owner_lookup", "relay_retry", "relay_failure", "relay_recovered", "tunnel_transition"] as const;
export const LINK_DIAGNOSTIC_OUTCOMES = [
  "match", "mismatch", "lookup_error", "deadline", "stale", "unavailable", "identity_unknown",
  "identity_mismatch", "auth_timeout", "auth_failed", "transport_error", "client_abort", "header_timeout", "recovered",
  "connected", "spawned", "stopped", "auth", "hostkey", "forward", "remote_forward_conflict", "timeout", "network",
  "unknown", "spawn_failed", "listener_unavailable",
] as const;
export const LINK_DIAGNOSTIC_STATES = ["idle", "connecting", "connected", "reconnecting", "failed"] as const;
/** Rows the dashboard asks for; the server caps any limit at 1000. */
export const LINK_DIAGNOSTICS_PAGE_LIMIT = 100;
/** The latest time a JavaScript Date can hold; a larger timestamp would throw when formatted. */
const MAX_DATE_MS = 8_640_000_000_000_000;

export type LinkDiagnosticEvent = typeof LINK_DIAGNOSTIC_EVENTS[number];
export type LinkDiagnosticOutcome = typeof LINK_DIAGNOSTIC_OUTCOMES[number];
export type LinkDiagnosticState = typeof LINK_DIAGNOSTIC_STATES[number];

export interface LinkDiagnosticView {
  /** A row key for this response; records have no identity of their own. */
  rowKey: string;
  event: LinkDiagnosticEvent;
  outcome: LinkDiagnosticOutcome;
  state?: LinkDiagnosticState;
  previousState?: LinkDiagnosticState;
  attempt?: number;
  tunnelPort?: number;
  timestamp?: number;
  suppressed?: number;
}

export interface LinkDiagnosticsView {
  records: LinkDiagnosticView[];
  matched: number;
  skipped: number;
  /** A file was larger than the 256 KiB read bound. */
  truncated: boolean;
  /** A file was a symlink, a non-regular file or under a symlinked link directory. */
  refused: boolean;
  /** A file exists but could not be read. */
  unreadable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function count(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function parseRecord(value: unknown, index: number): LinkDiagnosticView | null {
  if (!isRecord(value) || !oneOf(LINK_DIAGNOSTIC_EVENTS, value.event) || !oneOf(LINK_DIAGNOSTIC_OUTCOMES, value.outcome)) return null;
  const record: LinkDiagnosticView = { rowKey: "r" + index, event: value.event, outcome: value.outcome };
  if (oneOf(LINK_DIAGNOSTIC_STATES, value.previousState)) record.previousState = value.previousState;
  if (oneOf(LINK_DIAGNOSTIC_STATES, value.state)) record.state = value.state;
  if (count(value.attempt)) record.attempt = value.attempt;
  if (count(value.tunnelPort, 1) && value.tunnelPort <= 65_535) record.tunnelPort = value.tunnelPort;
  if (count(value.timestamp) && value.timestamp <= MAX_DATE_MS) record.timestamp = value.timestamp;
  if (count(value.suppressed, 1)) record.suppressed = value.suppressed;
  return record;
}

export function parseLinkDiagnostics(value: unknown): LinkDiagnosticsView {
  if (!isRecord(value) || !Array.isArray(value.records) || !count(value.matched) || !count(value.skipped)) {
    throw new Error("invalid link diagnostics response");
  }
  const files = Array.isArray(value.files) ? value.files.filter(isRecord) : [];
  return {
    records: value.records.map((record: unknown, index: number) => parseRecord(record, index)).filter((record): record is LinkDiagnosticView => record !== null),
    matched: value.matched,
    skipped: value.skipped,
    truncated: files.some(file => file.truncated === true),
    refused: files.some(file => file.state === "refused"),
    unreadable: files.some(file => file.state === "unreadable"),
  };
}

export async function fetchLinkDiagnostics(apiBase: string, signal?: AbortSignal): Promise<LinkDiagnosticsView> {
  return parseLinkDiagnostics(await requestLinkJson<unknown>(apiBase, "/api/link/diagnostics?limit=" + LINK_DIAGNOSTICS_PAGE_LIMIT, { signal }));
}
