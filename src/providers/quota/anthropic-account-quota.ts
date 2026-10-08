import { loadConfig } from "../../config";
import { getAccountSet } from "../../oauth/store";
import { captureConfigGeneration, sweepExpiredOnWrite } from "../../lib/state-store-sweeper";
import { configuredAnthropicInstance, type AnthropicInstanceId } from "../anthropic-instance";
import { ACCOUNT_QUOTA_TTL_MS } from "../quota-wire";
import { fetchAnthropicUsageQuotaForInstance } from "./vendor-probes-oauth";
import { AnthropicQuotaProbeOwnershipError, anthropicCooldownRecoveryFor } from "./anthropic-cooldown-recovery";
import {
  accountCacheKey, accountQuotaCache, accountQuotaInflight, captureProviderAccountQuotaEpoch,
  getTokenForAccountQuotaProbe, hydrateAccountQuotaCache, mayCommitAccountQuotaKey,
  normalizeAnthropicQuota, type AccountQuotaCacheEntry,
} from "./account-cache";

/** Resolve renewal first: a flight always belongs to the credential actually dispatched. */
export async function fetchAnthropicAccountQuota(
  instance: AnthropicInstanceId, accountId: string, force: boolean,
): Promise<AccountQuotaCacheEntry> {
  const unavailable = (): AccountQuotaCacheEntry => ({ ts: Date.now(), quota: null, unavailable: true });
  const config = loadConfig();
  const target = config.providers[instance];
  if (target?.disabled || target && target.authMode !== "oauth" || configuredAnthropicInstance(config, instance) !== instance) return unavailable();
  const targetIdentity = JSON.stringify(target);
  const epoch = captureProviderAccountQuotaEpoch(instance);
  const initialRow = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
  if (!initialRow) return unavailable();
  const recovery = anthropicCooldownRecoveryFor(instance);
  const incarnation = recovery.reserveAnthropicAccountIncarnation(accountId);
  const ownerCurrent = () => {
    const live = loadConfig();
    const row = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
    return epoch === captureProviderAccountQuotaEpoch(instance)
      && configuredAnthropicInstance(live, instance) === instance
      && JSON.stringify(live.providers[instance]) === targetIdentity
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
  catch { return unavailable(); }
  if (!ownerCurrent()) return unavailable();
  const flightKey = recovery.anthropicCredentialQuotaFlightKey(key, accountId);
  const flightCurrent = () => ownerCurrent()
    && recovery.anthropicCredentialQuotaFlightKey(key, accountId) === flightKey;
  const joinable = accountQuotaInflight.get(flightKey);
  if (joinable) {
    const joined = await joinable;
    return ownerCurrent() && (joined.isCurrent?.() ?? flightCurrent()) ? joined : unavailable();
  }
  const writerGeneration = captureConfigGeneration();
  const probe = (async (): Promise<AccountQuotaCacheEntry> => {
    try {
      const result = await recovery.probeAnthropicQuotaWithRecovery(accountId, token, fresh => {
        if (!flightCurrent()) throw new AnthropicQuotaProbeOwnershipError("quota flight changed");
        recovery.assertAnthropicQuotaSendAllowed(accountId, token);
        return fetchAnthropicUsageQuotaForInstance(instance, token, fresh);
      }, () => ownerCurrent() && mayCommitAccountQuotaKey(key, writerGeneration));
      if (result && !result.isCurrent()) return unavailable();
      if (!result && !flightCurrent()) return unavailable();
      const previous = accountQuotaCache.get(key);
      const retained = previous?.isCurrent?.() === false ? undefined : previous;
      const isCurrent = result?.isCurrent ?? flightCurrent;
      const entry: AccountQuotaCacheEntry = {
        ts: Date.now(), quota: normalizeAnthropicQuota(result?.quota ?? retained?.quota, Date.now()),
        ...(!result ? { unavailable: true as const } : {}), isCurrent,
      };
      if (isCurrent()) { accountQuotaCache.set(key, entry); sweepExpiredOnWrite(entry.ts); }
      return entry;
    } catch (error) {
      if (error instanceof AnthropicQuotaProbeOwnershipError || !flightCurrent()) return unavailable();
      const previous = accountQuotaCache.get(key);
      return { ...unavailable(), quota: previous?.isCurrent?.() === false ? null : normalizeAnthropicQuota(previous?.quota, Date.now()), isCurrent: flightCurrent };
    }
  })().finally(() => { if (accountQuotaInflight.get(flightKey) === probe) accountQuotaInflight.delete(flightKey); });
  accountQuotaInflight.set(flightKey, probe);
  return probe;
}
