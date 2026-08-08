import { removeCodexAccountCredential } from "./account-store";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { getMainChatgptAccountId } from "./auth-collision";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./main-account";
import { clearAccountQuota } from "./quota";
import { clearCodexUpstreamHealthForAccount, clearThreadAccountMapForAccount } from "./routing";
import { invalidateCodexWebSocketsForAccount } from "./websocket-registry";
import { clearMainAccountCredentialPresence, clearMainAccountInfoCache } from "./main-account-cache";
import { forgetCodexAccountPause } from "./account-pause";
import { clearCodexAccountPin, forgetCodexAccountPriority } from "./account-priority";
import { codexAccountNamespaceEntries, codexAccountPickerEnabled } from "./account-namespaces";
import type { OcxConfig } from "../types";

let observedMainChatgptAccountId: string | undefined;

export function purgeCodexAccountRuntimeState(accountId: string): void {
  clearAccountNeedsReauth(accountId);
  clearAccountQuota(accountId);
  clearThreadAccountMapForAccount(accountId);
  clearCodexUpstreamHealthForAccount(accountId);
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    clearMainAccountInfoCache();
    clearMainAccountCredentialPresence();
  }
}

function purgeMainCodexAccountRuntimeState(): void {
  purgeCodexAccountRuntimeState(MAIN_CODEX_ACCOUNT_ID);
  setMainAccountPlan(null);
  invalidateCodexWebSocketsForAccount(MAIN_CODEX_ACCOUNT_ID);
}

/**
 * The main Codex login is stored under the stable `__main__` alias, while
 * `~/.codex/auth.json` can be replaced with credentials for another physical
 * ChatGPT account. Drop alias-keyed runtime state when that identity changes so
 * cooldown, quota, reauth, and thread affinity do not leak across accounts.
 */
export function reconcileMainCodexAccountRuntimeState(): boolean {
  const currentAccountId = getMainChatgptAccountId();
  // A missing/malformed auth.json is an unknown identity, not a confirmed account switch. Keep the
  // prior observation and its safety state until a real account id can be read again.
  if (currentAccountId === null) return false;
  const previousAccountId = observedMainChatgptAccountId;
  observedMainChatgptAccountId = currentAccountId;
  if (previousAccountId === undefined || previousAccountId === currentAccountId) return false;

  purgeMainCodexAccountRuntimeState();
  return true;
}

/**
 * Apply a transaction-confirmed physical native-login change without waiting for
 * a later auth.json observation. The caller owns credential commit/rollback.
 */
export function applyConfirmedMainCodexAccountTransition(
  fromAccountId: string,
  toAccountId: string,
): boolean {
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
    if (toAccountId) observedMainChatgptAccountId = toAccountId;
    return false;
  }
  observedMainChatgptAccountId = toAccountId;
  purgeMainCodexAccountRuntimeState();
  return true;
}

export function resetMainCodexAccountIdentityTrackingForTests(): void {
  observedMainChatgptAccountId = undefined;
  clearMainAccountCredentialPresence();
}

/**
 * Delete a stored account while retaining its selector binding.
 * Returns true when a picker-visible row disappeared and the catalog must converge.
 */
export function deleteCodexAccount(runtimeConfig: OcxConfig, accountId: string): boolean {
  const hadStoredAccount = (runtimeConfig.codexAccounts ?? [])
    .some(account => !account.isMain && account.id === accountId);
  const hadVisiblePickerBinding = hadStoredAccount
    && codexAccountPickerEnabled(runtimeConfig)
    && codexAccountNamespaceEntries(runtimeConfig)
      .some(([, boundAccountId]) => boundAccountId === accountId);
  removeCodexAccountCredential(accountId);
  runtimeConfig.codexAccounts = (runtimeConfig.codexAccounts ?? [])
    .filter(account => account.isMain || account.id !== accountId);
  forgetCodexAccountPause(runtimeConfig, accountId);
  forgetCodexAccountPriority(runtimeConfig, accountId);
  clearCodexAccountPin(runtimeConfig, accountId);
  if (runtimeConfig.activeCodexAccountId === accountId) runtimeConfig.activeCodexAccountId = undefined;
  purgeCodexAccountRuntimeState(accountId);
  invalidateCodexWebSocketsForAccount(accountId);
  return hadVisiblePickerBinding;
}
