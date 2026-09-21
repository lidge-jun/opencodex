import { createBoundedFetch } from '../bounded-fetch';
import type { CompanionSettings } from './usage-companion-utils';
import type { AccountQuota } from '../codex-quota-utils';
import { normalizeQuotaForPlan } from '../codex-quota-utils';

export type TrayTotals = Partial<Record<'requests' | 'totalTokens' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheReadInputTokens' | 'estimatedCostUsd' | 'measuredRequests' | 'pricedRequests' | 'coverageRatio', number>>;
export type TrayModel = TrayTotals & { model: string; provider: string };
export interface TrayUsage { summary: TrayTotals; models: TrayModel[]; customWindow?: boolean; since?: number; until?: number; usageIncomplete?: boolean; historyTruncated?: boolean; entriesTruncated?: boolean }
export interface TrayAccount { unavailable?: boolean; id: string; label: string; quota: AccountQuota | null; plan?: string; active?: boolean; email?: string; status?: string; quotaFailure?: string }
export interface TrayProvider { name: string; accounts: TrayAccount[]; unavailable?: boolean }
export interface TrayProviderSource { name: string; path: string | null }
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Read only the safe management projection; never retain configuration credentials.
export function providerSources(value: unknown): TrayProviderSource[] {
  return Object.entries(object(object(value).providers)).flatMap(([name, raw]) => {
    const config = object(raw);
    if (config.disabled === true) return [];
    const path = name === 'openai' ? '/api/codex-auth/accounts'
      : config.authMode === 'oauth' ? `/api/oauth/accounts?${new URLSearchParams({ provider: name, quota: '1' })}`
      : config.hasApiKey === true && config.authMode !== 'forward' ? `/api/providers/keys?${new URLSearchParams({ name, quota: '1' })}` : null;
    return [{ name, path }];
  });
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
    return { id: row.id, label, email, plan, unavailable: row.quotaUnavailable === true, active: typeof activeId === 'string' ? activeId === row.id : row.active === true, status: typeof object(row.health).status === 'string' ? object(row.health).status as string : undefined, quotaFailure: typeof row.quotaFailure === 'string' ? row.quotaFailure : undefined, quota: normalizeQuotaForPlan(quota, plan) };
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
    { key: 'quota.fiveHourLimit' as const, percent: quota.fiveHourPercent ?? quota.shortPercent, reset: quota.fiveHourResetAt ?? quota.shortResetAt },
    { key: 'quota.weeklyLimit' as const, percent: quota.weeklyPercent, reset: quota.weeklyResetAt },
    { key: 'quota.monthlyLimit' as const, percent: quota.monthlyPercent, reset: quota.monthlyResetAt },
    ...(Array.isArray(quota.customWindows) ? quota.customWindows.filter(w => w && typeof w.label === 'string').map(w => ({ label: w.label, percent: w.percent, reset: w.resetAt })) : []),
  ];
  return windows.filter((w, index) => index === 0 && quota.monthlyPercent === undefined || finite(w.percent) || resetTimestamp(w.reset) !== null);
}

export function filterUsage(usage: TrayUsage, settings: CompanionSettings): TrayUsage {
  const models = usage.models.filter(row => !settings.hiddenProviders.includes(row.provider)
    && (settings.models === null || settings.models.includes(`${row.provider}/${row.model}`) || settings.models.includes(row.model)));
  if (settings.models === null && settings.hiddenProviders.length === 0) return { ...usage, models };
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
