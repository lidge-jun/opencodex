
import { listCodexAuthAccountsSnapshot } from "../codex/auth-api";
import { resolveEnvValue } from "../config";
import { getAccountCredential, getAccountSet } from "../oauth/store";
import { apiKeyPoolEntryId } from "./api-keys";
import { captureConfigGeneration, sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import { ACCOUNT_QUOTA_TTL_MS, CACHE_TTL_MS } from "./quota-wire";
import { replaceCachedProviderQuotas } from "./quota-routing-cache";
import {
  commitKiroAccountUsageState,
  fetchKiroUsageSnapshot,
  type KiroUsageSnapshot,
  kiroUsageContextForAccount,
} from "./kiro-usage";
import { mapQuotaRoster, readProviderApiKeyQuotas, type ProviderApiKeyQuota } from "./quota-key-accounts";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { ProviderQuota, QuotaFailureCode } from "./quota-types";
import {
  accountReportCurrent,
  AUTHORITATIVE_EMPTY_QUOTA,
  bumpProviderQuotaInvalidationEpoch,
  cacheKeyWithAggregationState,
  getProviderQuotaReportCache,
  hasCodexPoolProvider,
  inflight,
  invalidationEpoch,
  isBuiltInChatGptForwardProvider,
  isProviderQuotaReportCurrent,
  LAST_GOOD_MAX_AGE_MS,
  providerQuotaBeforePublishForTests,
  routingEvidence,
  setProviderQuotaReportCache,
  TERMINAL_QUOTA_FAILURE,
  type CodexAuthAccountsSnapshotPromise,
  type ProviderQuotaProbeResult,
  type ProviderQuotaReport,
  type ProviderQuotaResponse,
} from "./quota/report-cache";
import {
  accountCacheKey,
  accountQuotaCache,
  accountQuotaInflight,
  explicitAccountEpoch,
  explicitAccountReader,
  explicitQuotaConfig,
  explicitQuotaDestination,
  explicitQuotaIdentity,
  getTokenForAccountQuotaProbe,
  hasPassiveAccountQuota,
  hydrateAccountQuotaCache,
  mayCommitAccountQuotaKey,
  mayCommitProviderQuotaKey,
  normalizeAnthropicQuota,
  supportsPerAccountQuota,
  type AccountQuotaCacheEntry,
  type ProviderAccountQuota,
} from "./quota/account-cache";
import {
  fetchAnthropicQuota,
  fetchAnthropicUsageQuota,
  fetchChatGptForwardQuota,
  fetchCursorQuota,
  fetchKiroQuota,
  fetchMuseKeyQuota,
  fetchPassiveProviderQuota,
  fetchXaiQuota,
} from "./quota/vendor-probes-oauth";
import { fetchCommandCodeQuota, fetchKimiQuota, keyQuotaReaderForProvider } from "./quota/vendor-probes-key";
import { antigravityQuotaDiagnosticIdentity, fetchAntigravityQuota, probeAntigravityUsageQuota } from "./quota/antigravity";
import { persistKiroAccountState } from "./kiro-account-state-disk";
import { kiroProbeCurrent, kiroProbeIdentity } from "./quota/kiro-account-probe";

export type { ProviderQuota, ProviderQuotaCreditsUsd, ProviderQuotaWindow } from "./quota-types";
export { QUOTA_RESPONSE_MAX_BYTES } from "./quota-wire";
export {
  clearProviderQuotaCache,
  publishKeyReportForTests,
  readProviderQuotaJsonForTests,
  setProviderQuotaBeforePublishForTests,
  type ProviderQuotaReport,
  type ProviderQuotaResponse,
} from "./quota/report-cache";
export {
  clearAccountQuotaCache,
  getCachedProviderAccountQuota,
  hasPassiveAccountQuota,
  parseAnthropicRateLimitHeaders,
  providerOAuthAccountQuotaMode,
  readPassiveProviderAccountQuotas,
  recordAnthropicAccountQuotaFromHeaders,
  recordPassiveAccountQuota,
  reconcileProviderAccountQuotaRows,
  resetProviderQuotaReconcileStateForTests,
  setCachedProviderAccountQuotaForTests,
  supportsPerAccountQuota,
  sweepExpiredProviderAccountQuotaRows,
  type ProviderAccountQuota,
} from "./quota/account-cache";
export { fetchAntigravityUsageQuota, isCanonicalAntigravityQuotaUrl, setAntigravityAccountQuotaTransportForTests } from "./quota/antigravity";
export { parseOllamaCloudQuota, parseZaiQuotaLimits, providerApiKeyQuotaMode } from "./quota/vendor-probes-key";
export { parseXaiCreditsResponse } from "./quota/vendor-probes-oauth";

export async function fetchProviderApiKeyQuotas(config: OcxConfig, name: string, forceRefresh = false): Promise<ProviderApiKeyQuota[]> {
  const provider = config.providers[name];
  if (!provider || !keyQuotaReaderForProvider(name, provider)) return [];
  return readProviderApiKeyQuotas(config, name, forceRefresh, async (isolatedProvider, isolatedConfig) => {
    const result = await maybeFetchProviderQuota(name, isolatedProvider, isolatedConfig, false);
    if (result === TERMINAL_QUOTA_FAILURE) return { kind: "terminal" };
    if (result === AUTHORITATIVE_EMPTY_QUOTA) return { kind: "empty" };
    return result ? { kind: "quota", quota: result.quota } : { kind: "unavailable" };
  });
}

async function maybeFetchProviderQuota(
  name: string,
  provider: OcxProviderConfig,
  config: OcxConfig,
  forceRefresh: boolean,
  prefetchedCodexSnapshot?: CodexAuthAccountsSnapshotPromise,
): Promise<ProviderQuotaProbeResult> {
  if (provider.disabled === true) return null;
  try {
    if (isBuiltInChatGptForwardProvider(name, provider)) {
      return fetchChatGptForwardQuota(config, name, provider, forceRefresh, prefetchedCodexSnapshot);
    }
    if (provider.authMode === "oauth" && explicitAccountReader(name)) return await fetchExplicitCurrentQuota(name, provider, config);
    if (provider.authMode === "oauth" && name === "anthropic") return fetchAnthropicQuota(name);
    if (provider.authMode === "oauth" && name === "google-antigravity") return await fetchAntigravityQuota(name);
    if (provider.authMode === "oauth" && name === "kiro") return fetchKiroQuota(name);
    // meta-muse: a device-logged-in account can be probed at the key endpoint; an
    // imported or pasted one cannot, and falls back to its last in-band observation.
    // The probe is tried first and its failure is never fatal to the row.
    if (provider.authMode === "oauth" && hasPassiveAccountQuota(name)) {
      return (await fetchMuseKeyQuota(name)) ?? await fetchPassiveProviderQuota(name);
    }
    const reader = keyQuotaReaderForProvider(name, provider);
    // Keep destination/auth fields bound to the same request as the reader's captured
    // bearer, even if the live provider object changes while the quota probe awaits.
    return reader ? reader(name, { ...provider }) : null;
  } catch {
    return null;
  }
}

/**
 * Hand freshly committed provider reports to the optional quota-reset observer.
 *
 * Lazy import on purpose: this module is statically reachable from
 * src/server/responses/core.ts (via oauth/anthropic-routing.ts), so a static edge would put
 * the observer and its sink registry on every install's request path.
 *
 * No previous snapshot is passed. The observer keeps its own persisted last-seen map,
 * because `previous` here is bound only when `cache.key === key` and the key digest at
 * cacheKeyWithAggregationState includes quota values and updatedAt — so it is empty exactly
 * when a reset happened.
 *
 * Account identity is resolved SYNCHRONOUSLY, before any await. Two reasons, both observed:
 * pool failover rewrites `activeAccountId` during request routing
 * (promoteAnthropicActiveAccount -> setActiveAccount), so a 429 between this commit and a
 * later async read would attribute this report to a different account and overwrite that
 * account's baseline with these numbers. fetchAnthropicQuota already captures
 * `probedAccountId` before awaiting for exactly this reason; the observer must not be
 * sloppier than the cache it observes.
 *
 * Observations are serialized through a module-level promise chain for the same reason as
 * the codex seam: Bun does not resolve concurrent import() calls in call order, and an
 * out-of-order baseline swap manufactures false resets that then burn the durable
 * idempotence key.
 */
let pendingProviderObservation: Promise<void> = Promise.resolve();

/**
 * Stable per-account observation key for one provider report.
 *
 * OAuth providers key by active account id. Key-auth providers have NO account set, so
 * every key in `apiKeyPool` would collapse onto "default" and rotating from a spent key to
 * a fresh one would read as a reset (measured: 97% -> 12% fired a false surprise). The
 * cache key already discriminates these at cacheKey() via apiKeyPoolEntryId, so this
 * mirrors that discriminator instead of inventing a second notion of identity.
 */
function providerObservationAccountKey(provider: string, config: OcxConfig): string {
  const oauthAccountId = getAccountSet(provider)?.activeAccountId;
  if (oauthAccountId !== undefined) return `${provider}\u0000${oauthAccountId}`;
  const providerConfig = config.providers[provider];
  const resolvedKey = typeof providerConfig?.apiKey === "string"
    ? resolveEnvValue(providerConfig.apiKey)?.trim()
    : undefined;
  const keyId = resolvedKey ? apiKeyPoolEntryId(resolvedKey) : "default";
  return `${provider}\u0000key:${keyId}`;
}

/** Test-only view of the observation account key. */
export function providerObservationAccountKeyForTests(provider: string, config: OcxConfig): string {
  return providerObservationAccountKey(provider, config);
}

function notifyProviderQuotaSnapshot(
  reports: ReadonlyArray<ProviderQuotaReport>,
  config: OcxConfig,
): void {
  if (reports.length === 0) return;
  // Resolved here, synchronously, while the identity is still the one that produced these
  // reports.
  const observations = reports.map(report => ({
    scope: report.provider,
    accountKey: providerObservationAccountKey(report.provider, config),
    quota: report.quota,
  }));
  pendingProviderObservation = pendingProviderObservation
    .then(async () => {
      const observer = await import("../quota/reset-observer");
      if (!observer.hasQuotaResetSink()) return;
      const { providerWindowObservations } = await import("../quota/window-mapping");
      for (const observation of observations) {
        observer.observeQuotaSnapshot({
          scope: observation.scope,
          accountKey: observation.accountKey,
          windows: providerWindowObservations(observation.quota),
        });
      }
    })
    .catch(() => {
      // Detection is best-effort: a quota refresh must never fail because of it. Swallowing
      // here also keeps the chain alive — a rejected link would poison every later one.
    });
}

/** Await the observation chain. Tests only: production never needs to join it. */
export function flushProviderQuotaObservationsForTests(): Promise<void> {
  return pendingProviderObservation;
}

export async function fetchProviderQuotaReports(config: OcxConfig, forceRefresh = false): Promise<ProviderQuotaResponse> {
  // A Pool report's cache signature and provider fetch must share one account snapshot.
  // Preserve force semantics when deciding whether that snapshot refreshes upstream data.
  const prefetchedCodexSnapshot = hasCodexPoolProvider(config)
    ? listCodexAuthAccountsSnapshot(config, forceRefresh)
    : undefined;
  const keyCandidate = cacheKeyWithAggregationState(config, prefetchedCodexSnapshot);
  const key = typeof keyCandidate === "string" ? keyCandidate : await keyCandidate;
  const writerGeneration = captureConfigGeneration();
  const now = Date.now();
  // The cache fast path must not extend a preserved last-good row past its 30-minute bound:
  // a row preserved at age 29:59 plus a full 5-minute TTL would otherwise serve until ~35min.
  // An OBSERVED row is exempt: it carries the observation time, which is older than the bound
  // by construction and never becomes fresher on its own. Without the exemption a single
  // configured passive provider makes this predicate permanently false, so every dashboard
  // poll re-probes every OTHER provider upstream instead of serving the 5-minute cache.
  const currentCache = getProviderQuotaReportCache();
  const cacheFresh = currentCache && currentCache.key === key && now - currentCache.ts < CACHE_TTL_MS
    && currentCache.response.reports.every(item =>
      (item.observed === true || now - item.updatedAt < LAST_GOOD_MAX_AGE_MS)
      && isProviderQuotaReportCurrent(item));
  if (!forceRefresh && cacheFresh) return currentCache!.response;
  const joinable = inflight.get(key);
  if (!forceRefresh && joinable && joinable.epoch === invalidationEpoch) return joinable.promise;
  // A forced probe takes commit authority: older in-flight probes must not overwrite its result.
  if (forceRefresh) bumpProviderQuotaInvalidationEpoch();
  const epoch = invalidationEpoch;

  const promise = (async (): Promise<ProviderQuotaResponse> => {
    const previousCache = getProviderQuotaReportCache();
    const previous = previousCache && previousCache.key === key ? previousCache.response.reports : [];
    const probeResults = await Promise.all(
      Object.entries(config.providers).map(([name, provider]) => (
        maybeFetchProviderQuota(name, provider, config, forceRefresh, prefetchedCodexSnapshot)
      )),
    );
    const fresh = probeResults.filter((item): item is ProviderQuotaReport => (
      item !== null && item !== TERMINAL_QUOTA_FAILURE && item !== AUTHORITATIVE_EMPTY_QUOTA
    ));
    // Both sentinels suppress the previous row. A terminal failure means the response was
    // invalid; an authoritative empty means the response was valid and said there are no
    // model windows. Either way the old row is no longer true, which is what separates them
    // from `null` (told us nothing — keep the last-good row).
    const terminalFailures = new Set(
      Object.keys(config.providers).filter((_, index) => (
        probeResults[index] === TERMINAL_QUOTA_FAILURE
        || probeResults[index] === AUTHORITATIVE_EMPTY_QUOTA
      )),
    );
    await providerQuotaBeforePublishForTests?.();
    let commitKey: string | null = null;
    if (epoch === invalidationEpoch) {
      const commitKeyCandidate = cacheKeyWithAggregationState(config);
      commitKey = typeof commitKeyCandidate === "string" ? commitKeyCandidate : await commitKeyCandidate;
    }

    // Keep bounded last-good rows when a probe fails transiently; terminal-invalid provider
    // responses explicitly suppress their old row. Never re-stamp preserved timestamps.
    // Note: the cache key encodes the provider set (name/adapter/authMode/disabled/baseUrl),
    // so previous rows always correspond to currently configured, enabled providers — a
    // disabled or removed provider changes the key and starts from an empty previous set.
    const cutoff = Date.now() - LAST_GOOD_MAX_AGE_MS;
    const byProvider = new Map<string, ProviderQuotaReport>();
    const generationMismatchedProviders = new Set<string>();
    for (const item of previous) {
      // Same exemption as the fast path. A passive row reaching `previous` is not a probe
      // that went quiet — there is no probe — so age cannot condemn it.
      if (item.observed !== true && item.updatedAt < cutoff) continue;
      if (isProviderQuotaReportCurrent(item)) byProvider.set(item.provider, item);
      else generationMismatchedProviders.add(item.provider);
    }
    for (const item of fresh) {
      if (isProviderQuotaReportCurrent(item)) {
        byProvider.set(item.provider, item);
        generationMismatchedProviders.delete(item.provider);
      } else {
        byProvider.delete(item.provider);
        generationMismatchedProviders.add(item.provider);
      }
    }
    // Terminal-invalid probes suppress their previous row (transient failures keep it).
    for (const provider of terminalFailures) {
      byProvider.delete(provider);
      generationMismatchedProviders.delete(provider);
    }

    const response = { generatedAt: Date.now(), reports: [...byProvider.values()] };
    // Commit only when this probe still holds authority (no clear/force superseded it).
    if (
      epoch === invalidationEpoch
      && commitKey === key
      && generationMismatchedProviders.size === 0
    ) {
      const reports = response.reports.filter(item => mayCommitProviderQuotaKey(item.provider, writerGeneration));
      setProviderQuotaReportCache({ key, ts: Date.now(), response: { ...response, reports } });
      replaceCachedProviderQuotas(reports, routingEvidence);
      notifyProviderQuotaSnapshot(reports, config);
    }
    return response;
  })();

  const entry = { epoch, promise };
  inflight.set(key, entry);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === entry) inflight.delete(key);
  }
}

