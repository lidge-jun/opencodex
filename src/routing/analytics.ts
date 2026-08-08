/**
 * Source-backed routing analytics (RI-03).
 *
 * All metrics derive from the rebuildable request-history index
 * (`routing-history.sqlite`), never from repeated full JSONL scans. The
 * analysis is read-only: no routing decision, profile, or weight changes here
 * (ADR-10 - no automatic self-tuning).
 *
 * Bounds: at most ANALYTICS_MAX_ROWS matching rows are analyzed per call; a
 * larger population sets `historyTruncated: true` so readers never mistake a
 * sample for the full history.
 */

import type { PersistedUsageEntry } from "../usage/log";
import { estimateRequestCost, serviceTierContext } from "../usage/cost";
import { openRequestHistoryIndex, requestHistoryDb } from "./history/indexer";

export const ANALYTICS_MAX_ROWS = 50_000;
/** Default row cap for the management API (full cap remains available via `limit`). */
export const ANALYTICS_API_DEFAULT_ROWS = 5_000;

export interface RoutingAnalyticsFilters {
  provider?: string;
  model?: string;
  profileId?: string;
  surface?: string;
  from?: number;
  to?: number;
}

export type AnalyticsConfidence = "high" | "medium" | "low";

export interface AnalyticsBreakdownRow {
  provider: string;
  model: string;
  accountRef?: string;
  profileId?: string;
  requests: number;
  successes: number;
  failures: number;
  cancelled: number;
  successRate: number | null;
  p50DurationMs?: number;
  estimatedCostUsdPerSuccessfulRequest?: number | null;
}

export interface AnalyticsProfileRow {
  profileId: string;
  profileRevision?: string;
  requests: number;
  successes: number;
  failures: number;
  fallbacks: number;
  successRate: number | null;
}

export interface RoutingAnalyticsResult {
  generatedAt: number;
  totalRequests: number;
  scannedRows: number;
  historyTruncated: boolean;
  confidence: AnalyticsConfidence | null;
  successRate: number | null;
  failureRate: number | null;
  cancelledRate: number | null;
  fallbackRate: number | null;
  totalAttempts: number;
  averageAttemptsPerRequest: number | null;
  incompleteStreamRate: number | null;
  cooldownTriggeringFailures: number;
  durationMs: {
    p50?: number;
    p95?: number;
    p99?: number;
    sampleCount: number;
  };
  firstOutputMs: {
    p50?: number;
    p95?: number;
    p99?: number;
    sampleCount: number;
    /** Share of scanned requests with a TTFT measurement (0..1). */
    coverage: number | null;
  };
  estimatedCostUsdPerSuccessfulRequest: number | null;
  estimatedCostUsdTotalSuccessful: number | null;
  usageCoverage: number | null;
  priceCoverage: number | null;
  breakdown: AnalyticsBreakdownRow[];
  profileBreakdown: AnalyticsProfileRow[];
}

interface ScannedRow {
  provider: string;
  model: string;
  apiKeyId?: string | null;
  profileId?: string | null;
  profileRevision?: string | null;
  status: number;
  durationMs: number;
  firstOutputMs?: number | null;
  closeReason?: string | null;
  terminalStatus?: string | null;
  usageStatus: string;
  usageJson?: string | null;
  attemptCount: number;
  fallback: number;
  rowJson: string;
}

interface Bucket extends AnalyticsBreakdownRow {
  durations: number[];
  costUsdSum: number;
  costRows: number;
}

const COOLDOWN_RECOVERY_KINDS = new Set([
  "rate-limit-429",
  "key-429",
  "oauth-401",
  "anthropic-oauth-429",
]);

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function classifyRow(row: ScannedRow): "success" | "failure" | "cancelled" {
  if (row.closeReason === "client_cancel" || row.status === 499) return "cancelled";
  if (row.terminalStatus === "incomplete") return "failure";
  if (row.terminalStatus && row.terminalStatus !== "completed") return "failure";
  if (row.status >= 400) return "failure";
  return "success";
}

