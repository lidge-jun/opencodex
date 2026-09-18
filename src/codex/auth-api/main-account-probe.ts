import { parseMainPolicyUsageQuota, parseUsageQuota, setAccountQuotaFromParsed } from "../quota";
import type { StoredAccountQuota, WhamUsageResponse } from "../quota";
import { reconcileMainCodexAccountRuntimeState } from "../account-lifecycle";
import { getMainChatgptAccountId, readCodexTokensResult } from "../auth-collision";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../account-runtime-state";
import { extractAccountId } from "../../oauth/chatgpt";
import { getMainAccountPlan, isMainAccountTokenVerifiablyLive, MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "../main-account";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { captureMainAccountIdentityGeneration, clearMainAccountInfoCache, getMainAccountInfoCache, getMainQuotaCredentialGeneration, isMainAccountIdentityGenerationLive, isMainQuotaWriterLive, matchesMainQuotaCredential, observeMainQuotaCredential, setMainAccountCredentialPresence, setMainAccountInfoCache } from "../main-account-cache";
import type { MainQuotaWriter, MainAccountInfo } from "../main-account-cache";
import type { CodexQuotaRefreshOutcome } from "../quota-refresh-outcome";
import { observeMainReserveRevocation } from "../reserve-availability";
import type { AdmissionLease } from "../../lib/admission";
import { nonEmptyPlan } from "./runtime-config";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { WHAM_REQUEST_TIMEOUT_MS } from "../quota-recovery-timing";
import { withNativeMainCredentialClaim, isNativeMainClaimUnavailable } from "./http";
import { MAIN_TERMINAL_AUTH_CODES, readMainAuthErrorCode, nextQuotaDispatchSequence, isQuotaDispatchCurrent, publishQuotaDispatch } from "./pool-quota-probe";

/**
 * Last reset-credit count this process parsed for the main account, tagged with the
 * physical ChatGPT account it was read from.
 *
 * It is deliberately memory-only. The quota store is keyed by the stable `__main__`
 * ALIAS, and `~/.codex/auth.json` can be swapped for another account while the proxy is
 * not running — `reconcileMainCodexAccountRuntimeState` only purges alias-keyed state
 * when it observes the id CHANGE, and its first observation after a restart has nothing
 * to compare against. A disk-hydrated `__main__` entry can therefore belong to the
 * previous login, so filling the DTO from it would show one account's tickets on
 * another's card. Pool accounts have no such hole because their store key IS the account
 * id. Binding the value to `requestAccountId` keeps the fill honest: after a restart the
 * badge simply waits for the first usage response that carries the summary.
 */
let mainResetCreditsProvenance: { accountId: string; credits: number } | null = null;

export function rememberMainResetCredits(accountId: string | null, credits: number | undefined): void {
  if (accountId === null || credits === undefined) return;
  mainResetCreditsProvenance = { accountId, credits };
}

/** Forget the remembered count when the physical main identity is no longer the same. */
export function mainResetCreditsForCurrentIdentity(): number | undefined {
  if (!mainResetCreditsProvenance) return undefined;
  const currentAccountId = getMainChatgptAccountId();
  if (currentAccountId === null) return undefined;
  if (currentAccountId !== mainResetCreditsProvenance.accountId) {
    mainResetCreditsProvenance = null;
    return undefined;
  }
  return mainResetCreditsProvenance.credits;
}

export const MAIN_CACHE_TTL = 5 * 60_000;

/**
 * A WHAM 401 is not itself proof the local credential died. Upstream edges can
 * transiently reject a still-valid access token (region/anti-abuse/rotation
 * races), and fail-closing on every bare 401 makes a healthy main account flip
 * needs-reauth on the next GUI quota poll. Only treat the response as terminal
 * when the body carries a known terminal code or the local access token is not
 * verifiably live (`accessTokenLive`). Liveness must be strict: a JWT whose
 * `exp` cannot be decoded is NOT live — an undecodable token that vouched for
 * itself would make a real 401 permanently transient.
 */
export async function isTerminalMainAuthResponse(resp: Response, accessTokenLive: boolean): Promise<boolean> {
  if (resp.status === 401) {
    if (!accessTokenLive) return true;
    const code = await readMainAuthErrorCode(resp);
    return typeof code === "string" && MAIN_TERMINAL_AUTH_CODES.has(code);
  }
  if (resp.status !== 403) return false;
  const code = await readMainAuthErrorCode(resp);
  return typeof code === "string" && MAIN_TERMINAL_AUTH_CODES.has(code);
}

export interface MainResetQuotaProof {
  writer: MainQuotaWriter;
  credentialGeneration: number;
}

export interface MainAccountInfoFetchResult {
  info: MainAccountInfo;
  resetRecoveryProof?: MainResetQuotaProof & { dispatchSequence: number };
  /** Ephemeral result of this attempt, omitted when no WHAM request was made. */
  quotaRefresh?: CodexQuotaRefreshOutcome;
  /** Internal dispatch fence for diagnostics only; never copied into a public DTO or cache. */
  quotaRefreshGeneration?: number;
  /** Whether this attempt safely inspected the physical native-main credential. */
  credentialChecked: boolean;
  /** Meaningful only when credentialChecked is true. */
  hasCredential: boolean;
  /** Main identity generation captured while the native-main claim was held. */
  identityGeneration?: number;
  /** Present only when this call freshly parsed a WHAM usage response. */
  freshQuota?: Omit<StoredAccountQuota, "updatedAt">;
  /** Present only when this call's WHAM response included `rate_limit_reset_credits.available_count`. */
  freshResetCredits?: number;
}

export interface MainAccountInfoSnapshot {
  info: MainAccountInfo;
  mainIdentityGeneration: number;
  quotaRefresh?: CodexQuotaRefreshOutcome;
}

export async function fetchMainAccountInfoSnapshot(forceRefresh = false): Promise<MainAccountInfoSnapshot> {
  const result = await fetchMainAccountInfoAttempt(forceRefresh, 1);
  return {
    info: result.info,
    ...(result.quotaRefresh && result.quotaRefreshGeneration !== undefined
      && isMainAccountIdentityGenerationLive(result.quotaRefreshGeneration)
      ? { quotaRefresh: result.quotaRefresh } : {}),
    mainIdentityGeneration: result.identityGeneration ?? captureMainAccountIdentityGeneration(),
  };
}

export async function fetchMainAccountInfo(forceRefresh = false): Promise<MainAccountInfo> {
  return (await fetchMainAccountInfoSnapshot(forceRefresh)).info;
}

export const EMPTY_MAIN_ACCOUNT_INFO: MainAccountInfo = { email: null, plan: null, quota: null };

export async function retryMainAccountInfoIfIdentityChanged(
  requestAccountId: string | null,
  retriesRemaining: number,
  nativeMainLease: AdmissionLease,
  explicitRefresh: boolean,
): Promise<MainAccountInfoFetchResult | null> {
  const currentAccountId = getMainChatgptAccountId();
  if (currentAccountId === null || currentAccountId === requestAccountId) return null;
  reconcileMainCodexAccountRuntimeState();
  return retriesRemaining > 0
    ? fetchMainAccountInfoWhileOwned(true, retriesRemaining - 1, nativeMainLease, explicitRefresh)
    : { info: EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: true };
}

export async function fetchMainAccountInfoAttempt(
  forceRefresh: boolean,
  retriesRemaining: number,
  existingNativeMainLease?: AdmissionLease,
  nativeMainSharedClaimHeld = false,
  explicitRefresh: boolean = forceRefresh,
): Promise<MainAccountInfoFetchResult> {
  const nativeMainLease = existingNativeMainLease ?? tryAcquireNativeMainProfileClaim();
  if (!nativeMainLease) {
    return {
      info: EMPTY_MAIN_ACCOUNT_INFO,
      credentialChecked: false,
      hasCredential: false,
      identityGeneration: captureMainAccountIdentityGeneration(),
    };
  }
  try {
    const operation = async () => ({
      ...await fetchMainAccountInfoWhileOwned(forceRefresh, retriesRemaining, nativeMainLease, explicitRefresh),
      identityGeneration: captureMainAccountIdentityGeneration(),
    });
    if (nativeMainSharedClaimHeld) return await operation();
    try {
      return await withNativeMainCredentialClaim(operation);
    } catch (error) {
      if (isNativeMainClaimUnavailable(error)) {
        return {
          info: EMPTY_MAIN_ACCOUNT_INFO,
          credentialChecked: false,
          hasCredential: false,
          identityGeneration: captureMainAccountIdentityGeneration(),
        };
      }
      throw error;
    }
  } finally {
    if (!existingNativeMainLease) nativeMainLease.release();
  }
}

export async function fetchMainAccountInfoWhileOwned(
  forceRefresh: boolean,
  retriesRemaining: number,
  nativeMainLease: AdmissionLease,
  /**
   * Whether the *caller* asked for this refresh. `forceRefresh` also means "bypass the
   * cache", and `retryMainAccountInfoIfIdentityChanged` re-enters with it set purely to
   * re-read after the identity changed. Keeping the two apart stops that retry from
   * promoting a background poll into operator intent below.
   */
  explicitRefresh: boolean = forceRefresh,
): Promise<MainAccountInfoFetchResult> {
  const writerGeneration = captureConfigGeneration();
  reconcileMainCodexAccountRuntimeState();
  const tokenRead = readCodexTokensResult();
  setMainAccountCredentialPresence(tokenRead.status === "ok");
  if (tokenRead.status !== "ok") {
    // A local read failure is NOT proof of sign-out: a missing file can be a non-atomic rewrite
    // gap, and malformed JSON can be a half-written file. Clearing the cache and marking the
    // account for reauth here destroyed healthy email/plan/quota state and pinned a working
    // account as unusable. Preserve what we already know and let the caller retry; request
    // routing stays fail-closed because getMainAccountToken() re-reads the file itself, and the
    // account DTO still reports hasCredential=false while the file is unreadable.
    const preserved = getMainAccountInfoCache();
    return { info: preserved ?? EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: false };
  }
  const tokens = tokenRead.tokens;
  const requestAccountId = extractAccountId(tokens.id_token, tokens.access_token) ?? (tokens.account_id || null);
  const cached = getMainAccountInfoCache();
  if (!forceRefresh && cached && Date.now() - cached.ts < MAIN_CACHE_TTL) {
    return { info: cached, credentialChecked: true, hasCredential: true };
  }
  // Bind quota to the owned credential and the account actually selected by WHAM's header.
  // A conflicting legacy token/account tuple is not evidence for the new policy.
  const mainQuotaWriter = requestAccountId === tokens.account_id
    ? observeMainQuotaCredential(tokens.access_token, tokens.account_id)
    : undefined;
  const mainQuotaCredentialGeneration = getMainQuotaCredentialGeneration();
  // Keep diagnostics separate from authentication and freshness policy. Never serialize errors.
  const quotaSignal = AbortSignal.timeout(WHAM_REQUEST_TIMEOUT_MS);
  let quotaPhase: "request" | "body" | "decode" | "publish" = "request";
  let quotaRefreshGeneration = captureMainAccountIdentityGeneration();
  try {
    const dispatchSequence = nextQuotaDispatchSequence();
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
      signal: quotaSignal,
    });
    quotaPhase = "publish";
    if (!resp.ok) {
      const terminalAuthFailure = await isTerminalMainAuthResponse(resp, isMainAccountTokenVerifiablyLive());
      const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh);
      if (retried) return retried;
      if (!isQuotaDispatchCurrent(dispatchSequence)) {
        return { info: getMainAccountInfoCache() ?? EMPTY_MAIN_ACCOUNT_INFO,
          credentialChecked: true, hasCredential: true };
      }
      if (terminalAuthFailure) {
        // Account for this attempt's own synchronous invalidation, never prior external drift.
        const diagnosticStillLive = isMainAccountIdentityGenerationLive(quotaRefreshGeneration);
        clearMainAccountInfoCache();
        if (diagnosticStillLive) quotaRefreshGeneration = captureMainAccountIdentityGeneration();
        markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID, writerGeneration);
      }
      return {
        info: EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: true,
        quotaRefresh: { status: "http_error", httpStatus: resp.status },
        quotaRefreshGeneration,
      };
    }
    quotaPhase = "body";
    const data = (await resp.json()) as WhamUsageResponse;
    quotaPhase = "publish";
    const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh);
    if (retried) return retried;
    quotaPhase = "decode";
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid WHAM usage object");
    }
    // Check after body/retry awaits and before any cache, credits, policy or
    // Reserve publication. Returning cached state supplies no fresh recovery proof.
    if (!isQuotaDispatchCurrent(dispatchSequence)) {
      return { info: getMainAccountInfoCache() ?? EMPTY_MAIN_ACCOUNT_INFO,
        credentialChecked: true, hasCredential: true };
    }
    quotaPhase = "publish";
    // A delayed response from a replaced bearer cannot revoke a newer Reserve grant,
    // even in the same workspace or after an A→B→A credential transition.
    if (mainQuotaCredentialGeneration === getMainQuotaCredentialGeneration()
      && matchesMainQuotaCredential(tokens.access_token, tokens.account_id)) {
      observeMainReserveRevocation(data, mainQuotaWriter);
    }
    quotaPhase = "decode";
    const plan = nonEmptyPlan(data.plan_type) ?? nonEmptyPlan(cached?.plan) ?? nonEmptyPlan(getMainAccountPlan());
    const usage = { ...data, ...(plan ? { plan_type: plan } : {}) };
    const quota = parseUsageQuota(usage);
    const policyQuota = parseMainPolicyUsageQuota(usage);
    quotaPhase = "publish";
    const freshResetCredits = quota?.resetCredits;
    // Tag the count with the identity it was read from, so a later response that omits the
    // summary can restore the badge without ever crossing an account boundary.
    rememberMainResetCredits(requestAccountId, freshResetCredits);
    const result = {
      email: data.email ?? null,
      plan,
      quota,
      ts: Date.now(),
    };
    setMainAccountInfoCache(result);
    // Only an explicit refresh may retract a reauth quarantine. A 200 from
    // /wham/usage proves the token authenticates to the usage endpoint; it does not
    // prove the account can serve Responses traffic, which is a different backend path
    // and still answers 403 for a workspace the token may no longer select (#327).
    // Letting the background poll clear the flag put such an account straight back into
    // rotation: the next request failed the same way and re-marked it, so needsReauth
    // never settled and the dashboard kept showing nothing — the symptom #327 reported.
    // An explicit refresh is an operator asking to re-evaluate, normally right after
    // signing in again, so it stays authoritative.
    if (explicitRefresh) clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    // Mirror main quota + plan into the shared stores so the rotation engine can
    // score and auto-switch the main account exactly like a pool account (Option A).
    setMainAccountPlan(result.plan);
    if (result.quota) {
      setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, result.quota, writerGeneration, mainQuotaWriter, policyQuota);
    }
    publishQuotaDispatch(dispatchSequence);
    return {
      info: result,
      quotaRefresh: { status: quota ? "ok" : "not_reported" },
      quotaRefreshGeneration,
      credentialChecked: true,
      hasCredential: true,
      ...(quota ? { freshQuota: quota } : {}),
      ...(quota && mainQuotaWriter && isMainQuotaWriterLive(mainQuotaWriter)
        && mainQuotaCredentialGeneration === getMainQuotaCredentialGeneration()
        && matchesMainQuotaCredential(tokens.access_token, tokens.account_id)
        ? { resetRecoveryProof: { writer: mainQuotaWriter, credentialGeneration: mainQuotaCredentialGeneration, dispatchSequence } }
        : {}),
      ...(freshResetCredits !== undefined ? { freshResetCredits } : {}),
    };
  } catch (error) {
    const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh);
    if (retried) return retried;
    let status: CodexQuotaRefreshOutcome["status"] = "internal_error";
    if ((quotaPhase === "request" || quotaPhase === "body") && quotaSignal.aborted) status = "timeout";
    else if (quotaPhase === "request") status = "network_error";
    else if (quotaPhase === "body") status = error instanceof SyntaxError ? "invalid_response" : "network_error";
    else if (quotaPhase === "decode") status = "invalid_response";
    return {
      info: EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: true,
      quotaRefresh: { status },
      quotaRefreshGeneration,
    };
  }
}
