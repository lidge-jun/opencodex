import type { PoolAccountRoute } from "../lib/provider-egress";
import type { OcxConfig } from "../types";

/**
 * The configured route of one Codex pool account (`codexAccounts[].egress`), or undefined when the
 * account has none or is not a pool account. The main login has no pool entry and uses the provider's route.
 */
export function codexAccountEgressRoute(
  config: Pick<OcxConfig, "codexAccounts">, accountId: string | null | undefined,
): PoolAccountRoute | undefined {
  if (!accountId) return undefined;
  const account = config.codexAccounts?.find(row => row.id === accountId && row.isMain !== true);
  return account?.egress ? { id: account.id, scope: `codexAccounts.${account.id}.egress`, egress: account.egress } : undefined;
}