async function readExplicitAccountQuota(provider: string, accountId: string, configured?: OcxProviderConfig): Promise<{
  result: ProviderQuotaProbeResult;
  identity: string | undefined;
  isCurrent: () => boolean;
} | null> {
  const target = explicitQuotaConfig(provider, configured);
  if (!target || !explicitQuotaDestination(provider, target)) return null;
  const config = { ...target };
  const epoch = explicitAccountEpoch;
  const accessToken = await getTokenForAccountQuotaProbe(provider, accountId);
  const credential = getAccountCredential(provider, accountId);
  if (!credential || credential.access !== accessToken) return null;
  // Pair the post-renewal credential with the destination captured before renewal.
  const identity = explicitQuotaIdentity(provider, accountId, config);
  const isCurrent = () => epoch === explicitAccountEpoch
    && identity === explicitQuotaIdentity(provider, accountId, configured);
  if (!isCurrent()) return null;
  let result: ProviderQuotaProbeResult;
  switch (provider) {
    case "xai": result = await fetchXaiQuota(provider, { accessToken, upstreamAccountId: credential.accountId }); break;
    case "cursor": result = await fetchCursorQuota(provider, accessToken); break;
    case "kimi": result = await fetchKimiQuota(provider, config, accessToken); break;
    case "command-code": result = await fetchCommandCodeQuota(provider, config, accessToken); break;
    default: return null;
  }
  return { result, identity, isCurrent };
}

