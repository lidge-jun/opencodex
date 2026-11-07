import { afterEach, beforeEach, expect, test } from "bun:test";
import budget from "../fixtures/mistral-budget.json";
import subscription from "../fixtures/mistral-subscription.json";
import { clearProviderQuotaCache, fetchProviderApiKeyQuotas, fetchProviderQuotaReports, setProviderQuotaBeforePublishForTests } from "../../src/providers/quota";
import { providerApiKeyQuotaMode } from "../../src/providers/quota/vendor-probes-key";
import { classifyUpstreamCondition } from "../../src/lib/upstream-condition";
import type { OcxConfig } from "../../src/types";
import { saveConfig } from "../../src/config";
import { selectProactiveApiKey, clearKeyCooldowns } from "../../src/providers/key-failover";
import { providerWindowObservations } from "../../src/quota/window-mapping";
import { detectQuotaResets } from "../../src/quota/reset-detector";

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
afterEach(() => { globalThis.fetch = originalFetch; setProviderQuotaBeforePublishForTests(null); clearProviderQuotaCache(); });

test("successive Mistral budget payloads retain reset identities across usage and plan changes", async () => {
  const now = Date.parse("2026-12-01T00:01:00Z");
  let after = false;
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription")
    ? { ...subscription, plan_name: after ? "TEAM" : "EDU" }
    : { api_budget: { ...budget.api_budget, usage_percentage: after ? 2 : 90, reset_at: after ? "2027-01-01T00:00:00Z" : "2026-12-01T00:00:00Z" },
        vibe_budget: { ...budget.vibe_budget, usage_percentage: after ? 1 : 80, reset_at: after ? "2027-01-01T00:00:00Z" : "2026-12-01T00:00:00Z" } })) as typeof fetch;
  const before = (await fetchProviderQuotaReports(config, true)).reports[0]!.quota;
  after = true;
  const next = (await fetchProviderQuotaReports(config, true)).reports[0]!.quota;
  const events = detectQuotaResets({ scope: "provider", accountTag: "fixture", previous: providerWindowObservations(before), next: providerWindowObservations(next), now });
  expect(events.map(event => [event.window, event.kind])).toEqual([["custom:API budget", "scheduled"], ["custom:Vibe budget", "scheduled"]]);
});

test("Mistral reports both budget windows and plan and caches the paired read", async () => {
  const first = await fetchProviderQuotaReports(config, false);
  const report = first.reports.find(row => row.provider === "mistral");
  expect(report?.source).toBe("mistral:budget");
  expect(JSON.stringify(first)).not.toContain("test-mistral-key");
  expect(report?.quota.customWindows).toEqual([
    { label: "API budget", displayLabel: "API budget (EUR 2.50 of EUR 20.00 used; EDU)", percent: 12.5, resetAt: Date.parse("2026-12-01T00:00:00Z") },
    { label: "Vibe budget", displayLabel: "Vibe budget (EUR 0.20 of EUR 10.00 used; EDU)", percent: 2, resetAt: Date.parse("2026-12-01T00:00:00Z") },
  ]);
  await fetchProviderQuotaReports(config, false);
  expect(calls.sort()).toEqual(["https://api.mistral.ai/v1/billing/budget", "https://api.mistral.ai/v1/billing/subscription"]);
  await fetchProviderQuotaReports(config, true);
  expect(calls).toHaveLength(4);
});

test("unrecognized plan and currency text never enters budget display data", async () => {
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription")
    ? { ...subscription, plan_name: "PRIVATE-CANARY\nmalicious" }
    : { ...budget, api_budget: { ...budget.api_budget, currency: "EUR\nPRIVATE-CANARY" } })) as typeof fetch;
  const result = await fetchProviderQuotaReports(config, true);
  expect(JSON.stringify(result)).not.toContain("PRIVATE-CANARY");
  expect(result.reports[0]?.quota.unknownBudgetWindows?.[0]?.label).toBe("API budget");
  expect(result.reports[0]?.quota.customWindows?.[0]?.displayLabel).toBe("Vibe budget (EUR 0.20 of EUR 10.00 used)");
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

test("a denial wins over a rejected companion probe and clears stale rows", async () => {
  for (const status of [401, 403]) for (const denied of ["budget", "subscription"]) {
    clearProviderQuotaCache();
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : budget)) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports).toHaveLength(1);
    await fetchProviderApiKeyQuotas(config, "mistral", true);
    globalThis.fetch = (async input => {
      if (String(input).endsWith(`/${denied}`)) return new Response(null, { status });
      throw new Error("transport failure");
    }) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports).toEqual([]);
    const row = (await fetchProviderApiKeyQuotas(config, "mistral", true))[0];
    expect(row?.unavailable).toBe(true);
    expect(row?.quota).toBeNull();
  }
});

test("a transient rejection does not reject the aggregated report or hide another provider", async () => {
  const other = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-deepseek-key" } as const;
  const multi = { ...config, providers: { mistral: provider, deepseek: other } } as OcxConfig;
  for (const transient of ["both-rejected", "budget-500", "subscription-429"]) {
    clearProviderQuotaCache();
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : budget)) as typeof fetch;
    await fetchProviderQuotaReports(multi, true);
    await fetchProviderApiKeyQuotas(multi, "mistral", true);
    globalThis.fetch = (async input => {
      const url = String(input);
      if (!url.includes("mistral.ai")) return Response.json({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "10", granted_balance: "0", topped_up_balance: "10" }] });
      if (transient === "budget-500" && url.endsWith("/budget")) return new Response(null, { status: 500 });
      if (transient === "subscription-429" && url.endsWith("/subscription")) return new Response(null, { status: 429 });
      throw new Error("network unavailable");
    }) as typeof fetch;
    const result = await fetchProviderQuotaReports(multi, true);
    expect(result.reports.some(row => row.provider === "deepseek")).toBe(true);
    expect(result.reports.some(row => row.provider === "mistral")).toBe(true); // bounded last-good display
    const row = (await fetchProviderApiKeyQuotas(multi, "mistral", true))[0];
    expect(row?.unavailable).toBe(true);
    expect(row?.quota?.customWindows).toHaveLength(2);
  }
});

