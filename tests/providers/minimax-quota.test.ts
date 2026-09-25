import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../src/providers/quota";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
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
  for (const key of Object.keys(originalProxyEnv)) delete process.env[key];
  clearProviderQuotaCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalProxyEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearProviderQuotaCache();
});

describe("MiniMax Coding Plan quota", () => {
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
