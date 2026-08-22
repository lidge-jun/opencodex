/**
 * Evidence-based route health (RI-06).
 *
 * Health evidence combines:
 * - live in-memory routing state: Codex account cooldown / soft-avoid
 *   (authoritative hard state);
 * - historical evidence from the request-history index: success rate,
 *   consecutive failures, incomplete-stream rate, recent latency, sample
 *   count, recency-decayed weights.
 *
 * Failure classification is strict: client cancellations, invalid requests
 * (4xx except quota 429) and synthetic policy refusals never damage target
 * health. Transport-neutral failures are excluded by the classification the
 * routing layer already records (host/account split per #914 work).
 *
 * All formulas are deterministic with documented constants; no ML.
 */

import type { OcxConfig } from "../types";
import { openRequestHistoryIndexSync, requestHistoryDb } from "./history/indexer";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import {
  getCodexAccountCooldownUntil,
  getCodexAccountSoftAvoidUntil,
  getEffectiveActiveCodexAccountId,
  isCodexAccountInCooldown,
  listLiveCodexAccountIds,
} from "../codex/routing";
import type { RouteHealthEvidence } from "./trace";

export const HEALTH_SCORE_CONSTANTS = {
  /** Recent-success weight in the composite. */
  SUCCESS_WEIGHT: 0.50,
  /** Incomplete-stream (negative) weight. */
  INCOMPLETE_WEIGHT: 0.15,
  /** Recent-latency weight. */
  LATENCY_WEIGHT: 0.20,
  /** Consecutive-failure recovery weight. */
  RECOVERY_WEIGHT: 0.15,
  /** p50 latency at or above this (ms) scores zero on the latency axis. */
  LATENCY_TARGET_MS: 60_000,
  /** Samples needed for full confidence; fewer samples scale the score down. */
  MIN_CONFIDENCE_SAMPLES: 20,
  /** Soft-avoid multiplies the composite. */
  SOFT_AVOID_MULTIPLIER: 0.5,
  /** Recency decay: a sample loses half its weight every RECENCY_HALF_LIFE_DAYS. */
  RECENCY_HALF_LIFE_DAYS: 7,
} as const;

export const HEALTH_WINDOW_MS = 14 * 86_400_000;
export const HEALTH_MAX_SAMPLES = 100;

/**
 * Historical health evidence is cached briefly across candidates within one
 * routing decision (and rapid successive decisions). Live cooldown/soft-avoid
 * state is always read fresh - it is never cached. The TTL bounds how stale
 * the history index read may be; 1.5s keeps routing deterministic within a
 * decision while bounding per-candidate SQLite work.
 */
const HEALTH_HISTORY_CACHE_TTL_MS = 1_500;
const HEALTH_HISTORY_CACHE_MAX_ENTRIES = 64;

type HistoricalHealthEvidence = Pick<
  RouteHealthEvidence,
  "sampleCount" | "successRate" | "failures" | "incompleteStreamRate" | "recentLatencyMs" | "recencyWeight"
>;

const healthHistoryCache = new Map<string, { at: number; value: HistoricalHealthEvidence }>();

/** Test seam: routing tests append fresh rows and must not see cached history. */
export function clearHealthHistoryCacheForTests(): void {
  healthHistoryCache.clear();
}

function healthHistoryCacheKey(input: Pick<HealthEvidenceInput, "provider" | "model" | "accountRef">): string {
  return `${input.provider}\u0000${input.model}\u0000${input.accountRef ?? ""}`;
}

export interface HealthEvidenceInput {
  provider: string;
  model: string;
  accountRef?: string;
  /** Live codex account id for cooldown/soft-avoid state (provider "openai"). */
  codexAccountId?: string;
  now?: number;
}

interface HealthSample {
  status: number;
  closeReason: string | null;
  terminalStatus: string | null;
  durationMs: number;
  timestamp: number;
}

interface HealthRow extends HealthSample {
  attemptCount?: number;
  rowJson?: string | null;
}

/**
 * Per-attempt samples for a candidate from a row's persisted entry.
 * Combo/failover requests store each upstream try in `entry.attempts` while
 * the top-level row records the final outcome; a provider/model that failed
 * as a non-final attempt must still contribute its own health samples.
 */
