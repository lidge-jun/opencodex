/**
 * Sidecar credential locators shared by the web-search loop and the key-auth
 * passthrough bridge. Kept out of `index.ts` so the bridge can resolve a backend
 * without importing the barrel (a cycle: core loads both, and the barrel is still
 * evaluating when the bridge asks for these names).
 */
import type { OcxConfig, OcxProviderConfig, OcxWebSearchSidecarConfig } from "../types";
import { resolveSidecarAuth } from "../sidecar/auth";
import { getAccountSet } from "../oauth/store";
import type { XaiSearchOptions } from "./xai-executor";

/** Every backend id the config union admits. New ids are explicit-only and inert until their executor ships. */
export type WebSearchBackendId = "openai" | "anthropic" | "xai" | "gemini" | "exa";

/**
 * Precedence: explicit config wins; unset defaults to "openai" (ChatGPT forward path). The
 * anthropic backend (web_search_20250305) is only used when explicitly configured — auto-selecting
 * it from credential availability caused the sidecar to send incompatible models (e.g. gpt-5.6-luna)
 * to the Anthropic API.
 * The 2188 follow-up ids (xai/gemini/exa) resolve to themselves the same explicit-only way; their
 * planWebSearch arms stay fail-closed until each executor layer lands.
 *
 * Lives here rather than in `index.ts` for the reason at the top of this file: the passthrough
 * bridge has to answer "which backend was this global sidecar block configured for?" without
 * value-importing the barrel.
 */
export function resolveSidecarBackend(
  explicit: WebSearchBackendId | undefined,
): WebSearchBackendId {
  if (explicit === "anthropic" || explicit === "xai" || explicit === "gemini" || explicit === "exa") return explicit;
  return "openai";
}

/** A configured anthropic-adapter OAuth provider whose ACTIVE stored account is usable (not needs-reauth). */
export interface AnthropicSidecarProvider {
  providerName: string;
  provider: OcxProviderConfig;
}

/**
 * First enabled anthropic-adapter OAuth provider whose ACTIVE account holds a usable credential — the
 * only path that can run web_search_20250305 without a ChatGPT forward provider. Presence is decided by
 * getAccountSet + the active account's `needsReauth` marker (audit F1: getCredential alone can pick a
 * terminally-invalid account); token refresh happens later at executor time.
 * Delegates to the shared sidecar auth module (#2188) so web-search and vision
 * cannot drift on what "Anthropic auth present" means.
 */
export function findAnthropicSidecarProvider(config: OcxConfig): AnthropicSidecarProvider | undefined {
  const auth = resolveSidecarAuth(config);
  if (!auth.isAnthropicAuth || !auth.anthropicProviderName || !auth.anthropicProvider) return undefined;
  return { providerName: auth.anthropicProviderName, provider: auth.anthropicProvider };
}

/**
 * First enabled provider whose stored Grok OAuth account is active and not marked for
 * reauth — the only credential the xai web-search executor may spend. Same account-set
 * predicate the shared sidecar auth module applies to Anthropic.
 */
export function findXaiSidecarProvider(config: OcxConfig): { providerName: string; provider: OcxProviderConfig } | undefined {
  // The stored Grok credential lives under the provider named "xai" (registry id);
  // OAuth account sets are keyed by provider name, so the name IS the credential key.
  const provider = config.providers["xai"];
  if (!provider || provider.disabled === true || provider.authMode !== "oauth") return undefined;
  const set = getAccountSet("xai");
  const active = set?.accounts.find(account => account.id === set.activeAccountId);
  if (active && active.needsReauth !== true) return { providerName: "xai", provider };
  return undefined;
}

/**
 * First usable Antigravity credential holder: the "google-antigravity" provider
 * (registry id = OAuth store key, same narrowing as findXaiSidecarProvider) whose
 * active stored account is healthy AND carries a discovered CCA projectId — the
 * executor cannot form the envelope without it.
 */
export function findGeminiSidecarProvider(config: OcxConfig): { providerName: string; provider: OcxProviderConfig } | undefined {
  const provider = config.providers["google-antigravity"];
  if (!provider || provider.disabled === true || provider.authMode !== "oauth") return undefined;
  const set = getAccountSet("google-antigravity");
  const active = set?.accounts.find(account => account.id === set.activeAccountId);
  if (!active || active.needsReauth === true) return undefined;
  const projectId = (active.credential as { projectId?: string } | undefined)?.projectId;
  if (!projectId) return undefined;
  return { providerName: "google-antigravity", provider };
}

/** Lift the persisted xSearch config block into executor options (absent block = web_search only). */
export function xaiSearchOptionsFromConfig(cfg: Pick<OcxWebSearchSidecarConfig, "xSearch">): XaiSearchOptions {
  const x = cfg.xSearch;
  if (!x || x.enabled !== true) return {};
  return {
    xSearch: true,
    ...(x.allowedXHandles ? { allowedXHandles: x.allowedXHandles } : {}),
    ...(x.excludedXHandles ? { excludedXHandles: x.excludedXHandles } : {}),
    ...(x.fromDate ? { fromDate: x.fromDate } : {}),
    ...(x.toDate ? { toDate: x.toDate } : {}),
  };
}
