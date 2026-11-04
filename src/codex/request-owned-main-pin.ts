import type { CodexAuthPolicyConfig } from "./auth-context";
import type { OcxConfig } from "../types";
import type { CodexQuotaScope } from "./routing";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { computeCodexUsageScore, getCodexQuotaHealthSnapshot, isEffectiveCodexAccountPinned } from "./routing";
import { getEffectiveCodexAutoSwitchThreshold } from "./account-auto-switch";
import { codexAccountUsesCreditsAfterLimit, codexUsageLimitResetAt } from "./account-credit-use";
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota, getMainPolicyQuota } from "./quota";
import { hasSpendableCodexCredits } from "./quota-types";
import { isMainAccountHardLocked } from "./main-account-hard-lock";
import { authorizationCredential } from "../lib/authorization-scheme";
import { extractAccountId } from "../oauth/chatgpt";
import { matchesMainQuotaCredential } from "./main-account-cache";

/**
 * A request-owned bearer cannot inspect the physical main credential for its plan, but cached
 * WHAM usage is still valid routing evidence for the same logical main account. Score it with
 * the conservative unknown-plan rule: an unobserved governing window preserves the pin, while
 * any known weekly/monthly/short value at the threshold releases it through the ordinary Pool
 * path. This keeps the keyring boundary intact instead of reading auth.json just to classify a
 * request that already brought its own credential (#3157).
 */
function requestOwnedMainPinHasQuotaHeadroom(config: OcxConfig): boolean {
  const threshold = getEffectiveCodexAutoSwitchThreshold(config, MAIN_CODEX_ACCOUNT_ID);
  if (threshold <= 0) return true;
  const usage = computeCodexUsageScore(getAccountQuota(MAIN_CODEX_ACCOUNT_ID), undefined, Date.now(), codexAccountUsesCreditsAfterLimit(config, MAIN_CODEX_ACCOUNT_ID));
  return usage >= CODEX_UNKNOWN_USAGE_SCORE || usage < threshold;
}

/**
 * Whether a request carrying its OWN main credential still serves on main because the operator
 * manually pinned it (#3166), split from the surrounding resolution so request preview can ask
 * the identical question (#4850).
 *
 * Exported for exactly one reason: two copies of this fence is how #4850 happened. Final
 * authentication honoured the ownership boundary while request preview, computing its fence from
 * recovery and drain state alone, still handed pool eligibility the default liveness probe and
 * opened the physical `auth.json` twice per spawn. A predicate one caller can forget is a
 * predicate the other caller will eventually disagree with.
 *
 * Read-free by construction, which is what makes it usable on the fenced side. Every input is
 * config, policy, or in-memory runtime state: the pin fields, the paused list, the cached quota
 * score, the main policy quota the hard lock and the credits switch read, and `callerMatchesObservedMain`, which compares HMAC digests against the observed
 * credential record in `main-account-cache.ts`. Nothing here opens a file.
 *
 * `candidate` is the pin before the hard-lock question, because the caller still owes the
 * pending-binding check that only final authentication can fail closed on.
 */
export function requestOwnedMainPinState(
  headers: Headers,
  config: OcxConfig,
  policy: CodexAuthPolicyConfig,
  requestScopedMainCredential: boolean,
  fixedAccountId: string | undefined,
  quotaScope?: CodexQuotaScope,
): { candidate: boolean; preserve: boolean } {
  const candidate = requestScopedMainCredential
    && fixedAccountId === undefined
    && config.activeCodexAccountPinned === MAIN_CODEX_ACCOUNT_ID
    && isEffectiveCodexAccountPinned(config)
    && !policy.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID)
    && requestOwnedMainPinHasQuotaHeadroom(config);
  return {
    candidate,
    preserve: candidate && !(callerMatchesObservedMain(headers)
      && (isMainAccountHardLocked(policy)
        || mainCreditsHoldResetAt(policy) !== undefined
        || getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, quotaScope)?.cooldownUntil)),
  };
}

export function mainCreditsHoldResetAt(config: Pick<OcxConfig, "creditCodexAccountIds">): number | undefined {
  if (codexAccountUsesCreditsAfterLimit(config, MAIN_CODEX_ACCOUNT_ID)
    && hasSpendableCodexCredits(getMainPolicyQuota())) return undefined;
  return codexUsageLimitResetAt(getMainPolicyQuota(), undefined, Date.now());
}


/** No auth-file I/O: an unsigned claim alone never identifies a caller as stored main. */
export function callerMatchesObservedMain(headers: Headers): boolean {
  const bearer = authorizationCredential(headers);
  if (!bearer) return false;
  const effectiveAccountId = headers.get("chatgpt-account-id")
    ?? extractAccountId(undefined, bearer);
  return matchesMainQuotaCredential(bearer, effectiveAccountId);
}
