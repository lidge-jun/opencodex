import { decisionQuotaSinkActive, invalidateDecisionKeyQuotas, replaceCollectedDecisionQuotas, type AntigravityQuotaObservation, type AntigravityQuotaReceipt, type DecisionKeyObservation } from "../../lib/decision-quota-sink";
import { providerDecisionWindows } from "../quota-decision-publication";
import type { DecisionQuotaWindow } from "../quota-decision-snapshot";
import { createHash } from "node:crypto";
import { effectiveCodexAuthAccountId, listCodexAuthAccountsSnapshot } from "../../codex/auth-api";
import { CODEX_EXHAUSTED_USAGE_PERCENT, withoutRetiredCodexQuota, type StoredAccountQuota } from "../../codex/quota";
import { isMainAccountIdentityGenerationLive } from "../../codex/main-account-cache";
import { codexPlanKey } from "../../codex/plan";
import { isKeychainReference, resolveProviderApiKey } from "../key-store";
import { passiveKeychainGeneration, peekResolvedProviderKey } from "../api-key-resolve";
import { resolveEnvValue } from "../../config/proxy-env";
import { apiKeyPoolEntryId } from "../api-keys";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../registry";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../openai-tiers";
import { CODEX_CAPACITY_MAX_QUOTA_AGE_MS, type CodexCapacityAggregation, type CodexCapacityQuota } from "../codex-capacity";
import { clearCachedProviderQuotas, providerQuotaRoutingBinding, replaceCachedProviderQuotas, type ProviderQuotaRoutingEvidence } from "../quota-routing-cache";
import { clearProviderApiKeyQuotaCache } from "../quota-key-accounts";
import { QUOTA_JSON_READ_FAILURE, readQuotaJson } from "../quota-wire";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import type { ProviderQuota, ProviderRoutingQuota } from "../quota-types";

/** Keep a failed probe's previous row at most this long before dropping it. */
export const LAST_GOOD_MAX_AGE_MS = CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
const nativeMainReportGenerations = new WeakMap<ProviderQuotaReport, number>();
export const accountReportCurrent = new WeakMap<ProviderQuotaReport, () => boolean>();
const reportOwners = new WeakMap<ProviderQuotaReport, { name: string; signature: string; credentialBound: boolean }>();
function ownerSignature(provider: OcxProviderConfig, credentialBound = false): string {
  return createHash("sha256").update(JSON.stringify([provider.adapter, provider.baseUrl, provider.authMode ?? "key", credentialBound ? undefined : provider.apiKey, provider.disabled])).digest("hex");
}
export function captureReportOwner(name: string, provider: OcxProviderConfig): (report: ProviderQuotaReport) => void {
  const owner = { name, signature: ownerSignature(provider), credentialBound: false };
  return report => { if (!reportOwners.has(report)) reportOwners.set(report, owner); };
}
export async function collectOwnedReport(name: string, provider: OcxProviderConfig, probe: () => Promise<ProviderQuotaProbeResult>): Promise<ProviderQuotaProbeResult> {
  const bind = captureReportOwner(name, provider);
  const result = await probe();
  if (result && typeof result !== "symbol") bind(result);
  return result;
}
function reportOwnerCurrent(report: ProviderQuotaReport, provider: OcxProviderConfig | undefined, passive = false): boolean {
  const owner = reportOwners.get(report);
  // Only a key-authenticated report depends on the keychain value a passive read cannot verify.
  return !!owner && !!provider && !provider.disabled && owner.name === report.provider
    && !(passive && (provider.authMode ?? "key") === "key" && isKeychainReference(provider.apiKey))
    && owner.signature === ownerSignature(provider, owner.credentialBound);
}
/** The measured quota a reset detector should observe when the shown quota is an estimate (pooled rows). */
export const observedQuotaFor = new WeakMap<ProviderQuotaReport, ProviderQuota>();
export const routingEvidence = new WeakMap<ProviderQuotaReport, ProviderQuotaRoutingEvidence>();
/**
 * Credential identity captured by a probe that opted into binding; never serialized with the
 * report. Only producers whose report must not outlive its credential register here (#8290),
 * so a provider that did not opt in keeps its dev-era cache and join behaviour unchanged.
 */
