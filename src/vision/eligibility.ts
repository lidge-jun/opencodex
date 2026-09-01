/**
 * Which models may serve AS the vision sidecar (the describer), as opposed to the
 * models the sidecar describes FOR.
 *
 * Three rules make this non-obvious, and all are load-bearing:
 *
 * 1. `provider.noVisionModels` marks models the proxy describes images for, and
 *    `applyProviderConfigHints` deliberately ADDS "image" to their advertised
 *    input modalities so the Codex app does not block the attachment client-side.
 *    A blind model therefore advertises image input. Membership in that list is a
 *    hard disqualifier here, checked BEFORE the modality list it rewrote.
 * 2. The catalog enriches configured providers from the registry before it
 *    applies that rule. Eligibility must use the same effective provider policy,
 *    including a `noVisionModels` list learned after the config was persisted.
 * 3. Catalog rows frequently omit `inputModalities` entirely (the live
 *    `/api/models` response carries none for either openai or anthropic rows).
 *    Unknown is not zero: when no source can speak, the model stays eligible
 *    rather than silently vanishing from the picker.
 *    Native OpenAI metadata is likewise authoritative only for a native row or
 *    the canonical OpenAI provider; a routed row with the same id owns its own
 *    explicit modalities.
 */
import { modelInList, type OcxConfig, type OcxProviderConfig } from "../types";
import { modelRecordValue } from "../reasoning-effort";
import { getModelMetadataCaseInsensitive, resolveMetadataProvider } from "../generated/model-metadata";
import { nativeInputModalities } from "../codex/catalog/metadata";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";
import { enrichProviderFromRegistry } from "../providers/derive";

/**
 * The wire protocols `planVisionSidecar` can dispatch to (#2188 roadmap 170
 * REVISED). "routed" describes through the proxy's OWN router via loopback —
 * one executor for every non-forward, non-OAuth-Anthropic provider row.
 */
export type VisionSidecarBackend = "openai" | "anthropic" | "routed";

/** The two sides every deployment has; also the empty-auth fallback set. */
export type UniversalVisionBackend = "openai" | "anthropic";

/**
 * Default entry per backend: cheap, image-capable, and present in every deployment. Offered
 * whenever its side is enabled, and withheld only when that provider explicitly lists it as a
 * model the sidecar describes FOR — never merely because a metadata table stayed silent.
 *
 * Keyed by the UNIVERSAL subset on purpose (roadmap 170, audit blocker A):
 * xai/gemini are auth-gated sides whose catalogs are present whenever the side
 * is, so they carry no baseline, and a narrow-key total record documents that
 * without sprinkling non-null assertions at the consumers.
 */
export const BASELINE_VISION_MODELS: Record<UniversalVisionBackend, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
};

export interface VisionCandidateModel {
  provider: string;
  id: string;
  inputModalities?: string[];
  native?: boolean;
}

export interface VisionModelOption {
  value: string;
  label: string;
  backend: VisionSidecarBackend;
  /** True when the row is a guaranteed baseline rather than a catalog discovery. */
  baseline?: boolean;
}

type EnrichedProviderCache = Map<string, OcxProviderConfig>;

/**
 * Whether the proxy must describe images for this model before dispatching its main request.
 *
 * `noVisionModels` is an explicit override. A modality declaration is only evidence for this
 * path when it describes a text model that excludes image input: an audio-only declaration is
 * not a text-only model and must not be widened to image through the vision sidecar.
 */
export function isModelVisionSidecarConsumer(
  provider: Pick<OcxProviderConfig, "noVisionModels" | "modelInputModalities">,
  modelId: string,
): boolean {
  if (modelInList(provider.noVisionModels, modelId)) return true;
  const modalities = modelRecordValue(provider.modelInputModalities, modelId);
  return Array.isArray(modalities) && modalities.includes("text") && !modalities.includes("image");
}

