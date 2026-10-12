import { createBoundedFetch } from '../bounded-fetch';
import type { CompanionSettings } from './usage-companion-utils';
import type { AccountQuota } from '../codex-quota-utils';
import { normalizeQuotaForPlan } from '../codex-quota-utils';

export type TrayTotals = Partial<Record<'requests' | 'totalTokens' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheReadInputTokens' | 'estimatedCostUsd' | 'measuredRequests' | 'pricedRequests' | 'coverageRatio', number>>;
export type TrayModel = TrayTotals & { model: string; provider: string };
export interface TrayUsage { summary: TrayTotals; models: TrayModel[]; customWindow?: boolean; since?: number; until?: number; usageIncomplete?: boolean; historyTruncated?: boolean; entriesTruncated?: boolean }
/**
 * Whether this account can be made active from the tray. Mirrors the native panel
 * (`desktop/src-tauri/src/native_tray_accounts.rs` `switch_state`): only what the switch route
 * itself refuses is blocked, and an exhausted account stays switchable.
 */
export type TraySwitchState = 'active' | 'available' | 'blocked';
export type TraySwitchKind = 'codex' | 'oauth' | 'apiKey';
export interface TrayAccount { unavailable?: boolean; id: string; label: string; quota: AccountQuota | null; plan?: string; active?: boolean; email?: string; status?: string; quotaFailure?: string; switchState?: TraySwitchState; blockedReason?: 'mainHardLock' | 'paused' | 'validationPending'; exhausted?: boolean }
export interface TrayProvider { name: string; accounts: TrayAccount[]; unavailable?: boolean; switchKind?: TraySwitchKind | null }
export interface TrayProviderSource { name: string; path: string | null; switchKind: TraySwitchKind | null }
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Read only the safe management projection; never retain configuration credentials.
export function providerSources(value: unknown): TrayProviderSource[] {
  return Object.entries(object(object(value).providers)).flatMap<TrayProviderSource>(([name, raw]) => {
    const config = object(raw);
    if (config.disabled === true) return [];
    if (name === 'openai') return [{ name, path: '/api/codex-auth/accounts', switchKind: 'codex' as const }];
    if (config.authMode === 'oauth') return [{ name, path: `/api/oauth/accounts?${new URLSearchParams({ provider: name, quota: '1' })}`, switchKind: 'oauth' as const }];
    if (config.hasApiKey === true && config.authMode !== 'forward') return [{ name, path: `/api/providers/keys?${new URLSearchParams({ name, quota: '1' })}`, switchKind: 'apiKey' as const }];
    return [{ name, path: null, switchKind: null }];
  });
}

/** The management request that makes `accountId` active; the same routes and bodies the native panel and dashboard use. */
export function accountSwitchRequest(provider: string, kind: TraySwitchKind, accountId: string): { path: string; body: Record<string, string> } {
  if (kind === 'codex') return { path: '/api/codex-auth/active', body: { accountId } };
  if (kind === 'oauth') return { path: '/api/oauth/accounts/active', body: { provider, accountId } };
  return { path: '/api/providers/keys/active', body: { name: provider, id: accountId } };
}

function switchState(row: Record<string, unknown>, active: boolean): Pick<TrayAccount, 'switchState' | 'blockedReason'> {
  if (active) return { switchState: 'active' };
  if (object(row.mainAccountHardLock).state === 'blocked') return { switchState: 'blocked', blockedReason: 'mainHardLock' };
  if (row.paused === true) return { switchState: 'blocked', blockedReason: 'paused' };
  if (object(row.health).reason === 'validation_pending') return { switchState: 'blocked', blockedReason: 'validationPending' };
  return { switchState: 'available' };
}

/** Same windows as `isCodexQuotaExhausted`: 100% in a window the plan is governed by, or in the burst window. */
function exhausted(quota: Record<string, unknown>, plan: string | undefined): boolean {
  const monthlyOnly = ['go', 'free'].includes((plan ?? '').trim().toLowerCase());
  const short = quota.fiveHourPercent ?? quota.shortPercent;
  const windows = monthlyOnly ? [quota.monthlyPercent, short] : [quota.weeklyPercent, quota.monthlyPercent, short];
  return windows.some(value => typeof value === 'number' && Number.isFinite(value) && value >= 100);
}

export function parseAccounts(value: unknown): TrayAccount[] {
  const body = object(value);
  const rows = body.accounts ?? body.keys;
  if (!Array.isArray(rows)) throw new Error('Invalid account roster');
  return rows.map(raw => {
    const row = object(raw);
    if (typeof row.id !== 'string') throw new Error('Invalid account identifier');
    const email = typeof row.email === 'string' ? maskEmail(row.email) : undefined;
    const label = [row.alias, row.label, email, row.logLabel, row.id].find(item => typeof item === 'string' && item.length) as string;
    const quota = row.quotaUnavailable === true || row.quotaMode === 'unsupported' || !row.quota ? null : object(row.quota) as unknown as AccountQuota;
    const plan = typeof row.plan === 'string' ? row.plan : undefined;
    const activeId = body.activeAccountId ?? body.activeId ?? body.activeCodexAccountId;
    const active = typeof activeId === 'string' ? activeId === row.id : row.active === true;
    return { id: row.id, label, email, plan, unavailable: row.quotaUnavailable === true, active, ...switchState(row, active), exhausted: quota !== null && exhausted(object(row.quota), plan), status: typeof object(row.health).status === 'string' ? object(row.health).status as string : undefined, quotaFailure: typeof row.quotaFailure === 'string' ? row.quotaFailure : undefined, quota: normalizeQuotaForPlan(quota, plan) };
  });
}