test.each(["success", "unavailable"] as const)("a colliding replacement key never receives the previous key's cached budget (%s)", async result => {
  const first = "fixture-collision-76466", second = "fixture-collision-176773";
  const mutable = { ...provider, apiKey: first };
  const cfg = { defaultProvider: "mistral", providers: { mistral: mutable } } as OcxConfig;
  let calls = 0;
  globalThis.fetch = (async (input, init) => {
    calls++;
    const key = new Headers(init?.headers).get("authorization");
    if (key === `Bearer ${second}` && result === "unavailable") throw new Error("fixture transport failure");
    return Response.json(String(input).endsWith("/subscription") ? subscription : {
      ...budget, api_budget: { ...budget.api_budget, usage_percentage: key === `Bearer ${first}` ? 80 : 20 },
    });
  }) as typeof fetch;
  expect((await fetchProviderQuotaReports(cfg, false)).reports[0]?.quota.customWindows?.[0]?.percent).toBe(80);
  mutable.apiKey = second;
  const next = await fetchProviderQuotaReports(cfg, false);
  expect(calls).toBe(4);
  if (result === "success") expect(next.reports[0]?.quota.customWindows?.[0]?.percent).toBe(20);
  else expect(next.reports).toEqual([]);
});

test.each(["unchanged", "key", "removed", "destination"] as const)("a joined quota request validates its own configuration after %s", async change => {
  const first = { defaultProvider: "mistral", providers: { mistral: { ...provider } } } as OcxConfig;
  const second = { defaultProvider: "mistral", providers: { mistral: { ...provider } } } as OcxConfig;
  const gate = Promise.withResolvers<void>();
  let count = 0;
  globalThis.fetch = (async input => {
    count++;
    await gate.promise;
    return Response.json(String(input).endsWith("/subscription") ? subscription : budget);
  }) as typeof fetch;
  const original = fetchProviderQuotaReports(first);
  const joined = fetchProviderQuotaReports(second);
  expect(count).toBe(2);
  if (change === "key") second.providers.mistral!.apiKey = "replacement-key";
  if (change === "removed") delete second.providers.mistral;
  if (change === "destination") second.providers.mistral!.baseUrl = "https://example.com/v1";
  gate.resolve();
  expect((await original).reports).toHaveLength(1);
  expect((await joined).reports).toHaveLength(change === "unchanged" ? 1 : 0);
});

test("a transient refresh does not return a cached budget after its credential changes before publication", async () => {
  const mutable = { ...provider };
  const cfg = { defaultProvider: "mistral", providers: { mistral: mutable } } as OcxConfig;
  await fetchProviderQuotaReports(cfg, true);
  globalThis.fetch = (async () => { throw new Error("fixture transport failure"); }) as typeof fetch;
  setProviderQuotaBeforePublishForTests(() => { mutable.apiKey = "replacement-key"; });
  expect((await fetchProviderQuotaReports(cfg, true)).reports).toEqual([]);
});

test("a removed provider's denial does not suppress a different provider's retained quota", async () => {
  const other = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-deepseek-key" } as const;
  const cfg = { ...config, providers: { mistral: { ...provider }, deepseek: other } } as OcxConfig;
  globalThis.fetch = (async input => Response.json(String(input).includes("deepseek.com")
    ? { is_available: true, balance_infos: [{ currency: "USD", total_balance: "10", granted_balance: "0", topped_up_balance: "10" }] }
    : String(input).endsWith("/subscription") ? subscription : budget)) as typeof fetch;
  expect((await fetchProviderQuotaReports(cfg, true)).reports).toHaveLength(2);
  globalThis.fetch = (async input => {
    if (String(input).includes("mistral.ai")) { delete cfg.providers.mistral; return new Response(null, { status: 403 }); }
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  expect((await fetchProviderQuotaReports(cfg, true)).reports.map(row => row.provider)).toEqual(["deepseek"]);
});

test("display-only API and Vibe budgets do not rank keys in the quota strategy", async () => {
  for (const [api, vibe] of [[100, 0], [0, 100]]) {
    clearProviderQuotaCache();
    clearKeyCooldowns();
    const pooled = { ...provider, apiKey: "missing-active", apiKeyPoolStrategy: "quota", apiKeyPool: [
      { id: "first", key: "first-key" }, { id: "second", key: "second-key" },
    ] } as const;
    const cfg = { defaultProvider: "mistral", providers: { mistral: pooled } } as unknown as OcxConfig;
    saveConfig(cfg);
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith("/subscription")) return Response.json(subscription);
      const first = new Headers(init?.headers).get("authorization") === "Bearer first-key";
      return Response.json({ api_budget: { ...budget.api_budget, usage_percentage: first ? api : 10 }, vibe_budget: { ...budget.vibe_budget, usage_percentage: first ? vibe : 10 } });
    }) as typeof fetch;
    await fetchProviderApiKeyQuotas(cfg, "mistral", true);
    expect(selectProactiveApiKey(cfg, "mistral")?.apiKey).toBe("first-key");
  }
});
