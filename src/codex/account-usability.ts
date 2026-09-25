import { readCodexAccountRecord } from "./account-store";
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
import { isMainAccountHardLocked } from "./main-account-hard-lock";

export interface CodexAccountUsabilityOptions {
  /** Route using cached runtime state only; the caller must reject selected main before auth. */
  nativeMainSelectionOnly?: boolean;
  /** Test seam for proving whether routing attempted a physical native-token read. */
  isMainAccountTokenLive?: typeof isMainAccountTokenLive;
  /** Confirmed account ids for an account-gated model; omitted for ordinary native models. */
  modelEligibleAccountIds?: ReadonlySet<string>;
  /**
   * Accounts whose own confirmed roster definitively omits the requested model (#4768).
   *
   * Deliberately NOT read by this module. `modelEligibleAccountIds` is an eligibility boundary and
   * produces `model_not_entitled`; this is an ORDERING preference applied once, in
   * `getEligiblePoolAccounts`, and dropped whenever honouring it would leave no candidate. Reading
   * it here would turn a preference into a refusal and re-create the fail-closed behaviour the
   * flagships were deliberately taken out of.
   */
  deniedModelAccountIds?: ReadonlySet<string>;
  /**
   * This request's conversation carries live uploaded-file references (#4778).
   *
   * Also not read by this module, and for the same reason: it is a retention preference, never an
   * eligibility boundary. Uploaded files are scoped to the account that issued them, so moving
   * such a conversation orphans the reference and every later turn is refused with
   * `409 account_change_file_scope` -- the reference stays in history, so the conversation is
   * effectively dead. Retention makes that refusal rarer; it can never replace it, because an
   * account can always become unable to serve.
   */
  retainAccountForUploadedFiles?: boolean;
  /**
   * Main is live for this request only because the request carries its own main bearer (#5019).
   *
   * Main may then win this request's selection, but that credential belongs to the request, not
   * to the Pool: selecting it must never be written back as the shared active account. Persisting
   * it made every later request -- including one whose caller identity is unreadable, or one that
   * owns the cooled subscription -- follow a main the operator never chose.
   */
  requestOwnedMainCredential?: boolean;
}

/**
 * Why an account was refused, in the order the checks run. This is the attribution half of
 * selection: an operator whose model quietly disappeared needs to know that one account fell out
 * and why, not merely that the pool got smaller (#4212).
 */
export type CodexAccountUnusableReason =
  | "model_not_entitled"
  | "main_hard_locked"
  | "main_traffic_blocked"
  | "legacy_pool_sentinel"
  | "needs_reauth"
  | "main_credential_unavailable"
  | "not_in_pool"
  | "missing_credential"
  | "deleted"
  | "validation_pending";

/**
 * The single source of truth for both selection and its explanation. `isCodexAccountUsable()` is
 * this function's boolean projection rather than a parallel copy of the same branches, so a reason
 * can never claim an account is fine while routing drops it, or name a cause routing did not use.
 */
export function codexAccountUnusableReason(
  config: OcxConfig,
  accountId: string,
  options: CodexAccountUsabilityOptions = {},
): CodexAccountUnusableReason | undefined {
  if (options.modelEligibleAccountIds && !options.modelEligibleAccountIds.has(accountId)) {
    return "model_not_entitled";
  }
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    if (isMainAccountHardLocked(config)) return "main_hard_locked";
    // Startup recovery owns the physical auth/vault boundary. Never parse or select
    // native __main__ while an encrypted switch journal is pending or inconclusive.
    if (!options.nativeMainSelectionOnly && isNativeMainTrafficBlocked()) return "main_traffic_blocked";
    // A legacy pool row with the sentinel makes an active `__main__` ambiguous.
    // Fail closed until the authenticated compatibility-delete path removes it.
    if (hasLegacyMainCodexPoolAccount(config.codexAccounts)) return "legacy_pool_sentinel";
    if (isAccountNeedsReauth(accountId) && !hasMainAccountRefreshGrant()) return "needs_reauth";
    // A selection-only caller owns the recovery/drain fence and will reject main
    // before reservation or token materialization. Treat cached main as a routing
    // candidate without touching the credential file so affinity is not rebound.
    if (options.nativeMainSelectionOnly) return undefined;
    // Main account: a refresh grant is enough to route; materialization refreshes before I/O.
    const mainLive = options.isMainAccountTokenLive
      ? options.isMainAccountTokenLive()
      : isMainAccountCredentialUsable();
    return mainLive ? undefined : "main_credential_unavailable";
  }
  const exists = (config.codexAccounts ?? [])
    .some(account => isSelectableCodexPoolAccount(account) && account.id === accountId);
  if (!exists) return "not_in_pool";
  if (isAccountNeedsReauth(accountId)) return "needs_reauth";
  const record = readCodexAccountRecord(accountId);
  if (!record?.credential) return "missing_credential";
  if (record.deletedAt != null) return "deleted";
  if (record.codexValidationPending) return "validation_pending";
  return undefined;
}

export function isCodexAccountUsable(
  config: OcxConfig,
  accountId: string,
  options: CodexAccountUsabilityOptions = {},
): boolean {
  return codexAccountUnusableReason(config, accountId, options) === undefined;
}