function attemptSamplesFor(
  row: Pick<HealthRow, "timestamp" | "attemptCount" | "rowJson">,
  provider: string,
  model: string,
): HealthSample[] {
  if (!row.rowJson || (row.attemptCount ?? 1) <= 1) return [];
  try {
    const parsed = JSON.parse(row.rowJson) as { attempts?: unknown };
    if (!Array.isArray(parsed.attempts)) return [];
    const samples: HealthSample[] = [];
    for (const attempt of parsed.attempts) {
      if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) continue;
      const record = attempt as Record<string, unknown>;
      if (record.provider !== provider || record.model !== model) continue;
      if (typeof record.status !== "number" || typeof record.durationMs !== "number") continue;
      samples.push({
        status: record.status,
        closeReason: null,
        terminalStatus: null,
        durationMs: record.durationMs,
        timestamp: row.timestamp,
      });
    }
    return samples;
  } catch {
    return [];
  }
}

/**
 * Live Codex pool account state for an `openai` policy candidate.
 *
 * When a deterministic active account exists (manual selection or
 * `config.activeCodexAccountId`) its cooldown/soft-avoid state is
 * authoritative. Otherwise the target is conservatively cooled only when
 * every live pool account is cooling or soft-avoided; account selection
 * inside `src/codex/routing.ts` stays authoritative when any account is
 * usable, so policy scoring never invents account choices.
 */
export function codexPoolHealthEvidence(
  config: Parameters<typeof getEffectiveActiveCodexAccountId>[0],
  now = Date.now(),
): Pick<RouteHealthEvidence, "cooldownUntilMs" | "softAvoidUntilMs"> | undefined {
  const activeId = getEffectiveActiveCodexAccountId(config);
  if (activeId) {
    const until = getCodexAccountCooldownUntil(activeId, now);
    if (until !== null) return { cooldownUntilMs: until };
    const softUntil = getCodexAccountSoftAvoidUntil(activeId, now);
    if (softUntil !== null && softUntil > now) return { softAvoidUntilMs: softUntil };
    return undefined;
  }
  const live = [...listLiveCodexAccountIds(config)];
  if (live.length === 0) return undefined;
  const cooldowns: number[] = [];
  const softAvoids: number[] = [];
  for (const accountId of live) {
    const until = getCodexAccountCooldownUntil(accountId, now);
    if (until !== null) cooldowns.push(until);
    const softUntil = getCodexAccountSoftAvoidUntil(accountId, now);
    if (softUntil !== null && softUntil > now) softAvoids.push(softUntil);
  }
  if (cooldowns.length === live.length) return { cooldownUntilMs: Math.max(...cooldowns) };
  // Every account is unavailable, but not uniformly hard-cooled (e.g. some in
  // cooldown, some soft-avoided): degrade to soft-avoid with the latest expiry
  // so scoring still penalizes the pool.
  if (cooldowns.length + softAvoids.length >= live.length && softAvoids.length > 0) {
    return { softAvoidUntilMs: Math.max(...softAvoids, ...cooldowns) };
  }
  return undefined;
}

/**
 * Candidate health evidence assembled exactly like the router's policy path:
 * historical evidence plus authoritative live Codex pool state for `openai`
 * targets. Shared by the router and the dry-run management route so the two
 * surfaces cannot drift apart.
 */
export function policyCandidateHealthEvidence(
  config: Parameters<typeof getEffectiveActiveCodexAccountId>[0],
  candidate: { provider: string; model: string },
  now = Date.now(),
): RouteHealthEvidence {
  return {
    ...healthEvidenceForCandidate({
      provider: candidate.provider,
      model: candidate.model,
      codexAccountId: candidate.provider === OPENAI_CODEX_PROVIDER_ID
        ? getEffectiveActiveCodexAccountId(config)
        : undefined,
      now,
    }),
    // Live pool state stays authoritative for `openai` targets even when no
    // account reference exists in the candidate evidence.
    ...(candidate.provider === OPENAI_CODEX_PROVIDER_ID
      ? (codexPoolHealthEvidence(config, now) ?? {})
      : {}),
  };
}

function classifySample(sample: HealthSample): "success" | "failure" | "neutral" {
  if (sample.closeReason === "client_cancel" || sample.status === 499) return "neutral";
  // Invalid requests and policy refusals must not poison target health.
  if (sample.status >= 400 && sample.status < 500 && sample.status !== 429) return "neutral";
  if (sample.terminalStatus === "incomplete") return "failure";
  if (sample.terminalStatus && sample.terminalStatus !== "completed") return "failure";
  if (sample.status >= 400) return "failure";
  return "success";
}