async function fetchExplicitAccountQuota(provider: string, accountId: string, force: boolean, configured?: OcxProviderConfig): Promise<AccountQuotaCacheEntry> {
  const key = accountCacheKey(provider, accountId);
  const identity = explicitQuotaIdentity(provider, accountId, configured);
  const previous = accountQuotaCache.get(key);
  const cached = identity && previous?.identity === identity && previous.isCurrent?.() ? previous : undefined;
  if (!force && cached && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS
    && (!cached.quota || Date.now() - cached.quota.updatedAt < LAST_GOOD_MAX_AGE_MS)) return cached;
  const flightKey = `${key}\u0000${identity ?? "missing"}`;
  const running = accountQuotaInflight.get(flightKey);
  if (running) return running;
  const epoch = explicitAccountEpoch;
  const lastGood = cached?.quota && Date.now() - cached.quota.updatedAt < LAST_GOOD_MAX_AGE_MS ? cached.quota : null;
  const flight = (async (): Promise<AccountQuotaCacheEntry> => {
    let read: Awaited<ReturnType<typeof readExplicitAccountQuota>> = null;
    try { read = await readExplicitAccountQuota(provider, accountId, configured); } catch { /* unavailable */ }
    const isCurrent = read?.isCurrent ?? (() => epoch === explicitAccountEpoch && !!identity
      && identity === explicitQuotaIdentity(provider, accountId, configured));
    const result = read?.result;
    const current = epoch === explicitAccountEpoch && isCurrent();
    const quota = current && result && typeof result !== "symbol" ? result.quota : null;
    const empty = result === AUTHORITATIVE_EMPTY_QUOTA;
    const entry: AccountQuotaCacheEntry = {
      ts: Date.now(),
      quota: quota ?? (current && result !== TERMINAL_QUOTA_FAILURE && !empty
        && lastGood && Date.now() - lastGood.updatedAt < LAST_GOOD_MAX_AGE_MS ? lastGood : null),
      ...(!current || (!quota && !empty) ? { unavailable: true as const } : {}),
      identity: read?.identity ?? identity,
      isCurrent: () => epoch === explicitAccountEpoch && isCurrent(),
    };
    if (entry.isCurrent?.()) accountQuotaCache.set(key, entry);
    return entry;
  })().finally(() => { if (accountQuotaInflight.get(flightKey) === flight) accountQuotaInflight.delete(flightKey); });
  accountQuotaInflight.set(flightKey, flight);
  return flight;
}

