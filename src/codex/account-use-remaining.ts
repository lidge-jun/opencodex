import type { OcxConfig } from "../types";
import { deleteConfigTopLevelKey } from "../config/rebase-provenance";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";

type Policy = Pick<OcxConfig, "codexUseRemainingQuotaAccountIds">;

/** Included-quota preference only; never grants permission to spend credits. */
export function codexAccountUsesRemainingQuota(config: Policy | undefined, accountId: string): boolean {
  return config?.codexUseRemainingQuotaAccountIds?.includes(accountId) ?? false;
}

export function validRemainingQuotaAccountIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => id === MAIN_CODEX_ACCOUNT_ID || isValidCodexAccountId(id));
}

/** Preserve the underlying thresholds so turning this off restores their current values. */
export function setCodexAccountUseRemainingQuota(config: OcxConfig, accountId: string, enabled: boolean): void {
  const ids = new Set(config.codexUseRemainingQuotaAccountIds ?? []);
  if (enabled) ids.add(accountId);
  else ids.delete(accountId);
  if (ids.size) config.codexUseRemainingQuotaAccountIds = [...ids];
  else deleteConfigTopLevelKey(config, "codexUseRemainingQuotaAccountIds");
}
