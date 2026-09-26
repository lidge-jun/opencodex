/** Account-scoped Kiro management model evidence; never required for a request. */
import type { ProviderAccount } from "../oauth/types";
import { getAccountSet } from "../oauth/store";
import type { OcxProviderConfig } from "../types";
import { providerOutboundPost, providerRedirectError, type ProviderOutboundDependencies } from "../lib/provider-outbound";
import { kiroEvidenceIdentity } from "./kiro-account-state-disk";
import { normalizeKiroModelId, KIRO_MODEL_CONTEXT_WINDOWS } from "./kiro-models";
import { kiroManagementHost, kiroUsageContextForAccount } from "./kiro-usage";
import { isValidModelDiscoveryModelId, MODEL_DISCOVERY_MAX_MODELS } from "./model-discovery-limits";
import { asRecord, QUOTA_JSON_READ_FAILURE, readQuotaJson, REQUEST_TIMEOUT_MS } from "./quota-wire";

const TARGET = "KiroControlPlaneBearerService.ListAvailableModels";
export const KIRO_MODEL_CATALOG_TTL_MS = 60 * 60_000;
const LAST_GOOD_MS = 24 * 60 * 60_000;
const FAILURE_RETRY_MS = 60_000;

export interface KiroAccountModel { modelId: string; contextWindow?: number }
interface Row { identity: string; models: KiroAccountModel[]; observedAt: number; nextRefreshAt: number }
interface Flight { identity: string; promise: Promise<void> }
const rows = new Map<string, Row>();
const flights = new Map<string, Flight>();

export function kiroModelDiscoveryEnabled(): boolean {
  return process.env.OPENCODEX_KIRO_MODEL_DISCOVERY !== "0";
}

function liveAccount(accountId: string): ProviderAccount | undefined {
  return getAccountSet("kiro")?.accounts.find(account => account.id === accountId && account.needsReauth !== true);
}

function currentIdentity(accountId: string): string | undefined {
  const account = liveAccount(accountId);
  return account ? kiroEvidenceIdentity(account) : undefined;
}

function validRow(account: ProviderAccount): Row | undefined {
  const live = liveAccount(account.id);
  if (!live || kiroEvidenceIdentity(live) !== kiroEvidenceIdentity(account)) return undefined;
  const row = rows.get(account.id);
  if (!row || row.identity !== kiroEvidenceIdentity(live)) return undefined;
  if (Date.now() - row.observedAt >= LAST_GOOD_MS) return undefined;
  return row;
}

/** Synchronous cache read; no token refresh and no network. */
export function readKiroAccountModels(account: ProviderAccount): KiroAccountModel[] | undefined {
  return validRow(account)?.models;
}

function parseModels(value: unknown): KiroAccountModel[] | undefined {
  const payload = asRecord(value);
  if (!payload || !Array.isArray(payload.models) || payload.models.length === 0
    || payload.models.length > MODEL_DISCOVERY_MAX_MODELS) return undefined;
  const seen = new Set<string>();
  const models: KiroAccountModel[] = [];
  for (const value of payload.models) {
    const item = asRecord(value);
    if (!item || !isValidModelDiscoveryModelId(item.modelId) || seen.has(item.modelId)) continue;
    seen.add(item.modelId);
    const limits = asRecord(item.tokenLimits);
    const limit = limits?.maxInputTokens;
    models.push({ modelId: item.modelId,
      ...(typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0
        ? { contextWindow: limit } : {}) });
  }
  return models.length ? models : undefined;
}

/** Start an identity-fenced refresh without adding its latency to the serving request. */
export function refreshKiroAccountModelsDetached(
  account: ProviderAccount,
  providerConfig: OcxProviderConfig,
  dependencies: ProviderOutboundDependencies = {},
): void {
  if (!kiroModelDiscoveryEnabled() || account.needsReauth === true) return;
  const identity = kiroEvidenceIdentity(account);
  if (currentIdentity(account.id) !== identity) return;
  const old = validRow(account);
  if (old && Date.now() < old.nextRefreshAt) return;
  if (flights.get(account.id)?.identity === identity) return;

  const flight = (async (): Promise<void> => {
    let fresh: KiroAccountModel[] | undefined;
    try {
      const ctx = await kiroUsageContextForAccount(account.id);
      if (currentIdentity(account.id) !== identity || !ctx.profileArn) return;
      const url = new URL(kiroManagementHost(ctx));
      url.searchParams.set("origin", "AI_EDITOR");
      url.searchParams.set("profileArn", ctx.profileArn);
      const response = await providerOutboundPost("kiro", providerConfig, url.toString(), {
        headers: {
          authorization: `Bearer ${ctx.access}`,
          "content-type": "application/x-amz-json-1.0",
          accept: "application/json",
          "x-amz-target": TARGET,
          "x-amzn-codewhisperer-optout": "true",
        },
        body: JSON.stringify({ origin: "AI_EDITOR", profileArn: ctx.profileArn }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, dependencies);
      if (response.ok && !await providerRedirectError(response, url.toString())) {
        const body = await readQuotaJson(response);
        if (body !== QUOTA_JSON_READ_FAILURE) fresh = parseModels(body);
      }
    } catch {
      // Management discovery is advisory. Keep the last good row on every failure.
    }
    if (currentIdentity(account.id) !== identity) return;
    const now = Date.now();
    if (fresh) rows.set(account.id, { identity, models: fresh, observedAt: now,
      nextRefreshAt: now + KIRO_MODEL_CATALOG_TTL_MS });
    else if (old) rows.set(account.id, { ...old, nextRefreshAt: now + FAILURE_RETRY_MS });
  })();
  flights.set(account.id, { identity, promise: flight });
  void flight.catch(() => {}).finally(() => {
    if (flights.get(account.id)?.promise === flight) flights.delete(account.id);
  });
}

export function kiroAccountSupportsModel(accountId: string, model: string): boolean | undefined {
  const account = liveAccount(accountId);
  const models = account ? readKiroAccountModels(account) : undefined;
  if (!models) return undefined;
  const normalized = normalizeKiroModelId(model);
  return models.some(row => row.modelId === model || row.modelId === normalized);
}

/** Include the static floor while any live account has no observed limit. */
export function kiroObservedContextWindow(model: string): number | undefined {
  const normalized = normalizeKiroModelId(model);
  if (normalized === "auto") return undefined;
  const accounts = getAccountSet("kiro")?.accounts.filter(account => account.needsReauth !== true) ?? [];
  const limits: number[] = [];
  let unknown = accounts.length === 0;
  for (const account of accounts) {
    const hit = readKiroAccountModels(account)?.find(row => row.modelId === model || row.modelId === normalized);
    if (hit?.contextWindow === undefined) unknown = true;
    else limits.push(hit.contextWindow);
  }
  const staticWindow = KIRO_MODEL_CONTEXT_WINDOWS[normalized];
  if (unknown && staticWindow !== undefined) limits.push(staticWindow);
  return limits.length ? Math.min(...limits) : undefined;
}

export function clearKiroAccountModels(accountId?: string): void {
  if (accountId) { rows.delete(accountId); flights.delete(accountId); }
  else { rows.clear(); flights.clear(); }
}

/** Deterministic test seam; production requests never call this. */
export function awaitKiroModelRefreshForTests(accountId: string): Promise<void> {
  return flights.get(accountId)?.promise ?? Promise.resolve();
}