export function resetTimestamp(value: unknown): number | null {
  if (!finite(value) || value === 0) return null;
  const ms = value < 1e12 ? value * 1000 : value;
  return Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '•••';
  const suffix = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${local?.slice(0, 1) || '•'}•••@${domain.slice(0, 1)}•••${suffix}`;
}

export function relativeReset(value: unknown, locale: string, now = Date.now()): { text: string; exact?: string } {
  const ms = resetTimestamp(value);
  if (ms === null || ms <= now) return { text: '—' };
  const minutes = Math.ceil((ms - now) / 60_000);
  const unit = (n: number, name: 'day' | 'hour' | 'minute') => new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(n);
  const text = minutes < 60 ? unit(minutes, 'minute')
    : minutes < 1440 ? `${unit(Math.floor(minutes / 60), 'hour')} ${unit(minutes % 60, 'minute')}`
    : minutes < 10080 ? `${unit(Math.floor(minutes / 1440), 'day')} ${unit(Math.floor(minutes % 1440 / 60), 'hour')}`
    : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(ms);
  return { text, exact: new Date(ms).toLocaleString(locale) };
}

export function quotaWindows(quota: AccountQuota | null) {
  if (!quota) return [];
  const windows = [
    { id: 'quota.fiveHourLimit', key: 'quota.fiveHourLimit' as const, percent: quota.fiveHourPercent ?? quota.shortPercent, reset: quota.fiveHourResetAt ?? quota.shortResetAt },
    { id: 'quota.weeklyLimit', key: 'quota.weeklyLimit' as const, percent: quota.weeklyPercent, reset: quota.weeklyResetAt },
    { id: 'quota.monthlyLimit', key: 'quota.monthlyLimit' as const, percent: quota.monthlyPercent, reset: quota.monthlyResetAt },
    // A provider-named window is identified by its own label; the de-duplication below is what
    // keeps that unique, including against the fixed keys above.
    ...(Array.isArray(quota.customWindows) ? quota.customWindows.filter(w => w && typeof w.label === 'string').map(w => ({ id: w.label, label: w.label, percent: w.percent, reset: w.resetAt })) : []),
  ];
  // A window is listed only when it reports a percentage (zero included) or a reset time. Plans
  // differ in which windows they have: a weekly-only account has no 5-hour window, and showing a
  // dash row for it reads as "unknown usage" rather than "not part of this plan".
  const kept = windows.filter(w => finite(w.percent) || resetTimestamp(w.reset) !== null);
  // A provider is free to report two custom windows under one label. The row identity has to
  // stay unique anyway, or React reconciles two different windows onto the same row.
  const seen = new Map<string, number>();
  return kept.map(w => {
    const taken = seen.get(w.id) ?? 0;
    seen.set(w.id, taken + 1);
    return taken === 0 ? w : { ...w, id: `${w.id}#${taken}` };
  });
}

export function filterUsage(usage: TrayUsage, settings: CompanionSettings): TrayUsage {
  const hiddenProviders = new Set(settings.hiddenProviders);
  const configuredModels = settings.models === null ? null : new Set(settings.models);
  const models = usage.models.filter(row => !hiddenProviders.has(row.provider)
    && (configuredModels === null || configuredModels.has(`${row.provider}/${row.model}`) || configuredModels.has(row.model)));
  if (settings.models === null && settings.hiddenProviders.length === 0) return { ...usage, models };
  if (settings.models?.length !== 0 && usage.models.some(row => !row.provider || !row.model || (row.provider === 'other' && row.model === 'other'))) {
    return { ...usage, models: models.filter(row => row.provider !== 'other' || row.model !== 'other'), summary: {}, usageIncomplete: true };
  }
  const summary: TrayTotals = {};
  for (const key of ['requests', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheReadInputTokens', 'estimatedCostUsd', 'measuredRequests', 'pricedRequests'] as const) {
    if (models.length && models.every(row => finite(row[key]))) summary[key] = models.reduce((sum, row) => sum + row[key]!, 0);
  }
  return { ...usage, models, summary };
}

export function measuredTotals(data: TrayTotals): TrayTotals {
  const next = { ...data };
  if ((data.requests ?? 0) > 0 && (data.measuredRequests === 0 || data.coverageRatio === 0)) {
    for (const key of ['totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheReadInputTokens'] as const) delete next[key];
  }
  if ((data.requests ?? 0) > 0 && data.pricedRequests === 0) delete next.estimatedCostUsd;
  return next;
}

export async function fetchTrayJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const bounded = createBoundedFetch(20_000);
  const abort = () => bounded.controller.abort();
  if (signal.aborted) abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(path, { signal: bounded.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json() as T;
    if (bounded.signal.aborted) throw new Error('Tray request cancelled');
    return data;
  } finally {
    bounded.clear();
    signal.removeEventListener('abort', abort);
  }
}

export function parseTrayUsage(value: unknown): TrayUsage {
  const data = object(value);
  if (data.error || !data.summary || typeof data.summary !== 'object' || Array.isArray(data.summary) || !Array.isArray(data.models)) {
    throw new Error('Invalid usage');
  }
  return data as unknown as TrayUsage;
}
