import {
  isLabRouteSubjectId,
  readRecentUsageEntries,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
} from "../../usage/log";

export const PASSIVE_PRODUCTION_DEFAULT_LIMIT = 50;
export const PASSIVE_PRODUCTION_MAX_LIMIT = 200;
export const PASSIVE_PRODUCTION_MAX_SCAN_ROWS = 2_000;

export type PassiveProductionOutcome =
  | "success"
  | "client_cancel"
  | "route_error"
  | "environmental"
  | "unknown";

export interface PassiveRouteSignalV1 {
  schemaVersion: 1;
  subjectId: string;
  source: "production_usage_v1";
  requestRef: string;
  decisionRef?: string;
  attemptOrdinal: number;
  observedAt: number;
  outcome: PassiveProductionOutcome;
  httpStatus?: number;
}

export interface PassiveProductionSummaryV1 {
  schemaVersion: 1;
  subjectId: string;
  verificationStatus: "not_verification";
  recentProductionAttempts: number;
  recentSuccessfulAttempts: number;
  recentRouteErrorSignals: number;
  lastObservedProductionAttempt?: number;
}

export interface PassiveProductionQueryResultV1 {
  schemaVersion: 1;
  verificationStatus: "not_verification";
  summary: PassiveProductionSummaryV1;
  signals: PassiveRouteSignalV1[];
  scannedRows: number;
  truncated: boolean;
}

const ROUTE_ERROR_CODES = new Set([
  "upstream_error",
  "upstream_transport_error",
  "upstream_connect_error",
  "upstream_timeout",
]);
const ENVIRONMENTAL_ERROR_CODES = new Set([
  "authentication_error",
  "rate_limit_error",
  "admission_rejected",
  "upstream_host_circuit_open",
]);

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return PASSIVE_PRODUCTION_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("passive production limit must be a positive integer");
  return Math.min(value, PASSIVE_PRODUCTION_MAX_LIMIT);
}

function isFinalAttempt(entry: PersistedUsageEntry, attempt: PersistedUsageAttempt): boolean {
  const attempts = entry.attempts ?? [];
  return attempts.length > 0 && attempts[attempts.length - 1]?.ordinal === attempt.ordinal;
}

function classifyOutcome(entry: PersistedUsageEntry, attempt: PersistedUsageAttempt): PassiveProductionOutcome {
  if (attempt.status >= 200 && attempt.status < 300) return "success";
  if (isFinalAttempt(entry, attempt) && entry.closeReason === "client_cancel") return "client_cancel";
  if (attempt.errorCode && ENVIRONMENTAL_ERROR_CODES.has(attempt.errorCode)) return "environmental";
  if (attempt.errorCode && ROUTE_ERROR_CODES.has(attempt.errorCode)) return "route_error";
  return "unknown";
}

function signalFor(entry: PersistedUsageEntry, attempt: PersistedUsageAttempt): PassiveRouteSignalV1 | null {
  const subjectId = attempt.labRouteSubjectId;
  if (!isLabRouteSubjectId(subjectId)) return null;
  return {
    schemaVersion: 1,
    subjectId,
    source: "production_usage_v1",
    requestRef: entry.requestId,
    ...(entry.routeDecision?.decisionId ? { decisionRef: entry.routeDecision.decisionId } : {}),
    attemptOrdinal: attempt.ordinal,
    observedAt: entry.timestamp,
    outcome: classifyOutcome(entry, attempt),
    httpStatus: attempt.status,
  };
}

export function derivePassiveProductionSignals(
  entries: readonly PersistedUsageEntry[],
  subjectId: string,
  limit?: number,
): PassiveProductionQueryResultV1 {
  if (!isLabRouteSubjectId(subjectId)) throw new Error("invalid passive production subject id");
  const maxResults = boundedLimit(limit);
  const signals: PassiveRouteSignalV1[] = [];
  // readRecentUsageEntries returns the selected append-only rows oldest-first.
  // Tail selection, reverse iteration, and signals[0] as the newest observation rely on this ordering.
  const scanRows = entries.slice(-PASSIVE_PRODUCTION_MAX_SCAN_ROWS);
  const scanTruncated = entries.length > PASSIVE_PRODUCTION_MAX_SCAN_ROWS;
  let resultTruncated = false;

  scan: for (let rowIndex = scanRows.length - 1; rowIndex >= 0; rowIndex--) {
    const entry = scanRows[rowIndex]!;
    const attempts = entry.attempts ?? [];
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex--) {
      const signal = signalFor(entry, attempts[attemptIndex]!);
      if (signal?.subjectId !== subjectId) continue;
      if (signals.length >= maxResults) {
        resultTruncated = true;
        break scan;
      }
      signals.push(signal);
    }
  }

  const recentSuccessfulAttempts = signals.filter(signal => signal.outcome === "success").length;
  const recentRouteErrorSignals = signals.filter(signal => signal.outcome === "route_error").length;
  return {
    schemaVersion: 1,
    verificationStatus: "not_verification",
    summary: {
      schemaVersion: 1,
      subjectId,
      verificationStatus: "not_verification",
      recentProductionAttempts: signals.length,
      recentSuccessfulAttempts,
      recentRouteErrorSignals,
      ...(signals[0] ? { lastObservedProductionAttempt: signals[0].observedAt } : {}),
    },
    signals,
    scannedRows: scanRows.length,
    truncated: scanTruncated || resultTruncated,
  };
}

/** Read-only bounded CL-09 projection over the existing usage-log authority. */
export function queryPassiveProductionSignals(
  subjectId: string,
  limit?: number,
  configDir?: string,
): PassiveProductionQueryResultV1 {
  return derivePassiveProductionSignals(
    // Read one row past the scan cap so the projection can distinguish an exact-cap history
    // from a history with older rows omitted by the bounded reader.
    readRecentUsageEntries(PASSIVE_PRODUCTION_MAX_SCAN_ROWS + 1, configDir),
    subjectId,
    limit,
  );
}