export const keyReportCredentialIds = new WeakMap<ProviderQuotaReport, string>();
const keyReportDestinations = new WeakMap<ProviderQuotaReport, { adapter: string; baseUrl: string }>();
/**
 * Whether a probe-bound report still describes the provider as it is configured NOW.
 *
 * A report is published only for the credential and destination that produced it. The
 * comparison is a full digest: the 8-character apiKeyPoolEntryId is a cache discriminator,
 * not an identity, and two distinct keys can share it.
 */
export function keyReportCredentialCurrent(value: ProviderQuotaReport, provider: OcxProviderConfig | undefined, passive = false): boolean {
  const captured = keyReportCredentialIds.get(value);
  if (!captured) return true;
  if (!provider || provider.disabled || (provider.authMode ?? "key") !== "key") return false;
  const destination = keyReportDestinations.get(value);
  if (!destination || destination.adapter !== provider.adapter || destination.baseUrl !== provider.baseUrl) return false;
  // A passive read cannot open the OS keychain or publish credential observations.
  if (passive && isKeychainReference(provider.apiKey)) return false;
  const current = (passive ? resolveEnvValue(provider.apiKey) : resolveProviderApiKey(provider.apiKey))?.trim();
  return !!current && createHash("sha256").update(current).digest("hex") === captured;
}
/** Validate joined results against the joining caller's independently mutable configuration. */
export function validateJoinedReports(response: ProviderQuotaResponse, config: OcxConfig): ProviderQuotaResponse {
  return { ...response, reports: response.reports.filter(item => {
    const provider = config.providers[item.provider];
    return reportOwnerCurrent(item, provider) && isProviderQuotaReportCurrent(item)
      && keyReportCredentialCurrent(item, provider);
  }) };
}
/** Only the live Antigravity probe binds this projection; display/last-good rows cannot create it. */
export const antigravityEvidence = new WeakMap<ProviderQuotaReport, { receipt: AntigravityQuotaReceipt; windows: readonly DecisionQuotaWindow[] }>();
export let providerQuotaBeforePublishForTests: (() => void | Promise<void>) | null = null;
export let providerQuotaBeforeObservationForTests: (() => void | Promise<void>) | null = null;
export function setProviderQuotaBeforeObservationForTests(hook: (() => void | Promise<void>) | null): void {
  providerQuotaBeforeObservationForTests = hook;
}

/** Test-only seam for identity/config invalidation after probes but before publication. */
export function setProviderQuotaBeforePublishForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  providerQuotaBeforePublishForTests = hook;
}
export const TERMINAL_QUOTA_FAILURE = Symbol("terminal-quota-failure");
/**
 * The probe succeeded and the upstream authoritatively reported NO model-quota windows.
 *
 * Distinct from `null`, which means "this probe told us nothing" and deliberately preserves
 * the last-good row for up to 30 minutes. Collapsing the two would let a stale report outlive
 * the authoritative answer that replaced it: a GLM plan whose payload carries only MCP
 * `TIME_LIMIT` rows has no model windows, and the dashboard and quota-aware routing must stop
 * showing the previous token windows rather than keep them for another half hour.
 *
 * Suppression is shared with `TERMINAL_QUOTA_FAILURE`; only the reason differs.
 */
export const AUTHORITATIVE_EMPTY_QUOTA = Symbol("authoritative-empty-quota");
export type ProviderQuotaProbeResult =
  | ProviderQuotaReport
  | null
  | typeof TERMINAL_QUOTA_FAILURE
  | typeof AUTHORITATIVE_EMPTY_QUOTA;

export interface ProviderQuotaReport {
  provider: string;
  label: string;
  source: string;
  quota: ProviderQuota;
  updatedAt: number;
  /** Added by the management response projection, never stored on a cached report. */
  routingQuota?: ProviderRoutingQuota;
  reverseEngineered?: boolean;
  /**
   * The row was OBSERVED in-band on a streaming turn rather than probed.
   *
   * Age means something different for these. A probed provider re-reads on its own TTL,
   * so a row older than the last-good bound means the probe is failing and showing it
   * would misrepresent a live number. A passive provider publishes no endpoint at all
   * (`hasPassiveAccountQuota`), so its last observation is not a stale reading of
   * something fresher — it is the only measurement that exists, and dropping it leaves
   * the operator with nothing. Consumers that enforce a freshness bound must exempt
   * these and state the observation age instead.
   */
  observed?: boolean;
  aggregation?: CodexCapacityAggregation;
}

export interface ProviderQuotaResponse {
  generatedAt: number;
  reports: ProviderQuotaReport[];
}

