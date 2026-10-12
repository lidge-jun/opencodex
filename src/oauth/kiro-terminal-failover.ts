import type { OAuthAccessSnapshot } from "./index";
import type { OcxConfig } from "../types";
import { getValidAccessSnapshotForAccount } from "./index";
import { credentialGeneration, getAccountCredentialWithStatus, getAccountSet } from "./store";
import { eligibleFailoverAccounts, isGenericFailoverProvider,
  GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST } from "./generic-account-failover";

/**
 * Only an unchanged, allowlist-classified dead credential permits this alternate.
 *
 * Consent is the stored-login count, needsReauth rows included: the refused account was
 * marked needsReauth a moment ago, and counting only healthy rows would make a two-account
 * setup look like one exactly when the second account is needed.
 */
export async function tryAlternateAfterTerminalRefresh(
  config: OcxConfig, providerName: string, failedAccountId: string, failedGeneration: string,
): Promise<OAuthAccessSnapshot | null> {
  const provider = config.providers?.[providerName];
  if (!provider || !isGenericFailoverProvider(providerName, provider)) return null;
  const order = getAccountSet(providerName)?.accounts.map(row => row.id) ?? [];
  if (order.length < 2) return null;
  const failed = getAccountCredentialWithStatus(providerName, failedAccountId);
  if (!failed?.needsReauth || credentialGeneration(failed.credential) !== failedGeneration) return null;
  const after = order.indexOf(failedAccountId);
  if (after < 0) return null;
  const ring = [...order.slice(after + 1), ...order.slice(0, after)];
  const eligible = new Set(eligibleFailoverAccounts(providerName));
  let attempted = 0;
  for (const id of ring) {
    if (id === failedAccountId || !eligible.has(id)) continue;
    if (++attempted >= GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST) break;
    try { return await getValidAccessSnapshotForAccount(providerName, id, { requireUsableAccount: true }); }
    catch { /* Keep the original login-required result if every alternate is stale. */ }
  }
  return null;
}

export function tryKiroAlternateAfterTerminalRefresh(
  config: OcxConfig, failedAccountId: string, failedGeneration: string,
): Promise<OAuthAccessSnapshot | null> {
  return tryAlternateAfterTerminalRefresh(config, "kiro", failedAccountId, failedGeneration);
}
