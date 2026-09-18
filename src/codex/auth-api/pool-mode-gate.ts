import { getCodexAccountCredential, getValidCodexToken, readCodexAccountRecord } from "../account-store";
import { getAccountQuota, isCompleteCodexQuotaRecoverySnapshot } from "../quota";
import { reconcileMainCodexAccountRuntimeState } from "../account-lifecycle";
import { claimDueCodexQuotaRecoveryProbes, settleCodexQuotaRecoveryProbe } from "../routing";
import { readCodexTokens } from "../auth-collision";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "../account-runtime-state";
import { getValidMainAccountToken, MainAccountTokenRefreshError, MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { captureConfigGeneration, registerStateSweepAfterTick } from "../../lib/state-store-sweeper";
import { captureMainAccountIdentityGeneration, isMainAccountIdentityGenerationLive } from "../main-account-cache";
import { getMainAccountHardLockStatus } from "../main-account-hard-lock";
import type { OcxConfig } from "../../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { providerCodexAccountMode } from "../../providers/registry";
import { isSelectableCodexPoolAccount } from "../account-id";
import type { AdmissionLease } from "../../lib/admission";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { withNativeMainCredentialClaim, isNativeMainClaimUnavailable } from "./http";
import type { PoolQuotaResult } from "./pool-quota-probe";
import { fetchMainAccountInfoAttempt, fetchMainAccountInfo } from "./main-account-probe";
import { fetchPoolAccountQuota, PoolQuotaProbeBusyError, POOL_CACHE_TTL, POOL_QUOTA_REFRESH_CONCURRENCY } from "./pool-quota-probe";
import { getRuntimeConfig, configuredPoolAccount, mapWithConcurrency } from "./runtime-config";

let primeInFlight: Promise<void> | null = null;
/**
 * Last prime attempt per pool account. A failed WHAM lookup stores no quota, so
 * without this the account stays "unknown" and every later prime trigger re-selects
 * it as stale and repeats the same failing request. Successful lookups are already
 * throttled by their stored updatedAt; this gives failures the same TTL backoff.
 *
 * Keyed by credential generation so a re-authentication, refresh, or account removal
 * retries immediately instead of waiting out a backoff earned by the old credential.
 */
const poolQuotaPrimeAttemptedAt = new Map<string, { generation: number; at: number }>();
let cooldownRecoveryInFlight: Promise<void> | null = null;

export async function runCodexCooldownRecoveryProbes(config: OcxConfig, now = Date.now()): Promise<void> {
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!openai
    || openai.disabled === true
    || !isCanonicalOpenAiForwardProvider(openai)
    || providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool") return;
  if (cooldownRecoveryInFlight) return cooldownRecoveryInFlight;
  cooldownRecoveryInFlight = (async () => {
    const claims = claimDueCodexQuotaRecoveryProbes(config, POOL_QUOTA_REFRESH_CONCURRENCY, now);
    await mapWithConcurrency(claims, POOL_QUOTA_REFRESH_CONCURRENCY, async claim => {
      const account = configuredPoolAccount(config, claim.accountId);
      if (!account) {
        settleCodexQuotaRecoveryProbe(claim, false, {}, now);
        return;
      }
      try {
        const result = await fetchPoolAccountQuota(claim.accountId, true, account.plan);
        // Defence in depth: independent scopes are already excluded at the claim site.
        // Generic WHAM must never clear Reserve even if claim selection changes.
        const recovered = (claim.scope === undefined || claim.scope === "shared")
          && isCompleteCodexQuotaRecoverySnapshot(result.freshQuota ?? null, result.freshPlan ?? account.plan);
        settleCodexQuotaRecoveryProbe(claim, recovered, {
          credentialGeneration: result.freshCredentialGeneration,
        }, now);
      } catch {
        settleCodexQuotaRecoveryProbe(claim, false, {}, now);
      }
    });
  })().catch(() => {
    // Background recovery is best-effort; routing keeps the cooldown on failure.
  }).finally(() => { cooldownRecoveryInFlight = null; });
  return cooldownRecoveryInFlight;
}

let mainHardLockRecoveryInFlight: Promise<void> | null = null;

/** Metadata-only recovery on the existing sweep; failures retain the observed policy block. */
export async function runMainAccountHardLockRecovery(config: OcxConfig): Promise<void> {
  if (mainHardLockRecoveryInFlight) return mainHardLockRecoveryInFlight;
  if (getMainAccountHardLockStatus(config).state !== "blocked"
    || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)) return;
  const lease = tryAcquireNativeMainProfileClaim();
  if (!lease) return;
  mainHardLockRecoveryInFlight = (async () => {
    reconcileMainCodexAccountRuntimeState();
    if (getMainAccountHardLockStatus(config).state !== "blocked"
      || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)) return;
    const identityGeneration = captureMainAccountIdentityGeneration();
    const writerGeneration = captureConfigGeneration();
    try {
      // Refresh can require an exclusive credential claim: never hold WHAM's shared
      // claim while obtaining a valid token. The runtime lease spans both operations.
      if (!await getValidMainAccountToken({ preserveReauth: true })) return;
    } catch (error) {
      if (error instanceof MainAccountTokenRefreshError && error.reason === "reauth"
        && isMainAccountIdentityGenerationLive(identityGeneration)) {
        markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID, writerGeneration);
      }
      return;
    }
    if (isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)) return;
    await fetchMainAccountInfoAttempt(true, 1, lease, false, false);
  })().catch(() => {
    // Best-effort background metadata read; no cooldown/pause or policy clearing on failure.
  }).finally(() => {
    lease.release();
    mainHardLockRecoveryInFlight = null;
  });
  return mainHardLockRecoveryInFlight;
}

