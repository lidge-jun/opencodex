/**
 * The one place that decides whether a sidecar may treat ChatGPT or Anthropic
 * auth as PRESENT (#2188). Web-search and vision consumed two hand-rolled
 * copies of the Anthropic predicate and no Codex-login predicate at all —
 * provider presence was standing in for "logged in", which let a fresh install
 * with the built-in forward provider but no credential offer Luna as a
 * describer it could never run.
 *
 * Both flags are request-context-free: they read config plus the stored
 * account state, never headers. Per-request usability (exact accounts,
 * generation fences) stays in resolveFirstUsableOpenAiSidecar and the
 * executors; this module only answers "is this side worth offering at all?".
 */
import type { OcxConfig, OcxProviderConfig } from "../types";
import { listOpenAiForwardSidecarCandidates } from "../providers/openai-sidecar";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { isCodexAccountUsable } from "../codex/account-usability";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "../codex/account-id";
import { getAccountSet } from "../oauth/store";

export interface SidecarAuthState {
  /** ChatGPT login usable: canonical forward provider AND a live stored credential. */
  isCodexAuth: boolean;
  /** Enabled anthropic-adapter OAuth provider whose active account is not marked for reauth. */
  isAnthropicAuth: boolean;
  /** The provider an Anthropic-side executor would dispatch through, when isAnthropicAuth. */
  anthropicProviderName?: string;
  anthropicProvider?: OcxProviderConfig;
}

/**
 * Fixed auth-slot models (#2188): logged-in sides keep these candidates even
 * when the picker hides or disables them. The slot is the LOGIN's entitlement,
 * not the catalog's.
 */
export const AUTH_SLOT_MODELS = {
  codex: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
} as const;

export interface SidecarAuthSlot {
  provider: string;
  id: string;
  slot: keyof typeof AUTH_SLOT_MODELS;
}

/** Login-shaped, not provider-shaped: a forward provider with no credential is NOT Codex auth. */
function hasUsableCodexLogin(config: OcxConfig): boolean {
  if (listOpenAiForwardSidecarCandidates(config).length === 0) return false;
  if (isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID)) return true;
  return (config.codexAccounts ?? []).some(account =>
    isSelectableCodexPoolAccount(account) && isCodexAccountUsable(config, account.id));
}

/**
 * The predicate previously duplicated as findAnthropicSidecarProvider
 * (web-search) and findAnthropicVisionProvider (vision): first enabled
 * anthropic-adapter OAuth provider whose ACTIVE stored account holds a usable
 * credential. getAccountSet + needsReauth, not getCredential — a terminally
 * invalid account must not present as auth (audit F1).
 */
function findAnthropicAuthProvider(
  config: OcxConfig,
): { providerName: string; provider: OcxProviderConfig } | undefined {
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (provider.disabled === true) continue;
    if (provider.adapter !== "anthropic" || provider.authMode !== "oauth") continue;
    const set = getAccountSet(providerName);
    const active = set?.accounts.find(account => account.id === set.activeAccountId);
    if (active && active.needsReauth !== true) return { providerName, provider };
  }
  return undefined;
}

export function resolveSidecarAuth(config: OcxConfig): SidecarAuthState {
  const anthropic = findAnthropicAuthProvider(config);
  return {
    isCodexAuth: hasUsableCodexLogin(config),
    isAnthropicAuth: anthropic !== undefined,
    ...(anthropic ? { anthropicProviderName: anthropic.providerName, anthropicProvider: anthropic.provider } : {}),
  };
}

/** The auth-entitled fixed candidates. Emitted regardless of picker visibility. */
export function sidecarAuthSlots(auth: SidecarAuthState): SidecarAuthSlot[] {
  const slots: SidecarAuthSlot[] = [];
  if (auth.isCodexAuth) slots.push({ provider: OPENAI_CODEX_PROVIDER_ID, id: AUTH_SLOT_MODELS.codex, slot: "codex" });
  if (auth.isAnthropicAuth && auth.anthropicProviderName) {
    slots.push({ provider: auth.anthropicProviderName, id: AUTH_SLOT_MODELS.anthropic, slot: "anthropic" });
  }
  return slots;
}