let cache: { key: string; ts: number; response: ProviderQuotaResponse } | null = null;
export const inflight = new Map<string, { epoch: number; promise: Promise<ProviderQuotaResponse> }>();
/** Bumped on cache clear and on force-refresh start; stale-epoch probes lose commit authority. */
export let invalidationEpoch = 0;

/** Owner-module accessors: cache reassignment stays inside this file. */
export function getProviderQuotaReportCache(): { key: string; ts: number; response: ProviderQuotaResponse } | null {
  return cache;
}

export function setProviderQuotaReportCache(next: { key: string; ts: number; response: ProviderQuotaResponse } | null): void {
  cache = next;
}

export function bumpProviderQuotaInvalidationEpoch(): void {
  invalidationEpoch += 1;
}

/** Invalidate the report cache (e.g. after switching a provider's active account). */
export function clearProviderQuotaCache(): void {
  cache = null;
  clearCachedProviderQuotas();
  clearProviderApiKeyQuotaCache();
  invalidateDecisionKeyQuotas();
  invalidationEpoch += 1;
}

const providerReportEpochs = new Map<string, number>();

export function captureProviderReportEpochs(): ReadonlyMap<string, number> {
  return new Map(providerReportEpochs);
}

export function providerReportEpochChanged(captured: ReadonlyMap<string, number>, provider: string): boolean {
  return (providerReportEpochs.get(provider) ?? 0) !== (captured.get(provider) ?? 0);
}

/** Capture publication authority before queued reset observations can yield. */
export function captureObservationAuthority(config: OcxConfig, reports: readonly ProviderQuotaReport[]): (report: ProviderQuotaReport) => boolean {
  const epoch = invalidationEpoch;
  const providerEpochs = captureProviderReportEpochs();
  const keychainProofs = new Map<ProviderQuotaReport, { reference: string; generation: number } | undefined>();
  for (const report of reports) {
    const reference = config.providers[report.provider]?.apiKey;
    if (!keyReportCredentialIds.has(report) || !isKeychainReference(reference)) continue;
    keychainProofs.set(report, undefined);
    const key = peekResolvedProviderKey(reference);
    const generation = key === undefined ? undefined : passiveKeychainGeneration(reference, key);
    if (key?.trim() && generation !== undefined && createHash("sha256").update(key.trim()).digest("hex") === keyReportCredentialIds.get(report)) {
      keychainProofs.set(report, { reference, generation });
    }
  }
  return report => {
    const provider = config.providers[report.provider];
    const proof = keychainProofs.get(report);
    const key = proof && provider?.apiKey === proof.reference ? peekResolvedProviderKey(proof.reference) : undefined;
    const destination = keyReportDestinations.get(report);
    const keyCurrent = keychainProofs.has(report)
      ? !!proof && !!provider && !provider.disabled && (provider.authMode ?? "key") === "key"
        && destination?.adapter === provider.adapter && destination.baseUrl === provider.baseUrl
        && !!key?.trim() && passiveKeychainGeneration(proof.reference, key) === proof.generation
        && createHash("sha256").update(key.trim()).digest("hex") === keyReportCredentialIds.get(report)
      : keyReportCredentialCurrent(report, provider, true);
    return epoch === invalidationEpoch && !providerReportEpochChanged(providerEpochs, report.provider)
      && reportOwnerCurrent(report, provider) && isProviderQuotaReportCurrent(report)
      && keyCurrent;
  };
}

/**
 * Provider-scoped invalidation: drop one provider's report and routing row. The global epoch
 * is untouched, so another provider's cached row and in-flight commit authority survive; an
 * aggregate already in flight drops only this provider's row when it publishes.
 */
export function clearProviderQuotaCacheFor(provider: string): void {
  providerReportEpochs.set(provider, (providerReportEpochs.get(provider) ?? 0) + 1);
  if (!cache) return;
  const reports = cache.response.reports.filter(report => report.provider !== provider);
  cache = { ...cache, response: { ...cache.response, reports } };
  replaceCachedProviderQuotas(reports, routingEvidence);
}

