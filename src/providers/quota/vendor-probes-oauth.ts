import { effectiveCodexAuthAccountId, fetchMainAccountInfoSnapshot, listCodexAuthAccountsSnapshot } from "../../codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/main-account";
import { getValidAccessToken } from "../../oauth";
import { getAccountCredential, getAccountSet } from "../../oauth/store";
import { hydrateKiroAccountState, persistKiroAccountState } from "../kiro-account-state-disk";
import { kiroProbeCurrent, kiroProbeIdentity } from "./kiro-account-probe";
import { fetchMirasimQuota } from "../../adapters/mirasim/control-plane";
import { fetchMuseKeyQuotaSnapshot } from "../muse-key-quota";
import { CLAUDE_CLI_USER_AGENT } from "../claude-cli-identity";
import { XAI_GROK_CLIENT_VERSION, XAI_GROK_COMPATIBILITY } from "../xai-transport";
import {
  commitKiroAccountUsageState,
  fetchKiroUsageSnapshot,
  type KiroUsageSnapshot,
  kiroUsageContextForAccount,
} from "../kiro-usage";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { aggregateCodexPoolCapacity, CODEX_CAPACITY_MAX_QUOTA_AGE_MS, type CodexCapacityQuota } from "../codex-capacity";
import { asRecord, normalizePercent, normalizeResetAt, readQuotaJson, REQUEST_TIMEOUT_MS, toFiniteNumber } from "../quota-wire";
import { providerCodexAccountMode } from "../registry";
import {
  hasQuotaRows,
  providerLabel,
  providerQuotaFromCodexQuota,
  publicCapacityAggregation,
  report,
  tagNativeMainReport,
  type CodexAuthAccountsSnapshotPromise,
  type ProviderQuotaReport,
} from "./report-cache";
import {
  accountCacheKey,
  accountQuotaCache,
  hydrateAccountQuotaCache,
  mayCommitAccountQuotaKey,
  persistAccountQuotaCache,
} from "./account-cache";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import type { ProviderQuota, ProviderQuotaWindow } from "../quota-types";

const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_CREDITS_URL = `${XAI_BILLING_URL}?format=credits`;

export async function fetchMirasimQuotaReport(
  provider: string,
  config: OcxProviderConfig,
  accessToken: string,
): Promise<ProviderQuotaReport | null> {
  const quota = await fetchMirasimQuota(provider, config, accessToken);
  return quota ? report(provider, "mirasim:/v1/limits", quota) : null;
}

export async function fetchChatGptForwardQuota(
  config: OcxConfig,
  provider: string,
  providerConfig: OcxProviderConfig,
  forceRefresh: boolean,
  prefetchedSnapshot?: CodexAuthAccountsSnapshotPromise,
): Promise<ProviderQuotaReport | null> {
  if (providerCodexAccountMode(provider, providerConfig) === "direct") {
    const snapshot = await fetchMainAccountInfoSnapshot(forceRefresh);
    const quota = providerQuotaFromCodexQuota(snapshot.info.quota);
    if (quota) quota.updatedAt = Date.now();
    return quota
      ? tagNativeMainReport(report(provider, "chatgpt:wham", quota), snapshot.mainIdentityGeneration)
      : null;
  }
  const snapshot = await (prefetchedSnapshot ?? listCodexAuthAccountsSnapshot(config, forceRefresh));
  const accounts = snapshot.accounts;
  const activeId = effectiveCodexAuthAccountId(config);
  const capacityAccounts = accounts.map(account => ({
    ...account,
    active: account.id === activeId,
    quota: providerQuotaFromCodexQuota(account.quota),
  }));
  const active = capacityAccounts.find(account => account.active)
    ?? capacityAccounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)
    ?? capacityAccounts[0];
  const now = Date.now();
  const capacity = aggregateCodexPoolCapacity(capacityAccounts, now);
  if (capacity.aggregation && capacity.quota) {
    return tagNativeMainReport(
      report(
        provider,
        "chatgpt:wham",
        capacity.quota as ProviderQuota,
        publicCapacityAggregation(capacity.aggregation, "aggregate"),
      ),
      snapshot.mainIdentityGeneration,
    );
  }
  const activeUsable = !!active && !active.paused && active.needsReauth !== true;
  const quota = activeUsable && active?.quota
    ? { ...active.quota, updatedAt: active.quota.updatedAt ?? Date.now() } as CodexCapacityQuota
    : null;
  const quotaFresh = !!quota
    && Number.isFinite(quota.updatedAt)
    && now - quota.updatedAt < CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
  if (quota && quotaFresh) {
    const fallback = report(
      provider,
      "chatgpt:wham",
      quota as ProviderQuota,
      capacity.aggregation
        ? publicCapacityAggregation(capacity.aggregation, "effective-account-fallback")
        : undefined,
    );
    return tagNativeMainReport(fallback, snapshot.mainIdentityGeneration);
  }
  if (capacity.aggregation) {
    const updatedAt = Date.now();
    return tagNativeMainReport(
      {
        provider,
        label: providerLabel(provider),
        source: "chatgpt:wham",
        quota: { updatedAt },
        updatedAt,
        aggregation: publicCapacityAggregation(capacity.aggregation, "coverage-only"),
      },
      snapshot.mainIdentityGeneration,
    );
  }
  return null;
}

