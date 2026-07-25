import { removeCodexAccountCredential } from "./account-store";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { clearAccountQuota } from "./quota";
import { clearCodexUpstreamHealthForAccount, clearThreadAccountMapForAccount } from "./routing";
import { invalidateCodexWebSocketsForAccount } from "./websocket-registry";
import type { OcxConfig } from "../types";

export function purgeCodexAccountRuntimeState(accountId: string): void {
  clearAccountNeedsReauth(accountId);
  clearAccountQuota(accountId);
  clearThreadAccountMapForAccount(accountId);
  clearCodexUpstreamHealthForAccount(accountId);
}

export function deleteCodexAccount(runtimeConfig: OcxConfig, accountId: string): boolean {
  removeCodexAccountCredential(accountId);
  runtimeConfig.codexAccounts = (runtimeConfig.codexAccounts ?? []).filter(account => account.id !== accountId);
  let namespaceRemoved = false;
  if (runtimeConfig.codexAccountNamespaces) {
    const previousCount = Object.keys(runtimeConfig.codexAccountNamespaces).length;
    runtimeConfig.codexAccountNamespaces = Object.fromEntries(
      Object.entries(runtimeConfig.codexAccountNamespaces)
        .filter(([, boundAccountId]) => boundAccountId !== accountId),
    );
    namespaceRemoved = Object.keys(runtimeConfig.codexAccountNamespaces).length !== previousCount;
  }
  if (runtimeConfig.activeCodexAccountId === accountId) runtimeConfig.activeCodexAccountId = undefined;
  purgeCodexAccountRuntimeState(accountId);
  invalidateCodexWebSocketsForAccount(accountId);
  return namespaceRemoved;
}
