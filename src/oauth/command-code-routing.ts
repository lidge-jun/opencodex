/**
 * Command Code OAuth account pool — thin adapter over the generic OAuth pool
 * router (oauth-pool-routing.ts), mirroring the Codex pool rotation strategy.
 *
 * Default OFF via `config.commandCodeAccountPool.enabled`. See the generic
 * router docs for the full behavior contract.
 */
import {
  getAccountSet,
  getAccountCredential,
} from "./store";
import { POOL_KEY_COMMAND_CODE } from "../codex/pool-rotation";
import {
  bindOAuthPoolSessionAffinity,
  clearOAuthPoolAccountCooldown,
  clearOAuthPoolSessionAffinityForAccount,
  clearOAuthPoolState,
  formatOAuthPoolAccountOrdinal,
  formatOAuthPoolProviderForLog,
  getEligibleOAuthPoolAccounts,
  getOAuthPoolAccountHealthSnapshot,
  getOAuthPoolAccessToken,
  getOAuthPoolRetryAfterSeconds,
  isOAuthPoolEnabled,
  oauthPoolAutoSwitchThreshold,
  oauthPoolSessionAffinitySizeForTests,
  oauthPoolSessionKeyFromParts,
  OAUTH_POOL_MAX_FAILOVERS_PER_REQUEST,
  promoteOAuthPoolActiveAccount,
  resetOAuthPoolRoutingForManualSelection,
  resolveOAuthPoolAccountForSession,
  rotateOAuthPoolAccountOn429,
  sweepExpiredOAuthPoolRoutingHealth,
  type OAuthAccountPoolConfig,
  type OAuthPoolEligibilityHooks,
  type OAuthPoolProviderHooks,
  type OAuthPoolSelection,
  type OAuthPoolSelectionReason,
} from "./oauth-pool-routing";
import type { OcxConfig } from "../types";

const PROVIDER = "command-code";

/** Config slice for the command-code pool. */
export function commandCodeAccountPoolConfig(config: OcxConfig): OAuthAccountPoolConfig {
  return hooks.configOf(config) ?? {};
}

const hooks: OAuthPoolProviderHooks = {
  configOf: config => config.commandCodeAccountPool,
  priorityOf: config => {
    const priorities = config.commandCodeAccountPool?.accountPriorities;
    if (!priorities) return () => 0;
    return accountId => (
      Object.hasOwn(priorities, accountId)
        ? Math.max(-100, Math.min(100, priorities[accountId] ?? 0))
        : 0
    );
  },
  pinnedOf: config => config.commandCodeAccountPool?.activeAccountPinned,
  poolKey: POOL_KEY_COMMAND_CODE,
};

const eligibility: OAuthPoolEligibilityHooks = {
  canRefresh: accountId => {
    const set = getAccountSet(PROVIDER);
    const cred = getAccountCredential(PROVIDER, accountId);
    if (!cred) return false;
    if (cred.source !== "local-cli") return true;
    return set?.activeAccountId === accountId;
  },
};

export { PROVIDER as COMMAND_CODE_POOL_PROVIDER };
export const COMMAND_CODE_POOL_MAX_FAILOVERS_PER_REQUEST = OAUTH_POOL_MAX_FAILOVERS_PER_REQUEST;

export function isCommandCodeAccountPoolEnabled(config: OcxConfig): boolean {
  return isOAuthPoolEnabled(config, hooks);
}

export function commandCodeAutoSwitchThreshold(config: OcxConfig): number {
  return oauthPoolAutoSwitchThreshold(config, hooks);
}

export function getCommandCodeAccountHealthSnapshot(accountId: string, now = Date.now()) {
  return getOAuthPoolAccountHealthSnapshot(PROVIDER, accountId, now);
}

export function clearCommandCodeAccountCooldown(accountId: string): boolean {
  return clearOAuthPoolAccountCooldown(PROVIDER, accountId);
}

export function sweepExpiredCommandCodeRoutingHealth(now = Date.now()): number {
  return sweepExpiredOAuthPoolRoutingHealth(PROVIDER, now);
}

export function clearCommandCodeAccountPoolState(): void {
  clearOAuthPoolState(PROVIDER);
}

export function commandCodeSessionAffinitySizeForTests(): number {
  return oauthPoolSessionAffinitySizeForTests(PROVIDER);
}

export function getEligibleCommandCodeAccounts(now = Date.now()): string[] {
  return getEligibleOAuthPoolAccounts(PROVIDER, hooks, eligibility, undefined, now);
}

export function getCommandCodePoolRetryAfterSeconds(now = Date.now()): number | null {
  return getOAuthPoolRetryAfterSeconds(PROVIDER, now);
}

export function resolveCommandCodeAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): OAuthPoolSelection {
  return resolveOAuthPoolAccountForSession(PROVIDER, sessionKey, config, hooks, eligibility, now);
}

export function bindCommandCodeSessionAffinity(sessionKey: string | null | undefined, accountId: string, now = Date.now()): void {
  bindOAuthPoolSessionAffinity(PROVIDER, sessionKey, accountId, now);
}

export function clearCommandCodeSessionAffinityForAccount(accountId: string): void {
  clearOAuthPoolSessionAffinityForAccount(PROVIDER, accountId);
}

export function rotateCommandCodeAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  return rotateOAuthPoolAccountOn429(PROVIDER, config, hooks, eligibility, failedAccountId, retryAfterHeader, sessionKey, now);
}

export function promoteCommandCodeActiveAccount(accountId: string): void {
  promoteOAuthPoolActiveAccount(PROVIDER, accountId);
}

export function resetCommandCodeRoutingForManualSelection(accountId: string): void {
  resetOAuthPoolRoutingForManualSelection(PROVIDER, hooks, accountId);
}

export async function getCommandCodePoolAccessToken(accountId: string): Promise<string> {
  return getOAuthPoolAccessToken(PROVIDER, accountId, eligibility.canRefresh);
}

export function canRefreshCommandCodePoolAccount(accountId: string): boolean {
  return eligibility.canRefresh(accountId);
}

export function formatCommandCodeAccountOrdinal(accountId: string): string {
  return formatOAuthPoolAccountOrdinal(accountId);
}

export function formatCommandCodeProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
  config?: OcxConfig,
): string {
  return formatOAuthPoolProviderForLog(providerName, accountId, config);
}

export const commandCodeSessionKeyFromParts = oauthPoolSessionKeyFromParts;

export type CommandCodeAccountSelectionReason = OAuthPoolSelectionReason;
export interface CommandCodeAccountSelection extends OAuthPoolSelection {}
