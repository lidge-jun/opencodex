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
import { getAccountSet } from "../oauth/store";
import type { WebSearchBackendId } from "./index";

export interface WebSearchBackendDescriptor {
  backend: WebSearchBackendId;
  /** Liveness signal for this backend (auth presence for the shipped two). */
  isActive(auth: SidecarAuthState, config: OcxConfig): boolean;
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
  {
    backend: "xai",
    // Probe = stored Grok OAuth usable: enabled oauth-mode "xai" provider whose
    // active account is not marked for reauth — the same predicate
    // findXaiSidecarProvider applies at plan time (L7).
    isActive: (_auth, config) => {
      const provider = config.providers["xai"];
      if (!provider || provider.disabled === true || provider.authMode !== "oauth") return false;
      const set = getAccountSet("xai");
      const active = set?.accounts.find(account => account.id === set.activeAccountId);
      return !!active && active.needsReauth !== true;
    },
    eligibleModel: candidate => candidate.provider === "xai",
  },
  {
    backend: "gemini",
    // Probe = usable Antigravity OAuth + discovered projectId (findGeminiSidecarProvider's predicate).
    isActive: (_auth, config) => {
      const provider = config.providers["google-antigravity"];
      if (!provider || provider.disabled === true || provider.authMode !== "oauth") return false;
      const set = getAccountSet("google-antigravity");
      const active = set?.accounts.find(account => account.id === set.activeAccountId);
      if (!active || active.needsReauth === true) return false;
      return !!(active.credential as { projectId?: string } | undefined)?.projectId;
    },
    eligibleModel: candidate => candidate.provider === "google-antigravity",
  },
  {
    backend: "exa",
    // Probe = operator key present. Exa is not an LLM: no candidate models ever
    // match, so the GUI's model list stays untouched by this backend.
    isActive: (_auth, config) => !!config.webSearchSidecar?.exaApiKey,
    eligibleModel: () => false,
  },
];

/**
 * (picker-visible ∪ auth slots) ∩ (active backend able to run the row).
 * The auth slots always survive their own side's activation: a logged-in
 * side keeps Luna/Haiku even when the picker hides them.
 */
export function webSearchSidecarCandidates(
  config: OcxConfig,
  auth: SidecarAuthState,
  all: readonly SidecarCandidate[],
): SidecarCandidate[] {
  const active = WEB_SEARCH_BACKENDS.filter(descriptor => descriptor.isActive(auth, config));
  return all.filter(candidate => active.some(descriptor => descriptor.eligibleModel(candidate, auth)));
}

/** True when the id is one of the fixed auth-slot models (#2188 write-gate exception). */
export function isWebSearchAuthSlotModel(id: string): boolean {
  return id === AUTH_SLOT_MODELS.codex || id === AUTH_SLOT_MODELS.anthropic;
}
