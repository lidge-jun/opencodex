/**
 * Shadow-call intercept source models.
 *
 * Codex's hard-coded helper model is not stable across client versions: it was
 * `gpt-5.4-mini` up to 0.144.x and became `gpt-5.6-luna` in 0.145.0. The
 * intercept therefore matches a prefix SET, and every surface that names the
 * intercepted model (management API, GUI badges/tooltips, CLI) reads it from
 * here instead of hard-coding a slug that goes stale on the next client bump.
 */
export const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-5.4-mini", "gpt-5.6-luna"] as const;

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
 * Decide whether a matching source model should use the opt-in intercept.
 *
 * Codex 0.145.0+ identifies normal user turns and maintenance requests in
 * x-codex-turn-metadata. Only an explicit normal turn bypasses interception;
 * missing or unrecognized metadata retains the legacy opt-in prefix behavior.
 */
export function shouldInterceptShadowCall(
  modelId: string,
  configured: unknown,
  headers: Headers,
): boolean {
  if (!isShadowSourceModel(modelId, configured)) return false;
  const rawMetadata = headers.get("x-codex-turn-metadata");
  if (rawMetadata === null) return true;

  try {
    const parsed = JSON.parse(rawMetadata) as { request_kind?: unknown };
    return parsed?.request_kind !== "turn";
  } catch {
    return true;
  }
}