function centsValue(value: unknown): number | undefined {
  const rec = asRecord(value);
  return rec ? toFiniteNumber(rec.val) : undefined;
}

/** Decode JWT payload `sub` for xAI weekly credits when the stored credential lacks accountId. */
function xaiUserIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grok Build weekly credits envelope:
 * `{ config: { creditUsagePercent?, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end } } }`.
 * Omitted percent is treated as 0 (proto3 default).
 */
export function parseXaiCreditsResponse(value: unknown): { percent: number; resetAt?: number } | null {
  const body = asRecord(value);
  const config = asRecord(body?.config);
  if (!config) return null;
  const period = asRecord(config.currentPeriod);
  if (!period || period.type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;
  let percent = 0;
  if (config.creditUsagePercent !== undefined) {
    const normalized = normalizePercent(config.creditUsagePercent);
    if (normalized === undefined) return null;
    percent = normalized;
  }
  const resetAt = normalizeResetAt(period.end);
  return {
    percent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

async function fetchXaiWeeklyCredits(accessToken: string, userId: string): Promise<ProviderQuota | null> {
  try {
    const response = await fetch(XAI_CREDITS_URL, {
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        [XAI_GROK_COMPATIBILITY.headers.tokenAuth]: "xai-grok-cli",
        [XAI_GROK_COMPATIBILITY.headers.authenticateResponse]: "authenticate-response",
        "x-userid": userId,
        [XAI_GROK_COMPATIBILITY.headers.clientVersion]: XAI_GROK_CLIENT_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = parseXaiCreditsResponse(await readQuotaJson(response));
    if (!parsed) return null;
    return {
      weeklyPercent: parsed.percent,
      ...(parsed.resetAt !== undefined ? { weeklyResetAt: parsed.resetAt } : {}),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function fetchXaiQuota(provider: string, context: { accessToken: string; upstreamAccountId?: string }): Promise<ProviderQuotaReport | null> {
  const { accessToken } = context;

  // Prefer the SuperGrok weekly credits window that actually gates prompting (#1283).
  const userId = context.upstreamAccountId?.trim() || xaiUserIdFromAccessToken(accessToken);
  if (userId) {
    const weekly = await fetchXaiWeeklyCredits(accessToken, userId);
    if (weekly) return report(provider, "xai:grok-billing-credits", weekly);
  }

  // Legacy monthly dollar pool — retained when weekly is unavailable.
  try {
    const response = await fetch(XAI_BILLING_URL, {
      redirect: "error",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = asRecord(await readQuotaJson(response));
    const config = asRecord(body?.config);
    if (!config) return null;
    const limitCents = centsValue(config.monthlyLimit);
    const usedCents = centsValue(config.used);
    if (limitCents === undefined || usedCents === undefined || limitCents <= 0) return null;
    const percent = normalizePercent((usedCents / limitCents) * 100);
    if (percent === undefined) return null;
    return report(provider, "xai:grok-billing", {
      monthlyPercent: percent,
      monthlyResetAt: normalizeResetAt(config.billingPeriodEnd),
      updatedAt: Date.now(),
    });
  } catch {
    return null;
  }
}

function parseClaudeBucket(value: unknown): { percent?: number; resetAt?: number } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.utilization);
  const resetAt = normalizeResetAt(rec.resets_at);
  if (percent === undefined && resetAt === undefined) return null;
  return { percent, resetAt };
}

const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

function parseClaudeLimit(value: unknown): ProviderQuotaWindow | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.percent);
  if (percent === undefined) return null;
  const scope = asRecord(rec.scope);
  const model = asRecord(scope?.model);
  const rawLabel = String(model?.display_name ?? "")
    .replace(TERMINAL_CONTROL_CHARACTERS, "")
    .trim();
  if (!rawLabel) return null;
  const lowerLabel = rawLabel.toLowerCase();
  const label = lowerLabel.includes("fable") ? "Fable"
    : lowerLabel.includes("opus") ? "Opus"
      : lowerLabel.includes("sonnet") ? "Sonnet"
        : null;
  // An unrecognized display_name is never published as a quota label: stripping
  // control characters still leaves attacker-chosen residue on the quota line.
  if (label === null) return null;
  const resetAt = normalizeResetAt(rec.resets_at);
  // Model scope is proven structurally here, not guessed from text: the caller admits only
  // `kind: "weekly_scoped"`, and a limit without a recognized `scope.model.display_name` has
  // already returned null above. Routing keys on `scope`, never on `label`.
  return { label, scope: "model", percent, ...(resetAt !== undefined ? { resetAt } : {}) };
}

/** Claude's OAuth usage endpoint, probed with ONE account's own bearer token. */
const anthropicUsageInflight = new Map<string, Promise<ProviderQuota | null>>();

/**
 * Anthropic per-credential usage.
 *
 * This endpoint reports quota only. Its body carries `five_hour`, `seven_day`, the
 * model-scoped weekly buckets (`seven_day_fable`/`_opus`/`_sonnet`) and a `limits` array,
 * and **no subscription or tier field** — nor does the OAuth token response, which yields only
 * `account.uuid` and `account.email_address` (`src/oauth/anthropic.ts`). That is why
 * `OAuthAccountSummary.plan` is `null` for Anthropic rather than populated here (#3777); it is
 * a missing upstream field, not an unfinished mapping.
 *
 * A tier must not be inferred from what is here. Percentages are normalized per account, so a
 * Max x5 seat at 50% is byte-identical to a Max x20 seat at 50%, and the presence of a
 * model-scoped window tracks entitlement rather than seat size. Populate `plan` only when
 * upstream returns the tier itself.
 */
export async function fetchAnthropicUsageQuota(accessToken: string): Promise<ProviderQuota | null> {
  const joinable = anthropicUsageInflight.get(accessToken);
  if (joinable) return joinable;

  const probe = (async (): Promise<ProviderQuota | null> => {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": CLAUDE_CLI_USER_AGENT,
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = asRecord(await readQuotaJson(response));
    if (!body) return null;
    const fiveHour = parseClaudeBucket(body.five_hour);
    const sevenDay = parseClaudeBucket(body.seven_day);
    const fable = parseClaudeBucket(body.seven_day_fable);
    const opus = parseClaudeBucket(body.seven_day_opus);
    const sonnet = parseClaudeBucket(body.seven_day_sonnet);
    const customWindows: ProviderQuotaWindow[] = [];
    if (fable?.percent !== undefined) customWindows.push({ label: "Fable", scope: "model", percent: fable.percent, ...(fable.resetAt !== undefined ? { resetAt: fable.resetAt } : {}) });
    if (opus?.percent !== undefined) customWindows.push({ label: "Opus", scope: "model", percent: opus.percent, ...(opus.resetAt !== undefined ? { resetAt: opus.resetAt } : {}) });
    if (sonnet?.percent !== undefined) customWindows.push({ label: "Sonnet", scope: "model", percent: sonnet.percent, ...(sonnet.resetAt !== undefined ? { resetAt: sonnet.resetAt } : {}) });
    const knownLabels = new Set(customWindows.map(window => window.label.toLowerCase()));
    const limits = Array.isArray(body.limits) ? body.limits : [];
    for (const rawLimit of limits) {
      const limitRecord = asRecord(rawLimit);
      // `session` and `weekly_all` mirror the canonical five-hour and weekly
      // buckets above; only model-scoped weekly limits add a third window.
      if (String(limitRecord?.kind ?? "").trim().toLowerCase() !== "weekly_scoped") continue;
      const limit = parseClaudeLimit(rawLimit);
      if (!limit || knownLabels.has(limit.label.toLowerCase())) continue;
      knownLabels.add(limit.label.toLowerCase());
      customWindows.push(limit);
    }
    const quota: ProviderQuota = {
      // Claude's 5-hour window is a first-class rate limit, same as the Codex login 5h/weekly
      // rows: report it in the canonical fields so the dashboard renders it with the standard
      // "5-hour limit" label and ordering instead of as a generic extra window.
      ...(fiveHour?.percent !== undefined ? { fiveHourPercent: fiveHour.percent } : {}),
      ...(fiveHour?.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
      ...(sevenDay?.percent !== undefined ? { weeklyPercent: sevenDay.percent } : {}),
      ...(sevenDay?.resetAt !== undefined ? { weeklyResetAt: sevenDay.resetAt } : {}),
      ...(customWindows.length > 0 ? { customWindows } : {}),
      updatedAt: Date.now(),
    };
    // Empty / schema-changed payloads must not cache as "success with no bars".
    return hasQuotaRows(quota) ? quota : null;
  })().finally(() => {
    if (anthropicUsageInflight.get(accessToken) === probe) anthropicUsageInflight.delete(accessToken);
  });
  anthropicUsageInflight.set(accessToken, probe);
  return probe;
}

export async function fetchAnthropicQuota(provider: string): Promise<ProviderQuotaReport | null> {
  // Capture the account we intend to probe before awaiting — a mid-flight active
  // switch must not seed the wrong account's cache with this response.
  const probedAccountId = getAccountSet("anthropic")?.activeAccountId;
  const probedAccountKey = probedAccountId ? accountCacheKey("anthropic", probedAccountId) : null;
  const writerGeneration = captureConfigGeneration();
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("anthropic");
  } catch {
    return null;
  }
  const quota = await fetchAnthropicUsageQuota(accessToken);
  if (!quota) return null;
  // Share the active-account probe with the per-account cache so Providers-page
  // loads do not double-hit Anthropic's rate-limited usage endpoint.
  if (probedAccountId && probedAccountKey) {
    const stillOwnsToken = getAccountCredential("anthropic", probedAccountId)?.access === accessToken;
    if (stillOwnsToken && mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
      accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota });
    }
  }
  return report(provider, "anthropic:oauth-usage", quota);
}

/**
 * Provider-level Kiro row: the active account's usage, shown on the Providers page.
 *
 * The per-account cache is seeded from the same probe so opening that page does not read
 * the active account twice, and the account id is captured before the await so a
 * concurrent account switch cannot file this answer under the wrong account.
 */
export async function fetchKiroQuota(provider: string): Promise<ProviderQuotaReport | null> {
  hydrateKiroAccountState();
  const probedAccountId = getAccountSet("kiro")?.activeAccountId;
  if (!probedAccountId) return null;
  const identity = kiroProbeIdentity(probedAccountId);
  const probedAccountKey = accountCacheKey("kiro", probedAccountId);
  const writerGeneration = captureConfigGeneration();
  let snapshot: KiroUsageSnapshot | null;
  try {
    snapshot = await fetchKiroUsageSnapshot(await kiroUsageContextForAccount(probedAccountId));
  } catch {
    return null;
  }
  if (!snapshot) return null;
  if (!kiroProbeCurrent(probedAccountId, identity)) return null;
  if (mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
    accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota: snapshot.quota, identity });
    commitKiroAccountUsageState(probedAccountKey, snapshot, identity);
    persistKiroAccountState();
  }
  return report(provider, "kiro:usage-limits", snapshot.quota);
}

/**
 * Provider-level row probed from the key endpoint, for an account that CAN be probed.
 *
 * Written through the same account cache the passive path reads, so the measurement
 * survives a restart and the per-account rows at oauth-account-routes.ts:313 pick it up
 * with no mode change. Deliberately does not flip providerOAuthAccountQuotaMode: that
 * mode selects readPassiveProviderAccountQuotas, and the probed per-account path it would
 * switch to is gated on supportsPerAccountQuota, which has no meta-muse reader, so the
 * GUI account list would go from showing observations to showing nothing.
 */
export async function fetchMuseKeyQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const probedAccountId = getAccountSet(provider)?.activeAccountId;
  if (!probedAccountId) return null;
  const oauthAccessToken = getAccountCredential(provider, probedAccountId)?.muse?.oauthAccessToken;
  // An imported or pasted credential has no account token and never will: it is
  // capability, not provider id, that decides whether a probe is possible.
  if (!oauthAccessToken) return null;
  const probedAccountKey = accountCacheKey(provider, probedAccountId);
  const writerGeneration = captureConfigGeneration();
  const quota = await fetchMuseKeyQuotaSnapshot(probedAccountId, oauthAccessToken);
  if (!quota) return null;
  if (mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
    // Hydrate before writing, for the same reason recordPassiveAccountQuota does:
    // persistAccountQuotaCache serializes the whole in-memory map.
    hydrateAccountQuotaCache();
    accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota });
    persistAccountQuotaCache();
  }
  return report(provider, `${provider}:key-endpoint`, quota);
}
/**
 * Provider-level row for a passive provider: the ACTIVE account's last observed
 * subscription windows, the same shape `fetchAnthropicQuota` and `fetchKiroQuota`
 * return.
 *
 * Cache-only. A dashboard load or `ocx account refresh` must never spend an inference
 * turn, so `forceRefresh` does not exist on this path — there is nothing to refresh.
 * `report.updatedAt` is the observation time, which is what both GUI surfaces render
 * as the relative age of the row.
 */