export function registerCodexCooldownRecoveryProbeWorker(config: OcxConfig): void {
  registerStateSweepAfterTick({
    name: "codex-cooldown-recovery",
    afterTick: () => {
      void runCodexCooldownRecoveryProbes(config);
      void runMainAccountHardLockRecovery(config);
    },
  });
}

export interface PrimeCodexPoolQuotasOptions {
  /** Test seams for proving fenced/recovery priming performs no native-main work. */
  reconcileMainAccount?: typeof reconcileMainCodexAccountRuntimeState;
  readMainTokens?: typeof readCodexTokens;
  fetchMainInfo?: typeof fetchMainAccountInfo;
}

let getValidPoolTokenForPrime = getValidCodexToken;

/** Test-only: inject a deterministic pre-dispatch credential outcome for quota priming. */
export function setCodexPoolQuotaTokenResolverForTests(
  resolver: typeof getValidCodexToken,
): () => void {
  const previous = getValidPoolTokenForPrime;
  getValidPoolTokenForPrime = resolver;
  return () => {
    if (getValidPoolTokenForPrime === resolver) getValidPoolTokenForPrime = previous;
  };
}

export function tryAcquireNativeMainPrimeLease(): AdmissionLease | null {
  return tryAcquireNativeMainProfileClaim();
}

/**
 * Best-effort prime of pool-account (and main) quota so the rotation engine has
 * real usage scores instead of leaving every account at the unknown sentinel.
 *
 * Quota is otherwise populated only from live upstream headers (an idle pool
 * account never serves traffic, so it never gets scored) or from the dashboard
 * WHAM fetch (a CLI-only user never opens it). Without priming, every account
 * stays unknown and auto-switch cannot move (see Phase 10). This runs at startup
 * and lazily before routing when the active account is unknown.
 *
 * Single-flight: concurrent callers share one pass instead of stampeding N WHAM
 * fetches. Per-fetch 8s timeouts and the 5-minute POOL_CACHE_TTL already bound
 * cost, so the worst case is one WHAM call per account per TTL window. Failures
 * are swallowed: a blocked WSL network must never crash startup or a request.
 */