function advertisesImageInput(modalities: readonly string[] | undefined): boolean | undefined {
  if (!modalities || modalities.length === 0) return undefined;
  return modalities.includes("image");
}

/** Vendor-table modalities for a routed row, or undefined when the table has no opinion. */
function metadataImageInput(provider: string, modelId: string): boolean | undefined {
  const resolved = resolveMetadataProvider(provider) ?? provider;
  const meta = getModelMetadataCaseInsensitive(resolved, modelId);
  return advertisesImageInput(meta?.input);
}

/**
 * Mirrors the catalog's registry enrichment without mutating saved configuration. The picker
 * checks many rows from one provider, so its caller shares this small call-local cache.
 */
function enrichedProviderForVision(
  config: Pick<OcxConfig, "providers">,
  providerName: string,
  cache: EnrichedProviderCache,
): OcxProviderConfig | undefined {
  const cached = cache.get(providerName);
  if (cached) return cached;
  const configured = config.providers?.[providerName];
  if (!configured) return undefined;
  const enriched = structuredClone(configured);
  enrichProviderFromRegistry(providerName, enriched);
  cache.set(providerName, enriched);
  return enriched;
}

function isVisionSidecarConsumerWithCache(
  config: Pick<OcxConfig, "providers">,
  providerName: string,
  modelId: string,
  cache: EnrichedProviderCache,
): boolean {
  const provider = enrichedProviderForVision(config, providerName, cache);
  return provider !== undefined && isModelVisionSidecarConsumer(provider, modelId);
}

/**
 * Is this model listed as one the sidecar describes FOR? Such a model cannot be
 * the describer, and its advertised modalities are untrustworthy.
 */
export function isVisionSidecarConsumer(config: Pick<OcxConfig, "providers">, providerName: string, modelId: string): boolean {
  return isVisionSidecarConsumerWithCache(config, providerName, modelId, new Map());
}

/**
 * Can this model accept an image on the wire? Sources are consulted in descending
 * trustworthiness; the first that speaks wins. `undefined` means nothing knows,
 * which callers treat as eligible.
 */
export function modelAcceptsImageInput(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
): boolean | undefined {
  return modelAcceptsImageInputWithCache(config, candidate, new Map());
}

function modelAcceptsImageInputWithCache(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
  cache: EnrichedProviderCache,
): boolean | undefined {
  if (isVisionSidecarConsumerWithCache(config, candidate.provider, candidate.id, cache)) return false;
  if (candidate.native === true || (candidate.provider === "openai" && SUPPORTED_NATIVE_OPENAI_SLUGS.has(candidate.id))) {
    return advertisesImageInput(nativeInputModalities(candidate.id)) ?? true;
  }
  const fromRow = advertisesImageInput(candidate.inputModalities);
  if (fromRow !== undefined) return fromRow;
  return metadataImageInput(candidate.provider, candidate.id);
}

/** Eligible = not a sidecar consumer, and not positively known to be text-only. */
export function isVisionEligibleModel(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
): boolean {
  return isVisionEligibleModelWithCache(config, candidate, new Map());
}

function isVisionEligibleModelWithCache(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
  cache: EnrichedProviderCache,
): boolean {
  return modelAcceptsImageInputWithCache(config, candidate, cache) !== false;
}

/** Which executor can describe through this row. */
export function visionBackendForCandidate(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
  anthropicProviderName?: string,
): VisionSidecarBackend | undefined {
  if (candidate.native || candidate.provider === "openai") return "openai";
  // The runtime dispatches through exactly ONE Anthropic provider — the enabled OAuth row
  // with a healthy active account that `findAnthropicVisionProvider` picks. Speaking the
  // Messages wire is not enough: a key-auth row of the same adapter is unreachable, and an
  // option that cannot be dispatched is worse than a missing one, because selecting it fails
  // at describe time rather than at pick time.
  if (anthropicProviderName !== undefined && candidate.provider === anthropicProviderName) {
    return "anthropic";
  }
  // EVERY other provider row describes through the proxy's own router
  // (roadmap 170 revised): the loopback executor covers all provider wires,
  // so no row is left without an executor.
  return "routed";
}

