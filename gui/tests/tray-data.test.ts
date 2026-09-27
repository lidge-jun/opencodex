import { describe, expect, test } from 'bun:test';
import { fetchTrayJson, parseTrayUsage, filterUsage, measuredTotals, parseAccounts, providerSources, quotaWindows, relativeReset, resetTimestamp } from '../src/pages/tray-data';
import type { CompanionSettings } from '../src/pages/usage-companion-utils';

describe('tray data', () => {
  const now = Date.UTC(2026, 8, 21, 0);
  test('reset accepts seconds/milliseconds and rejects missing, invalid and expired observations', () => {
    for (const value of [undefined, null, 0, -1, NaN, Infinity, '2026-10-01', 9e18]) expect(resetTimestamp(value)).toBeNull();
    expect(resetTimestamp(now / 1000)).toBe(now);
    expect(resetTimestamp(now)).toBe(now);
    expect(relativeReset(now, 'en', now)).toEqual({ text: '—' });
    expect(relativeReset(now - 1, 'en', now)).toEqual({ text: '—' });
    expect(relativeReset(now + 42 * 60000, 'en', now).text).toBe('42m');
    expect(relativeReset(now + 297 * 60000, 'en', now).text).toBe('4h 57m');
    expect(relativeReset(now + 35 * 3600000, 'en', now).text).toBe('1d 11h');
    const long = relativeReset(now + 30 * 86400000, 'en', now);
    expect(long.text).toBe(new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(now + 30 * 86400000));
    expect(long.exact).toBeDefined();
  });
  test('projects providers and preserves actual account identity without exposing email', () => {
    expect(providerSources({ providers: { openai: {}, oauth: { authMode: 'oauth' }, key: { hasApiKey: true }, off: { disabled: true } } }).map(p => p.path)).toEqual(['/api/codex-auth/accounts', '/api/oauth/accounts?provider=oauth&quota=1', '/api/providers/keys?name=key&quota=1']);
    const [account] = parseAccounts({ activeAccountId: 'a', accounts: [{ id: 'a', email: 'person@example.com', plan: 'plus', quota: { weeklyPercent: 35, updatedAt: now } }] });
    expect(account.label).toBe('p•••@e•••.com');
    expect(account.active).toBe(true);
    expect(account.plan).toBe('plus');
    // Weekly-only plan: no placeholder 5-hour row.
    expect(quotaWindows(account.quota).map(w => w.id)).toEqual(['quota.weeklyLimit']);
    expect(quotaWindows({ fiveHourPercent: null, weeklyPercent: 0 } as never).map(w => w.id)).toEqual(['quota.weeklyLimit']);
    // Zero and reset-only windows still count as reported.
    expect(quotaWindows({ fiveHourPercent: 0, weeklyPercent: 1 } as never).map(w => w.id)).toEqual(['quota.fiveHourLimit', 'quota.weeklyLimit']);
    expect(quotaWindows({ shortResetAt: now + 60_000 } as never).map(w => w.id)).toEqual(['quota.fiveHourLimit']);
    expect(quotaWindows({} as never)).toEqual([]);
    expect(parseAccounts({ keys: [{ id: 'k', label: 'Work', quotaUnavailable: true, quota: { weeklyPercent: 0 } }] })[0].quota).toBeNull();
    expect(parseAccounts({ keys: [{ id: 'k', quotaUnavailable: true }] })[0].unavailable).toBe(true);
    expect(parseAccounts({ keys: [{ id: 'k', quotaMode: 'unsupported' }] })[0].unavailable).toBe(false);
    expect(() => parseAccounts({ accounts: [{}] })).toThrow();
    const free = parseAccounts({ accounts: [{ id: 'f', plan: 'free', quota: { weeklyPercent: 1, shortPercent: 2, monthlyPercent: 3 } }] })[0];
    expect(quotaWindows(free.quota)).toHaveLength(1);
  });
  test('unmeasured/unpriced nonzero requests are unknown, explicit zero stays zero, filters preserve missing', () => {
    expect(measuredTotals({ requests: 3, measuredRequests: 0, pricedRequests: 0, totalTokens: 0, estimatedCostUsd: 0 })).toEqual({ requests: 3, measuredRequests: 0, pricedRequests: 0 });
    expect(measuredTotals({ requests: 0, measuredRequests: 0, totalTokens: 0 }).totalTokens).toBe(0);
    const settings = { models: ['x/a'], hiddenProviders: [] } as unknown as CompanionSettings;
    const result = filterUsage({ summary: { totalTokens: 40 }, models: [{ provider: 'x', model: 'a', requests: 1 }, { provider: 'y', model: 'a', totalTokens: 40 }] }, settings);
    expect(result.summary.totalTokens).toBeUndefined();
    expect(result.summary.requests).toBe(1);
    expect(result.models).toHaveLength(1);
  });
  test('active filters cannot redistribute an unknown folded model total', () => {
    const usage = { summary: { requests: 99, totalTokens: 999 }, models: [
      { provider: 'visible', model: 'm', requests: 2, totalTokens: 3 },
      { provider: 'other', model: 'other', requests: 97, totalTokens: 996 },
    ] };
    const filtered = filterUsage(usage, { models: null, hiddenProviders: ['hidden'] } as CompanionSettings);
    expect(filtered.summary).toEqual({});
    expect(filtered.usageIncomplete).toBe(true);
    expect(filtered.models).toHaveLength(1);
    expect(filterUsage(usage, { models: null, hiddenProviders: [] } as CompanionSettings).summary).toEqual(usage.summary);
    expect(filterUsage(usage, { models: [], hiddenProviders: [] } as CompanionSettings).usageIncomplete).toBeUndefined();
  });
});

test('tray rejects HTTP-200 read failures before filtering but accepts genuine zero usage', () => {
  const zero = { summary: { requests: 0, totalTokens: 0 }, models: [] };
  expect(() => parseTrayUsage({ ...zero, error: 'read_failed' })).toThrow('Invalid usage');
  expect(parseTrayUsage(zero)).toEqual(zero);
  expect(() => parseTrayUsage(null)).toThrow();
});

test('tray fetch works without AbortSignal static helpers and forwards cancellation', async () => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
  try {
    globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
    expect(await fetchTrayJson('/api/config', new AbortController().signal)).toEqual({ ok: true });
    globalThis.fetch = ((_path, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      const fail = () => reject(new Error('cancelled'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    })) as typeof fetch;
    const controller = new AbortController();
    const pending = fetchTrayJson('/api/config', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    await expect(fetchTrayJson('/api/config', controller.signal)).rejects.toThrow('cancelled');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, 'any', any);
    Object.defineProperty(AbortSignal, 'timeout', timeout);
  }
});
