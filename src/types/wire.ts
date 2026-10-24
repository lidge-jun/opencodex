import { isOpenCodeGoGeminiDestination, OPENCODE_GO_BASE_URL, OPENCODE_GO_MODEL_WIRES, OPENCODE_GO_LEGACY_NAME_PINS, type OpenCodeGoDestination } from "./opencode-go";
import { openCodeZenBaseUrl, openCodeZenKeyBaseUrl, type OpenCodeZenDestination } from "./opencode-zen";

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

/** Native Go wire pins share the exact-model table with registry Responses defaults. */
export function captureWireAdapterHardPins(providerName: string, provider?: WirePinProvider): Readonly<Record<string, string>> {
  if (providerName !== "opencode-go") return Object.freeze({});
  // The existing Go preset pins saved URLs to this endpoint before dispatch. Pure policy
  // captures must use that same destination even when handed an unnormalized config row.
  const destination = provider && { ...provider, baseUrl: OPENCODE_GO_BASE_URL };
  return Object.freeze(Object.fromEntries(Object.entries(OPENCODE_GO_MODEL_WIRES).filter(([modelId, wire]) =>
    (wire === "anthropic" && OPENCODE_GO_LEGACY_NAME_PINS.has(modelId))
    || (wire !== "openai-responses" && isOpenCodeGoGeminiDestination(destination)),
  )));
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
  // TokenLab declares Claude ids as Chat + Anthropic Messages, never Responses
  // (`tokenlab.accepted_request_formats` on GET /v1/models/{id}, all 11 live claude-* ids on
  // 2026-09-30). Messages is their native wire; POST /v1/messages accepts x-api-key.
  tokenlab: Object.freeze({
    endpoint: "https://api.tokenlab.sh/v1",
    prefixes: Object.freeze({ "claude-": "anthropic" }),
  }),
});

/** Just enough of a provider config to tell whether it still points at the pinned endpoint. */
export interface WirePinProvider extends OpenCodeGoDestination, OpenCodeZenDestination {}

function normalizedEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Providers whose adapter is their credential boundary: the adapter alone pins the destination and
 * the auth header for an account token. No model may switch wires, whatever `baseUrl` or the row's
 * own `adapter` says, because a generic wire would send that token as a Bearer key to the configured
 * URL. The empty prefix covers every model id.
 */
const CREDENTIAL_PINNED_ADAPTERS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "workbuddy-ai": Object.freeze({ "": "workbuddy-ai" }),
  "dsh-account": Object.freeze({ "": "dsh-account" }),
});

function prefixPinsFor(providerName: string, provider: WirePinProvider | undefined): Readonly<Record<string, string>> | undefined {
  if (Object.hasOwn(CREDENTIAL_PINNED_ADAPTERS, providerName)) return CREDENTIAL_PINNED_ADAPTERS[providerName];
  if (providerName === "opencode-zen" && openCodeZenKeyBaseUrl(provider)) {
    return openCodeZenBaseUrl(provider) ? { "gemini-": "google", "claude-": "anthropic" } : { "claude-": "anthropic" };
  }
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
  return pinnedWireAdapter(providerName, modelId, provider) !== undefined;
}

/** The wire a pinned model must use, or undefined when the model is not pinned. */
export function pinnedWireAdapter(providerName: string, modelId: string, provider?: WirePinProvider): string | undefined {
  const pins = captureWireAdapterHardPins(providerName, provider);
  return Object.hasOwn(pins, modelId) ? pins[modelId] : prefixedWireAdapter(providerName, modelId, provider);
}
