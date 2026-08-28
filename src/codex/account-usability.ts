import { getCodexAccountCredential } from "./account-store";
import { isAccountNeedsReauth } from "./account-runtime-state";
import {
  MAIN_CODEX_ACCOUNT_ID,
  hasMainAccountRefreshGrant,
  isMainAccountCredentialUsable,
  isMainAccountTokenLive,
} from "./main-account";
import { hasLegacyMainCodexPoolAccount, isSelectableCodexPoolAccount } from "./account-id";
import type { OcxConfig } from "../types";
import { isNativeMainTrafficBlocked } from "./native-profile-startup";

export interface CodexAccountUsabilityOptions {
  /** Route using cached runtime state only; the caller must reject selected main before auth. */
  nativeMainSelectionOnly?: boolean;
  /** Test seam for proving whether routing attempted a physical native-token read. */
  isMainAccountTokenLive?: typeof isMainAccountTokenLive;
  /** Confirmed account ids for an account-gated model; omitted for ordinary native models. */
  modelEligibleAccountIds?: ReadonlySet<string>;
}

export function isCodexAccountUsable(
  config: OcxConfig,
  accountId: string,
  options: CodexAccountUsabilityOptions = {},
): boolean {
  if (options.modelEligibleAccountIds && !options.modelEligibleAccountIds.has(accountId)) return false;
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // Startup recovery owns the physical auth/vault boundary. Never parse or select
    // native __main__ while an encrypted switch journal is pending or inconclusive.
    if (!options.nativeMainSelectionOnly && isNativeMainTrafficBlocked()) return false;
    // A legacy pool row with the sentinel makes an active `__main__` ambiguous.
    // Fail closed until the authenticated compatibility-delete path removes it.
    if (hasLegacyMainCodexPoolAccount(config.codexAccounts)) return false;
    if (isAccountNeedsReauth(accountId) && !hasMainAccountRefreshGrant()) return false;
    // A selection-only caller owns the recovery/drain fence and will reject main
    // before reservation or token materialization. Treat cached main as a routing
    // candidate without touching the credential file so affinity is not rebound.
    if (options.nativeMainSelectionOnly) return true;
    // Main account: a refresh grant is enough to route; materialization refreshes before I/O.
    return options.isMainAccountTokenLive
      ? options.isMainAccountTokenLive()
      : isMainAccountCredentialUsable();
  }
  const exists = (config.codexAccounts ?? [])
    .some(account => isSelectableCodexPoolAccount(account) && account.id === accountId);
  if (!exists) return false;
  if (isAccountNeedsReauth(accountId)) return false;
  return !!getCodexAccountCredential(accountId);
}
