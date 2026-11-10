import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAnthropicAccountPoolState } from "../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { clearAccountQuotaCache, clearProviderQuotaCache, fetchProviderQuotaReports, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { fetchAnthropicQuota } from "../../src/providers/quota/vendor-probes-oauth";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let ids: string[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pool-capacity-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache();
  for (let i = 0; i < 3; i++) await saveCredential("anthropic", {
    access: `synthetic-access-${i}`, refresh: `synthetic-refresh-${i}`,
    expires: Date.now() + 3_600_000, accountId: `pool-capacity-${i}`, source: "oauth",
  });
  ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  // The active account's live usage probe: 40% of 5h, 20% of the week.
  globalThis.fetch = (async input => {
    expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage");
    return Response.json({
      five_hour: { utilization: 40, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache(); clearProviderQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function config(poolEnabled: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
    anthropicAccountPool: { enabled: poolEnabled },
  };
}

test("an enabled Anthropic account pool reports the pool-wide capacity estimate like the Codex pool", async () => {
  const [, b, c] = ids as [string, string, string];
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("anthropic", b, {
    fiveHourPercent: 100, fiveHourResetAt: now + 1_800_000, weeklyPercent: 60, weeklyResetAt: now + 172_800_000, updatedAt: now,
  });
  setCachedProviderAccountQuotaForTests("anthropic", c, {
    fiveHourPercent: 10, weeklyPercent: 0, updatedAt: now,
  });

  const result = await fetchAnthropicQuota("anthropic", config(true));

  expect(result?.source).toBe("anthropic:oauth-usage");
  // Equal weights: (40 + 100 + 10) / 3 and (20 + 60 + 0) / 3.
  expect(result?.quota.fiveHourPercent).toBeCloseTo(50, 5);
  expect(result?.quota.weeklyPercent).toBeCloseTo(80 / 3, 5);
  expect(result?.aggregation).toMatchObject({
    kind: "capacity-weighted-v1",
    presentation: "aggregate",
    includedAccounts: 3,
    excludedAccounts: 0,
    unknownPlanAccounts: 0,
    incomplete: false,
    currentAccount: { quota: { fiveHourPercent: 40, weeklyPercent: 20 } },
  });
  // The next 5-hour recovery is account b's reset, returning its full share of the pool.
  expect(result?.aggregation?.fiveHour?.nextRecoveryAt).toBe(now + 1_800_000);
  expect(result?.aggregation?.fiveHour?.nextRecoveryPercent).toBeCloseTo(100 / 3, 5);
});

test("a paused pool account is excluded from the estimate and reported as incomplete coverage", async () => {
  const [, b, c] = ids as [string, string, string];
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("anthropic", b, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt: now });
  setCachedProviderAccountQuotaForTests("anthropic", c, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: now });
  await setAccountPaused("anthropic", b, true);

  const result = await fetchAnthropicQuota("anthropic", config(true));

  expect(result?.quota.fiveHourPercent).toBeCloseTo(20, 5);
  expect(result?.aggregation).toMatchObject({ includedAccounts: 2, excludedAccounts: 1, pausedAccounts: 1, incomplete: true });
});

test("with the account pool off the report stays the active account's own reading", async () => {
  const [, b] = ids as [string, string, string];
  setCachedProviderAccountQuotaForTests("anthropic", b, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt: Date.now() });

  const result = await fetchAnthropicQuota("anthropic", config(false));

  expect(result?.quota.fiveHourPercent).toBe(40);
  expect(result?.quota.weeklyPercent).toBe(20);
  expect(result?.aggregation).toBeUndefined();
});

test("pausing an inactive pool account retires the cached pooled report", async () => {
  const [, b, c] = ids as [string, string, string];
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("anthropic", b, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt: now });
  setCachedProviderAccountQuotaForTests("anthropic", c, { fiveHourPercent: 10, weeklyPercent: 0, updatedAt: now });
  let probes = 0;
  const probe = globalThis.fetch;
  globalThis.fetch = (async (input, init) => { probes++; return probe(input, init); }) as typeof fetch;
  const cfg = config(true);
  clearProviderQuotaCache();

  const first = (await fetchProviderQuotaReports(cfg)).reports.find(item => item.provider === "anthropic");
  expect(first?.aggregation).toMatchObject({ includedAccounts: 3, pausedAccounts: 0 });
  const afterFirst = probes;
  // Pausing a seat that is not active leaves the active account and the cache key unchanged.
  await setAccountPaused("anthropic", b, true);

  const second = (await fetchProviderQuotaReports(cfg)).reports.find(item => item.provider === "anthropic");
  expect(probes).toBeGreaterThan(afterFirst);
  expect(second?.aggregation).toMatchObject({ includedAccounts: 2, pausedAccounts: 1, incomplete: true });
});

test("an enabled pool holding one account reports that account's own reading", async () => {
  const [, b, c] = ids as [string, string, string];
  const { removeAccount } = await import("../../src/oauth/store");
  await removeAccount("anthropic", b);
  await removeAccount("anthropic", c);

  const result = await fetchAnthropicQuota("anthropic", config(true));

  expect(result?.quota.fiveHourPercent).toBe(40);
  expect(result?.aggregation).toBeUndefined();
});
