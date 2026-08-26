/**
 * The one place that decides which models the management API offers as vision
 * describers, and which it refuses to persist.
 *
 * Two routes write a vision sidecar model — `PUT /api/sidecar-settings` and the
 * `visionSidecar` override in `PUT /api/claude-code`. They share this module so
 * the policy cannot drift: a gate on one route and a stale copy on the other is
 * the same as no gate at all.
 */
import type { OcxConfig } from "../../types";
import { findAnthropicVisionProvider, type AnthropicVisionProvider } from "../../vision";
import { VISION_BACKENDS } from "../../vision/backends";
import {
  modelAcceptsImageInput,
  visionEligibleModelOptions,
  type VisionCandidateModel,
  type VisionModelOption,
  type VisionSidecarBackend,
} from "../../vision/eligibility";
import { pickerVisibleSidecarCandidates } from "../../sidecar/candidates";
import { resolveSidecarAuth } from "../../sidecar/auth";

/**
 * Backends whose executor could actually run (#2188 roadmap 170): openai
 * forward, anthropic OAuth, xai OAuth, Antigravity OAuth — resolved by the
 * VISION_BACKENDS descriptor table so this module and the options path cannot
 * drift on what "active" means.
 *
 * `anthropicSidecar` is REQUIRED rather than defaulted. `findAnthropicVisionProvider`
 * reads the OAuth account store from disk, and a default argument made every helper
 * in this chain re-resolve it whenever a caller passed an explicit `undefined` —
 * which is exactly the no-executor case. Passing it in keeps one read per request.
 * The descriptor table re-derives the anthropic flag from the shared auth
 * module; asserting the caller's resolution stays consistent with it is the
 * job of the shared module, not this file.
 */
export function enabledVisionBackends(
  config: OcxConfig,
  anthropicSidecar: AnthropicVisionProvider | undefined,
): VisionSidecarBackend[] {
  const auth = resolveSidecarAuth(config);
  // Preserve the caller's resolution for the anthropic side: the descriptor
  // reads the shared auth module, but a caller that already resolved "no
  // executor" must not see anthropic options it cannot dispatch. The filter
  // applies to the ACTIVE set only — the fresh-install fallback below stays
  // both universal sides, exactly the pre-widening behavior (test 6 pins it).
  const active = VISION_BACKENDS
    .filter(descriptor => descriptor.isActive(auth, config))
    .map(descriptor => descriptor.backend)
    .filter(backend => backend !== "anthropic" || anthropicSidecar !== undefined);
  // "routed" is active by construction, so the fresh-install fallback keys on
  // the UNIVERSAL sides: when neither resolves, both are offered so the picker
  // stays populated (permissive-unknown rule; test 6 pins it).
  if (!active.includes("openai") && !active.includes("anthropic")) {
    return ["openai", "anthropic", ...active];
  }
  return active;
}

/**
 * Visible catalog rows in the shape the eligibility predicate consumes.
 * Sourced from the unified picker set (#2188): picker-visible rows ∪ auth
 * slots, UNFILTERED. Rule 2 (− provably text-only) belongs to the OPTIONS
 * path only (visionEligibleModelOptions already applies it). The PUT gate
 * consumes this list as EVIDENCE: a picker row proving an id text-only is
 * exactly what visionDescriberIsProvablyBlind needs to reject that id, so
 * pre-filtering here would deaden the gate (review F1: reject → allow flip).
 */
export async function visionCandidateRows(config: OcxConfig): Promise<VisionCandidateModel[]> {
  const auth = resolveSidecarAuth(config);
  const all = await pickerVisibleSidecarCandidates(config, auth);
  return all.map(candidate => ({
    provider: candidate.provider,
    id: candidate.id,
    ...(candidate.inputModalities ? { inputModalities: candidate.inputModalities } : {}),
    ...(candidate.native ? { native: true } : {}),
  }));
}

