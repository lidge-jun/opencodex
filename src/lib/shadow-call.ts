/**
 * Shadow-call intercept source models.
 *
 * Codex 0.145.0+ uses `gpt-5.6-luna` for helper calls. Older clients through
 * 0.144.x used `gpt-5.4-mini`; operators supporting them can restore that
 * prefix with the `sourceModels` override. Every surface that names the
 * intercepted model (management API, GUI badges/tooltips, CLI) reads it from
 * here instead of hard-coding a slug that goes stale on the next client bump.
 */
export const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-5.6-luna"] as const;

/** Normalize a persisted `sourceModels` override; falls back to the defaults. */
export function shadowSourceModels(configured?: unknown): string[] {
  const configuredStrings = Array.isArray(configured)
    ? configured
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map(v => v.trim())
    : [];
  return configuredStrings.length > 0 ? configuredStrings : [...DEFAULT_SHADOW_SOURCE_MODELS];
}

/**
 * True when `modelId` is one of Codex's helper/shadow source models.
 * Routed ids (`provider/model`) are hard-excluded: a shadow call is always a
 * bare native slug, and an explicit routed selection must never be hijacked.
 */
export function isShadowSourceModel(modelId: string, configured?: unknown): boolean {
  if (modelId.includes("/")) return false;
  return shadowSourceModels(configured).some(prefix => modelId.startsWith(prefix));
}

/**
 * The configured source prefix this model matched, or undefined.
 *
 * Callers that RECORD the intercepted model must record this rather than the caller's raw
 * `modelId`. Matching is by prefix, so `gpt-5.6-luna` plus arbitrary trailing text still
 * intercepts — and the raw string is caller-controlled, reaches `usage.jsonl` and `/api/logs`,
 * and only passes a pattern-based redactor on the way. A credential family that redactor does
 * not recognize survives verbatim. Returning the operator-configured prefix keeps the log
 * field inside a set the operator chose, so no caller string is ever persisted.
 */
export function shadowSourceModelPrefix(modelId: string, configured?: unknown): string | undefined {
  if (modelId.includes("/")) return undefined;
  return shadowSourceModels(configured).find(prefix => modelId.startsWith(prefix));
}

/**
 * Decide whether a matching source model should use the opt-in intercept.
 *
 * Before Codex 0.147.0 this checked x-codex-turn-metadata and exempted
 * request_kind "turn". Codex 0.147.0 can label background helper calls as
 * "turn", causing them to bypass the intercept (#1684). The fix is to
 * intercept every configured shadow source model unconditionally — the model
 * slug alone is a sufficient signal.
 */
export function shouldInterceptShadowCall(
  modelId: string,
  configured: unknown,
): boolean {
  return isShadowSourceModel(modelId, configured);
}
