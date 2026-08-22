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
import {
  modelAcceptsImageInput,
  visionEligibleModelOptions,
  type VisionCandidateModel,
  type VisionModelOption,
  type VisionSidecarBackend,
} from "../../vision/eligibility";
import { listOpenAiForwardSidecarCandidates } from "../../providers/openai-sidecar";
import { pickerVisibleSidecarCandidates } from "../../sidecar/candidates";
import { resolveSidecarAuth } from "../../sidecar/auth";

/**
 * Backends whose executor could actually run: openai forward, anthropic OAuth.
 *
 * `anthropicSidecar` is REQUIRED rather than defaulted. `findAnthropicVisionProvider`
 * reads the OAuth account store from disk, and a default argument made every helper
 * in this chain re-resolve it whenever a caller passed an explicit `undefined` —
 * which is exactly the no-executor case. Passing it in keeps one read per request.
 */
export function enabledVisionBackends(
  config: OcxConfig,
  anthropicSidecar: AnthropicVisionProvider | undefined,
): VisionSidecarBackend[] {
  const backends: VisionSidecarBackend[] = [];
  // The OpenAI describer needs a CANONICAL ChatGPT forward provider, not merely a
  // provider keyed "openai" — same predicate the runtime sidecar resolver uses.
  if (listOpenAiForwardSidecarCandidates(config).length > 0) backends.push("openai");
  if (anthropicSidecar) backends.push("anthropic");
  // Neither side resolvable (fresh install, no login): fall back to both so the
  // picker is populated rather than empty, matching the permissive-unknown rule.
  return backends.length > 0 ? backends : ["openai", "anthropic"];
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
 * Anthropic table and absence reads as "unknown". Both families are therefore
 * consulted and any positive text-only verdict wins. That is safe precisely
 * because the two vendor tables share no bare model id, so they can never
 * disagree about one.
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

  const hinted: VisionSidecarBackend = backendHint === "anthropic" ? "anthropic" : "openai";
  const probed: VisionSidecarBackend[] = hinted === "anthropic"
    ? ["anthropic", "openai"]
    : ["openai", "anthropic"];
  return probed.some(provider => modelAcceptsImageInput(config, { provider, id: requested }) === false);
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
