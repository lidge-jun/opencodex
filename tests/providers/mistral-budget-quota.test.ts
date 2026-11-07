import { afterEach, beforeEach, expect, test } from "bun:test";
import budget from "../fixtures/mistral-budget.json";
import subscription from "../fixtures/mistral-subscription.json";
import { clearProviderQuotaCache, fetchProviderApiKeyQuotas, fetchProviderQuotaReports } from "../../src/providers/quota";
import { providerApiKeyQuotaMode } from "../../src/providers/quota/vendor-probes-key";
import { classifyUpstreamCondition } from "../../src/lib/upstream-condition";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const provider = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "test-mistral-key" } as const;
const config = { defaultProvider: "mistral", providers: { mistral: provider } } as OcxConfig;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  clearProviderQuotaCache();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-mistral-key");
    expect(init?.redirect).toBe("error");
    return Response.json(url.endsWith("/subscription") ? subscription : budget);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; clearProviderQuotaCache(); });

test("Mistral reports both budget windows and plan and caches the paired read", async () => {
  const first = await fetchProviderQuotaReports(config, false);
  const report = first.reports.find(row => row.provider === "mistral");
  expect(report?.source).toBe("mistral:budget");
  expect(JSON.stringify(first)).not.toContain("test-mistral-key");
  expect(report?.quota.customWindows).toEqual([
    { label: "API budget (EUR 2.50 of EUR 20.00 used; EDU)", percent: 12.5, resetAt: Date.parse("2026-12-01T00:00:00Z") },
    { label: "Vibe budget (EUR 0.20 of EUR 10.00 used; EDU)", percent: 2, resetAt: Date.parse("2026-12-01T00:00:00Z") },
  ]);
  await fetchProviderQuotaReports(config, false);
  expect(calls.sort()).toEqual(["https://api.mistral.ai/v1/billing/budget", "https://api.mistral.ai/v1/billing/subscription"]);
  await fetchProviderQuotaReports(config, true);
  expect(calls).toHaveLength(4);
});

test("lookalike destinations cannot receive a key", () => {
  for (const baseUrl of ["https://api.mistral.ai.evil.example/v1", "https://api.mistral.ai/v1?x=y", "http://api.mistral.ai/v1"]) {
    expect(providerApiKeyQuotaMode("mistral", { ...provider, baseUrl })).toBe("unsupported");
  }
});

test("Mistral 402 is billing exhaustion and 429 is rate limiting", () => {
  expect(classifyUpstreamCondition({ status: 402 })).toBe("billing_exhausted");
  expect(classifyUpstreamCondition({ status: 429 })).toBe("rate_limited");
});

test("zero or missing budgets and null currency are unknown, never exhausted", async () => {
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : {
    api_budget: { ...budget.api_budget, initial_budget: 0 },
    vibe_budget: { ...budget.vibe_budget, currency: null },
  })) as typeof fetch;
  const report = (await fetchProviderQuotaReports(config, true)).reports[0];
  expect(report?.quota.customWindows ?? []).toEqual([]);
  expect(report?.quota.unknownBudgetWindows).toEqual([
    { label: "API budget (EDU)", resetAt: Date.parse("2026-12-01T00:00:00Z") },
    { label: "Vibe budget (EDU)", resetAt: Date.parse("2026-12-01T00:00:00Z") },
  ]);
});

test("a missing budget stays unknown alongside a measured budget", async () => {
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : {
    api_budget: { ...budget.api_budget, initial_budget: undefined }, vibe_budget: budget.vibe_budget,
  })) as typeof fetch;
  const report = (await fetchProviderQuotaReports(config, true)).reports[0];
  expect(report?.quota.unknownBudgetWindows?.[0]?.label).toBe("API budget (EDU)");
  expect(report?.quota.customWindows?.[0]?.percent).toBe(2);
});

test("401 and 403 invalidate previous budgets and mark the key unavailable", async () => {
  for (const status of [401, 403]) {
    clearProviderQuotaCache();
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : budget)) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports.length).toBe(1);
    expect((await fetchProviderApiKeyQuotas(config, "mistral", true))[0]?.quota).toBeTruthy();
    globalThis.fetch = (async () => new Response(null, { status })) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports).toEqual([]);
    const row = (await fetchProviderApiKeyQuotas(config, "mistral", true))[0];
    expect(row?.unavailable).toBe(true);
    expect(row?.quota).toBeNull();
  }
});