function cacheKey(config: OcxConfig): string {
  const providers = Object.entries(config.providers)
    .map(([name, provider]) => {
      const resolvedKey = typeof provider.apiKey === "string"
        ? resolveProviderApiKey(provider.apiKey)?.trim()
        : undefined;
      // The 8-char pool id is a cheap discriminator, not an identity: two keys can share it.
      // A probe-bound report is re-validated against its captured full digest
      // (keyReportCredentialCurrent), so a collision cannot serve the other key's budgets.
      const activeKeyId = resolvedKey ? apiKeyPoolEntryId(resolvedKey) : "none";
      return `${name}:${provider.adapter}:${provider.authMode ?? "key"}:${providerCodexAccountMode(name, provider) ?? "none"}:${provider.disabled === true ? "off" : "on"}:${provider.baseUrl}:${activeKeyId}`;
    })
    .sort()
    .join("|");
  return `${config.defaultProvider}|${providers}`;
}

export type CodexAuthAccountsSnapshotPromise = ReturnType<typeof listCodexAuthAccountsSnapshot>;

export function hasCodexPoolProvider(config: OcxConfig): boolean {
  return Object.entries(config.providers).some(([name, provider]) => (
    provider.disabled !== true
    && isBuiltInChatGptForwardProvider(name, provider)
    && providerCodexAccountMode(name, provider) !== "direct"
  ));
}

/**
 * Signature of one pool account's presentation state. Every proxied Codex response restamps the
 * observation, so a raw `updatedAt` in the key stopped the report cache from ever committing
 * while traffic flowed (#7956). The key carries the fresh/stale verdict aggregation derives
 * from it instead; value changes and freshness transitions still miss the cache. A displayed
 * window `updatedAt` can therefore lag a restamp by up to the report cache TTL. The exception is
 * an exhausted short window without a reset: its `shortObservedAt` alone decides whether it
 * still blocks, over a window as short as that TTL, so that clock stays in the key.
 */
