import { randomUUID } from "node:crypto";
import type { AccountPauseDetails } from "../types/account-auto-pause";
import type { OcxConfig } from "../types";
import { deleteConfigTopLevelKey } from "../config/rebase-provenance";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { invalidateRetainedNativeMainLogin } from "./native-main-credentials";

/** Whether an account is administratively excluded from future pool selection. */
export function isCodexAccountPaused(config: OcxConfig, accountId: string): boolean {
  return config.pausedCodexAccountIds?.includes(accountId) ?? false;
}

/** Persist the account's pool eligibility without changing credentials or runtime health. */
export function setCodexAccountPaused(config: OcxConfig, accountId: string, paused: boolean, details?: AccountPauseDetails): void {
  // Pausing main ends a retained native-main login; resuming never revives it (#7345).
  if (paused && accountId === MAIN_CODEX_ACCOUNT_ID) invalidateRetainedNativeMainLogin("pause");
  config.codexAccountPauseState = { ...config.codexAccountPauseState,
    [accountId]: { revision: randomUUID(), ...(paused && details ? { details } : {}) } };
  const pausedIds = new Set(config.pausedCodexAccountIds ?? []);
  if (paused) pausedIds.add(accountId);
  else pausedIds.delete(accountId);

  if (pausedIds.size > 0) config.pausedCodexAccountIds = [...pausedIds];
  else deleteConfigTopLevelKey(config, "pausedCodexAccountIds");
}

export function forgetCodexAccountPause(config: OcxConfig, accountId: string): void {
  setCodexAccountPaused(config, accountId, false);
  if (config.codexAccountPauseState) delete config.codexAccountPauseState[accountId];
}
