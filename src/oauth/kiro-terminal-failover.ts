import type { OAuthAccessSnapshot } from "./index";
import type { OcxConfig } from "../types";
import { getValidAccessSnapshotForAccount } from "./index";
import { credentialGeneration, getAccountCredentialWithStatus, getAccountSet } from "./store";
import { eligibleFailoverAccounts, isGenericOAuthFailoverEnabled,
  GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST } from "./generic-account-failover";

/** Only an unchanged, allowlist-classified dead credential permits this alternate. */
export async function tryKiroAlternateAfterTerminalRefresh(
  config: OcxConfig, failedAccountId: string, failedGeneration: string,
): Promise<OAuthAccessSnapshot | null> {
  if (!isGenericOAuthFailoverEnabled(config, "kiro")) return null;
  const failed = getAccountCredentialWithStatus("kiro", failedAccountId);
  if (!failed?.needsReauth || credentialGeneration(failed.credential) !== failedGeneration) return null;
  const order = getAccountSet("kiro")?.accounts.map(row => row.id) ?? [];
  const after = order.indexOf(failedAccountId);
  if (after < 0) return null;
  const ring = [...order.slice(after + 1), ...order.slice(0, after)];
  const eligible = new Set(eligibleFailoverAccounts("kiro"));
  let attempted = 0;
  for (const id of ring) {
    if (id === failedAccountId || !eligible.has(id)) continue;
    if (++attempted >= GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST) break;
    try { return await getValidAccessSnapshotForAccount("kiro", id, { requireUsableAccount: true }); }
    catch { /* Keep the original login-required result if every alternate is stale. */ }
  }
  return null;
}
