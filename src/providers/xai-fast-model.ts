import type { FastWire, OcxParsedRequest, OcxProviderConfig, TierDecision } from "../types";

/**
 * Grok OAuth Fast is a serving lane, not a tier.
 *
 * The Grok OAuth gateway lists `grok-4.7` and `grok-4.7-build-fast` as two models, but they are one model
 * on two lanes (same effort ladder, image input, 500k limit and advertised defaults). Measured live on
 * 2026-09-30: build-fast is 1.5-1.7x faster end to end, while `service_tier: "priority"` on grok-4.7 bought
 * no measurable speed and cost ~5.9x the ticks per output token (build-fast costs ~2x).
 * Evidence: devlog/_fin/260930_grok47_build_unify/010_probe-evidence.md.
 *
 * So on the OAuth lane only, a Fast grok-4.7 request is SERIALIZED as the build-fast id and sends no tier.
 * The logical id stays grok-4.7 everywhere else (parsed.modelId, route, policy, usage attempt), so effort,
 * sampling strips and operator overrides keep resolving against grok-4.7. Key auth never reaches this
 * (build-fast is not on the public API) and keeps priority processing.
 */
export const XAI_OAUTH_FAST_MODELS: Readonly<Record<string, string>> = Object.freeze({
  "grok-4.7": "grok-4.7-build-fast",
});

/** Serving-lane ids that must not be published as rows of their own. */
export const XAI_OAUTH_FAST_VARIANT_IDS: ReadonlySet<string> = new Set(Object.values(XAI_OAUTH_FAST_MODELS));

export function xaiOauthFastModel(
  providerName: string,
  provider: Pick<OcxProviderConfig, "authMode">,
  modelId: string,
): string | undefined {
  // Same predicate the transport uses to select the Grok CLI gateway (xai-transport.ts).
  if (providerName !== "xai" || provider.authMode !== "oauth") return undefined;
  return Object.hasOwn(XAI_OAUTH_FAST_MODELS, modelId) ? XAI_OAUTH_FAST_MODELS[modelId] : undefined;
}

function modelVariantFastWire(variant: string): FastWire {
  return { kind: "model-variant", canonicalToWire: { priority: variant }, foreignCallerTiers: "drop" };
}

/** Shared by admission preview and final serialization; explicit operator wires stay authoritative. */
export function xaiOauthFastModelForDecision(
  route: { providerName: string; provider: Pick<OcxProviderConfig, "authMode" | "fastWire">; modelId: string },
  decision: TierDecision | undefined,
): string | undefined {
  return decision?.kind === "set" && route.provider.fastWire === undefined
    ? xaiOauthFastModel(route.providerName, route.provider, route.modelId)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Settle the serialized model for the final route. Runs after decideTier on every (re)normalization, so it
 * also undoes an override a previous route in the same request installed: core-normalize only rewrites
 * `raw.model` when the route id differs from parsed.modelId, and a same-id fallback (xai/grok-4.7 on key
 * auth) would otherwise inherit the variant.
 *
 * The caller's Fast intent (options.serviceTier, raw.service_tier) is left in place for such re-runs; the
 * `drop` decision is what keeps the tier off this wire (canonical-forward.ts, openai-chat.ts).
 */
export function applyXaiOauthFastModel(
  parsed: OcxParsedRequest,
  route: { providerName: string; provider: Pick<OcxProviderConfig, "authMode" | "fastWire">; modelId: string },
  logCtx?: { wireModel?: string },
): void {
  const raw = isRecord(parsed._rawBody) ? parsed._rawBody : undefined;
  const previous = parsed._wireModelOverride;
  // The lane switch replaces the registry's service-tier Fast only. The xai registry entry declares no
  // FastWire, so a provider-level `fastWire` is always the operator's own (service-tier.ts reads it
  // first): that decision carries a wire value they verified, and it is sent unchanged.
  const variant = xaiOauthFastModelForDecision(route, parsed.options.tierDecision);
  if (!variant) {
    if (previous === undefined) return;
    delete parsed._wireModelOverride;
    if (raw && raw.model === previous) raw.model = route.modelId;
    if (logCtx?.wireModel === previous) delete logCtx.wireModel;
    return;
  }
  const observation = parsed.options.tierObservation;
  if (observation) {
    // The lane switch is the Fast wire. A service_tier echo says nothing about it, so it can neither
    // confirm nor deny Fast here (and never unlocks priority pricing, which needs confirmation).
    parsed.options.tierObservation = {
      ...observation,
      fastWire: modelVariantFastWire(variant),
      responseTierAuthoritative: false,
    };
  }
  parsed.options.tierDecision = { kind: "drop" };
  parsed._wireModelOverride = variant;
  if (raw) raw.model = variant;
  if (logCtx) logCtx.wireModel = variant;
}
