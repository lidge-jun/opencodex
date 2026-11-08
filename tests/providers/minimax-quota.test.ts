import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderQuotaCache, fetchProviderApiKeyQuotas, fetchProviderQuotaReports } from "../../src/providers/quota";
import { clearKeyCooldowns, selectProactiveApiKey } from "../../src/providers/key-failover";
import { saveConfig } from "../../src/config";
import { ensureQuotaPoolIdentity, resetQuotaPoolIdentityMemoForTests } from "../../src/quota-pool/identity";
import { readQuotaPool } from "../../src/quota-pool/assemble";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let testHome: string;
const originalProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]).map(key => [key, process.env[key]]));

function config(name: string, baseUrl: string): OcxConfig {
  return {
    defaultProvider: name,
    providers: { [name]: { adapter: "openai-chat", authMode: "key", baseUrl, apiKey: "test-secret" } },
  } as OcxConfig;
}

function response(modelRemains: unknown, statusCode = 0): Response {
  return Response.json({ base_resp: { status_code: statusCode }, model_remains: modelRemains });
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-minimax-quota-"));
  process.env.OPENCODEX_HOME = testHome;
  resetQuotaPoolIdentityMemoForTests();
  for (const key of Object.keys(originalProxyEnv)) delete process.env[key];
  clearProviderQuotaCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalProxyEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearKeyCooldowns();
  clearProviderQuotaCache();
  resetQuotaPoolIdentityMemoForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(testHome);
});

describe("MiniMax Coding Plan quota", () => {
  test("quota strategy selects the key with Coding Plan headroom", async () => {
    const cfg = config("minimax", "https://api.minimax.io/v1");
    Object.assign(cfg.providers.minimax!, {
      apiKey: "not-active", apiKeyPoolStrategy: "quota",
      apiKeyPool: [{ id: "first", key: "first-key" }, { id: "second", key: "second-key" }],
    });
    saveConfig(cfg);
    clearKeyCooldowns();
    globalThis.fetch = (async (_input, init) => response([{
      model_name: "general",
      current_interval_remaining_percent: new Headers(init?.headers).get("authorization") === "Bearer first-key" ? 0 : 80,
    }])) as typeof fetch;
    const rows = await fetchProviderApiKeyQuotas(cfg, "minimax", true);
    expect(rows.map(row => row.quota?.customWindows?.[0]?.percent)).toEqual([100, 20]);
    expect(selectProactiveApiKey(cfg, "minimax")?.apiKey).toBe("second-key");
  });

  test("quota pool includes the Coding Plan inference windows", async () => {
    const cfg = config("minimax", "https://api.minimax.io/v1");
    globalThis.fetch = (async () => response([{
      model_name: "general", current_interval_remaining_percent: 0,
      current_weekly_status: 1, current_weekly_remaining_percent: 60,
    }])) as typeof fetch;
    await fetchProviderQuotaReports(cfg, true);
    ensureQuotaPoolIdentity();
    const result = await readQuotaPool(cfg);
    if (!result.ok) throw new Error(result.error);
    expect(result.pool.providers.find(row => row.provider === "minimax")?.pooled.windows.map(row => [row.label, row.usedPercent])).toEqual([
      ["Coding Plan 5-hour", 100], ["Coding Plan weekly", 40],
    ]);
    cfg.providers.minimax!.apiKey = "replacement-key";
    const replaced = await readQuotaPool(cfg);
    if (!replaced.ok) throw new Error(replaced.error);
    expect(replaced.pool.providers.find(row => row.provider === "minimax")?.pooled.windows ?? []).toEqual([]);
  });

  test("CN uses current endpoint and reports general 5-hour and weekly consumed percentages with resets", async () => {
    let request: { url?: string; authorization?: string; redirect?: RequestRedirect } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = {
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        redirect: init?.redirect,
      };
      return response([
        { model_name: "general", current_interval_remaining_percent: 62.5, end_time: 1_800_000_000, current_weekly_status: 1, current_weekly_remaining_percent: 25, weekly_end_time: 1_810_000_000 },
        { model_name: "video", current_interval_remaining_percent: 0, end_time: 1_800_000_000, current_weekly_status: 1, current_weekly_remaining_percent: 0, weekly_end_time: 1_810_000_000 },
      ]);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config("minimax-cn", "https://api.minimaxi.com/v1"), true);

    expect(request).toMatchObject({
      url: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
      authorization: "Bearer test-secret",
      redirect: "error",
    });
    expect(result.reports[0]?.quota.customWindows).toEqual([
      { label: "Coding Plan 5-hour", percent: 37.5, resetAt: 1_800_000_000_000 },
      { label: "Coding Plan weekly", percent: 75, resetAt: 1_810_000_000_000 },
    ]);
  });

  test("international provider uses the minimax.io host", async () => {
    let url = "";
    globalThis.fetch = (async input => {
      url = String(input);
      return response([{ model_name: "general", current_interval_remaining_percent: 80, end_time: 1_800_000_000 }]);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config("minimax", "https://api.minimax.io/v1"), true);

    expect(url).toBe("https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
    expect(result.reports[0]?.quota.customWindows?.[0]?.percent).toBe(20);
  });

  test("no-week plans expose only the 5-hour window", async () => {
    globalThis.fetch = (async () => response([
      { model_name: "general", current_interval_remaining_percent: 44, end_time: 1_800_000_000, current_weekly_status: 0, current_weekly_remaining_percent: 0 },
    ])) as typeof fetch;

    const result = await fetchProviderQuotaReports(config("minimax-cn", "https://api.minimaxi.com/v1"), true);

    expect(result.reports[0]?.quota.customWindows).toEqual([
      { label: "Coding Plan 5-hour", percent: 56, resetAt: 1_800_000_000_000 },
    ]);
  });

  test.each([
    ["nonzero status", [{ model_name: "general", current_interval_remaining_percent: 20 }], 7],
    ["missing general model", [{ model_name: "video", current_interval_remaining_percent: 20 }], 0],
    ["invalid percentage", [{ model_name: "general", current_interval_remaining_percent: "invalid" }], 0],
  ])("does not publish an empty window for %s", async (_label, rows, status) => {
    globalThis.fetch = (async () => response(rows, status)) as typeof fetch;

    const result = await fetchProviderQuotaReports(config("minimax-cn", "https://api.minimaxi.com/v1"), true);

    expect(result.reports).toEqual([]);
  });

  test("bounds numeric percentages and ignores malformed JSON", async () => {
    globalThis.fetch = (async () => response([
      { model_name: "general", current_interval_remaining_percent: -5 },
    ])) as typeof fetch;
    const bounded = await fetchProviderQuotaReports(config("minimax-cn", "https://api.minimaxi.com/v1"), true);
    expect(bounded.reports[0]?.quota.customWindows?.[0]?.percent).toBe(100);

    clearProviderQuotaCache();
    globalThis.fetch = (async () => new Response("not json")) as typeof fetch;
    const malformed = await fetchProviderQuotaReports(config("minimax-cn", "https://api.minimaxi.com/v1"), true);
    expect(malformed.reports).toEqual([]);
  });
});
