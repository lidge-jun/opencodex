/**
 * Which backends may RUN a hosted web_search, and which candidate rows each
 * can run (#2188 rule 2 for web-search: ∩ probed backend with an executor).
 *
 * A backend registers here only when BOTH hold:
 *  - an executor exists in this repository (src/web-search/executor.ts or
 *    anthropic-executor.ts today), and
 *  - its liveness probe passes. For the two shipped backends the probe IS
 *    auth presence — the ChatGPT forward path and the stored Anthropic OAuth
 *    path fail closed without a credential, so a live credential is the
 *    strongest pre-flight signal short of spending a search.
 *
 * Future backends (Gemini google_search, Grok web_search, Zen hosted search,
 * Exa-class vendors) stay OUT of this table until a live probe and an
 * executor land — the research and probe contracts are recorded in
 * devlog/_plan/260820_sidecar_selection_unification/002 and 031. Documenting
 * a tool is not the same as being able to run it.
 */
import type { OcxConfig } from "../types";
import { AUTH_SLOT_MODELS, type SidecarAuthState } from "../sidecar/auth";
import type { SidecarCandidate } from "../sidecar/candidates";

export interface WebSearchBackendDescriptor {
  backend: "openai" | "anthropic";
  /** Liveness signal for this backend (auth presence for the shipped two). */
  isActive(auth: SidecarAuthState): boolean;
  /** Which candidate rows this backend's executor can actually run. */
  eligibleModel(candidate: SidecarCandidate, auth: SidecarAuthState): boolean;
}

export const WEB_SEARCH_BACKENDS: readonly WebSearchBackendDescriptor[] = [
  {
    backend: "openai",
    isActive: auth => auth.isCodexAuth,
    // The ChatGPT forward executor runs BARE native slugs and the Codex auth
    // slot — settings.model is POSTed verbatim to the forward /responses, so
    // an account-bound "selector/slug" row (model-rows emits those as
    // provider "openai", native true) or a custom openai-keyed row would
    // persist an id the executor cannot run (review F1). The sidecar never
    // calls routeModel; there is no prefix-stripping on this path.
    eligibleModel: candidate => candidate.provider === "openai"
      && (candidate.native === true || candidate.authSlot === true)
      && !candidate.id.includes("/"),
  },
  {
    backend: "anthropic",
    isActive: auth => auth.isAnthropicAuth,
    // The stored-OAuth Messages executor dispatches through exactly ONE
    // provider — the one the shared auth module resolved. Same-adapter keyed
    // rows are unreachable, mirroring visionBackendForCandidate's stance.
    eligibleModel: (candidate, auth) => candidate.provider === auth.anthropicProviderName,
  },
];

/**
 * (picker-visible ∪ auth slots) ∩ (active backend able to run the row).
 * The auth slots always survive their own side's activation: a logged-in
 * side keeps Luna/Haiku even when the picker hides them.
 */
export function webSearchSidecarCandidates(
  _config: OcxConfig,
  auth: SidecarAuthState,
  all: readonly SidecarCandidate[],
): SidecarCandidate[] {
  const active = WEB_SEARCH_BACKENDS.filter(descriptor => descriptor.isActive(auth));
  return all.filter(candidate => active.some(descriptor => descriptor.eligibleModel(candidate, auth)));
}

/** True when the id is one of the fixed auth-slot models (#2188 write-gate exception). */
export function isWebSearchAuthSlotModel(id: string): boolean {
  return id === AUTH_SLOT_MODELS.codex || id === AUTH_SLOT_MODELS.anthropic;
}
