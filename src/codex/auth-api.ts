export { checkAccountIdCollision, getMainChatgptAccountId } from "./auth-collision";
export { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
export {
  applyAccountQuotaFromUpstreamHeaders,
  clearAccountQuota,
  getAccountQuota,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
} from "./quota";
export { clearMainAccountInfoCache } from "./main-account-cache";
export { maskEmail } from "../lib/privacy";
export { CodexLoginStateBusyError } from "./auth-api/login-state";
export type {
  CodexAccountReauthReason,
  CodexAuthAccountDto,
  CodexAuthAccountsSnapshot,
} from "./auth-api/account-list";
export { listCodexAuthAccountsSnapshot, refreshCodexQuotaForActivation, listCodexAuthAccounts } from "./auth-api/account-list";
export type { MainAccountInfoSnapshot } from "./auth-api/main-account-probe";
export { fetchMainAccountInfoSnapshot, fetchMainAccountInfo } from "./auth-api/main-account-probe";
export { PoolQuotaProbeBusyError, seedCodexAuthAdmissionForTests, fetchPoolAccountQuota } from "./auth-api/pool-quota-probe";
export type { PrimeCodexPoolQuotasOptions } from "./auth-api/pool-mode-gate";
export {
  runCodexCooldownRecoveryProbes,
  runMainAccountHardLockRecovery,
  registerCodexCooldownRecoveryProbeWorker,
  setCodexPoolQuotaTokenResolverForTests,
  primeCodexPoolQuotas,
  clearCodexQuotaPrimeState,
  clearCodexQuotaPrimeSingleFlightForTests,
  clearCodexCooldownRecoveryProbeState,
} from "./auth-api/pool-mode-gate";
export { createResetCreditWhamClient } from "./auth-api/reset-credit-service";
export type { CodexAuthCatalogConvergence } from "./auth-api/login-flow";
export { handleCodexAuthAPI } from "./auth-api/routes";
import { getEffectiveActiveCodexAccountId } from "./routing";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import type { OcxConfig } from "../types";

export function effectiveCodexAuthAccountId(config: OcxConfig): string {
  return getEffectiveActiveCodexAccountId(config) ?? MAIN_CODEX_ACCOUNT_ID;
}