export async function fetchPassiveProviderQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const activeId = getAccountSet(provider)?.activeAccountId;
  if (!activeId) return null;
  // Idempotent; without it a proxy restart shows nothing until the next streaming turn
  // even though the last observation is on disk.
  hydrateAccountQuotaCache();
  const entry = accountQuotaCache.get(accountCacheKey(provider, activeId));
  if (!entry?.quota) return null;
  const built = report(provider, `${provider}:subscription-observation`, entry.quota);
  // Tagged here rather than inside report(), which every probed path shares.
  return built ? { ...built, observed: true } : null;
}

// ---------------------------------------------------------------------------
// Per-account quota (multiauth)
// ---------------------------------------------------------------------------


/** Cursor included usage via api2.cursor.sh (Bearer from OAuth) — unofficial, may change. */
export async function fetchCursorQuota(provider: string, accessToken: string): Promise<ProviderQuotaReport | null> {

  const authHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "opencodex-quota",
  } as const;

  // Prefer dashboard period usage (Pro/Team/Ultra spend allowance in USD cents).
  // Field names follow Cursor's Connect RPC shape (limit/remaining/includedSpend), not usedCents.
  try {
    const periodRes = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      redirect: "error",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (periodRes.ok) {
      const body = asRecord(await readQuotaJson(periodRes));
      const planUsage = asRecord(body?.planUsage);
      if (planUsage) {
        const resetAt = normalizeResetAt(body?.billingCycleEnd ?? planUsage.billingCycleEnd ?? body?.periodEnd);

        // Primary meter: overall included allowance (Cursor Settings → Usage total %).
        // autoPercentUsed / apiPercentUsed are secondary pools and must not replace the total.
        const limit = toFiniteNumber(planUsage.limit ?? planUsage.limitCents ?? planUsage.totalLimitCents);
        const remaining = toFiniteNumber(planUsage.remaining ?? planUsage.remainingCents);
        const includedSpend = toFiniteNumber(planUsage.includedSpend ?? planUsage.usedCents ?? planUsage.used);
        const totalSpend = toFiniteNumber(planUsage.totalSpend);
        let used: number | undefined;
        if (includedSpend !== undefined) used = includedSpend;
        else if (limit !== undefined && remaining !== undefined) used = Math.max(0, limit - remaining);
        else if (totalSpend !== undefined) used = totalSpend;
        const totalPercent = normalizePercent(planUsage.totalPercentUsed ?? planUsage.percentUsed)
          ?? (limit !== undefined && limit > 0 && used !== undefined
            ? normalizePercent((used / limit) * 100)
            : undefined);

        const autoPercent = normalizePercent(planUsage.autoPercentUsed);
        const apiPercent = normalizePercent(planUsage.apiPercentUsed);
        const customWindows: ProviderQuotaWindow[] = [];
        if (autoPercent !== undefined) {
          customWindows.push({
            label: "First-party models",
            percent: autoPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          });
        }
        if (apiPercent !== undefined) {
          customWindows.push({
            label: "API usage",
            percent: apiPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          });
        }

        if (totalPercent !== undefined || customWindows.length > 0) {
          const built = report(provider, "cursor:period-usage", {
            ...(totalPercent !== undefined ? {
              monthlyPercent: totalPercent,
              ...(resetAt !== undefined ? { monthlyResetAt: resetAt } : {}),
            } : {}),
            ...(customWindows.length > 0 ? { customWindows } : {}),
            updatedAt: Date.now(),
          });
          if (built) return { ...built, reverseEngineered: true };
        }
      }
    }
  } catch {
    /* fall through */
  }

  // /api/usage/summary — same host, sometimes richer than /auth/usage for Team plans.
  try {
    const summaryRes = await fetch("https://api2.cursor.sh/api/usage/summary", {
      headers: authHeaders,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (summaryRes.ok) {
      const body = asRecord(await readQuotaJson(summaryRes));
      const individual = asRecord(body?.individualUsage);
      const plan = asRecord(individual?.plan);
      if (plan) {
        const used = toFiniteNumber(plan.used);
        const limit = toFiniteNumber(plan.limit);
        const percent = normalizePercent(plan.totalPercentUsed)
          ?? (used !== undefined && limit !== undefined && limit > 0
            ? normalizePercent((used / limit) * 100)
            : undefined);
        if (percent !== undefined) {
          const built = report(provider, "cursor:usage-summary", {
            monthlyPercent: percent,
            monthlyResetAt: normalizeResetAt(body?.billingCycleEnd),
            updatedAt: Date.now(),
          });
          if (built) return { ...built, reverseEngineered: true };
        }
      }
    }
  } catch {
    /* fall through to /auth/usage */
  }

  const response = await fetch("https://api2.cursor.sh/auth/usage", {
    headers: authHeaders,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await readQuotaJson(response));
  if (!body) return null;

  // Prefer the gpt-4 bucket (historical "fast requests"); else first model with used+limit.
  let used: number | undefined;
  let limit: number | undefined;
  const gpt4 = asRecord(body["gpt-4"]);
  if (gpt4) {
    used = toFiniteNumber(gpt4.numRequests ?? gpt4.used);
    limit = toFiniteNumber(gpt4.maxRequestUsage ?? gpt4.limit ?? gpt4.maxRequests);
  }
  if (used === undefined || limit === undefined || limit <= 0) {
    for (const [key, value] of Object.entries(body)) {
      if (key === "startOfMonth" || key === "billingCycleStart") continue;
      const bucket = asRecord(value);
      if (!bucket) continue;
      const bucketUsed = toFiniteNumber(bucket.numRequests ?? bucket.used);
      const bucketLimit = toFiniteNumber(bucket.maxRequestUsage ?? bucket.limit ?? bucket.maxRequests);
      if (bucketUsed !== undefined && bucketLimit !== undefined && bucketLimit > 0) {
        used = bucketUsed;
        limit = bucketLimit;
        break;
      }
    }
  }
  if (used === undefined || limit === undefined || limit <= 0) return null;
  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;
  const startOfMonth = normalizeResetAt(body.startOfMonth ?? body.billingCycleStart);
  // Next reset = same day next month, computed in UTC to avoid timezone-shifted rollover.
  const monthlyResetAt = startOfMonth !== undefined
    ? (() => {
        const start = new Date(startOfMonth);
        return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
      })()
    : undefined;
  const built = report(provider, "cursor:auth-usage", {
    monthlyPercent: percent,
    ...(monthlyResetAt !== undefined ? { monthlyResetAt } : {}),
    updatedAt: Date.now(),
  });
  return built ? { ...built, reverseEngineered: true } : null;
}
