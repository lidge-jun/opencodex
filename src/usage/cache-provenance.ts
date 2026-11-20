import type { OcxUsage } from "../types";

/**
 * Where a row's cache-token detail came from.
 *
 * Strict-client normalization emits zero-default token-detail objects on every bridged wire
 * (`responsesUsage` in src/bridge.ts), so a `cached_tokens: 0` read back off that wire is a
 * wire-compatibility artifact and not a measured cache miss. The three values stay distinct all
 * the way to the summary because folding `synthesized` or `unknown` into `observed` is what
 * lets a pool that discarded every warm prefix still report a plausible cache hit rate (#4546).
 */
export type CacheTelemetryProvenance = "observed" | "synthesized" | "unknown";

/**
 * Classify one usage record's cache detail.
 *
 * `wireParsed` means the counts were read back off a response wire rather than reported raw by
 * the adapter. An all-zero cache detail from that source cannot be told apart from the zero
 * defaults the normalizer writes, so it is `synthesized`; the same shape reported raw is a real
 * zero and stays `observed`. A record with no cache fields at all is `unknown`, which is not a
 * zero either.
 */
export function classifyCacheTelemetryProvenance(
  usage: OcxUsage | undefined,
  options: { wireParsed?: boolean } = {},
): CacheTelemetryProvenance {
  if (!usage) return "unknown";
  const present = [usage.cachedInputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (present.length === 0) return "unknown";
  if (present.some(value => value > 0)) return "observed";
  return options.wireParsed === true ? "synthesized" : "observed";
}

export function cacheTokensFromUsage(usage?: OcxUsage): {
  read: number | undefined;
  creation: number | undefined;
  hasCacheTelemetry: boolean;
} {
  if (!usage) return { read: undefined, creation: undefined, hasCacheTelemetry: false };
  const creation = usage.cacheCreationInputTokens;
  const read = typeof usage.cacheReadInputTokens === "number"
    ? usage.cacheReadInputTokens
    : typeof usage.cachedInputTokens === "number" && typeof creation === "number"
      ? Math.max(0, usage.cachedInputTokens - creation)
      : usage.cachedInputTokens;
  const hasCacheTelemetry = typeof usage.cachedInputTokens === "number"
    || typeof usage.cacheReadInputTokens === "number"
    || typeof usage.cacheCreationInputTokens === "number";
  return { read, creation, hasCacheTelemetry };
}

/**
 * Cache tokens plus the provenance that says whether they may be averaged.
 *
 * A persisted `cacheProvenance` wins; a row written before the field existed is reconstructed
 * from its own shape, which reproduces the previous reading exactly (telemetry present is
 * observed, absent is unknown) so historical rows do not change meaning. Only `observed` reaches
 * a hit-rate denominator: a synthesized zero was emitted for wire compatibility and an unknown
 * was never measured, and averaging either as a zero is how a cold pool reports a warm cache.
 */
export function cacheObservationFromUsage(
  usage: OcxUsage | undefined,
  provenance: CacheTelemetryProvenance | undefined,
): { read: number | undefined; creation: number | undefined; provenance: CacheTelemetryProvenance } {
  const { read, creation, hasCacheTelemetry } = cacheTokensFromUsage(usage);
  // A row cannot have observed what it does not carry, so a stored label never opens the
  // denominator for a record with no cache fields in it.
  if (!usage || !hasCacheTelemetry) return { read, creation, provenance: "unknown" };
  return { read, creation, provenance: provenance ?? classifyCacheTelemetryProvenance(usage) };
}