async function fetchExplicitCurrentQuota(provider: string, config: OcxProviderConfig, liveConfig: OcxConfig): Promise<ProviderQuotaProbeResult> {
  const id = getAccountSet(provider)?.activeAccountId;
  if (!id) return null;
  const read = await readExplicitAccountQuota(provider, id, config);
  if (!read) return null;
  const isCurrent = () => liveConfig.providers[provider] === config
    && read.isCurrent() && getAccountSet(provider)?.activeAccountId === id;
  if (!isCurrent()) return TERMINAL_QUOTA_FAILURE;
  if (read.result && typeof read.result !== "symbol") accountReportCurrent.set(read.result, isCurrent);
  return read.result;
}
async function fetchAccountQuota(
  provider: string,
  accountId: string,
  forceRefresh: boolean,
  providerConfig?: OcxProviderConfig,
): Promise<AccountQuotaCacheEntry> {
  if (!supportsPerAccountQuota(provider)) return { ts: Date.now(), quota: null, unavailable: true };
  if (explicitAccountReader(provider)) return fetchExplicitAccountQuota(provider, accountId, forceRefresh, providerConfig);
  if (provider === "anthropic" || provider === "kiro") hydrateAccountQuotaCache();
  const key = accountCacheKey(provider, accountId);
  const writerGeneration = captureConfigGeneration();
  const kiroIdentity = provider === "kiro" ? kiroProbeIdentity(accountId) : undefined;
  const cachedCandidate = accountQuotaCache.get(key);
  const cached = provider !== "kiro" || cachedCandidate?.identity === kiroIdentity ? cachedCandidate : undefined;
  if (!forceRefresh && cached && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS) {
    if (provider === "google-antigravity" && cached.quotaFailure && cached.quotaFailureIsCurrent?.() !== true) return { ...cached, quotaFailure: undefined };
    return provider === "anthropic" ? { ...cached, quota: normalizeAnthropicQuota(cached.quota, Date.now()) } : cached;
  }
  const joinable = accountQuotaInflight.get(key);
  if (joinable) {
    const joined = await joinable;
    return provider !== "kiro" || joined.identity === kiroIdentity
      ? joined : fetchAccountQuota(provider, accountId, true, providerConfig);
  }

  const epoch = explicitAccountEpoch;
  const probe = (async (): Promise<AccountQuotaCacheEntry> => {
    let diagnosticIdentity: string | undefined;
    let quotaFailure: QuotaFailureCode | undefined;
    const quotaFailureIsCurrent = () => {
      try { return epoch === explicitAccountEpoch && diagnosticIdentity !== undefined && diagnosticIdentity === antigravityQuotaDiagnosticIdentity(accountId); }
      catch { return false; }
    };
    const diagnosticFields = () => quotaFailure && quotaFailureIsCurrent() ? { quotaFailure, quotaFailureIsCurrent } : {};
    try {
      if (provider === "google-antigravity") diagnosticIdentity = antigravityQuotaDiagnosticIdentity(accountId);
      let quota: ProviderQuota | null;
      let kiroSnapshot: KiroUsageSnapshot | null = null;
      if (provider === "kiro") {
        kiroSnapshot = await fetchKiroUsageSnapshot(await kiroUsageContextForAccount(accountId));
        quota = kiroSnapshot?.quota ?? null;
      } else {
        const token = await getTokenForAccountQuotaProbe(provider, accountId);
        if (provider === "google-antigravity") {
          // Per-account Gem/Cla windows (#1082). The project id is part of the stored
          // credential; without it the probe cannot be made, and that is "unavailable",
          // never 0%.
          const credential = getAccountCredential(provider, accountId);
          diagnosticIdentity = credential?.access === token ? antigravityQuotaDiagnosticIdentity(accountId, credential) : undefined;
          if (!diagnosticIdentity || !credential?.projectId) throw new Error("antigravity account unavailable");
          const result = await probeAntigravityUsageQuota(token, credential.projectId);
          quota = result.kind === "available" ? result.quota : null;
          if (result.kind === "unavailable") quotaFailure = result.failure;
        } else if (provider === "anthropic") {
          quota = await fetchAnthropicUsageQuota(token);
        } else {
          return { ts: Date.now(), quota: null, unavailable: true };
        }
      }
      if (!quota) {
        // Preserve last-good bars while negative-caching the failed probe.
        const entry: AccountQuotaCacheEntry = {
          ts: Date.now(),
          quota: provider === "anthropic"
            ? normalizeAnthropicQuota(accountQuotaCache.get(key)?.quota, Date.now()) : cached?.quota ?? null,
          unavailable: true,
          ...(provider === "kiro" ? { identity: kiroIdentity } : {}),
          ...diagnosticFields(),
        };
        if (mayCommitAccountQuotaKey(key, writerGeneration) && (provider !== "kiro" || kiroProbeCurrent(accountId, kiroIdentity))) {
          accountQuotaCache.set(key, entry);
          if (provider === "kiro") persistKiroAccountState();
          sweepExpiredOnWrite(entry.ts);
        }
        return entry;
      }
      const entry: AccountQuotaCacheEntry = {
        ts: Date.now(), quota: provider === "anthropic" ? normalizeAnthropicQuota(quota, Date.now()) : quota,
        ...(provider === "kiro" ? { identity: kiroIdentity } : {}),
      };
      if (mayCommitAccountQuotaKey(key, writerGeneration) && (provider !== "kiro" || kiroProbeCurrent(accountId, kiroIdentity))) {
        accountQuotaCache.set(key, entry);
        if (provider === "kiro") { commitKiroAccountUsageState(key, kiroSnapshot, kiroIdentity); persistKiroAccountState(); }
        sweepExpiredOnWrite(entry.ts);
      }
      return entry;
    } catch {
      if (provider === "google-antigravity") quotaFailure = "account_unavailable";
      const entry: AccountQuotaCacheEntry = {
        ts: Date.now(),
        quota: provider === "anthropic"
          ? normalizeAnthropicQuota(accountQuotaCache.get(key)?.quota, Date.now()) : cached?.quota ?? null,
        unavailable: true,
        ...(provider === "kiro" ? { identity: kiroIdentity } : {}),
        ...diagnosticFields(),
      };
      if (mayCommitAccountQuotaKey(key, writerGeneration) && (provider !== "kiro" || kiroProbeCurrent(accountId, kiroIdentity))) {
        accountQuotaCache.set(key, entry);
        if (provider === "kiro") persistKiroAccountState();
        sweepExpiredOnWrite(entry.ts);
      }
      return entry;
    }
  })().finally(() => {
    if (accountQuotaInflight.get(key) === probe) accountQuotaInflight.delete(key);
  });
  accountQuotaInflight.set(key, probe);
  return probe;
}

