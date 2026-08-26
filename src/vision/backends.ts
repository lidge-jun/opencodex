/**
 * Which backends may DESCRIBE images for the vision sidecar, and which
 * candidate rows each can describe through (#2188 vision rules; roadmap 170
 * REVISED: the "routed" backend).
 *
 * A SIBLING of WEB_SEARCH_BACKENDS, not a shared table: vision has no
 * per-model probe (rule 2 is "− provably text-only", enforced by
 * modelAcceptsImageInput, not here), carries per-side baseline models, and
 * excludes non-LLM backends like exa.
 *
 * Three backends, not one per provider: "openai" and "anthropic" carry auth
 * semantics loopback routing cannot replicate (forwarded ChatGPT headers,
 * OAuth beta fences) and their defaults must not drift. Every OTHER
 * picker-visible provider row reaches the describer through "routed" — a
 * loopback self-fetch of the proxy's own /v1/chat/completions, where the
 * router and adapters already speak each provider's wire. That is what makes
 * this table closed under provider growth: a new provider needs no new
 * describe executor.
 */
import type { OcxConfig } from "../types";
import type { SidecarAuthState } from "../sidecar/auth";
import { listOpenAiForwardSidecarCandidates } from "../providers/openai-sidecar";
import type { VisionCandidateModel, VisionSidecarBackend } from "./eligibility";

export interface VisionBackendDescriptor {
  backend: VisionSidecarBackend;
  /** Liveness signal for this backend. */
  isActive(auth: SidecarAuthState, config: OcxConfig): boolean;
  /** Which candidate rows this backend's describe executor can actually run. */
  candidateMatch(candidate: VisionCandidateModel, auth: SidecarAuthState): boolean;
  /**
   * Default entry for this side: cheap, image-capable, present in every
   * deployment. Only the two universal sides carry one — "routed" has no
   * universal model to name.
   */
  baseline?: string;
  /** Stable option ordering (baselines first within a side). */
  rank: number;
}

export const VISION_BACKENDS: readonly VisionBackendDescriptor[] = [
  {
    backend: "openai",
    // The OpenAI describer needs a CANONICAL ChatGPT forward provider, not
    // merely a provider keyed "openai" — same predicate the runtime sidecar
    // resolver uses. Deliberately NOT auth.isCodexAuth: tightening to a live
    // credential here would change which options a fresh install sees, and
    // the options list is a suggestion surface, not the write gate.
    isActive: (_auth, config) => listOpenAiForwardSidecarCandidates(config).length > 0,
    candidateMatch: candidate => candidate.native === true || candidate.provider === "openai",
    baseline: "gpt-5.6-luna",
    rank: 0,
  },
  {
    backend: "anthropic",
    isActive: auth => auth.isAnthropicAuth,
    // The runtime dispatches through exactly ONE Anthropic provider — the
    // resolved OAuth row. Same-adapter keyed rows are unreachable (see
    // visionBackendForCandidate's original stance).
    candidateMatch: (candidate, auth) => candidate.provider === auth.anthropicProviderName,
    baseline: "claude-haiku-4-5",
    rank: 1,
  },
  {
    backend: "routed",
    // Always offered: options only materialize when a matching picker row
    // exists, and the row's own provider config is the liveness signal — the
    // loopback request fails closed through ordinary routing errors.
    isActive: () => true,
    // Any row the other two executors do NOT own. Auth-slot rows are
    // entitlements of the openai/anthropic sides and never route here.
    candidateMatch: (candidate, auth) =>
      candidate.native !== true
      && candidate.provider !== "openai"
      && candidate.provider !== auth.anthropicProviderName,
    rank: 2,
  },
];

export function visionBackendDescriptor(backend: VisionSidecarBackend): VisionBackendDescriptor {
  const descriptor = VISION_BACKENDS.find(entry => entry.backend === backend);
  if (!descriptor) throw new Error(`unknown vision backend "${backend}"`);
  return descriptor;
}

/**
 * The active backend set for option generation. Falls back to the two
 * UNIVERSAL sides when neither is active (fresh install: picker stays
 * populated, permissive-unknown rule); "routed" is active by construction.
 */
export function activeVisionBackends(auth: SidecarAuthState, config: OcxConfig): VisionSidecarBackend[] {
  const active = VISION_BACKENDS.filter(entry => entry.isActive(auth, config)).map(entry => entry.backend);
  return active.includes("openai") || active.includes("anthropic")
    ? active
    : ["openai", "anthropic", ...active.filter(backend => backend === "routed")];
}

