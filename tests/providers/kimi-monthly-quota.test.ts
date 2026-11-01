import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../../src/oauth/store";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../src/providers/quota";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
let home: string;

beforeEach(() => {
  for (const key of proxyKeys) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "ocx-kimi-monthly-"));
  process.env.OPENCODEX_HOME = home;
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  for (const key of proxyKeys) {
    if (originalProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProxyEnv[key];
  }
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function config(authMode: "key" | "oauth" = "key"): OcxConfig {
  const name = authMode === "oauth" ? "kimi" : "kimi-code";
  return {
    defaultProvider: name,
    providers: {
      [name]: {
        adapter: "openai-chat",
        authMode,
        baseUrl: "https://api.kimi.com/coding/v1",
        ...(authMode === "key" ? { apiKey: "kimi-monthly-fixture-key" } : {}),
      },
    },
  } as OcxConfig;
}

function mockUsage(payload: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.kimi.com/coding/v1/usages");
    expect(init?.redirect).toBe("error");
    return Response.json(payload);
  }) as typeof fetch;
}

const resetAt = "2026-12-01T00:00:00Z";
const monthlyRow = { used_ratio: 0.375, reset_at: resetAt };

describe("Kimi monthly quota", () => {
  test.each(["key", "oauth"] as const)("publishes a monthly-only %s report", async authMode => {
    if (authMode === "oauth") {
      await saveCredential("kimi", {
        access: "kimi-monthly-fixture-access",
        refresh: "kimi-monthly-fixture-refresh",
        expires: Date.now() + 3600_000,
      });
    }
    mockUsage({ usages: { limit_month_total: monthlyRow } });

    const { reports } = await fetchProviderQuotaReports(config(authMode), true);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe("kimi:usages");
    expect(reports[0]?.quota).toEqual({
      monthlyPercent: 37.5,
      monthlyResetAt: Date.parse(resetAt),
      updatedAt: expect.any(Number),
    });
  });

  test.each([
    { name: "data", payload: { data: { usages: { limit_month_total: monthlyRow } } } },
    { name: "quota", payload: { quota: { usages: { limit_month_total: monthlyRow } } } },
    { name: "data.quota", payload: { data: { quota: { usages: { limit_month_total: monthlyRow } } } } },
    { name: "null outer usage", payload: { usage: null, data: { usages: { limit_month_total: monthlyRow } } } },
  ])("reads monthly usage from $name", async ({ payload }) => {
    mockUsage(payload);
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(37.5);
    expect(reports[0]?.quota.monthlyResetAt).toBe(Date.parse(resetAt));
  });

  test.each(["limit_month_total", "monthTotal", "limit_month_code", "monthCode"])(
    "recognizes %s and camel-case ratio/reset fields", async field => {
      mockUsage({ usages: { [field]: { usedRatio: "0.625", resetAt } } });
      const { reports } = await fetchProviderQuotaReports(config(), true);
      expect(reports[0]?.quota.monthlyPercent).toBe(62.5);
      expect(reports[0]?.quota.monthlyResetAt).toBe(Date.parse(resetAt));
    },
  );

  test("prefers the total monthly allowance over the coding-only fallback", async () => {
    mockUsage({ usages: {
      limit_month_total: { used_ratio: 0.25 },
      limit_month_code: { used_ratio: 0.75 },
    } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(25);
  });

  test("falls back to coding usage when total monthly usage is unusable", async () => {
    mockUsage({ usages: {
      limit_month_total: { used_ratio: "invalid" },
      limit_month_code: monthlyRow,
    } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(37.5);
  });

  test("keeps legacy windows and subscription credits alongside monthly usage", async () => {
    mockUsage({
      usage: { limit: "200", used: "50" },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", remaining: "80" },
      }],
      totalQuota: { limit: "100", used: "10" },
      data: { usages: { limit_month_total: monthlyRow } },
    });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota).toMatchObject({
      fiveHourPercent: 20,
      weeklyPercent: 25,
      monthlyPercent: 37.5,
      customWindows: [{ label: "Total subscription credits", percent: 10 }],
    });
  });

  test("does not unwrap nested legacy windows over usable outer usages", async () => {
    mockUsage({ usages: { limit_month_total: monthlyRow }, data: { usage: { percent: 90 } } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(37.5);
    expect(reports[0]?.quota.weeklyPercent).toBeUndefined();
  });

  test.each([
    { row: { limit: 100, used: 40, used_ratio: 0.8 }, expected: 40 },
    { row: { limit: 100, remaining: 70, used_ratio: 0.8 }, expected: 30 },
    { row: { percent: 55 }, expected: 55 },
    { row: { used_ratio: 0 }, expected: 0 },
    { row: { used_ratio: 1 }, expected: 100 },
  ])("preserves arithmetic, percentage and boundary values: $expected", async ({ row, expected }) => {
    mockUsage({ usages: { limit_month_total: row } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(expected);
    expect(reports[0]?.quota.monthlyResetAt).toBeUndefined();
  });

  test.each([null, "", "invalid", true, {}, []])("ignores invalid used_ratio %j", async used_ratio => {
    mockUsage({ usages: { limit_month_total: { used_ratio } } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports).toEqual([]);
  });

  test("does not fabricate monthly usage from legacy windows or total subscription credits", async () => {
    mockUsage({ usage: { percent: 20 }, totalQuota: { percent: 60 } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.weeklyPercent).toBe(20);
    expect(reports[0]?.quota.monthlyPercent).toBeUndefined();
    expect(reports[0]?.quota.customWindows).toEqual([{ label: "Total subscription credits", percent: 60 }]);
  });
});
