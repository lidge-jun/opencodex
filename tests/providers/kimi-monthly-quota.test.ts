import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../../src/oauth/store";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../src/providers/quota";
import { clearComboTargetCooldowns, pickComboTarget } from "../../src/combos";
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
  clearComboTargetCooldowns();
  for (const key of proxyKeys) {
    if (originalProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProxyEnv[key];
  }
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function config(authMode: "key" | "oauth" = "key", baseUrl = "https://api.kimi.com/coding/v1"): OcxConfig {
  const name = authMode === "oauth" ? "kimi" : "kimi-code";
  return {
    defaultProvider: name,
    providers: {
      [name]: {
        adapter: "openai-chat",
        authMode,
        baseUrl,
        ...(authMode === "key" ? { apiKey: "kimi-monthly-fixture-key" } : {}),
      },
    },
  } as OcxConfig;
}

function mockUsage(payload: unknown, url = "https://api.kimi.com/coding/v1/usages"): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(url);
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

  test.each([
    { name: "empty root usages", payload: { usages: {}, data: { usages: { limit_month_total: monthlyRow } } } },
    { name: "unparseable root usages", payload: { usages: { limit_month_total: { used_ratio: "invalid" } }, data: { usages: { limit_month_total: monthlyRow } } } },
    { name: "root quota after empty root usages", payload: { usages: {}, quota: { usages: { limit_month_total: monthlyRow } } } },
    { name: "root quota after empty data usages", payload: { data: { usages: {} }, quota: { usages: { limit_month_total: monthlyRow } } } },
    { name: "data quota after empty root quota", payload: { quota: {}, data: { quota: { usages: { limit_month_total: monthlyRow } } } } },
    { name: "data quota after unparseable root quota", payload: { quota: { usages: { limit_month_code: { used_ratio: "invalid" } } }, data: { quota: { usages: { limit_month_total: monthlyRow } } } } },
    { name: "data quota after empty data usages", payload: { data: { usages: {}, quota: { usages: { limit_month_total: monthlyRow } } } } },
  ])("finds monthly usage with $name", async ({ payload }) => {
    mockUsage(payload);
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(37.5);
    expect(reports[0]?.quota.monthlyResetAt).toBe(Date.parse(resetAt));
  });

  test("retains root quota when legacy windows unwrap the data envelope", async () => {
    mockUsage({
      data: { usage: { percent: 25 } },
      quota: { usages: { limit_month_total: monthlyRow } },
    });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota).toMatchObject({ weeklyPercent: 25, monthlyPercent: 37.5 });
  });

  test.each([0, 0.25])("keeps the first usable container, including ratio %s", async ratio => {
    mockUsage({
      usages: { limit_month_code: { used_ratio: ratio } },
      data: { usages: { limit_month_total: monthlyRow } },
    });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(ratio * 100);
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

  test.each([-0.1, 1.5, "-0.1", "1.5"])("ignores out-of-range ratios and preserves coding fallback: %s", async ratio => {
    mockUsage({ usages: { limit_month_total: { used_ratio: ratio } } });
    expect((await fetchProviderQuotaReports(config(), true)).reports).toEqual([]);
    clearProviderQuotaCache();
    mockUsage({ usages: {
      limit_month_total: { used_ratio: ratio },
      limit_month_code: { used_ratio: 0.2, reset_at: resetAt },
    } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(20);
    expect(reports[0]?.quota.monthlyResetAt).toBe(Date.parse(resetAt));
  });

  test.each(["used_ratio", "usedRatio"])("retains direct-percent fallback after invalid %s", async field => {
    mockUsage({ usages: { limit_month_total: { [field]: 1.5, percent: 45 } } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(45);
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

  const exhaustedLegacy = {
    usage: { percent: 100 },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "100" } }],
  };

  function comboConfig(): OcxConfig {
    const base = config();
    return {
      ...base,
      providers: { ...base.providers, fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", apiKey: "fallback-key" } },
      combos: { "quota-scope": { strategy: "failover", targets: [
        { provider: "kimi-code", model: "primary-model" }, { provider: "fallback", model: "fallback-model" },
      ] } },
    } as OcxConfig;
  }

  test.each([
    { name: "usable outer usages", usages: { limit_month_total: { used_ratio: 0.2 } }, monthly: 20 },
    { name: "empty outer usages", usages: {}, monthly: undefined },
    { name: "malformed outer usages", usages: { limit_month_total: { used_ratio: "invalid" } }, monthly: undefined },
    { name: "non-object outer usages", usages: "invalid", monthly: undefined },
  ])("reports nested exhausted legacy windows beside $name", async ({ usages, monthly }) => {
    mockUsage({ usages, data: exhaustedLegacy });
    const cfg = comboConfig();
    const { reports } = await fetchProviderQuotaReports(cfg, true);
    expect(reports[0]?.quota).toMatchObject({ weeklyPercent: 100, fiveHourPercent: 100 });
    expect(reports[0]?.quota.monthlyPercent).toBe(monthly);
    expect(pickComboTarget(cfg, "quota-scope")?.target.provider).toBe("fallback");
  });

  test("nested monthly container does not hide exhausted outer legacy windows", async () => {
    mockUsage({ ...exhaustedLegacy, data: { usages: { limit_month_total: { used_ratio: 0.2 } } } });
    const cfg = comboConfig();
    const { reports } = await fetchProviderQuotaReports(cfg, true);
    expect(reports[0]?.quota).toMatchObject({ weeklyPercent: 100, fiveHourPercent: 100, monthlyPercent: 20 });
    expect(pickComboTarget(cfg, "quota-scope")?.target.provider).toBe("fallback");
  });

  test.each([
    { name: "remaining above limit", row: { limit: 100, remaining: 200, used_ratio: 1 } },
    { name: "negative remaining", row: { limit: 100, remaining: -50, used_ratio: 1 } },
    { name: "negative used", row: { limit: 100, used: -20, used_ratio: 1 } },
    { name: "used above limit", row: { limit: 100, used: 250, used_ratio: 1 } },
    { name: "negative used with valid remaining", row: { limit: 100, used: -20, remaining: 50, used_ratio: 1 } },
    { name: "negative limit", row: { limit: -100, used: 0, used_ratio: 1 } },
  ])("falls back to used_ratio when counters are invalid: $name", async ({ row }) => {
    mockUsage({ usages: { limit_month_total: row } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(100);
  });

  test.each([
    { name: "used above limit", row: { limit: 100, used: 250 } },
    { name: "negative remaining", row: { limit: 100, remaining: -50 } },
  ])("an overage without a ratio reads as exhausted: $name", async ({ row }) => {
    mockUsage({ usages: { limit_month_total: row } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(100);
  });

  test.each([
    { name: "negative remaining beside a lower used", row: { limit: 100, used: 40, remaining: -50 } },
    { name: "used overage beside a valid remaining", row: { limit: 100, used: 150, remaining: 60 } },
  ])("either counter overage exhausts the window and the route: $name", async ({ row }) => {
    mockUsage({ usages: { limit_month_total: row } });
    const cfg = comboConfig();
    const { reports } = await fetchProviderQuotaReports(cfg, true);
    expect(reports[0]?.quota.monthlyPercent).toBe(100);
    expect(pickComboTarget(cfg, "quota-scope")?.target.provider).toBe("fallback");
  });

  test.each([
    { name: "zero remaining beside an impossible used", row: { limit: 100, used: -1, remaining: 0, used_ratio: 0.2 } },
    { name: "used at the limit beside an impossible remaining", row: { limit: 100, used: 100, remaining: 101, used_ratio: 0.2 } },
  ])("an exhaustion signal wins over an impossible companion counter: $name", async ({ row }) => {
    mockUsage({ usages: { limit_month_total: row } });
    const cfg = comboConfig();
    const { reports } = await fetchProviderQuotaReports(cfg, true);
    expect(reports[0]?.quota.monthlyPercent).toBe(100);
    expect(pickComboTarget(cfg, "quota-scope")?.target.provider).toBe("fallback");
  });

  test("a tiny positive remainder is not exhaustion", async () => {
    mockUsage({ usages: { limit_month_total: { limit: 100, remaining: 0.000000000000001 } } });
    const cfg = comboConfig();
    const { reports } = await fetchProviderQuotaReports(cfg, true);
    expect(reports[0]?.quota.monthlyPercent).toBeLessThan(100);
    expect(pickComboTarget(cfg, "quota-scope")?.target.provider).not.toBe("fallback");
  });

  test("drops a row whose only counters are invalid", async () => {
    mockUsage({ usages: { limit_month_total: { limit: 100, remaining: 200 }, limit_month_code: { used_ratio: 0.4 } } });
    const { reports } = await fetchProviderQuotaReports(config(), true);
    expect(reports[0]?.quota.monthlyPercent).toBe(40);
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

describe("Kimi regional (kimi.ai) Coding Plan quota (#8332)", () => {
  const regional = "https://api.kimi.ai/coding/v1";

  test("a key-auth provider on api.kimi.ai probes its own origin's /usages", async () => {
    // Field shape from public API-key reports against this endpoint: legacy counters beside
    // ratio windows that can contradict them. Valid counters win over a zero ratio.
    mockUsage({
      usage: { limit: 100, used: 40, remaining: 60, resetTime: resetAt },
      limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 100, used: 100, remaining: 0, resetTime: resetAt } }],
      usages: { limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0 }, limit_month_total: { used_ratio: 0.1, reset_time: resetAt } },
    }, `${regional}/usages`);

    const { reports } = await fetchProviderQuotaReports(config("key", `${regional}/`), true);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe("kimi:usages");
    expect(reports[0]?.quota).toMatchObject({ fiveHourPercent: 100, weeklyPercent: 40, monthlyPercent: 10 });
  });

  test.each([
    { name: "an OAuth token on api.kimi.ai", authMode: "oauth" as const, baseUrl: regional },
    { name: "a lookalike host", authMode: "key" as const, baseUrl: "https://api.kimi.ai.example.test/coding/v1" },
    { name: "another path on api.kimi.ai", authMode: "key" as const, baseUrl: "https://api.kimi.ai/v1" },
  ])("$name never receives the credential", async ({ authMode, baseUrl }) => {
    if (authMode === "oauth") {
      await saveCredential("kimi", {
        access: "kimi-regional-fixture-access",
        refresh: "kimi-regional-fixture-refresh",
        expires: Date.now() + 3600_000,
      });
    }
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return Response.json({ usages: { limit_month_total: monthlyRow } });
    }) as typeof fetch;

    const { reports } = await fetchProviderQuotaReports(config(authMode, baseUrl), true);

    expect(requested.filter(url => url.includes("/usages"))).toEqual([]);
    expect(reports.some(report => report.source === "kimi:usages")).toBe(false);
  });
});
