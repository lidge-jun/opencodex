import { removeCodexAccountCredential } from "./account-store";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { getMainChatgptAccountId } from "./auth-collision";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./main-account";
import { clearAccountQuota } from "./quota";
import { clearCodexUpstreamHealthForAccount, clearThreadAccountMapForAccount } from "./routing";
import { invalidateCodexWebSocketsForAccount } from "./websocket-registry";
import type { OcxConfig } from "../types";

let observedMainChatgptAccountId: string | null | undefined;

export function purgeCodexAccountRuntimeState(accountId: string): void {
  clearAccountNeedsReauth(accountId);
  clearAccountQuota(accountId);
  clearThreadAccountMapForAccount(accountId);
  clearCodexUpstreamHealthForAccount(accountId);
}

/**
 * The main Codex login is stored under the stable `__main__` alias, while
 * `~/.codex/auth.json` can be replaced with credentials for another physical
 * ChatGPT account. Drop alias-keyed runtime state when that identity changes so
 * cooldown, quota, reauth, and thread affinity do not leak across accounts.
 */
export function reconcileMainCodexAccountRuntimeState(): boolean {
  const currentAccountId = getMainChatgptAccountId();
  const previousAccountId = observedMainChatgptAccountId;
  observedMainChatgptAccountId = currentAccountId;
  if (previousAccountId === undefined || previousAccountId === currentAccountId) return false;

  purgeCodexAccountRuntimeState(MAIN_CODEX_ACCOUNT_ID);
  setMainAccountPlan(null);
  invalidateCodexWebSocketsForAccount(MAIN_CODEX_ACCOUNT_ID);
  return true;
}

export function resetMainCodexAccountIdentityTrackingForTests(): void {
  observedMainChatgptAccountId = undefined;
}

export function deleteCodexAccount(runtimeConfig: OcxConfig, accountId: string): void {
  removeCodexAccountCredential(accountId);
  runtimeConfig.codexAccounts = (runtimeConfig.codexAccounts ?? []).filter(account => account.id !== accountId);
  if (runtimeConfig.activeCodexAccountId === accountId) runtimeConfig.activeCodexAccountId = undefined;
  purgeCodexAccountRuntimeState(accountId);
  invalidateCodexWebSocketsForAccount(accountId);
}