function baselineCandidate(
  backend: UniversalVisionBackend,
  anthropicProviderName: string | undefined,
): VisionCandidateModel {
  return {
    provider: backend === "openai" ? "openai" : anthropicProviderName ?? "anthropic",
    id: BASELINE_VISION_MODELS[backend],
    // Both baselines are known image-capable. This makes their only exclusion path the
    // provider's explicit consumer list, never a silent or stale metadata table.
    inputModalities: ["text", "image"],
  };
}

/**
 * The picker's option list: every eligible row reachable by an enabled
 * executor, plus each enabled universal side's baseline unless that baseline
 * is explicitly excluded, de-duplicated and stably ordered (side rank order,
 * baselines first within a side). Anthropic rows must belong to the OAuth
 * provider that would actually execute them, so `anthropicProviderName` is
 * what makes that side's catalog rows eligible at all; xai/gemini rows map by
 * provider identity and appear only when the caller enabled those backends.
 *
 * This is the SUGGESTION list (narrow): it emits only rows an executor can reach
 * and some source has heard of. It is deliberately NOT the same set as the write
 * gate. `modelAcceptsImageInput` answers "can we prove this model cannot see?"
 * and is the only input to rejection. Absence from this list must never imply
 * rejection — an unknown id stays eligible via the undefined → eligible fallback.
 *
 * De-duplication is by BARE model id, first eligible row wins. Two providers of
 * the same adapter family can expose the same id; they resolve to the same
 * backend, and only `value` reaches the client, so first-wins costs nothing.
 */
export function visionEligibleModelOptions(
  config: Pick<OcxConfig, "providers">,
  candidates: readonly VisionCandidateModel[],
  enabledBackends: readonly VisionSidecarBackend[],
  anthropicProviderName?: string,
): VisionModelOption[] {
  const enabled = new Set(enabledBackends);
  const byValue = new Map<string, VisionModelOption>();
  const enrichedProviders: EnrichedProviderCache = new Map();

  for (const backend of Object.keys(BASELINE_VISION_MODELS) as UniversalVisionBackend[]) {
    if (!enabled.has(backend)) continue;
    const candidate = baselineCandidate(backend, anthropicProviderName);
    if (!isVisionEligibleModelWithCache(config, candidate, enrichedProviders)) continue;
    const id = candidate.id;
    byValue.set(id, { value: id, label: id, backend, baseline: true });
  }
  for (const candidate of candidates) {
    const backend = visionBackendForCandidate(config, candidate, anthropicProviderName);
    if (!backend || !enabled.has(backend)) continue;
    if (!isVisionEligibleModelWithCache(config, candidate, enrichedProviders)) continue;
    // Routed rows carry NAMESPACED values ("provider/model") so the loopback
    // dispatch is unambiguous under routeModel; the legacy sides keep bare ids
    // (GUI current-value compatibility, and the forward/OAuth executors POST
    // the string verbatim). De-dup stays keyed by the emitted value.
    const value = backend === "routed" ? `${candidate.provider}/${candidate.id}` : candidate.id;
    if (byValue.has(value)) continue;
    byValue.set(value, { value, label: value, backend });
  }

  // Two slots per side (baseline first), ranked openai < anthropic < routed
  // so widening the union appends rather than interleaves (roadmap 170).
  const sideRank: Record<VisionSidecarBackend, number> = { openai: 0, anthropic: 2, routed: 4 };
  const order = (option: VisionModelOption) =>
    sideRank[option.backend] + (option.baseline ? 0 : 1);
  return [...byValue.values()].sort((a, b) => order(a) - order(b) || a.value.localeCompare(b.value));
}
