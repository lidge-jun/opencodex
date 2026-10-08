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
import { configuredAnthropicInstance, type AnthropicInstanceId } from "../providers/anthropic-instance";
import { isAnthropicInstanceId } from "../providers/anthropic-instance-id";

/**
 * The parent request's pool for an inheriting helper. A missing or disabled row keeps the parent's
 * identity, so a pool removed mid-request refuses instead of discovering another pool; only a present
 * custom row that is not the builtin instance (an unmarked custom `anthropic2`) stops inheritance.
 */
export function inheritedAnthropicInstance(config: OcxConfig, parentProviderName: string | undefined): AnthropicInstanceId | undefined {
  if (!isAnthropicInstanceId(parentProviderName)) return undefined;
  const row = config.providers?.[parentProviderName];
  if (!row || row.disabled === true) return parentProviderName;
  return configuredAnthropicInstance(config, parentProviderName);
}

export class AnthropicHelperUnavailableError extends Error {
  readonly code = "anthropic_helper_unavailable";
  constructor(readonly instance: AnthropicInstanceId) {
    super(`The selected ${instance} helper account pool is unavailable`);
    this.name = "AnthropicHelperUnavailableError";
  }
}
export type AnthropicHelperContext = {
  backendFamily: string;
  anthropicInstance?: AnthropicInstanceId;
  parentProviderName?: string;
};

/**
 * Availability of one selected pool: the configured builtin row plus at least one stored account the
 * pool could select. Which account actually sends (model route, cooldown, manual choice) is decided
 * by snapshot resolution at send time, exactly as the main request path does, so a paused or
 * reauth-pending ACTIVE account does not make a pool with another usable account unavailable.
 */
export function resolveAnthropicSidecarAuth(config: OcxConfig, instance: AnthropicInstanceId):
  { anthropicProviderName: AnthropicInstanceId; anthropicProvider: OcxProviderConfig } | undefined {
  const provider = config.providers[instance];
  if (!provider || provider.disabled || provider.authMode !== "oauth" || provider.adapter !== "anthropic"
    || configuredAnthropicInstance(config, instance) !== instance) return undefined;
  if (!getAccountSet(instance)?.accounts.some(row => row.paused !== true && row.needsReauth !== true)) return undefined;
  return { anthropicProviderName: instance, anthropicProvider: provider };
}

/**
 * Explicit target, then the parent's CONFIGURED builtin instance. The parent name alone is not
 * enough: a custom provider that happens to be named `anthropic2` is not Pool 2 and is never inherited.
 */
export function resolveAnthropicHelperInstance(config: OcxConfig, context: AnthropicHelperContext): AnthropicInstanceId | undefined {
  if (context.backendFamily !== "anthropic") return undefined;
  const instance = context.anthropicInstance ?? inheritedAnthropicInstance(config, context.parentProviderName);
  if (instance && !resolveAnthropicSidecarAuth(config, instance)) throw new AnthropicHelperUnavailableError(instance);
  return instance;
}

/**
 * Planner boundary for the typed refusal: an unavailable selected pool means "this helper does not
 * run", never "fail the main request" and never "discover another pool". Other errors propagate.
 */
export function withAnthropicHelperRefusal<T>(surface: string, resolve: () => T): T | undefined {
  try {
    return resolve();
  } catch (error) {
    if (!(error instanceof AnthropicHelperUnavailableError)) throw error;
    console.warn(`[${surface}] ${error.message}; the request continues without this helper`);
    return undefined;
  }
}

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
    // Never adds Pool 2 automatically. The OAuth store key `anthropic2` belongs to the builtin pool:
    // its token path and the token guardian refuse an unmarked row of that name, so offering such a
    // custom row here would advertise credentials no helper executor will spend.
    if (providerName === "anthropic2") continue;
    if (provider.disabled === true) continue;
    if (provider.adapter !== "anthropic" || provider.authMode !== "oauth") continue;
    const set = getAccountSet(providerName);
    const active = set?.accounts.find(account => account.id === set.activeAccountId);
    if (active && active.needsReauth !== true) return { providerName, provider };
  }
  return undefined;
}

export function resolveSidecarAuth(config: OcxConfig, instance?: AnthropicInstanceId): SidecarAuthState {
  const exact = instance ? resolveAnthropicSidecarAuth(config, instance) : undefined;
  if (instance && !exact) throw new AnthropicHelperUnavailableError(instance);
  const anthropic = exact ? { providerName: exact.anthropicProviderName, provider: exact.anthropicProvider }
    : findAnthropicAuthProvider(config);
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
