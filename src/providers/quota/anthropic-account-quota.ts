import { loadConfig } from "../../config";
import type { OcxConfig } from "../../types";
import { getAccountSet } from "../../oauth/store";
import { captureConfigGeneration, sweepExpiredOnWrite } from "../../lib/state-store-sweeper";
import { configuredAnthropicInstance, type AnthropicInstanceId } from "../anthropic-instance";
import { ACCOUNT_QUOTA_TTL_MS } from "../quota-wire";
import { fetchAnthropicUsageProbeForInstance } from "./vendor-probes-oauth";
import { thrownQuotaFailure } from "./failure-codes";
import type { QuotaFailureCode } from "../quota-types";
import { AnthropicQuotaProbeOwnershipError, anthropicCooldownRecoveryFor, type AnthropicQuotaRecoveryResult } from "./anthropic-cooldown-recovery";
import {
  accountCacheKey, accountQuotaCache, accountQuotaInflight, captureProviderAccountQuotaEpoch,
  commitAnthropicAccountQuota, getCachedProviderAccountQuota, getTokenForAccountQuotaProbe,
  hydrateAccountQuotaCache, mayCommitAccountQuotaKey, normalizeAnthropicQuota,
  persistAccountQuotaCache, withoutAnthropicMonthlyFallback, type AccountQuotaCacheEntry,
} from "./account-cache";

/**
 * Resolve renewal first: a flight always belongs to the credential actually dispatched.
 * `config` is the caller's live object. Currency re-reads that one object, never a fresh file
 * load, so memory/disk drift cannot refuse every probe; commit authority stays with the
 * captured writer generation.
 */
export async function fetchAnthropicAccountQuota(
  instance: AnthropicInstanceId, accountId: string, force: boolean, config: OcxConfig = loadConfig(),
  /** Never join an older account or vendor flight; a reset reread needs post-grant evidence. */
  freshDispatch = false,
): Promise<AccountQuotaCacheEntry> {
  const unavailable = (): AccountQuotaCacheEntry => ({ ts: Date.now(), quota: null, unavailable: true });
  const target = config.providers[instance];
  if (target?.disabled || target && target.authMode !== "oauth" || configuredAnthropicInstance(config, instance) !== instance) return unavailable();
  const targetIdentity = JSON.stringify(target);
  const epoch = captureProviderAccountQuotaEpoch(instance);
  const initialRow = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
  if (!initialRow) return unavailable();
  const recovery = anthropicCooldownRecoveryFor(instance);
  const incarnation = recovery.reserveAnthropicAccountIncarnation(accountId);
  const ownerCurrent = () => {
    const row = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
    return epoch === captureProviderAccountQuotaEpoch(instance)
      && configuredAnthropicInstance(config, instance) === instance
      && JSON.stringify(config.providers[instance]) === targetIdentity
      && recovery.anthropicAccountIncarnation(accountId) === incarnation
      && !!row && row.loginId === initialRow.loginId && row.addedAt === initialRow.addedAt;
  };
  hydrateAccountQuotaCache();
  const key = accountCacheKey(instance, accountId);
  const candidate = accountQuotaCache.get(key);
  const cached = candidate?.isCurrent?.() === false ? undefined : candidate;
  if (!force && cached && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS) {
    return { ...cached, quota: normalizeAnthropicQuota(cached.quota, Date.now()) };
  }
  let token: string;
  try { token = await getTokenForAccountQuotaProbe(instance, accountId); }
  catch {
    // Missing, signed-out or unrefreshable credential: a reauthentication matter, never a quota fact.
    return { ...unavailable(), quotaFailure: "account_unavailable", quotaFailureIsCurrent: ownerCurrent };
  }
  if (!ownerCurrent()) return unavailable();
  const flightKey = recovery.anthropicCredentialQuotaFlightKey(key, accountId);
  const flightCurrent = () => ownerCurrent()
    && recovery.anthropicCredentialQuotaFlightKey(key, accountId) === flightKey;
  const joinable = freshDispatch ? undefined : accountQuotaInflight.get(flightKey);
  if (joinable) {
    const joined = await joinable;
    return ownerCurrent() && (joined.isCurrent?.() ?? flightCurrent()) ? joined : unavailable();
  }
  const writerGeneration = captureConfigGeneration();
  // An unusable probe reports unavailability over retained observations. A retirement-only
  // result also removes the monthly fallback while keeping plan observations. Cache and
  // decision writes both require current credential and generation ownership.
  const publish = (result: AnthropicQuotaRecoveryResult | null, failure?: QuotaFailureCode): AccountQuotaCacheEntry => {
    const previous = accountQuotaCache.get(key);
    const retained = previous?.isCurrent?.() === false ? undefined : previous;
    const isCurrent = result?.isCurrent ?? flightCurrent;
    const retirementOnly = result?.quota === null;
    const quotaUnavailable = !result?.quota;
    const quota = retirementOnly ? withoutAnthropicMonthlyFallback(getCachedProviderAccountQuota(instance, accountId))
      : result?.quota ?? retained?.quota;
    const entry: AccountQuotaCacheEntry = {
      ts: Date.now(), quota: normalizeAnthropicQuota(quota, Date.now()),
      ...(quotaUnavailable ? { unavailable: true as const } : {}), isCurrent,
      ...(quotaUnavailable && failure ? { quotaFailure: failure, quotaFailureIsCurrent: isCurrent } : {}),
    };
    if (isCurrent() && mayCommitAccountQuotaKey(key, writerGeneration)) {
      commitAnthropicAccountQuota(key, entry, !!result && result.quota?.monthlyPercent === undefined, result?.dispatch);
      result?.publishDecisionQuota();
      if (result) persistAccountQuotaCache();
      sweepExpiredOnWrite(entry.ts);
    }
    return entry;
  };
  const probe = (async (): Promise<AccountQuotaCacheEntry> => {
    // The closed reason of the last usage read in this flight: an HTTP status class, an unusable
    // body, or a thrown dispatch. Ownership and cooldown refusals never set it.
    let failure: QuotaFailureCode | undefined;
    try {
      const result = await recovery.probeAnthropicQuotaWithRecovery(accountId, token, fresh => {
        if (!flightCurrent()) throw new AnthropicQuotaProbeOwnershipError("quota flight changed");
        recovery.assertAnthropicQuotaSendAllowed(accountId, token);
        return fetchAnthropicUsageProbeForInstance(instance, token, fresh || freshDispatch).then(
          read => { failure = read.failure; return read; },
          error => { failure = thrownQuotaFailure(error); throw error; },
        );
      }, () => ownerCurrent() && mayCommitAccountQuotaKey(key, writerGeneration));
      if (result && !result.isCurrent()) return unavailable();
      if (!result && !flightCurrent()) return unavailable();
      return publish(result, failure);
    } catch (error) {
      if (error instanceof AnthropicQuotaProbeOwnershipError || !flightCurrent()) return unavailable();
      return publish(null, failure);
    }
  })().finally(() => { if (accountQuotaInflight.get(flightKey) === probe) accountQuotaInflight.delete(flightKey); });
  accountQuotaInflight.set(flightKey, probe);
  return probe;
}
