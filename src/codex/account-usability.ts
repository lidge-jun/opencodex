import { getCodexAccountCredential } from "./account-store";
import { isAccountNeedsReauth } from "./account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID, isMainAccountTokenLive } from "./main-account";
import { hasLegacyMainCodexPoolAccount, isSelectableCodexPoolAccount } from "./account-id";
import type { OcxConfig } from "../types";

export function isCodexAccountUsable(config: OcxConfig, accountId: string): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // A legacy pool row with the sentinel makes an active `__main__` ambiguous.
    // Fail closed until the authenticated compatibility-delete path removes it.
    if (hasLegacyMainCodexPoolAccount(config.codexAccounts)) return false;
    // Main account: credential is the read-only ~/.codex/auth.json token (Option A).
    return isMainAccountTokenLive() && !isAccountNeedsReauth(accountId);
  }
  const exists = (config.codexAccounts ?? [])
    .some(account => isSelectableCodexPoolAccount(account) && account.id === accountId);
  if (!exists) return false;
  if (isAccountNeedsReauth(accountId)) return false;
  return !!getCodexAccountCredential(accountId);
}
