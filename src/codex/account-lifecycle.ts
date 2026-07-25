import { removeCodexAccountCredential } from "./account-store";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { clearAccountQuota } from "./quota";
import { clearCodexUpstreamHealthForAccount, clearThreadAccountMapForAccount } from "./routing";
import { invalidateCodexWebSocketsForAccount } from "./websocket-registry";
import type { OcxConfig } from "../types";
import { visibleCodexAccountNamespaceEntries } from "./account-namespaces";

export function purgeCodexAccountRuntimeState(accountId: string): void {
  clearAccountNeedsReauth(accountId);
  clearAccountQuota(accountId);
  clearThreadAccountMapForAccount(accountId);
  clearCodexUpstreamHealthForAccount(accountId);
}

export function deleteCodexAccount(runtimeConfig: OcxConfig, accountId: string): boolean {
  const visibleBindingRemoved = visibleCodexAccountNamespaceEntries(runtimeConfig)
    .some(([, boundAccountId]) => boundAccountId === accountId);
  removeCodexAccountCredential(accountId);
  runtimeConfig.codexAccounts = (runtimeConfig.codexAccounts ?? []).filter(account => account.id !== accountId);
  if (runtimeConfig.activeCodexAccountId === accountId) runtimeConfig.activeCodexAccountId = undefined;
  purgeCodexAccountRuntimeState(accountId);
  invalidateCodexWebSocketsForAccount(accountId);
  return visibleBindingRemoved;
}