function decayWeight(timestamp: number, now: number): number {
  const ageDays = Math.max(0, now - timestamp) / 86_400_000;
  return Math.pow(0.5, ageDays / HEALTH_SCORE_CONSTANTS.RECENCY_HALF_LIFE_DAYS);
}

function median(sorted: number[]): number | undefined {
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Historical health evidence from the derived index (synchronous: called at
 * routing time). Never throws; an unopened/unreadable index yields unknown.
 */
function computeHistoricalHealthEvidence(
  input: Pick<HealthEvidenceInput, "provider" | "model" | "accountRef">,
  now: number,
): HistoricalHealthEvidence {
  try {
    openRequestHistoryIndexSync();
    const handle = requestHistoryDb();
    const where: string[] = ["provider = ?", "model = ?", "timestamp >= ?"];
    const values: Array<string | number> = [input.provider, input.model, now - HEALTH_WINDOW_MS];
    if (input.accountRef) {
      where.push("api_key_id = ?");
      values.push(input.accountRef);
    }
    const rows = handle.query(
      `SELECT status, close_reason AS closeReason, terminal_status AS terminalStatus,
              duration_ms AS durationMs, timestamp,
              attempt_count AS attemptCount, row_json AS rowJson
       FROM requests WHERE ${where.join(" AND ")}
       ORDER BY timestamp DESC LIMIT ?`,
    ).all(...values, HEALTH_MAX_SAMPLES) as HealthRow[];
    // Rows whose top-level target differs from this candidate may still carry
    // candidate attempts (combo/failover): expand those too. The serialized
    // provider/model LIKE prefilter keeps the LIMIT from being consumed by
    // rows that cannot contribute samples for this candidate.
    const escapeLike = (value: string): string => value.replace(/[\\%_]/g, match => `\\${match}`);
    const attemptRows = handle.query(
      `SELECT timestamp, attempt_count AS attemptCount, row_json AS rowJson
       FROM requests WHERE timestamp >= ? AND attempt_count > 1
         AND row_json LIKE ? ESCAPE '\\'
         AND row_json LIKE ? ESCAPE '\\'
         AND NOT (provider = ? AND model = ?)
       ORDER BY timestamp DESC LIMIT ?`,
    ).all(
      now - HEALTH_WINDOW_MS,
      `%\"provider\":\"${escapeLike(input.provider)}\"%`,
      `%\"model\":\"${escapeLike(input.model)}\"%`,
      input.provider,
      input.model,
      HEALTH_MAX_SAMPLES,
    ) as Array<
      Pick<HealthRow, "timestamp" | "attemptCount" | "rowJson">
    >;

    const samples: HealthSample[] = [];
    for (const row of rows) {
      const attemptSamples = attemptSamplesFor(row, input.provider, input.model);
      samples.push(...(attemptSamples.length > 0 ? attemptSamples : [row]));
    }
    for (const row of attemptRows) {
      samples.push(...attemptSamplesFor(row, input.provider, input.model));
    }
    // Newest first for the consecutive-failure walk; attempt samples inherit
    // their row's timestamp.
    samples.sort((a, b) => b.timestamp - a.timestamp);

    let successes = 0;
    let failures = 0;
    let incompleteStreams = 0;
    let weightedSuccess = 0;
    let weightedTotal = 0;
    const latencies: number[] = [];
    for (const sample of samples) {
      const kind = classifySample(sample);
      const weight = decayWeight(sample.timestamp, now);
      if (kind === "neutral") continue;
      if (kind === "success") {
        successes += 1;
        weightedSuccess += weight;
        weightedTotal += weight;
      } else {
        failures += 1;
        weightedTotal += weight;
      }
      if (sample.terminalStatus === "incomplete") incompleteStreams += 1;
      latencies.push(sample.durationMs);
    }
    // Consecutive failures: walk newest -> oldest until a success.
    let consecutiveFailures = 0;
    for (const sample of samples) {
      const kind = classifySample(sample);
      if (kind === "neutral") continue;
      if (kind === "failure") consecutiveFailures += 1;
      else break;
    }

    const sampleCount = successes + failures;
    const out: HistoricalHealthEvidence = {};
    if (sampleCount > 0) {
      out.sampleCount = sampleCount;
      out.successRate = weightedTotal > 0 ? weightedSuccess / weightedTotal : 0;
      if (consecutiveFailures > 0) out.failures = consecutiveFailures;
      if (incompleteStreams > 0) out.incompleteStreamRate = incompleteStreams / sampleCount;
      latencies.sort((a, b) => a - b);
      const p50 = median(latencies);
      if (p50 !== undefined) out.recentLatencyMs = p50;
      out.recencyWeight = decayWeight(samples[0]!.timestamp, now);
    }
    return out;
  } catch {
    /* index unreadable: evidence stays unknown */
    return {};
  }
}

export function healthEvidenceForCandidate(input: HealthEvidenceInput): RouteHealthEvidence {
  const now = input.now ?? Date.now();
  const evidence: RouteHealthEvidence = {};

  // Live authoritative state: hard cooldown and soft-avoid for Codex pool
  // accounts. Cooldown stays authoritative over any historical score. Always
  // read fresh - never cached.
  if (input.codexAccountId && input.provider === "openai") {
    if (isCodexAccountInCooldown(input.codexAccountId, now)) {
      const until = getCodexAccountCooldownUntil(input.codexAccountId, now);
      if (until !== null) evidence.cooldownUntilMs = until;
    }
    const softAvoidUntil = getCodexAccountSoftAvoidUntil(input.codexAccountId, now);
    if (softAvoidUntil !== null && softAvoidUntil > now) evidence.softAvoidUntilMs = softAvoidUntil;
  }

  const cacheKey = healthHistoryCacheKey(input);
  const cached = healthHistoryCache.get(cacheKey);
  if (cached && now - cached.at < HEALTH_HISTORY_CACHE_TTL_MS) {
    Object.assign(evidence, cached.value);
  } else {
    const history = computeHistoricalHealthEvidence(input, now);
    Object.assign(evidence, history);
    if (healthHistoryCache.size >= HEALTH_HISTORY_CACHE_MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of healthHistoryCache) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) healthHistoryCache.delete(oldestKey);
    }
    healthHistoryCache.set(cacheKey, { at: now, value: history });
  }

  return evidence;
}

