/**
 * Assemble `ocx.quota-pool/1` (`GET /api/quota-pool`) from what this Home already holds.
 *
 * Strictly passive. Every source below is a cache another path filled; this module starts no
 * probe, token refresh, quota refresh or upstream call and writes nothing. The whole assembly runs
 * inside `runPassiveRead`, so even the shared readers it calls (the Codex account list, the OAuth
 * store) take their passive branch: no WHAM probe, no native-main claim, no file hardening or
 * malformed-store backup. Sources:
 *
 * - Codex pool accounts: the passive `listCodexAuthAccountsSnapshot` (stored `StoredAccountQuota`
 *   per account plus the cached main-account reading);
 * - per-account OAuth quota (Anthropic instances, Kiro, Antigravity, xAI, Cursor, Kimi, Command
 *   Code, Devin, DSH, Meta): the last-good per-account cache;
 * - Claude CLI: the usage-admission snapshot (5-hour, weekly and family windows, plus a parsed
 *   CLI limit refusal);
 * - provider-level reports: `heldProviderQuotaReports`, the reports the Home last published, used
 *   as `pooled` only for a provider without account rows.
 *
 * A provider with account rows gets its `pooled` windows from those rows (`pooled.ts`), so the
 * pool does not depend on an active quota read having warmed the report cache.
 *
 * An unknown window is omitted, never emitted as 0%. A window whose reset has passed is unknown
 * again and is omitted too. Optional fields are left out instead of set to null.
 */
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { ProviderQuota, ProviderQuotaWindow } from "../providers/quota-types";
import type { StoredAccountQuota } from "../codex/quota-types";
import { isTerminalShortWindow, resetAtToMs } from "../codex/quota-types";
import { runPassiveRead } from "../lib/passive-read";
import { packageVersion } from "../lib/package-version";
import { listCodexAuthAccountsSnapshot } from "../codex/auth-api";
import { latestCodexQuotaObservationSource } from "../codex/quota";
import { ACCOUNT_LOG_LABEL_RE, oauthAccountLogLabel } from "../codex/account-label";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers-destination";
import { hasCodexPoolProvider, heldProviderQuotaReports, type ProviderQuotaReport } from "../providers/quota/report-cache";
import {
  accountCacheKey,
  accountQuotaCache,
  getCachedProviderAccountQuota,
  hasPassiveAccountQuota,
  supportsPerAccountQuota,
} from "../providers/quota/account-cache";
import { parseQuotaFailureCode } from "../providers/quota-types";
import { getAccountSet } from "../oauth/store";
import { peekClaudeUsageObservation } from "../adapters/claude-cli/usage-admission";
import {
  QUOTA_POOL_SCHEMA,
  type QuotaPool,
  type QuotaPoolAccount,
  type QuotaPoolAccountState,
  type QuotaPoolProvider,
  type QuotaPoolRole,
  type QuotaPoolSource,
  type QuotaPoolWindow,
} from "./contract";
import { quotaPoolAccountRef, readQuotaPoolIdentity, type QuotaPoolIdentity } from "./identity";
import { pooledWindows, type PooledAccountInput } from "./pooled";
import { codexCapacityWeight } from "../providers/codex-capacity";

const VERSION = packageVersion("0.0.0");
const SHORT_BURST_MAX_SECONDS = 6 * 3600;
const SHORT_DAILY_MAX_SECONDS = 36 * 3600;

export interface QuotaPoolDeps {
  now?: () => number;
  /** Test seam for the Claude CLI admission file. */
  claudeUsageStatePath?: string;
}

