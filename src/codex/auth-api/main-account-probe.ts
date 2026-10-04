import { parseCodexCredits, rememberCodexCredits } from "../credits";
import { fetchCodexUsage } from "../quota-query-backoff";
import type { CodexUsageOwner } from "../quota-query-backoff";
import { loadConfig } from "../../config";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { providerCodexAccountMode } from "../../providers/registry";
import { isSelectableCodexPoolAccount } from "../account-id";
import type { OcxConfig } from "../../types";
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
import { isCodexTerminalAuthCode } from "../quota-refresh-outcome";
import type { CodexQuotaRefreshOutcome, CodexTerminalAuthCode } from "../quota-refresh-outcome";
import { observeMainReserveRevocation } from "../reserve-availability";
import type { AdmissionLease } from "../../lib/admission";
import { nonEmptyPlan } from "./runtime-config";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { WHAM_REQUEST_TIMEOUT_MS } from "../quota-recovery-timing";
import { withNativeMainCredentialClaim, isNativeMainClaimUnavailable } from "./http";
import { readMainAuthErrorCode, currentQuotaDispatchSequence, nextQuotaDispatchSequence, isQuotaDispatchCurrent, publishQuotaDispatch } from "./pool-quota-probe";

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

function sharedMainQuotaPacingEnabled(config: OcxConfig): boolean {
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (openai?.disabled === true || openai?.codexAccountMode === "direct") return false;
  return (openai !== undefined && isCanonicalOpenAiForwardProvider(openai)
    && providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) === "pool")
    || (config.codexAccounts ?? []).some(isSelectableCodexPoolAccount);
}

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
  return (await classifyMainAuthResponse(resp, accessTokenLive)).terminal;
}

/** As `isTerminalMainAuthResponse`, also naming the provider code that made it terminal. */
async function classifyMainAuthResponse(
  resp: Response,
  accessTokenLive: boolean,
): Promise<{ terminal: boolean; code?: CodexTerminalAuthCode }> {
  if (resp.status !== 401 && resp.status !== 403) return { terminal: false };
  const code = await readMainAuthErrorCode(resp);
  if (isCodexTerminalAuthCode(code)) return { terminal: true, code };
  return { terminal: resp.status === 401 && !accessTokenLive };
}

export interface MainResetQuotaProof {
  writer: MainQuotaWriter;
  credentialGeneration: number;
}

export interface MainAccountInfoFetchResult {
  info: MainAccountInfo;
  /** Parsed ordinary info from a stale credential; callers must not display it as shared state. */
  infoUnpublished?: true;
  resetRecoveryProof?: MainResetQuotaProof & { dispatchSequence: number };
  /** Ephemeral result of this attempt, omitted when no WHAM request was made. */
  quotaRefresh?: CodexQuotaRefreshOutcome;
  /** Internal dispatch fence for diagnostics only; never copied into a public DTO or cache. */
  quotaRefreshGeneration?: number;
  /** This current-credential usage response supplied terminal auth evidence; never public. */
  terminalAuthFailure?: true;
  /** Whether this attempt safely inspected the physical native-main credential. */
  credentialChecked: boolean;
  /** Meaningful only when credentialChecked is true. */
  hasCredential: boolean;
  /** Main identity generation captured while the native-main claim was held. */
  identityGeneration?: number;
  /** Freshly parsed usage from the current credential; stale ordinary return values are excluded. */
  freshQuota?: Omit<StoredAccountQuota, "updatedAt">;
  /** Current-credential response's `rate_limit_reset_credits.available_count`, when present. */
  freshResetCredits?: number;
}

export interface MainAccountInfoSnapshot {
  info: MainAccountInfo;
  /** Ordinary info that was never published and must not become provider quota. */
  infoUnpublished?: true;
  mainIdentityGeneration: number;
  quotaRefresh?: CodexQuotaRefreshOutcome;
}

export async function fetchMainAccountInfoSnapshot(forceRefresh = false, config?: OcxConfig): Promise<MainAccountInfoSnapshot> {
  const result = await fetchMainAccountInfoAttempt(forceRefresh, 1, undefined, false, forceRefresh, false, config);
  return {
    info: result.info,
    ...(result.infoUnpublished ? { infoUnpublished: true as const } : {}),
    ...(result.quotaRefresh && result.quotaRefreshGeneration !== undefined
      && isMainAccountIdentityGenerationLive(result.quotaRefreshGeneration)
      ? { quotaRefresh: result.quotaRefresh } : {}),
    mainIdentityGeneration: result.identityGeneration ?? captureMainAccountIdentityGeneration(),
  };
}