function quotaSignatureValue(quota: CodexCapacityQuota | null, now: number): unknown {
  if (!quota) return null;
  const resetless = !(typeof quota.fiveHourResetAt === "number" && quota.fiveHourResetAt > 0);
  const observationDecides = resetless && (quota.fiveHourPercent ?? 0) >= CODEX_EXHAUSTED_USAGE_PERCENT;
  return {
    fiveHourPercent: quota.fiveHourPercent,
    fiveHourResetAt: quota.fiveHourResetAt,
    ...(observationDecides ? { shortObservedAt: quota.shortObservedAt } : {}),
    weeklyPercent: quota.weeklyPercent,
    weeklyResetAt: quota.weeklyResetAt,
    monthlyPercent: quota.monthlyPercent,
    monthlyResetAt: quota.monthlyResetAt,
    fresh: Number.isFinite(quota.updatedAt) && now - quota.updatedAt <= CODEX_CAPACITY_MAX_QUOTA_AGE_MS,
    customWindows: [...(quota.customWindows ?? [])]
      .map(window => ({ label: window.label, percent: window.percent, resetAt: window.resetAt }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export function providerQuotaFromCodexQuota(
  quota: StoredAccountQuota | Omit<StoredAccountQuota, "updatedAt"> | null | undefined,
): CodexCapacityQuota | null {
  if (!quota) return null;
  // Direct snapshots bypass account DTOs; sanitize here as well as at ingestion.
  quota = withoutRetiredCodexQuota(quota);
  if (!quota) return null;
  const projected: CodexCapacityQuota = {
    ...(quota.shortPercent !== undefined ? { fiveHourPercent: quota.shortPercent } : {}),
    ...(quota.shortResetAt !== undefined ? { fiveHourResetAt: quota.shortResetAt } : {}),
    // Freshness for the reset-less terminal rule. Without it the dashboard evaluates that rule
    // with no evidence and returns null while routing refuses the same account (#5045).
    ...(quota.shortObservedAt !== undefined ? { shortObservedAt: quota.shortObservedAt } : {}),
    ...(quota.weeklyPercent !== undefined ? { weeklyPercent: quota.weeklyPercent } : {}),
    ...(quota.weeklyResetAt !== undefined ? { weeklyResetAt: quota.weeklyResetAt } : {}),
    ...(quota.monthlyPercent !== undefined ? { monthlyPercent: quota.monthlyPercent } : {}),
    ...(quota.monthlyResetAt !== undefined ? { monthlyResetAt: quota.monthlyResetAt } : {}),
    ...(quota.customWindows !== undefined ? { customWindows: quota.customWindows } : {}),
    updatedAt: "updatedAt" in quota ? quota.updatedAt : Date.now(),
  };
  return hasQuotaRows(projected) ? projected : null;
}

/** Hash only presentation-relevant state; account ids and email addresses never enter the key. */
export function cacheKeyWithAggregationState(
  config: OcxConfig,
  prefetchedSnapshot?: CodexAuthAccountsSnapshotPromise,
): string | Promise<string> {
  const base = cacheKey(config);
  if (!hasCodexPoolProvider(config)) return base;
  return (async () => {
    try {
      const activeId = effectiveCodexAuthAccountId(config);
      const snapshot = await (prefetchedSnapshot ?? listCodexAuthAccountsSnapshot(config, false));
      const now = Date.now();
      const rows = snapshot.accounts.map(account => ({
        isMain: account.isMain,
        active: account.id === activeId,
        plan: codexPlanKey(account.plan) ?? null,
        paused: account.paused,
        needsReauth: account.needsReauth === true,
        quota: quotaSignatureValue(providerQuotaFromCodexQuota(account.quota), now),
      }));
      const canonicalRows = rows.map(row => JSON.stringify(row)).sort();
      const digest = createHash("sha256").update(JSON.stringify(canonicalRows)).digest("hex").slice(0, 24);
      return `${base}|codex-pool:${digest}`;
    } catch {
      return `${base}|codex-pool:unavailable`;
    }
  })();
}

function publicCapacityWindow(window: import("../codex-capacity").CodexCapacityWindowAggregation) {
  const { totalWeight: _totalWeight, consumedWeight: _consumedWeight, remainingWeight: _remainingWeight, ...safe } = window;
  return safe;
}

/** Management API metadata intentionally omits configured/weighted unit counts. */
export function publicCapacityAggregation(
  aggregation: CodexCapacityAggregation,
  presentation: NonNullable<CodexCapacityAggregation["presentation"]>,
): CodexCapacityAggregation {
  const safeCurrentAccount = presentation === "coverage-only" && aggregation.currentAccount
    ? { ...aggregation.currentAccount, quota: null }
    : aggregation.currentAccount;
  return {
    ...aggregation,
    presentation,
    ...(safeCurrentAccount ? { currentAccount: safeCurrentAccount } : {}),
    ...(aggregation.fiveHour ? { fiveHour: publicCapacityWindow(aggregation.fiveHour) } : {}),
    ...(aggregation.weekly ? { weekly: publicCapacityWindow(aggregation.weekly) } : {}),
    ...(aggregation.monthly ? { monthly: publicCapacityWindow(aggregation.monthly) } : {}),
    ...(aggregation.customWindows ? {
      customWindows: aggregation.customWindows.map(window => ({
        label: window.label,
        ...publicCapacityWindow(window),
      })),
    } : {}),
  };
}

export function hasQuotaRows(quota: ProviderQuota | null | undefined): quota is ProviderQuota {
  if (!quota) return false;
  return typeof quota.fiveHourPercent === "number"
    || (quota.unknownBudgetWindows?.length ?? 0) > 0
    || typeof quota.weeklyPercent === "number"
    || typeof quota.monthlyPercent === "number"
    || quota.creditsUsd?.unlimited === true
    || typeof quota.creditsUsd?.percent === "number"
    || !!quota.customWindows?.some(window => typeof window.percent === "number");
}

export function providerLabel(providerId: string): string {
  return getProviderRegistryEntry(providerId)?.label ?? providerId;
}

/** Test-only access to the quota reader's deadline and cancellation contract. */
export async function readProviderQuotaJsonForTests(response: Response, timeoutMs: number): Promise<unknown> {
  const result = await readQuotaJson(response, timeoutMs);
  return result === QUOTA_JSON_READ_FAILURE ? null : result;
}

export function isBuiltInChatGptForwardProvider(name: string, provider: OcxProviderConfig): boolean {
  return name === OPENAI_CODEX_PROVIDER_ID && isCanonicalOpenAiForwardProvider(provider);
}

export function report(
  provider: string,
  source: string,
  quota: ProviderQuota,
  aggregation?: CodexCapacityAggregation,
): ProviderQuotaReport | null {
  if (!hasQuotaRows(quota)) return null;
  return {
    provider,
    label: providerLabel(provider),
    source,
    quota,
    updatedAt: quota.updatedAt,
    ...(aggregation ? { aggregation } : {}),
  };
}

/**
 * Publish a credential-bound report, and routing evidence only when the producer
 * hands over its inference-only projection.
 *
 * The projection is deliberately not defaulted to the display quota. A producer must
 * decide that its rows really do constrain inference on the probed credential; omitting
 * the argument leaves the report display-only, so a new producer cannot inherit
 * provider-veto authority merely by calling this helper. Ownership alone is not the
 * scope decision: providerQuotaRoutingBinding resolving is necessary, never sufficient.
 */
export function keyReport(
  provider: string,
  source: string,
  quota: ProviderQuota,
  config: OcxProviderConfig,
  probedCredential: string,
  inferenceQuota?: ProviderQuota,
  options?: { bindCredential?: boolean },
): ProviderQuotaReport | null {
  const result = report(provider, source, quota);
  if (!result) return result;
  if (options?.bindCredential === true) {
    keyReportCredentialIds.set(result, createHash("sha256").update(probedCredential).digest("hex"));
    keyReportDestinations.set(result, { adapter: config.adapter, baseUrl: config.baseUrl });
    reportOwners.set(result, { name: provider, signature: ownerSignature(config, true), credentialBound: true });
  }
  if (!inferenceQuota) return result;
  const binding = providerQuotaRoutingBinding(provider, config, probedCredential);
  if (binding) routingEvidence.set(result, { quota: inferenceQuota, binding });
  return result;
}

export function tagNativeMainReport(
  value: ProviderQuotaReport | null,
  generation: number,
): ProviderQuotaReport | null {
  if (value) nativeMainReportGenerations.set(value, generation);
  return value;
}

/**
 * Test-only seam: publish exactly as a credential-bound producer does, and hand back the
 * routing evidence the publication actually attached.
 *
 * Live producers all pass a projection today, so no probe fixture can prove the OTHER half
 * of the contract: that omitting it stays display-only. Routing an omitted argument through
 * the real helper keeps that provable, and a re-introduced `= quota` default would be
 * observed here (a defaulted parameter also fires for an explicitly undefined argument).
 */
export function publishKeyReportForTests(
  provider: string,
  source: string,
  quota: ProviderQuota,
  config: OcxProviderConfig,
  probedCredential: string,
  inferenceQuota?: ProviderQuota,
): { report: ProviderQuotaReport | null; routing: ProviderQuotaRoutingEvidence | undefined } {
  const result = keyReport(provider, source, quota, config, probedCredential, inferenceQuota);
  return { report: result, routing: result ? routingEvidence.get(result) : undefined };
}

export function isProviderQuotaReportCurrent(value: ProviderQuotaReport): boolean {
  const generation = nativeMainReportGenerations.get(value);
  return (generation === undefined || isMainAccountIdentityGenerationLive(generation))
    && (accountReportCurrent.get(value)?.() ?? true);
}

/** Called only by an accepted collector/cache publication, never the JEV read path. */
export function publishCollectedDecisionQuota(reports: ProviderQuotaReport[], config: OcxConfig): void {
  if (!decisionQuotaSinkActive()) return;
  const keys: DecisionKeyObservation[] = [];
  const oauth: AntigravityQuotaObservation[] = [];
  for (const report of reports) {
    const provider = config.providers[report.provider];
    if (!provider || !isProviderQuotaReportCurrent(report)) continue;
    const observation = antigravityEvidence.get(report);
    if (observation) oauth.push({ name: report.provider, provider, ...observation });
    const evidence = routingEvidence.get(report);
    if (evidence && evidence.binding === providerQuotaRoutingBinding(report.provider, provider))
      keys.push({ name: report.provider, provider, windows: providerDecisionWindows(evidence.quota) });
  }
  replaceCollectedDecisionQuotas(keys, oauth);
}

/**
 * The reports this process already holds for the configured providers, for a passive read (#6959):
 * no probe, token refresh, account snapshot or publication into routing evidence. The Home's own
 * dashboard and traffic keep the cache current.
 */
export function heldProviderQuotaReports(config: OcxConfig): ProviderQuotaResponse {
  const held = getProviderQuotaReportCache()?.response;
  return {
    generatedAt: held?.generatedAt ?? Date.now(),
    reports: (held?.reports ?? []).filter(item => {
      const provider = config.providers[item.provider];
      return reportOwnerCurrent(item, provider, true) && isProviderQuotaReportCurrent(item) && keyReportCredentialCurrent(item, provider, true);
    }),
  };
}