export type QuotaPoolResult = { ok: true; pool: QuotaPool } | { ok: false; error: "quota_pool_identity_unavailable" };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function iso(ms: number): string | undefined {
  if (!finite(ms) || ms <= 0) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** A used percent inside the contract's 0..100, or undefined when there is no reading. */
function percent(value: unknown): number | undefined {
  if (!finite(value) || value < 0) return undefined;
  return Math.min(100, value);
}

type WindowDraft = Omit<QuotaPoolWindow, "observedAt" | "source"> & { resetMs?: number };

/**
 * Finish a window, or drop it when it carries nothing (no percent, no counters) or its reset has
 * already passed: an elapsed window is unknown now, not empty.
 */
function finish(draft: WindowDraft, source: QuotaPoolSource, observedMs: number, now: number): QuotaPoolWindow | null {
  const observedAt = iso(observedMs);
  if (!observedAt) return null;
  const { resetMs, ...rest } = draft;
  if (resetMs !== undefined && resetMs <= now) return null;
  if (rest.usedPercent === undefined && rest.used === undefined && rest.limit === undefined && rest.exhausted === undefined) return null;
  const resetsAt = resetMs !== undefined ? iso(resetMs) : undefined;
  const exhausted = rest.exhausted ?? (rest.usedPercent !== undefined ? rest.usedPercent >= 100 : undefined);
  const window: QuotaPoolWindow = { ...rest, source, observedAt };
  if (resetsAt) window.resetsAt = resetsAt;
  if (exhausted !== undefined) window.exhausted = exhausted;
  return window;
}

function resetMs(value: unknown): number | undefined {
  return finite(value) && value > 0 ? resetAtToMs(value) : undefined;
}

function shortKind(seconds: number | undefined): Pick<QuotaPoolWindow, "id" | "kind" | "label"> {
  if (seconds === undefined || seconds <= SHORT_BURST_MAX_SECONDS) return { id: "5h", kind: "burst_5h", label: "5-hour" };
  if (seconds <= SHORT_DAILY_MAX_SECONDS) return { id: "daily", kind: "daily", label: "Daily" };
  return { id: "short", kind: "custom", label: "Short window" };
}

/** Codex `StoredAccountQuota`, mapped as the header and WHAM parsers stored it. */
export function codexQuotaWindows(quota: StoredAccountQuota, source: QuotaPoolSource, now: number): QuotaPoolWindow[] {
  const out: QuotaPoolWindow[] = [];
  const push = (window: QuotaPoolWindow | null) => { if (window) out.push(window); };
  const shortPercent = percent(quota.shortPercent);
  const shortSeconds = finite(quota.shortWindowSeconds) && quota.shortWindowSeconds > 0 ? quota.shortWindowSeconds : undefined;
  if (shortPercent !== undefined) {
    push(finish({
      ...shortKind(shortSeconds),
      usedPercent: shortPercent,
      ...(shortSeconds !== undefined ? { windowSeconds: shortSeconds } : {}),
      resetMs: resetMs(quota.shortResetAt),
      exhausted: isTerminalShortWindow(quota, now),
    }, source, quota.shortObservedAt ?? quota.updatedAt, now));
  }
  const weekly = percent(quota.weeklyPercent);
  if (weekly !== undefined) {
    push(finish({ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: weekly, resetMs: resetMs(quota.weeklyResetAt) }, source, quota.updatedAt, now));
  }
  const monthly = percent(quota.monthlyPercent);
  if (monthly !== undefined) {
    push(finish({ id: "monthly", kind: "monthly", label: "Monthly", usedPercent: monthly, resetMs: resetMs(quota.monthlyResetAt) }, source, quota.updatedAt, now));
  }
  for (const custom of quota.customWindows ?? []) {
    const used = percent(custom?.percent);
    if (typeof custom?.label !== "string" || !custom.label.trim() || used === undefined) continue;
    push(finish({ id: `custom:${custom.label}`, kind: "custom", label: custom.label, usedPercent: used, resetMs: resetMs(custom.resetAt) }, source, quota.updatedAt, now));
  }
  return out;
}

function customWindow(window: ProviderQuotaWindow, source: QuotaPoolSource, updatedAt: number, now: number): QuotaPoolWindow | null {
  if (typeof window?.label !== "string" || !window.label.trim()) return null;
  // An exact-model row (Antigravity diagnostics, CCA fallback) restates the pool its family
  // window already reports and carries no proven scope; reporting it unscoped would let it gate
  // every model.
  if (window.modelId !== undefined && window.scope !== "model") return null;
  const scoped = window.scope === "model";
  const passive = finite(window.passiveObservedAt);
  return finish({
    id: scoped ? `family:${window.label.toLowerCase()}` : `custom:${window.label}`,
    kind: "custom",
    label: window.label,
    ...(percent(window.percent) !== undefined ? { usedPercent: percent(window.percent) } : {}),
    // GOAT's placement reads `family:<name>` as every versioned model in that Claude family.
    ...(scoped ? { scopeModel: `family:${window.label.toLowerCase()}` } : {}),
    ...(window.rejected === true ? { exhausted: true } : {}),
    resetMs: resetMs(window.resetAt),
  }, passive ? "header" : source, passive ? window.passiveObservedAt! : updatedAt, now);
}

/** A `ProviderQuota` (provider report or per-account cache row). */
export function providerQuotaWindows(quota: ProviderQuota, source: QuotaPoolSource, now: number): QuotaPoolWindow[] {
  const out: QuotaPoolWindow[] = [];
  const push = (window: QuotaPoolWindow | null) => { if (window) out.push(window); };
  const at = quota.updatedAt;
  const fixed = [
    ["5h", "burst_5h", "5-hour", quota.fiveHourPercent, quota.fiveHourResetAt],
    ["weekly", "weekly", "Weekly", quota.weeklyPercent, quota.weeklyResetAt],
    ["monthly", "monthly", "Monthly", quota.monthlyPercent, quota.monthlyResetAt],
  ] as const;
  for (const [id, kind, label, value, reset] of fixed) {
    const used = percent(value);
    if (used === undefined) continue;
    push(finish({ id, kind, label, usedPercent: used, resetMs: resetMs(reset) }, source, at, now));
  }
  const kiroUsed = finite(quota.kiroCreditsUsed) && quota.kiroCreditsUsed >= 0 ? quota.kiroCreditsUsed : undefined;
  const kiroLimit = finite(quota.kiroCreditsLimit) && quota.kiroCreditsLimit > 0 ? quota.kiroCreditsLimit : undefined;
  if (kiroUsed !== undefined || kiroLimit !== undefined) {
    push(finish({
      id: "credits:kiro", kind: "credits", label: "Kiro credits", unit: "credits",
      ...(kiroUsed !== undefined ? { used: kiroUsed } : {}),
      ...(kiroLimit !== undefined ? { limit: kiroLimit } : {}),
      ...(kiroUsed !== undefined && kiroLimit !== undefined ? { usedPercent: percent((kiroUsed / kiroLimit) * 100) } : {}),
    }, source, at, now));
  }
  const usd = quota.creditsUsd;
  if (usd && finite(usd.used) && usd.used >= 0) {
    const unlimited = usd.unlimited === true;
    push(finish({
      id: "credits:usd", kind: "credits", label: "USD credits", unit: "usd", used: usd.used,
      ...(!unlimited && finite(usd.limit) && usd.limit > 0 ? { limit: usd.limit } : {}),
      ...(!unlimited && percent(usd.percent) !== undefined ? { usedPercent: percent(usd.percent) } : {}),
      ...(unlimited ? { exhausted: false } : finite(usd.remaining) ? { exhausted: usd.remaining <= 0 } : {}),
    }, source, at, now));
  }
  for (const custom of quota.customWindows ?? []) push(customWindow(custom, source, at, now));
  return out;
}

function accountState(input: { reauth: boolean; paused: boolean; windows: readonly QuotaPoolWindow[] }): QuotaPoolAccountState {
  if (input.reauth) return "reauth";
  if (input.paused) return "paused";
  // A model-scoped window never gates the account as a whole.
  if (input.windows.some(window => window.exhausted === true && window.scopeModel === undefined)) return "exhausted";
  return input.windows.length === 0 ? "unknown" : "available";
}

function nextResetAt(windows: readonly QuotaPoolWindow[]): string | undefined {
  const resets = windows.filter(window => window.scopeModel === undefined && window.resetsAt).map(window => window.resetsAt!).sort();
  return resets[0];
}

function reportSource(report: ProviderQuotaReport): QuotaPoolSource {
  if (report.aggregation) return "estimated";
  return report.observed === true ? "header" : "measured";
}

/** An account row with its input to the provider's pooled windows. */
interface TrackedAccount {
  account: QuotaPoolAccount;
  pool: PooledAccountInput;
}

function codexAccounts(identity: QuotaPoolIdentity, accounts: Awaited<ReturnType<typeof listCodexAuthAccountsSnapshot>>["accounts"], now: number): TrackedAccount[] {
  const provider = OPENAI_CODEX_PROVIDER_ID;
  return accounts.map(dto => {
    const source: QuotaPoolSource = latestCodexQuotaObservationSource(dto.id) === "response-header" ? "header" : "measured";
    const windows = dto.quota ? codexQuotaWindows(dto.quota as StoredAccountQuota, source, now) : [];
    const account: QuotaPoolAccount = {
      provider,
      accountRef: quotaPoolAccountRef(identity, provider, dto.id),
      // needsReauth only: a passive read leaves hasCredential false when it did not check, and an
      // account without a credential already carries needsReauth.
      state: accountState({ reauth: dto.needsReauth === true, paused: dto.paused, windows }),
      windows,
    };
    if (typeof dto.logLabel === "string" && ACCOUNT_LOG_LABEL_RE.test(dto.logLabel)) account.label = dto.logLabel;
    if (typeof dto.plan === "string" && dto.plan.trim()) account.plan = dto.plan.trim();
    // A plan-excluded account and a duplicate of the main login are outside automatic routing.
    const eligible = !dto.paused && dto.needsReauth !== true && dto.selectionExcludedReason === undefined;
    return { account, pool: { eligible, weight: codexCapacityWeight(dto.plan), windows } };
  });
}

/**
 * Per-account OAuth providers have no calibrated plan-to-capacity table (the Codex weights describe
 * Codex plans only), so each routable account counts once.
 */
function oauthAccounts(identity: QuotaPoolIdentity, provider: string, now: number): TrackedAccount[] {
  const set = getAccountSet(provider);
  if (!set) return [];
  return set.accounts.map(row => {
    const quota = getCachedProviderAccountQuota(provider, row.id);
    const entry = accountQuotaCache.get(accountCacheKey(provider, row.id));
    const windows = quota ? providerQuotaWindows(quota, "measured", now) : [];
    const account: QuotaPoolAccount = {
      provider,
      accountRef: quotaPoolAccountRef(identity, provider, row.id),
      label: oauthAccountLogLabel(row.id, provider),
      state: accountState({ reauth: row.needsReauth === true, paused: row.paused === true, windows }),
      windows,
    };
    const failure = entry?.quotaFailure && entry.quotaFailureIsCurrent?.() === true ? parseQuotaFailureCode(entry.quotaFailure) : undefined;
    if (failure) account.failure = failure;
    return { account, pool: { eligible: row.paused !== true && row.needsReauth !== true, weight: 1, windows } };
  });
}

function claudeCliAccounts(identity: QuotaPoolIdentity, provider: string, deps: QuotaPoolDeps, now: number): TrackedAccount[] {
  const observation = peekClaudeUsageObservation(deps.claudeUsageStatePath ? { statePath: deps.claudeUsageStatePath } : {});
  if (!observation) return [];
  const windows = observation.quota ? providerQuotaWindows(observation.quota, "measured", now) : [];
  if (finite(observation.refusalUntil) && observation.refusalUntil > now) {
    const refusal = finish({ id: "refusal", kind: "custom", label: "Claude CLI limit", exhausted: true, resetMs: observation.refusalUntil },
      "estimated", observation.checkedAt, now);
    if (refusal) windows.push(refusal);
  }
  return [{
    account: {
      provider,
      accountRef: quotaPoolAccountRef(identity, provider, `claude-cli:${observation.identity}`),
      state: accountState({ reauth: false, paused: false, windows }),
      windows,
    },
    pool: { eligible: true, weight: 1, windows },
  }];
}

function role(config: OcxConfig): QuotaPoolRole {
  return config.runtimeRole === "hub" || config.runtimeRole === "client" ? config.runtimeRole : "standalone";
}

function enabled(provider: OcxProviderConfig | undefined): provider is OcxProviderConfig {
  return !!provider && provider.disabled !== true;
}

async function assemble(config: OcxConfig, identity: QuotaPoolIdentity, deps: QuotaPoolDeps): Promise<QuotaPool> {
  const now = (deps.now ?? Date.now)();
  const names = Object.keys(config.providers).filter(name => enabled(config.providers[name])).sort();
  const reports = new Map(heldProviderQuotaReports(names).reports.map(report => [report.provider, report]));
  const codexPool = hasCodexPoolProvider(config);
  const codex = codexPool ? (await listCodexAuthAccountsSnapshot(config)).accounts : [];
  const providers: QuotaPoolProvider[] = [];
  for (const name of names) {
    const provider = config.providers[name]!;
    let rows: TrackedAccount[] = [];
    let tracked = false;
    // Whether requests to this provider are served by those account rows. A per-account provider
    // configured with an API key keeps any stored OAuth rows on display, but its quota is the
    // key's report, as the quota dispatcher reads it.
    let poolFromRows = true;
    if (codexPool && name === OPENAI_CODEX_PROVIDER_ID) {
      tracked = true;
      rows = codexAccounts(identity, codex, now);
    } else if (provider.adapter === "claude-cli") {
      tracked = true;
      rows = claudeCliAccounts(identity, name, deps, now);
    } else if (supportsPerAccountQuota(name) || hasPassiveAccountQuota(name)) {
      tracked = true;
      rows = oauthAccounts(identity, name, now);
      poolFromRows = provider.authMode === "oauth";
    }
    const report = reports.get(name);
    if (!tracked && !report) continue;
    // Account rows are the evidence a held report was computed from, at least as new and with
    // their own observation times; the report stands in only where there are no rows.
    const windows = poolFromRows && rows.length > 0
      ? pooledWindows(rows.map(row => row.pool), now)
      : report ? providerQuotaWindows(report.quota, reportSource(report), now) : [];
    const pooled: QuotaPoolProvider["pooled"] = { windows };
    const next = nextResetAt(windows);
    if (next) pooled.nextResetAt = next;
    providers.push({ provider: name, accounts: rows.map(row => row.account), pooled });
  }
  return {
    schema: QUOTA_POOL_SCHEMA,
    producer: { version: VERSION, role: role(config), homeId: identity.homeId },
    generatedAt: iso(now) ?? new Date().toISOString(),
    providers,
  };
}

/** The quota pool, or an identity error. Always a passive read, whoever asks. */
export function readQuotaPool(config: OcxConfig, deps: QuotaPoolDeps = {}): Promise<QuotaPoolResult> {
  return runPassiveRead(async () => {
    const identity = readQuotaPoolIdentity();
    if (!identity) return { ok: false, error: "quota_pool_identity_unavailable" } as const;
    return { ok: true, pool: await assemble(config, identity, deps) } as const;
  });
}