function parseEntry(rowJson: string): PersistedUsageEntry | null {
  try {
    const parsed = JSON.parse(rowJson) as PersistedUsageEntry;
    return parsed && typeof parsed === "object" && typeof parsed.requestId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function cooldownTriggering(entry: PersistedUsageEntry | null, status: number): boolean {
  if (status === 429) return true;
  if (!Array.isArray(entry?.attempts)) return false;
  return entry.attempts.some((attempt: unknown) => {
    if (!attempt || typeof attempt !== "object") return false;
    const recoveryKinds = (attempt as { recoveryKinds?: unknown }).recoveryKinds;
    return Array.isArray(recoveryKinds)
      && recoveryKinds.some(kind => typeof kind === "string" && COOLDOWN_RECOVERY_KINDS.has(kind));
  });
}

function successCostUsd(
  row: Pick<ScannedRow, "provider" | "model">,
  entry: PersistedUsageEntry,
): number | null {
  if (!entry.usage) return null;
  const estimate = estimateRequestCost({
    provider: row.provider,
    model: row.model,
    usage: entry.usage,
    usageStatus: entry.usageStatus,
    serviceTier: serviceTierContext(entry),
  });
  return estimate ? estimate.cost.total : null;
}

export async function computeRoutingAnalytics(
  filters: RoutingAnalyticsFilters,
  options: { maxRows?: number } = {},
): Promise<RoutingAnalyticsResult> {
  await openRequestHistoryIndex();
  const handle = requestHistoryDb();
  const maxRows = Math.min(
    Math.max(1, Math.trunc(options.maxRows ?? ANALYTICS_MAX_ROWS)),
    ANALYTICS_MAX_ROWS,
  );

  const where: string[] = [];
  const values: Array<string | number> = [];
  const add = (clause: string, value: string | number) => {
    where.push(clause);
    values.push(value);
  };
  if (filters.provider !== undefined) add("provider = ?", filters.provider);
  if (filters.model !== undefined) add("model = ?", filters.model);
  if (filters.profileId !== undefined) add("profile_id = ?", filters.profileId);
  if (filters.surface !== undefined) add("surface = ?", filters.surface);
  if (filters.from !== undefined) add("timestamp >= ?", filters.from);
  if (filters.to !== undefined) add("timestamp <= ?", filters.to);
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

  const rows = handle.query(
    `SELECT provider, model, api_key_id AS apiKeyId, profile_id AS profileId,
            profile_revision AS profileRevision, status,
            duration_ms AS durationMs, first_output_ms AS firstOutputMs,
            close_reason AS closeReason, terminal_status AS terminalStatus,
            usage_status AS usageStatus, usage_json AS usageJson,
            attempt_count AS attemptCount, fallback, row_json AS rowJson
     FROM requests${whereSql} ORDER BY timestamp DESC LIMIT ?`,
  ).all(...values, maxRows + 1) as ScannedRow[];

  const scanned = rows.slice(0, maxRows);
  const historyTruncated = rows.length > maxRows;

  let successes = 0;
  let failures = 0;
  let cancelled = 0;
  let fallbacks = 0;
  let totalAttempts = 0;
  let incompleteStreams = 0;
  let cooldownFailures = 0;
  let usageReported = 0;
  const durations: number[] = [];
  const firstOutputs: number[] = [];
  let costTotalUsd = 0;
  let costCount = 0;

  const byKey = new Map<string, Bucket>();
  const byProfile = new Map<string, AnalyticsProfileRow>();

  for (const row of scanned) {
    const kind = classifyRow(row);
    if (kind === "success") successes += 1;
    else if (kind === "failure") failures += 1;
    else cancelled += 1;
    if (row.fallback === 1) fallbacks += 1;
    totalAttempts += row.attemptCount;
    if (row.terminalStatus === "incomplete") incompleteStreams += 1;
    durations.push(row.durationMs);
    if (row.firstOutputMs !== null && row.firstOutputMs !== undefined && row.firstOutputMs >= 0) {
      firstOutputs.push(row.firstOutputMs);
    }
    if (row.usageStatus !== "unreported") usageReported += 1;

    let rowCostUsd: number | null = null;
    if (kind === "success") {
      const entry = parseEntry(row.rowJson);
      if (entry) {
        rowCostUsd = successCostUsd(row, entry);
        if (rowCostUsd !== null) {
          costTotalUsd += rowCostUsd;
          costCount += 1;
        }
      }
    }

    if (kind === "failure") {
      const failureEntry = parseEntry(row.rowJson);
      if (cooldownTriggering(failureEntry, row.status)) cooldownFailures += 1;
    }

    const key = `${row.provider}\0${row.model}\0${row.apiKeyId ?? ""}\0${row.profileId ?? ""}`;
    let bucket: Bucket | undefined = byKey.get(key);
    if (!bucket) {
      bucket = {
        provider: row.provider,
        model: row.model,
        ...(row.apiKeyId ? { accountRef: row.apiKeyId } : {}),
        ...(row.profileId ? { profileId: row.profileId } : {}),
        requests: 0,
        successes: 0,
        failures: 0,
        cancelled: 0,
        successRate: null,
        durations: [],
        costUsdSum: 0,
        costRows: 0,
      };
      byKey.set(key, bucket);
    }
    bucket.requests += 1;
    if (kind === "success") bucket.successes += 1;
    else if (kind === "failure") bucket.failures += 1;
    else bucket.cancelled += 1;
    bucket.durations.push(row.durationMs);
    if (rowCostUsd !== null) {
      bucket.costUsdSum += rowCostUsd;
      bucket.costRows += 1;
    }

    if (row.profileId) {
      let profile = byProfile.get(row.profileId);
      if (!profile) {
        profile = {
          profileId: row.profileId,
          ...(row.profileRevision ? { profileRevision: row.profileRevision } : {}),
          requests: 0,
          successes: 0,
          failures: 0,
          fallbacks: 0,
          successRate: null,
        };
        byProfile.set(row.profileId, profile);
      }
      profile.requests += 1;
      if (kind === "success") profile.successes += 1;
      else if (kind === "failure") profile.failures += 1;
      if (row.fallback === 1) profile.fallbacks += 1;
    }
  }

  durations.sort((a, b) => a - b);
  firstOutputs.sort((a, b) => a - b);
  const total = scanned.length;
  const rate = (count: number): number | null => (total > 0 ? count / total : null);

  const breakdown: AnalyticsBreakdownRow[] = [...byKey.values()].map(bucket => {
    const sorted = bucket.durations.sort((a, b) => a - b);
    const p50DurationMs = percentile(sorted, 50);
    return {
      provider: bucket.provider,
      model: bucket.model,
      ...(bucket.accountRef ? { accountRef: bucket.accountRef } : {}),
      ...(bucket.profileId ? { profileId: bucket.profileId } : {}),
      requests: bucket.requests,
      successes: bucket.successes,
      failures: bucket.failures,
      cancelled: bucket.cancelled,
      successRate: bucket.requests > 0 ? bucket.successes / bucket.requests : null,
      ...(p50DurationMs !== undefined ? { p50DurationMs } : {}),
      ...(bucket.requests > 0
        ? { estimatedCostUsdPerSuccessfulRequest: bucket.costRows > 0
          ? bucket.costUsdSum / bucket.costRows
          : null }
        : {}),
    };
  }).sort((a, b) => b.requests - a.requests);

  const profileBreakdown: AnalyticsProfileRow[] = [...byProfile.values()].map(profile => ({
    ...profile,
    successRate: profile.requests > 0 ? profile.successes / profile.requests : null,
  })).sort((a, b) => b.requests - a.requests);

  const confidence: AnalyticsConfidence | null = total === 0
    ? null
    : total >= 100 ? "high" : total >= 20 ? "medium" : "low";

  return {
    generatedAt: Date.now(),
    totalRequests: total,
    scannedRows: scanned.length,
    historyTruncated,
    confidence,
    successRate: rate(successes),
    failureRate: rate(failures),
    cancelledRate: rate(cancelled),
    fallbackRate: rate(fallbacks),
    totalAttempts,
    averageAttemptsPerRequest: total > 0 ? totalAttempts / total : null,
    incompleteStreamRate: rate(incompleteStreams),
    cooldownTriggeringFailures: cooldownFailures,
    durationMs: {
      ...(percentile(durations, 50) !== undefined ? { p50: percentile(durations, 50) } : {}),
      ...(percentile(durations, 95) !== undefined ? { p95: percentile(durations, 95) } : {}),
      ...(percentile(durations, 99) !== undefined ? { p99: percentile(durations, 99) } : {}),
      sampleCount: durations.length,
    },
    firstOutputMs: {
      ...(percentile(firstOutputs, 50) !== undefined ? { p50: percentile(firstOutputs, 50) } : {}),
      ...(percentile(firstOutputs, 95) !== undefined ? { p95: percentile(firstOutputs, 95) } : {}),
      ...(percentile(firstOutputs, 99) !== undefined ? { p99: percentile(firstOutputs, 99) } : {}),
      sampleCount: firstOutputs.length,
      coverage: total > 0 ? firstOutputs.length / total : null,
    },
    estimatedCostUsdPerSuccessfulRequest: costCount > 0 ? costTotalUsd / costCount : null,
    estimatedCostUsdTotalSuccessful: costCount > 0 ? costTotalUsd : null,
    usageCoverage: total > 0 ? usageReported / total : null,
    priceCoverage: successes > 0 ? costCount / successes : null,
    breakdown,
    profileBreakdown,
  };
}