/**
 * Per-account quota rows for a provider's logged-in accounts. Probes run in parallel; a
 * single failing account never blocks the others.
 */
export async function fetchProviderAccountQuotas(
  provider: string,
  forceRefresh = false,
  providerConfig?: OcxProviderConfig,
  /**
   * When set to a known account id, only that account is force-probed upstream
   * and the rest serve from cache. An unknown id falls back to force-all so a
   * stale caller can never leave every account unforced.
   */
  onlyAccountId?: string,
): Promise<ProviderAccountQuota[]> {
  if (!supportsPerAccountQuota(provider)) return [];
  const set = getAccountSet(provider);
  if (!set) return [];
  const scoped = onlyAccountId && set.accounts.some(account => account.id === onlyAccountId)
    ? onlyAccountId
    : undefined;
  return mapQuotaRoster(set.accounts, async account => {
    const forced = forceRefresh && (!scoped || account.id === scoped);
    const entry = await fetchAccountQuota(provider, account.id, forced, providerConfig);
    const result: ProviderAccountQuota = {
      accountId: account.id,
      quota: provider === "anthropic" ? normalizeAnthropicQuota(entry.quota, Date.now()) : entry.quota,
      ...(entry.unavailable ? { unavailable: true as const } : {}),
      ...(entry.unavailable && entry.quotaFailure && entry.quotaFailureIsCurrent?.() === true ? { quotaFailure: entry.quotaFailure } : {}),
    };
    if (entry.quotaFailureIsCurrent) Object.defineProperty(result, "quotaFailureIsCurrent", { value: entry.quotaFailureIsCurrent });
    if (!explicitAccountReader(provider)) return result;
    const identity = entry.identity;
    Object.defineProperty(result, "isCurrent", { value: () => {
      if (entry.isCurrent) return entry.isCurrent();
      const credential = getAccountCredential(provider, account.id);
      return !!credential && (!identity || explicitQuotaIdentity(provider, account.id, providerConfig) === identity);
    } });
    return result;
  });
}
