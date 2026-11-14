/**
 * Live meter: generation speed, cache hit and context fill for ONE completed request row.
 *
 * Pure projection of a `RequestLogEntry`. Speed divides the upstream-reported output tokens
 * by the recorded generation window (`genStartMs` .. `lastOutputMs`, request-log-generation-window.ts),
 * never by wall time or first visible text. Anything that cannot be measured is `null` plus a
 * closed reason code; nothing is estimated or guessed. Carries numbers, model and provider
 * names only: no prompt text, account labels or identifiers.
 *
 * Ported from the Codex++ userscript reader (codexpp-andrew-extensions/meter/core.mjs); the
 * reason vocabulary is the same.
 */
import type { RequestLogEntry } from "../server/request-log";
import { cacheObservationFromUsage } from "./summary";

export type MeterSpeedReason =
  | "no_matching_request" | "request_aborted" | "request_incomplete" | "request_failed"
  | "usage_missing" | "tokens_estimated" | "output_missing" | "generation_timing_missing"
  | "generation_window_too_short" | "invalid_generation_window" | "multiple_attempts";

export type MeterPercentReason = "usage_missing" | "tokens_estimated" | "input_missing" | "limit_unknown" | "cache_unobserved";

export interface LiveMeter {
  speed: { value: number | null; reason: MeterSpeedReason | null };
  outputTokens: number | null;
  generationMs: number | null;
  cache: { readTokens: number | null; inputTokens: number | null; percent: number | null; reason: MeterPercentReason | null };
  context: { usedTokens: number | null; limitTokens: number | null; percent: number | null; reason: MeterPercentReason | null };
  model: string | null;
  provider: string | null;
  client: string | null;
  timestamp: number | null;
}

/** Rows that are not a conversation turn (automatic approval reviews) never become the meter. */
export function isConversationMeterRow(entry: Pick<RequestLogEntry, "model">): boolean {
  return typeof entry.model === "string" && entry.model !== "codex-auto-review";
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function speed(entry: RequestLogEntry): LiveMeter["speed"] {
  const none = (reason: MeterSpeedReason) => ({ value: null, reason });
  if (entry.closeReason === "client_cancel" || entry.status === 499) return none("request_aborted");
  if (entry.terminalStatus === "failed" || entry.terminalStatus === "incomplete"
    || entry.closeReason === "body_stall" || entry.closeReason === "body_overflow") return none("request_incomplete");
  if (!(entry.status >= 200 && entry.status < 400)) return none("request_failed");
  if (!entry.usage || entry.usageStatus === "unsupported") return none("usage_missing");
  if (entry.usageStatus === "estimated" || entry.usage.estimated === true) return none("tokens_estimated");
  const tokens = entry.usage.outputTokens;
  if (!(Number.isFinite(tokens) && tokens > 0)) return none("output_missing");
  // A retried row sums output over every attempt, but its generation window is one span from the
  // first attempt's first event to the last attempt's last delta, gaps between attempts included.
  if ((entry.attempts?.length ?? 0) > 1) return none("multiple_attempts");
  const start = entry.genStartMs;
  const end = entry.lastOutputMs;
  if (!(typeof start === "number" && Number.isFinite(start) && start >= 0 && typeof end === "number" && Number.isFinite(end))) {
    return none("generation_timing_missing");
  }
  const window = end - start;
  if (window < 1000) return none(window > 0 ? "generation_window_too_short" : "invalid_generation_window");
  if (Number.isFinite(entry.durationMs) && end > entry.durationMs + 10) return none("invalid_generation_window");
  return { value: (tokens * 1000) / window, reason: null };
}

/**
 * `contextLimitTokens` is the model's window as the catalog knows it, supplied by the caller
 * (a pure projection cannot look it up). `null` when unknown: the percentage is then `null`.
 */
export function liveMeterFromEntry(entry: RequestLogEntry, contextLimitTokens: number | null): LiveMeter {
  const s = speed(entry);
  const reported = !!entry.usage && entry.usageStatus !== "unsupported"
    && entry.usageStatus !== "estimated" && entry.usage.estimated !== true;
  const usageReason: MeterPercentReason | null = !entry.usage || entry.usageStatus === "unsupported"
    ? "usage_missing" : reported ? null : "tokens_estimated";
  const usage = reported ? entry.usage : undefined;
  const inputTokens = count(usage?.inputTokens);
  const outputTokens = count(usage?.outputTokens);
  const readTokens = count(usage?.cacheReadInputTokens ?? usage?.cachedInputTokens);
  // `cacheReadInputTokens` is the read subset of `inputTokens`. Only an observed reading is a hit
  // rate: a synthesized zero is wire-only and an unknown one was never measured (summary.ts).
  const cacheObserved = !!usage && cacheObservationFromUsage(usage, entry.cacheProvenance).provenance === "observed";
  const cacheKnown = readTokens !== null && inputTokens !== null && inputTokens > 0
    && cacheObserved && readTokens <= inputTokens;
  const used = count(usage?.contextTotalTokens)
    ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const limit = contextLimitTokens !== null && Number.isFinite(contextLimitTokens) && contextLimitTokens > 0
    ? contextLimitTokens : null;
  return {
    speed: s,
    outputTokens,
    generationMs: s.value !== null ? (entry.lastOutputMs as number) - (entry.genStartMs as number) : null,
    cache: {
      readTokens, inputTokens,
      percent: cacheKnown ? (100 * readTokens) / inputTokens : null,
      reason: cacheKnown ? null : usageReason
        ?? (readTokens !== null && inputTokens !== null && inputTokens > 0 && !cacheObserved ? "cache_unobserved" : "input_missing"),
    },
    context: {
      usedTokens: used, limitTokens: limit,
      percent: used !== null && limit !== null ? Math.min(100, (100 * used) / limit) : null,
      reason: used === null ? usageReason ?? "input_missing" : limit === null ? "limit_unknown" : null,
    },
    model: entry.model ?? null,
    provider: entry.provider ?? null,
    client: entry.client ?? null,
    timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : null,
  };
}

export type MeterClientFamily = "codex" | "claude" | "other";

/** Family of a recorded client label; unknown or absent rows count only toward the overall meter. */
export function meterClientFamily(client: string | undefined): MeterClientFamily | null {
  if (!client || client === "unknown") return null;
  if (client.startsWith("codex_")) return "codex";
  if (client.startsWith("claude_")) return "claude";
  return "other";
}

export interface LiveMeterSelection {
  overall: RequestLogEntry | null;
  byFamily: Partial<Record<MeterClientFamily, RequestLogEntry>>;
}

/**
 * Newest completed conversation row overall and per client family. The store is append-ordered
 * but combo and retried rows can finish out of order, so recency is by `timestamp`.
 * `matches` narrows to one conversation when the caller supplied one.
 */
export function selectLiveMeterEntries(
  entries: readonly RequestLogEntry[],
  matches: (entry: RequestLogEntry) => boolean = () => true,
): LiveMeterSelection {
  const out: LiveMeterSelection = { overall: null, byFamily: {} };
  const newer = (a: RequestLogEntry | null | undefined, b: RequestLogEntry) => !a || b.timestamp >= a.timestamp;
  for (const entry of entries) {
    if (!isConversationMeterRow(entry) || !matches(entry)) continue;
    if (newer(out.overall, entry)) out.overall = entry;
    const family = meterClientFamily(entry.client);
    if (family && newer(out.byFamily[family], entry)) out.byFamily[family] = entry;
  }
  return out;
}
