import { createHash } from "node:crypto";
import { effectiveCodexAuthAccountId, listCodexAuthAccountsSnapshot } from "../../codex/auth-api";
import { withoutRetiredCodexQuota, type StoredAccountQuota } from "../../codex/quota";
import { isMainAccountIdentityGenerationLive } from "../../codex/main-account-cache";
import { codexPlanKey } from "../../codex/plan";
import { resolveProviderApiKey } from "../key-store";
import { apiKeyPoolEntryId } from "../api-keys";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../registry";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../openai-tiers";
import { CODEX_CAPACITY_MAX_QUOTA_AGE_MS, type CodexCapacityAggregation, type CodexCapacityQuota } from "../codex-capacity";
import { clearCachedProviderQuotas, providerQuotaRoutingBinding, type ProviderQuotaRoutingEvidence } from "../quota-routing-cache";
import { clearProviderApiKeyQuotaCache } from "../quota-key-accounts";
import { QUOTA_JSON_READ_FAILURE, readQuotaJson } from "../quota-wire";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import type { ProviderQuota, ProviderRoutingQuota } from "../quota-types";

/** Keep a failed probe's previous row at most this long before dropping it. */
export const LAST_GOOD_MAX_AGE_MS = CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
const nativeMainReportGenerations = new WeakMap<ProviderQuotaReport, number>();
export const accountReportCurrent = new WeakMap<ProviderQuotaReport, () => boolean>();
export const routingEvidence = new WeakMap<ProviderQuotaReport, ProviderQuotaRoutingEvidence>();
export let providerQuotaBeforePublishForTests: (() => void | Promise<void>) | null = null;

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
  invalidationEpoch += 1;
}

function cacheKey(config: OcxConfig): string {
  const providers = Object.entries(config.providers)
    .map(([name, provider]) => {
      const resolvedKey = typeof provider.apiKey === "string"
        ? resolveProviderApiKey(provider.apiKey)?.trim()
        : undefined;
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

function quotaSignatureValue(quota: CodexCapacityQuota | null): unknown {
  if (!quota) return null;
  return {
    fiveHourPercent: quota.fiveHourPercent,
    fiveHourResetAt: quota.fiveHourResetAt,
    weeklyPercent: quota.weeklyPercent,
    weeklyResetAt: quota.weeklyResetAt,
    monthlyPercent: quota.monthlyPercent,
    monthlyResetAt: quota.monthlyResetAt,
    updatedAt: quota.updatedAt,
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
      const rows = snapshot.accounts.map(account => ({
        isMain: account.isMain,
        active: account.id === activeId,
        plan: codexPlanKey(account.plan) ?? null,
        paused: account.paused,
        needsReauth: account.needsReauth === true,
        quota: quotaSignatureValue(providerQuotaFromCodexQuota(account.quota)),
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
): ProviderQuotaReport | null {
  const result = report(provider, source, quota);
  if (!result || !inferenceQuota) return result;
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