export async function fetchMainAccountInfo(forceRefresh = false, config?: OcxConfig): Promise<MainAccountInfo> {
  return (await fetchMainAccountInfoSnapshot(forceRefresh, config)).info;
}

export const EMPTY_MAIN_ACCOUNT_INFO: MainAccountInfo = { email: null, plan: null, quota: null };

export async function retryMainAccountInfoIfIdentityChanged(
  requestAccountId: string | null,
  retriesRemaining: number,
  nativeMainLease: AdmissionLease,
  explicitRefresh: boolean,
  paced: boolean,
): Promise<MainAccountInfoFetchResult | null> {
  const currentAccountId = getMainChatgptAccountId();
  if (currentAccountId === null || currentAccountId === requestAccountId) return null;
  reconcileMainCodexAccountRuntimeState();
  return retriesRemaining > 0
    ? fetchMainAccountInfoWhileOwned(true, retriesRemaining - 1, nativeMainLease, explicitRefresh, false, paced)
    : { info: EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: true };
}

export async function fetchMainAccountInfoAttempt(
  forceRefresh: boolean,
  retriesRemaining: number,
  existingNativeMainLease?: AdmissionLease,
  nativeMainSharedClaimHeld = false,
  explicitRefresh: boolean = forceRefresh,
  postReset = false,
  config?: OcxConfig,
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
    const paced = sharedMainQuotaPacingEnabled(config ?? loadConfig());
    const operation = async () => ({
      ...await fetchMainAccountInfoWhileOwned(forceRefresh, retriesRemaining, nativeMainLease, explicitRefresh, postReset, paced),
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

/**
 * Read native-main usage while ownership is held, publishing only current credential evidence.
 * A replaced same-account bearer may return its parsed ordinary info without mutating shared
 * state or supplying recovery proof. Conflicting identities and stale errors return cached info.
 */
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
  /** Reset-credit consume needs a fresh post-spend observation, not an earlier read. */
  postReset = false,
  paced = true,
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
  /** A disk replacement may have no second probe to advance the credential generation. */
  const credentialIsCurrent = (): boolean => {
    const current = readCodexTokensResult(undefined, { bounded: true });
    if (current.status !== "ok") return false;
    const effectiveAccountId = extractAccountId(current.tokens.id_token, current.tokens.access_token)
      ?? (current.tokens.account_id || null);
    if (effectiveAccountId !== current.tokens.account_id || effectiveAccountId !== requestAccountId) return false;
    observeMainQuotaCredential(current.tokens.access_token, current.tokens.account_id);
    return mainQuotaWriter !== undefined
      && isMainQuotaWriterLive(mainQuotaWriter)
      && mainQuotaCredentialGeneration === getMainQuotaCredentialGeneration()
      && matchesMainQuotaCredential(tokens.access_token, tokens.account_id);
  };
  // Keep diagnostics separate from authentication and freshness policy. Never serialize errors.
  const quotaSignal = AbortSignal.timeout(WHAM_REQUEST_TIMEOUT_MS);
  let quotaPhase: "request" | "body" | "decode" | "publish" = "request";
  let quotaRefreshGeneration = captureMainAccountIdentityGeneration();
  const readState: { owner?: CodexUsageOwner<MainAccountInfoFetchResult>; usable: boolean } = { usable: false };
  const read = async (): Promise<MainAccountInfoFetchResult> => {
    try {
      let dispatchSequence = 0;
      const baseKey = `main:${writerGeneration}:${mainQuotaCredentialGeneration}`;
      const resetEpoch = postReset ? `:post-reset:${currentQuotaDispatchSequence()}` : "";
      const admission = await fetchCodexUsage<MainAccountInfoFetchResult>(
        `${baseKey}${resetEpoch}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
        signal: quotaSignal,
      }, () => { dispatchSequence = nextQuotaDispatchSequence(); },
      paced ? { pacingKey: baseKey } : { unpaced: true });
      if (!admission) return { info: getMainAccountInfoCache() ?? EMPTY_MAIN_ACCOUNT_INFO,
        credentialChecked: true, hasCredential: true };
      if (admission.kind === "joined") {
        const current = credentialIsCurrent() && writerGeneration === captureConfigGeneration();
        if (!current) return { info: getMainAccountInfoCache() ?? EMPTY_MAIN_ACCOUNT_INFO,
          credentialChecked: true, hasCredential: true };
        if (explicitRefresh && (admission.result.quotaRefresh?.status === "ok"
          || admission.result.quotaRefresh?.status === "not_reported")) clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        return admission.result;
      }
      readState.owner = admission;
      const resp = admission.response;
      quotaPhase = "publish";
      if (!resp.ok) {
        const authFailure = await classifyMainAuthResponse(resp, isMainAccountTokenVerifiablyLive());
        const terminalAuthFailure = authFailure.terminal;
        const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh, paced);
        if (retried) return retried;
        if (!isQuotaDispatchCurrent(dispatchSequence) || !credentialIsCurrent()) {
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
        // Keep the last-known plan visible: after a plan change revokes the session, the plan the
        // account HAD is what tells the operator why it stopped working.
        return {
          info: { ...EMPTY_MAIN_ACCOUNT_INFO, plan: nonEmptyPlan(cached?.plan) ?? nonEmptyPlan(getMainAccountPlan()) },
          credentialChecked: true, hasCredential: true,
          quotaRefresh: { status: "http_error", httpStatus: resp.status,
            ...(authFailure.code ? { code: authFailure.code } : {}) },
          quotaRefreshGeneration,
          ...(terminalAuthFailure ? { terminalAuthFailure: true as const } : {}),
        };
      }
      quotaPhase = "body";
      const data = (await resp.json()) as WhamUsageResponse;
      quotaPhase = "publish";
      const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh, paced);
      if (retried) return retried;
      quotaPhase = "decode";
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Invalid WHAM usage object");
      }
      // A newer published response wins over this attempt, including its returned display info.
      if (!isQuotaDispatchCurrent(dispatchSequence)) {
        return { info: getMainAccountInfoCache() ?? EMPTY_MAIN_ACCOUNT_INFO,
          credentialChecked: true, hasCredential: true };
      }
      quotaPhase = "publish";
      // A delayed response from a replaced bearer cannot revoke a newer Reserve grant,
      // even in the same workspace or after an A→B→A credential transition.
      if (credentialIsCurrent()) {
        observeMainReserveRevocation(data, mainQuotaWriter);
      }
      quotaPhase = "decode";
      const plan = nonEmptyPlan(data.plan_type) ?? nonEmptyPlan(cached?.plan) ?? nonEmptyPlan(getMainAccountPlan());
      const usage = { ...data, ...(plan ? { plan_type: plan } : {}) };
      const quota = parseUsageQuota(usage);
      const policyQuota = parseMainPolicyUsageQuota(usage);
      quotaPhase = "publish";
      const result = {
        email: data.email ?? null,
        plan,
        quota,
        ts: Date.now(),
      };
      if (!credentialIsCurrent()) {
        // Preserve same-identity ordinary info, but never publish stale evidence or state.
        if (mainQuotaWriter && isMainQuotaWriterLive(mainQuotaWriter)) {
          return { info: result, infoUnpublished: true, credentialChecked: true, hasCredential: true };
        }
        return { info: getMainAccountInfoCache() ?? EMPTY_MAIN_ACCOUNT_INFO,
          credentialChecked: true, hasCredential: true };
      }
      const freshResetCredits = quota?.resetCredits;
      // Tag the count with the identity it was read from, so a later response that omits the
      // summary can restore the badge without ever crossing an account boundary.
      rememberMainResetCredits(requestAccountId, freshResetCredits);
      if (requestAccountId !== null) rememberCodexCredits(MAIN_CODEX_ACCOUNT_ID, requestAccountId, parseCodexCredits(data.credits));
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
      readState.usable = quota !== null;
      return {
        info: result,
        quotaRefresh: { status: quota ? "ok" : "not_reported" },
        quotaRefreshGeneration,
        credentialChecked: true,
        hasCredential: true,
        ...(quota ? { freshQuota: quota } : {}),
        ...(quota && mainQuotaWriter && credentialIsCurrent()
          ? { resetRecoveryProof: { writer: mainQuotaWriter, credentialGeneration: mainQuotaCredentialGeneration, dispatchSequence } }
          : {}),
        ...(freshResetCredits !== undefined ? { freshResetCredits } : {}),
      };
    } catch (error) {
      const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh, paced);
      if (retried) return retried;
      if (!credentialIsCurrent()) {
        return { info: getMainAccountInfoCache() ?? EMPTY_MAIN_ACCOUNT_INFO,
          credentialChecked: true, hasCredential: true };
      }
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
  };
  let outcome: MainAccountInfoFetchResult | undefined;
  try { outcome = await read(); return outcome; }
  finally { readState.owner?.settle(readState.usable, outcome); }
}
