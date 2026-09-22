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
  "opencode-go": new Set([
    "minimax-m2.5",
    "minimax-m2.7",
    "minimax-m3",
    // OpenCode's catalog identifies Union Alpha as @ai-sdk/anthropic while the
    // provider defaults to OpenAI-compatible; direct Chat returns 500 and direct
    // Messages reaches the session check (#4847).
    "union-alpha",
  ]),
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

interface WirePinPrefixRule {
  /** The registry endpoint the rule describes; another destination under the same name is not covered. */
  readonly endpoint: string;
  readonly prefixes: Readonly<Record<string, string>>;
}

/**
 * Provider-local model-id prefixes whose upstream accepts only one wire, bound to the endpoint that
 * behaves that way. Command Code's Provider API serves `claude-*` ids only on `/provider/v1/messages`
 * (live `supported_endpoints` on 2026-09-23 list `/messages` alone; `/chat/completions` answers 400
 * "must be called via /provider/v1/messages"). A prefix covers Claude ids Command Code adds later.
 */
const WIRE_ADAPTER_PIN_PREFIXES: Readonly<Record<string, WirePinPrefixRule>> = Object.freeze({
  commandcode: Object.freeze({
    endpoint: "https://api.commandcode.ai/provider/v1",
    prefixes: Object.freeze({ "claude-": "anthropic" }),
  }),
});

/** Just enough of a provider config to tell whether it still points at the pinned endpoint. */
export interface WirePinProvider {
  readonly baseUrl?: unknown;
}

function normalizedEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function prefixPinsFor(providerName: string, provider: WirePinProvider | undefined): Readonly<Record<string, string>> | undefined {
  if (!provider || !Object.hasOwn(WIRE_ADAPTER_PIN_PREFIXES, providerName)) return undefined;
  const rule = WIRE_ADAPTER_PIN_PREFIXES[providerName]!;
  return normalizedEndpoint(provider.baseUrl) === rule.endpoint ? rule.prefixes : undefined;
}

/**
 * Detached provider-local prefix pins for pure wire-policy resolution. Empty unless the provider
 * still points at the endpoint the rule describes.
 */
export function captureWireAdapterHardPinPrefixes(
  providerName: string,
  provider: WirePinProvider | undefined,
): Readonly<Record<string, string>> {
  return Object.freeze({ ...(prefixPinsFor(providerName, provider) ?? {}) });
}

function prefixedWireAdapter(providerName: string, modelId: string, provider: WirePinProvider | undefined): string | undefined {
  const prefixes = prefixPinsFor(providerName, provider);
  if (!prefixes) return undefined;
  const folded = modelId.toLowerCase();
  for (const [prefix, adapter] of Object.entries(prefixes)) {
    if (folded.startsWith(prefix)) return adapter;
  }
  return undefined;
}

/**
 * True when the upstream speaks exactly one wire for this model, so a configured
 * override must not apply.
 *
 * Deliberately independent of the provider's current adapter: the wire resolver runs
 * more than once per request, and a check phrased as "pin differs from the current
 * adapter" would pass on the first pass and then let the override win on the second.
 */
export function isWirePinnedModel(providerName: string, modelId: string, provider?: WirePinProvider): boolean {
  return (anthropicWireModelsForProvider(providerName)?.has(modelId) ?? false)
    || prefixedWireAdapter(providerName, modelId, provider) !== undefined;
}

/** The wire a pinned model must use, or undefined when the model is not pinned. */
export function pinnedWireAdapter(providerName: string, modelId: string, provider?: WirePinProvider): string | undefined {
  return anthropicWireModelsForProvider(providerName)?.has(modelId)
    ? "anthropic"
    : prefixedWireAdapter(providerName, modelId, provider);
}