export async function primeCodexPoolQuotas(
  config: OcxConfig,
  reason: string,
  options: PrimeCodexPoolQuotasOptions = {},
): Promise<void> {
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  // Prune attempt markers for accounts that no longer exist BEFORE the eligibility
  // return. A removal that happens while the provider is disabled or out of pool mode
  // would otherwise leave a stale failure marker behind; restoring the same account id
  // within POOL_CACHE_TTL would then read that old failure as current and skip the
  // retry the restored credential is entitled to.
  const runtimeConfig = getRuntimeConfig(config);
  const configuredPoolIds = new Set((runtimeConfig.codexAccounts ?? []).map(account => account.id));
  for (const accountId of poolQuotaPrimeAttemptedAt.keys()) {
    if (!configuredPoolIds.has(accountId)) poolQuotaPrimeAttemptedAt.delete(accountId);
  }
  if (
    !openai
    || openai.disabled === true
    || !isCanonicalOpenAiForwardProvider(openai)
    || providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool"
  ) return;
  if (primeInFlight) return primeInFlight;
  primeInFlight = (async () => {
    const pool = (runtimeConfig.codexAccounts ?? []).filter(isSelectableCodexPoolAccount);
    const stale = pool.filter(a => {
      const q = getAccountQuota(a.id);
      if (q) return Date.now() - q.updatedAt >= POOL_CACHE_TTL;
      // No stored quota: either never primed, or the last attempt failed. Retry only
      // once per TTL window so an unreachable or rejecting account cannot turn every
      // prime trigger into another upstream request.
      const lastAttempt = poolQuotaPrimeAttemptedAt.get(a.id);
      if (!lastAttempt) return true;
      // A newer credential invalidates the previous failure: retry without waiting.
      if (lastAttempt.generation !== readCodexAccountRecord(a.id)?.generation) return true;
      return Date.now() - lastAttempt.at >= POOL_CACHE_TTL;
    });
    const primeMain = async () => {
      const mainLease = tryAcquireNativeMainPrimeLease();
      if (!mainLease) return;
      try {
        try {
          await withNativeMainCredentialClaim(async () => {
            // Keep one local owner and one cross-process reader from physical
            // identity reconciliation through WHAM and all quota publication.
            (options.reconcileMainAccount ?? reconcileMainCodexAccountRuntimeState)();
            if (getAccountQuota(MAIN_CODEX_ACCOUNT_ID)) return;
            if (!(options.readMainTokens ?? readCodexTokens)()) return;
            if (options.fetchMainInfo) await options.fetchMainInfo(false);
            else await fetchMainAccountInfoAttempt(false, 1, mainLease, true);
          });
        } catch (error) {
          if (!isNativeMainClaimUnavailable(error)) throw error;
        }
      } finally {
        mainLease.release();
      }
    };
    try {
      await Promise.allSettled([
        primeMain(),
        mapWithConcurrency(stale, POOL_QUOTA_REFRESH_CONCURRENCY, async a => {
          if (!getCodexAccountCredential(a.id)) return;
          let result: PoolQuotaResult;
          try {
            result = await fetchPoolAccountQuota(a.id, false, a.plan, getValidPoolTokenForPrime);
          } catch (error) {
            // Local quota-flight saturation proves no WHAM request existed for this account.
            // Consume it per item so sibling workers remain inside the shared prime lifetime.
            if (error instanceof PoolQuotaProbeBusyError) return;
            throw error;
          }
          // Only the data-plane function knows whether upstream dispatch began. Any
          // cache hit, credential deferral, or local admission failure remains eligible.
          const attempted = result.quotaProbeAttempted;
          if (!attempted) return;
          if (!configuredPoolAccount(getRuntimeConfig(config), a.id)) {
            poolQuotaPrimeAttemptedAt.delete(a.id);
            return;
          }
          poolQuotaPrimeAttemptedAt.set(a.id, {
            // getValidCodexToken may rotate the credential before WHAM is sent.
            // Bind the backoff to the generation that actually made the request;
            // otherwise the next prime sees a false generation change and retries
            // the same failed WHAM call immediately.
            generation: attempted.credentialGeneration,
            at: attempted.at,
          });
        }),
      ]);
    } catch {
      // Priming is best-effort; never propagate.
    }
    if (process.env.OPENCODEX_DEBUG_QUOTA === "1") {
      console.warn(`[codex-quota] prime done (reason=${reason}, pool=${pool.length}, refreshed=${stale.length})`);
    }
  })().finally(() => { primeInFlight = null; });
  return primeInFlight;
}

/** Test-only: drop any in-flight prime pass so a leaked single-flight promise
 * from another suite cannot coalesce into the next prime. */
export function clearCodexQuotaPrimeState(): void {
  primeInFlight = null;
  poolQuotaPrimeAttemptedAt.clear();
  getValidPoolTokenForPrime = getValidCodexToken;
}

/** Test-only: drop the shared single-flight promise while keeping the per-account
 * failure backoff, so a test can trigger a second real prime pass and still observe
 * the throttle a production caller would see. */
export function clearCodexQuotaPrimeSingleFlightForTests(): void {
  primeInFlight = null;
}

/** Test-only reset for the worker-level single-flight. */
export function clearCodexCooldownRecoveryProbeState(): void {
  cooldownRecoveryInFlight = null;
}