/**
 * Deterministic latency score in [0,1] from the recorded p50, shared by the health
 * composite and the standalone `optimize.latency` term so the two cannot drift apart.
 *
 * An unmeasured candidate scores the NEUTRAL midpoint, not 0. Punishing it into last
 * place would make selection depend on which candidate happened to be exercised first,
 * which is the order-dependence this scoring exists to remove.
 */
export function latencyScoreFromEvidence(evidence: RouteHealthEvidence | undefined): number {
  const p50 = evidence?.recentLatencyMs;
  if (p50 === undefined) return 0.5;
  return Math.max(0, Math.min(1, 1 - p50 / HEALTH_SCORE_CONSTANTS.LATENCY_TARGET_MS));
}

/**
 * Deterministic health score in [0,1]. Returns null when evidence is unknown
 * (no samples) so callers can apply the profile's unknownEvidence policy.
 * A live hard cooldown scores 0 (authoritative).
 */
export function healthScore(evidence: RouteHealthEvidence | undefined, now = Date.now()): number | null {
  if (!evidence) return null;
  if (evidence.cooldownUntilMs !== undefined && evidence.cooldownUntilMs > now) return 0;
  if (!evidence.sampleCount || evidence.sampleCount < 1) return null;
  const successRate = evidence.successRate ?? 0;
  const incompleteRate = evidence.incompleteStreamRate ?? 0;
  const latency = latencyScoreFromEvidence(evidence);
  const consecutive = evidence.failures ?? 0;
  const recoveryScore = 1 - Math.min(1, consecutive / 5);
  const composite = HEALTH_SCORE_CONSTANTS.SUCCESS_WEIGHT * successRate
    + HEALTH_SCORE_CONSTANTS.INCOMPLETE_WEIGHT * (1 - incompleteRate)
    + HEALTH_SCORE_CONSTANTS.LATENCY_WEIGHT * latency
    + HEALTH_SCORE_CONSTANTS.RECOVERY_WEIGHT * recoveryScore;
  const confidence = Math.min(1, evidence.sampleCount / HEALTH_SCORE_CONSTANTS.MIN_CONFIDENCE_SAMPLES);
  const softAvoid = evidence.softAvoidUntilMs !== undefined && evidence.softAvoidUntilMs > now
    ? HEALTH_SCORE_CONSTANTS.SOFT_AVOID_MULTIPLIER
    : 1;
  return composite * confidence * softAvoid;
}
