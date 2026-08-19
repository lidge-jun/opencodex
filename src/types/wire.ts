/**
 * Accepted values for the per-provider upstream HTTP-version pin (#1668). Shared by the
 * zod load schema, the management write boundary (POST/PATCH), and the fetch runtime, so
 * a value that one boundary accepts can never be rejected by another.
 */
export const UPSTREAM_HTTP_VERSION_VALUES = [
  "auto",
  "http1.1",
  "h1",
  "http2",
  "h2",
] as const;

export type UpstreamHttpVersion = (typeof UPSTREAM_HTTP_VERSION_VALUES)[number];

export const REASONING_SUMMARY_DELIVERY_VALUES = [
  "sequential",
  "sequential_cutoff",
  "concurrent",
  "concurrent_cutoff",
] as const;

export type ReasoningSummaryDelivery = typeof REASONING_SUMMARY_DELIVERY_VALUES[number];

/** Trusted runtime ownership for Codex-account credentials. Never persisted per provider. */
export type CodexAccountMode = "direct" | "pool";

export const OPENAI_PROVIDER_TIER_VERSION = 2 as const;

/**
 * Wires that a per-model `modelAdapters` override may select.
 *
 * Deliberately narrow: provider-specific adapters (cursor, kiro, google, ...) carry
 * their own credential and base-URL semantics, so exposing them here would widen the
 * auth boundary rather than pick a wire. Widening this set needs a per-adapter
 * credential threat model first (#404).
 */
export const MODEL_ADAPTER_OVERRIDE_ALLOWED: ReadonlySet<string> = new Set([
  "openai-chat",
  "openai-responses",
]);

/**
 * Providers whose listed model ids must be driven over the Anthropic wire even when
 * the provider's configured adapter says otherwise — the upstream only speaks
 * Anthropic for these models.
 */
const ANTHROPIC_WIRE_MODELS: Record<string, ReadonlySet<string>> = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3"]),
};

function anthropicWireModelsForProvider(providerName: string): ReadonlySet<string> | undefined {
  return Object.hasOwn(ANTHROPIC_WIRE_MODELS, providerName)
    ? ANTHROPIC_WIRE_MODELS[providerName]
    : undefined;
}

/** Detached provider-local hard-pin table for pure wire-policy resolution. */
export function captureWireAdapterHardPins(providerName: string): Readonly<Record<string, string>> {
  const models = anthropicWireModelsForProvider(providerName);
  if (!models) return Object.freeze({});
  return Object.freeze(Object.fromEntries([...models].map(modelId => [modelId, "anthropic"])));
}

/**
 * True when the upstream speaks exactly one wire for this model, so a configured
 * override must not apply.
 *
 * Deliberately independent of the provider's current adapter: the wire resolver runs
 * more than once per request, and a check phrased as "pin differs from the current
 * adapter" would pass on the first pass and then let the override win on the second.
 */
export function isWirePinnedModel(providerName: string, modelId: string): boolean {
  return anthropicWireModelsForProvider(providerName)?.has(modelId) ?? false;
}

/** The wire a pinned model must use, or undefined when the model is not pinned. */
export function pinnedWireAdapter(providerName: string, modelId: string): string | undefined {
  return isWirePinnedModel(providerName, modelId) ? "anthropic" : undefined;
}
