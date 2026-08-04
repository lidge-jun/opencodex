import type { OcxConfig } from "../types";

/** Whether an account is administratively excluded from future pool selection. */
export function isCodexAccountPaused(config: OcxConfig, accountId: string): boolean {
  return config.pausedCodexAccountIds?.includes(accountId) ?? false;
}

/** Persist the account's pool eligibility without changing credentials or runtime health. */
export function setCodexAccountPaused(config: OcxConfig, accountId: string, paused: boolean): void {
  const pausedIds = new Set(config.pausedCodexAccountIds ?? []);
  if (paused) pausedIds.add(accountId);
  else pausedIds.delete(accountId);

  if (pausedIds.size > 0) config.pausedCodexAccountIds = [...pausedIds];
  else delete config.pausedCodexAccountIds;
}

export function forgetCodexAccountPause(config: OcxConfig, accountId: string): void {
  setCodexAccountPaused(config, accountId, false);
}