export function visionModelOptionsFrom(
  config: OcxConfig,
  candidates: readonly VisionCandidateModel[],
  anthropicSidecar: AnthropicVisionProvider | undefined,
): VisionModelOption[] {
  return visionEligibleModelOptions(
    config,
    candidates,
    enabledVisionBackends(config, anthropicSidecar),
    anthropicSidecar?.providerName,
  );
}

/** Convenience for read paths that have no candidate list in hand yet. */
export async function visionModelOptionsFor(
  config: OcxConfig,
  anthropicSidecar: AnthropicVisionProvider | undefined,
): Promise<VisionModelOption[]> {
  return visionModelOptionsFrom(config, await visionCandidateRows(config), anthropicSidecar);
}

/**
 * Can we PROVE the requested describer is blind?
 *
 * Only a positive `false` rejects. An id no source knows stays allowed, because
 * the runtime never required catalog membership and an operator may be ahead of
 * our tables.
 *
 * When no catalog row matches, the caller's `backend` is only a HINT, never the
 * authority. Trusting it let a client launder a known-blind OpenAI model past the
 * gate by claiming `backend: "anthropic"`, since the id is absent from the
 * Anthropic table and absence reads as "unknown".
 *
 * A NAMESPACED id ("provider/model", the routed-backend option shape) names
 * its provider outright, so that provider's config row and metadata family
 * are probed directly. A BARE id probes ALL configured provider families and
 * any positive text-only verdict wins (roadmap 170: a bare `grok-4` is
 * provably text-only in the xai vendor table and must not slip through a
 * two-family probe). That is safe precisely because the vendor tables share
 * no bare model id (collision scan in roadmap 160: openai 48, anthropic 26,
 * xai 32, google 43, zero overlaps), so they can never disagree about one.
 */
export function visionDescriberIsProvablyBlind(
  config: OcxConfig,
  requested: string,
  candidates: readonly VisionCandidateModel[],
  backendHint: VisionSidecarBackend | undefined,
): boolean {
  // Catalog rows can carry operator-authored modalities. A positive claim from one
  // must not hide another row or canonical metadata that proves this id is blind.
  if (candidates.some(candidate => candidate.id === requested
    && modelAcceptsImageInput(config, candidate) === false)) return true;

  // Namespaced routed id: the provider is named, probe it directly (config
  // row enrichment + its metadata family both flow through the predicate).
  const sep = requested.indexOf("/");
  if (sep > 0) {
    const provider = requested.slice(0, sep);
    const id = requested.slice(sep + 1);
    if (modelAcceptsImageInput(config, { provider, id }) === false) return true;
    // A namespaced candidate row (value shape) may also carry the proof.
    return candidates.some(candidate => candidate.provider === provider && candidate.id === id
      && modelAcceptsImageInput(config, candidate) === false);
  }

  // Bare id: probe the base vendor families plus every configured provider —
  // a positive text-only verdict from any source wins.
  const families = new Set(["openai", "anthropic", "xai", "google-antigravity", ...Object.keys(config.providers ?? {})]);
  const ordered = backendHint === "anthropic"
    ? ["anthropic", ...[...families].filter(family => family !== "anthropic")]
    : ["openai", ...[...families].filter(family => family !== "openai")];
  return ordered.some(provider => modelAcceptsImageInput(config, { provider, id: requested }) === false);
}

/** The 400 body both routes return, so the two errors cannot diverge either. */
export function visionDescriberRejection(
  field: "vision.model" | "visionSidecar.model",
  requested: string,
  config: OcxConfig,
  candidates: readonly VisionCandidateModel[],
): { error: string; allowed: string[] } {
  return {
    error: `${field} "${requested}" cannot describe images: it has no image input support, or it is a model the vision sidecar describes FOR.`,
    // The rejection path is not hot, so it resolves the executor itself rather than
    // making every 400 caller thread one through.
    allowed: visionModelOptionsFrom(config, candidates, findAnthropicVisionProvider(config)).map(option => option.value),
  };
}
