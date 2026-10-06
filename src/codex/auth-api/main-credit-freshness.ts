import { codexAccountUsesCreditsAfterLimit, codexUsageLimitResetAt } from "../account-credit-use";
import { isAccountNeedsReauth } from "../account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { getMainQuotaCredentialGeneration } from "../main-account-cache";
import { getMainAccountHardLockStatus } from "../main-account-hard-lock";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { getMainPolicyQuota } from "../quota";
import { nextCodexUsageQueryAt } from "../quota-query-backoff";
import { CODEX_CREDITS_FRESHNESS_MS } from "../quota-types";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import type { OcxConfig } from "../../types";
import { fetchMainAccountInfoAttempt } from "./main-account-probe";

/**
 * Re-read opted-in main credits once they are this old. Usage headers never re-observe a balance
 * and nothing on the request path reads WHAM for an already-known main quota, so without this the
 * only refresh was the dashboard poll behind a five-minute cache, which reliably lands after
 * `CODEX_CREDITS_FRESHNESS_MS` and stops while the dashboard is hidden. Two minutes of margin
 * covers the one-minute sweep tick plus a slow WHAM read.
 */
export const MAIN_CREDITS_REFRESH_AFTER_MS = CODEX_CREDITS_FRESHNESS_MS - 2 * 60_000;

let mainCreditRefreshInFlight: Promise<void> | null = null;

/**
 * Keep the evidence that lets an opted-in, exhausted main login spend credits from expiring on the
 * sweep. Metadata only: it never clears a cooldown, a hard lock or a retraction, and it reads WHAM
 * only while the main credit hold would otherwise apply.
 */
export async function runMainCreditFreshnessRefresh(config: OcxConfig): Promise<void> {
  if (mainCreditRefreshInFlight) return mainCreditRefreshInFlight;
  if (!codexAccountUsesCreditsAfterLimit(config, MAIN_CODEX_ACCOUNT_ID)) return;
  const now = Date.now();
  const quota = getMainPolicyQuota();
  const credits = quota?.credits;
  // Retracted, empty or refused credit evidence cannot lift the hold; leave it to explicit reads.
  // Age is deliberately not checked here: a stale positive balance is exactly what to refresh.
  if (!credits || credits.hasCredits === false || credits.overageLimitReached === true
    || credits.allowed === false
    || (credits.unlimited !== true && !(typeof credits.balance === "number" && credits.balance > 0))) return;
  if (codexUsageLimitResetAt(quota, undefined, now) === undefined) return;
  if (Number.isFinite(credits.observedAt) && now - credits.observedAt < MAIN_CREDITS_REFRESH_AFTER_MS) return;
  // The hard lock refuses the main login regardless of credits and paces its own recovery reads.
  if (getMainAccountHardLockStatus(config).state === "blocked") return;
  if (isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)) return;
  const queryAfter = nextCodexUsageQueryAt(`main:${captureConfigGeneration()}:${getMainQuotaCredentialGeneration()}`);
  if ((queryAfter ?? 0) > now) return;
  const lease = tryAcquireNativeMainProfileClaim();
  if (!lease) return;
  mainCreditRefreshInFlight = fetchMainAccountInfoAttempt(true, 1, lease, false, false, false, config)
    .then(() => undefined, () => undefined)
    .finally(() => {
      lease.release();
      mainCreditRefreshInFlight = null;
    });
  return mainCreditRefreshInFlight;
}
