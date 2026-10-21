/** Cache counters and provenance only. Never retain a raw payload, body, or credential here. */
import type { CacheTelemetry, OcxUsage } from "../types/request";

export type CacheProvenance = "observed" | "synthesized" | "unknown";
export type UsageObservationSource = "upstream" | "client";
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function rawCacheTelemetry(raw: unknown): CacheTelemetry {
  if (!record(raw)) return { source: "upstream", usagePresent: false };
  const details = record(raw.input_tokens_details) ? raw.input_tokens_details
    : record(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
  const read = details?.cached_tokens ?? raw.cache_read_input_tokens;
  const creation = details?.cache_write_tokens ?? raw.cache_creation_input_tokens;
  return {
    source: "upstream", usagePresent: true,
    ...(number(read) ? { read } : {}),
    ...(number(creation) ? { creation } : {}),
  };
}

/** Adapter callbacks precede the bridge's zero-default client encoder. */
export function withAdapterCacheTelemetry(usage: OcxUsage | undefined): OcxUsage | undefined {
  if (!usage) return usage;
  if (usage.cacheTelemetry !== undefined) {
    const evidence = normalizeCacheTelemetry(usage.cacheTelemetry);
    // Invalid metadata is not permission to reinterpret normalized counters as raw evidence.
    return evidence ? usage : { ...usage, cacheTelemetry: { source: "aggregate", usagePresent: true, complete: false } };
  }
  const read = usage.cacheReadInputTokens ?? usage.cachedInputTokens;
  return {
    ...usage,
    cacheTelemetry: {
      source: usage.estimated ? "client" : "adapter", usagePresent: true,
      ...(number(read) ? { read } : {}),
      ...(number(usage.cacheCreationInputTokens) ? { creation: usage.cacheCreationInputTokens } : {}),
    },
  };
}

/** Validate and detach only the closed evidence fields when persisting or reading a ledger. */
export function normalizeCacheTelemetry(value: unknown): CacheTelemetry | undefined {
  if (!record(value) || typeof value.source !== "string"
    || !["upstream", "adapter", "client", "aggregate"].includes(value.source)
    || typeof value.usagePresent !== "boolean"
    || (value.read !== undefined && !number(value.read))
    || (value.creation !== undefined && !number(value.creation))
    || (["complete", "readComplete", "creationComplete"] as const).some(field => value[field] !== undefined
      && (value.source !== "aggregate" || typeof value[field] !== "boolean"))
    || (!value.usagePresent && (value.read !== undefined || value.creation !== undefined))) return undefined;
  return {
    source: value.source as CacheTelemetry["source"], usagePresent: value.usagePresent,
    ...(number(value.read) ? { read: value.read } : {}),
    ...(number(value.creation) ? { creation: value.creation } : {}),
    ...(typeof value.complete === "boolean" ? { complete: value.complete } : {}),
    ...(typeof value.readComplete === "boolean" ? { readComplete: value.readComplete } : {}),
    ...(typeof value.creationComplete === "boolean" ? { creationComplete: value.creationComplete } : {}),
  };
}

export function cacheProvenance(usage: OcxUsage | undefined): CacheProvenance {
  if (!usage) return "unknown";
  const evidence = normalizeCacheTelemetry(usage.cacheTelemetry);
  if (evidence) {
    if (!evidence.usagePresent || evidence.source === "client"
      || (evidence.source === "aggregate" && evidence.complete !== true)) return "unknown";
    if (number(evidence.read) || number(evidence.creation)) return "observed";
    return [usage.cachedInputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens].some(number)
      ? "synthesized" : "unknown";
  }
  if (usage.cacheTelemetry !== undefined) return "unknown";
  // Old zeros (or wire-parsed zeros without evidence) cannot be backfilled. Positive counts
  // remain usable; unlike zero they cannot have been produced by zero-default normalization.
  return [usage.cachedInputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens]
    .some(value => number(value) && value > 0) ? "observed" : "unknown";
}

/** A historic label cannot recover whether an old zero was defaulted or measured. */
export function cacheProvenanceForRecord(usage: OcxUsage | undefined, stored?: CacheProvenance): CacheProvenance {
  const derived = cacheProvenance(usage);
  if (usage?.cacheTelemetry || derived === "unknown") return derived;
  return stored ?? derived;
}

/** Identity, not numeric similarity, prevents a new unresolved attempt borrowing old usage. */
export function finalAttemptUsage(usage: OcxUsage | undefined, active?: { usage?: OcxUsage }, attempts?: readonly { usage?: OcxUsage }[]): OcxUsage | undefined {
  if (!active) return usage;
  if (active.usage) return active.usage;
  const belongsElsewhere = usage && attempts?.some(attempt => attempt !== active && (attempt.usage === usage
    || (usage.cacheTelemetry !== undefined && attempt.usage?.cacheTelemetry === usage.cacheTelemetry)));
  return belongsElsewhere ? undefined : usage;
}

export function aggregateCacheTelemetry(usages: readonly (OcxUsage | undefined)[]): CacheTelemetry {
  const evidence = usages.map(usage => {
    const saved = normalizeCacheTelemetry(usage?.cacheTelemetry);
    if (saved || !usage || usage.cacheTelemetry !== undefined) return saved;
    // Legacy positive counters remain usable; legacy zero alone is not an observation.
    if (cacheProvenance(usage) !== "observed") return undefined;
    const read = usage.cacheReadInputTokens ?? usage.cachedInputTokens;
    const creation = usage.cacheCreationInputTokens;
    return { source: "adapter" as const, usagePresent: true,
      ...(number(read) && read > 0 ? { read } : {}),
      ...(number(creation) && creation > 0 ? { creation } : {}) };
  });
  const complete = usages.length > 0 && usages.every(usage => cacheProvenance(usage) === "observed");
  const sum = (field: "read" | "creation") => {
    const values = evidence.flatMap(item => item?.source !== "client" && number(item?.[field]) ? [item![field]!] : []);
    const total = values.reduce((sum, value) => sum + value, 0);
    return values.length && number(total) ? total : undefined;
  };
  const fieldComplete = (field: "read" | "creation") => complete && evidence.every(item =>
    number(item?.[field]) && item?.[field === "read" ? "readComplete" : "creationComplete"] !== false);
  const read = sum("read");
  const creation = sum("creation");
  return { source: "aggregate", usagePresent: usages.some(usage => usage !== undefined
      && normalizeCacheTelemetry(usage.cacheTelemetry)?.usagePresent !== false), complete,
    readComplete: fieldComplete("read") && read !== undefined,
    creationComplete: fieldComplete("creation") && creation !== undefined,
    ...(read !== undefined ? { read } : {}), ...(creation !== undefined ? { creation } : {}) };
}

export function usageFromResponsesPayload(usage: unknown, source: UsageObservationSource = "client"): OcxUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown; cache_write_1h_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
    total_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  if (typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number") {
    return {
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      cacheTelemetry: source === "upstream" ? rawCacheTelemetry(raw) : { source: "client", usagePresent: true },
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.input_tokens_details?.cached_tokens === "number"
        ? {
            cachedInputTokens: raw.input_tokens_details.cached_tokens,
            cacheReadInputTokens: raw.input_tokens_details.cached_tokens,
          }
        : {}),
      ...(typeof raw.input_tokens_details?.cache_write_tokens === "number"
        ? { cacheCreationInputTokens: raw.input_tokens_details.cache_write_tokens }
        : {}),
      ...(typeof raw.input_tokens_details?.cache_write_1h_tokens === "number"
        ? { cacheCreation1hInputTokens: raw.input_tokens_details.cache_write_1h_tokens } : {}),
      ...(typeof raw.output_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.output_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  if (typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number") {
    return {
      inputTokens: raw.prompt_tokens,
      outputTokens: raw.completion_tokens,
      cacheTelemetry: source === "upstream" ? rawCacheTelemetry(raw) : { source: "client", usagePresent: true },
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.prompt_tokens_details?.cached_tokens === "number"
        ? {
            cachedInputTokens: raw.prompt_tokens_details.cached_tokens,
            cacheReadInputTokens: raw.prompt_tokens_details.cached_tokens,
          }
        : {}),
      ...(typeof raw.prompt_tokens_details?.cache_write_tokens === "number"
        ? { cacheCreationInputTokens: raw.prompt_tokens_details.cache_write_tokens }
        : {}),
      ...(typeof raw.completion_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.completion_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  return undefined;
}
