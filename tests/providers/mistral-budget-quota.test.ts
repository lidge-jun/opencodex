import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import budget from "../fixtures/mistral-budget.json";
import subscription from "../fixtures/mistral-subscription.json";
import {
  clearProviderQuotaCache,
  fetchProviderApiKeyQuotas,
  fetchProviderQuotaReports,
  setProviderQuotaBeforePublishForTests,
} from "../../src/providers/quota";
import { providerApiKeyQuotaMode } from "../../src/providers/quota/vendor-probes-key";
import { keyReport, publishKeyReportForTests, routingEvidence, setProviderQuotaReportCache } from "../../src/providers/quota/report-cache";
import { classifyUpstreamCondition } from "../../src/lib/upstream-condition";
import { MistralBudgetPacer, resolveMistralTransport } from "../../src/providers/mistral-transport";
import { runPassiveRead } from "../../src/lib/passive-read";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import type { OcxConfig } from "../../src/types";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns, selectProactiveApiKey } from "../../src/providers/key-failover";
import { providerWindowObservations } from "../../src/quota/window-mapping";
import { mistralUnknownBudgetWindows } from "../../src/providers/quota-mistral-budget";
import { detectQuotaResets } from "../../src/quota/reset-detector";
import { ensureQuotaPoolIdentity } from "../../src/quota-pool/identity";
import { readQuotaPool } from "../../src/quota-pool/assemble";
import { QuotaPoolSchema } from "../helpers/quota-pool-schema";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home: string;
const provider = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "test-mistral-key" } as const;
const config = { defaultProvider: "mistral", providers: { mistral: provider } } as OcxConfig;
let calls: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-mistral-budget-"));
  process.env.OPENCODEX_HOME = home;
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
afterEach(() => {
  globalThis.fetch = originalFetch;
  setProviderQuotaBeforePublishForTests(null);
  clearProviderQuotaCache();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("Mistral budget probe", () => {
  test("passive reports verify the current key and destination without probing or reading keychain", async () => {
    expect((await fetchProviderQuotaReports(config, true)).reports).toHaveLength(1);
    const originalCalls = calls.length;
    const previousEnv = process.env.OCX_TEST_MISTRAL_PASSIVE;
    process.env.OCX_TEST_MISTRAL_PASSIVE = "test-mistral-key";
    let keychainReads = 0;
    setProviderKeychainEntryFactoryForTests(() => ({
      getPassword: () => { keychainReads++; return "test-mistral-key"; },
      setPassword: () => {}, deletePassword: () => true,
    }));
    try {
      const variants = [
        { ...provider, apiKey: "replacement-key" },
        { ...provider, disabled: true },
        { ...provider, authMode: "oauth" },
        { ...provider, baseUrl: "https://other.example/v1" },
        { ...provider, apiKey: "keychain:fixture" },
      ];
      for (const current of variants) {
        const changed = { ...config, providers: { mistral: current } } as OcxConfig;
        expect((await runPassiveRead(() => fetchProviderQuotaReports(changed, true))).reports).toEqual([]);
      }
      const envConfig = { ...config, providers: { mistral: { ...provider, apiKey: "${OCX_TEST_MISTRAL_PASSIVE}" } } } as OcxConfig;
      expect((await runPassiveRead(() => fetchProviderQuotaReports(envConfig, true))).reports).toHaveLength(1);
      process.env.OCX_TEST_MISTRAL_PASSIVE = "replacement-key";
      expect((await runPassiveRead(() => fetchProviderQuotaReports(envConfig, true))).reports).toEqual([]);
      expect((await runPassiveRead(() => fetchProviderQuotaReports(config, true))).reports).toHaveLength(1);
      expect(calls).toHaveLength(originalCalls);
      expect(keychainReads).toBe(0);
    } finally {
      setProviderKeychainEntryFactoryForTests(null);
      if (previousEnv === undefined) delete process.env.OCX_TEST_MISTRAL_PASSIVE;
      else process.env.OCX_TEST_MISTRAL_PASSIVE = previousEnv;
    }
  });
  test("quota pool excludes credential-bound held evidence after key rotation", async () => {
    const now = Date.now();
    const report = keyReport("mistral", "fixture", { weeklyPercent: 42, updatedAt: now }, provider, provider.apiKey, undefined, { bindCredential: true });
    expect(report).not.toBeNull();
    setProviderQuotaReportCache({ key: "fixture", ts: now, response: { generatedAt: now, reports: [report!] } });
    ensureQuotaPoolIdentity();
    const unchanged = await readQuotaPool(config);
    if (!unchanged.ok) throw new Error(unchanged.error);
    expect(unchanged.pool.providers.find(row => row.provider === "mistral")?.pooled.windows.length).toBeGreaterThan(0);
    const rotated = { ...config, providers: { mistral: { ...provider, apiKey: "replacement-key" } } } as OcxConfig;
    const changed = await readQuotaPool(rotated);
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.pool.providers.find(row => row.provider === "mistral")).toBeUndefined();
  });
  test("reports both budget windows and plan, and caches the paired read", async () => {
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

  test("successive payloads retain reset identities across usage and plan changes", async () => {
    const now = Date.parse("2026-12-01T00:01:00Z");
    let after = false;
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription")
      ? { ...subscription, plan_name: after ? "TEAM" : "EDU" }
      : {
          api_budget: { ...budget.api_budget, usage_percentage: after ? 2 : 90, reset_at: after ? "2027-01-01T00:00:00Z" : "2026-12-01T00:00:00Z" },
          vibe_budget: { ...budget.vibe_budget, usage_percentage: after ? 1 : 80, reset_at: after ? "2027-01-01T00:00:00Z" : "2026-12-01T00:00:00Z" },
        })) as typeof fetch;
    const before = (await fetchProviderQuotaReports(config, true)).reports[0]!.quota;
    after = true;
    const next = (await fetchProviderQuotaReports(config, true)).reports[0]!.quota;
    const events = detectQuotaResets({ scope: "provider", accountTag: "fixture", previous: providerWindowObservations(before), next: providerWindowObservations(next), now });
    expect(events.map(event => [event.window, event.kind])).toEqual([["custom:API budget", "scheduled"], ["custom:Vibe budget", "scheduled"]]);
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

  test.each(["success", "unavailable"] as const)("a colliding replacement key never receives the previous key's cached budget (%s)", async result => {
    const first = "fixture-collision-76466", second = "fixture-collision-176773";
    const mutable = { ...provider, apiKey: first };
    const cfg = { defaultProvider: "mistral", providers: { mistral: mutable } } as OcxConfig;
    let count = 0;
    globalThis.fetch = (async (input, init) => {
      count++;
      const key = new Headers(init?.headers).get("authorization");
      if (key === `Bearer ${second}` && result === "unavailable") throw new Error("fixture transport failure");
      return Response.json(String(input).endsWith("/subscription") ? subscription : {
        ...budget, api_budget: { ...budget.api_budget, usage_percentage: key === `Bearer ${first}` ? 80 : 20 },
      });
    }) as typeof fetch;
    expect((await fetchProviderQuotaReports(cfg, false)).reports[0]?.quota.customWindows?.[0]?.percent).toBe(80);
    mutable.apiKey = second;
    const next = await fetchProviderQuotaReports(cfg, false);
    expect(count).toBe(4);
    if (result === "success") expect(next.reports[0]?.quota.customWindows?.[0]?.percent).toBe(20);
    else expect(next.reports).toEqual([]);
  });

  test.each(["unchanged", "key", "removed", "destination", "local"] as const)("a joined quota request validates its own configuration after %s", async change => {
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
    if (change === "local") second.providers.mistral!.authMode = "local";
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
    globalThis.fetch = (async input => Response.json(new URL(String(input)).hostname === "api.deepseek.com"
      ? { is_available: true, balance_infos: [{ currency: "USD", total_balance: "10", granted_balance: "0", topped_up_balance: "10" }] }
      : String(input).endsWith("/subscription") ? subscription : budget)) as typeof fetch;
    expect((await fetchProviderQuotaReports(cfg, true)).reports).toHaveLength(2);
    globalThis.fetch = (async input => {
      if (new URL(String(input)).hostname === "api.mistral.ai") { delete cfg.providers.mistral; return new Response(null, { status: 403 }); }
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    // A provider removed mid-probe retires its own row, and the generation mismatch fences the
    // whole aggregate from committing; the surviving provider is re-probed cleanly below.
    expect((await fetchProviderQuotaReports(cfg, true)).reports).toEqual([]);
    globalThis.fetch = (async () => { throw new Error("unexpected network request"); }) as typeof fetch;
    globalThis.fetch = (async input => Response.json({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "10", granted_balance: "0", topped_up_balance: "10" }] })) as typeof fetch;
    expect((await fetchProviderQuotaReports(cfg, true)).reports.map(row => row.provider)).toEqual(["deepseek"]);
  });
});

describe("Mistral destination guard", () => {
  test.each([
    "https://api.mistral.ai.evil.example/v1",
    "https://api.mistral.ai/v1?x=y",
    "http://api.mistral.ai/v1",
    "https://api.mistral.ai/v1#frag",
    `https://user:pass${"@"}api.mistral.ai/v1`,
    "https://api.mistral.ai:8443/v1",
    "https://api.mistral.ai.evil.ai/v1",
    "https://evilapi.mistral.ai/v1",
  ])("lookalike or credentialed destination %s cannot receive a key", baseUrl => {
    expect(providerApiKeyQuotaMode("mistral", { ...provider, baseUrl })).toBe("unsupported");
  });

  test.each(["https://api.mistral.ai", "https://api.mistral.ai/", "https://api.mistral.ai/v1", "https://api.mistral.ai/v1/"])(
    "canonical Mistral destination %s is probe-eligible",
    baseUrl => {
      expect(providerApiKeyQuotaMode("mistral", { ...provider, baseUrl })).toBe("probe");
    },
  );

  test("no request leaves the proxy for a lookalike destination", async () => {
    const cfg = { defaultProvider: "mistral", providers: { mistral: { ...provider, baseUrl: "https://api.mistral.ai.evil.example/v1" } } } as OcxConfig;
    expect((await fetchProviderQuotaReports(cfg, true)).reports).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a canonical provider under another name still probes only the fixed endpoint", async () => {
    const cfg = { defaultProvider: "studio", providers: { studio: { ...provider, baseUrl: "https://api.mistral.ai" } } } as OcxConfig;
    const report = (await fetchProviderQuotaReports(cfg, true)).reports[0];
    expect(report?.source).toBe("mistral:budget");
    expect(calls.sort()).toEqual(["https://api.mistral.ai/v1/billing/budget", "https://api.mistral.ai/v1/billing/subscription"]);
  });

  test("a redirect is a transport failure, not a quota reading", async () => {
    globalThis.fetch = (async () => { throw new TypeError("redirect mode is error"); }) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports).toEqual([]);
  });

  test("an oversized or unreadable body is not a quota reading", async () => {
    globalThis.fetch = (async input => String(input).endsWith("/subscription")
      ? new Response("x".repeat(8 * 1024 * 1024), { status: 200 })
      : Response.json(budget)) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports).toEqual([]);
  });
});

describe("Mistral error classification", () => {
  test.each([[402, "billing_exhausted"], [429, "rate_limited"]] as const)(
    "a real Mistral inference transport preserves HTTP %s for %s classification",
    async (status, expected) => {
      const response = new Response("upstream refusal", { status });
      const transport = resolveMistralTransport({ ...provider, fetch: (async () => response) as typeof fetch }, new MistralBudgetPacer());
      const result = await transport.fetch!("https://api.mistral.ai/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer fixture" }, body: JSON.stringify({ model: "fixture-model" }),
      });
      expect(result).toBe(response);
      expect(classifyUpstreamCondition({ status: result.status })).toBe(expected);
      expect(await result.text()).toBe("upstream refusal");
    },
  );
  test("402 is billing exhaustion and 429 is rate limiting", () => {
    expect(classifyUpstreamCondition({ status: 402 })).toBe("billing_exhausted");
    expect(classifyUpstreamCondition({ status: 429 })).toBe("rate_limited");
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
        if (new URL(url).hostname !== "api.mistral.ai") return Response.json({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "10", granted_balance: "0", topped_up_balance: "10" }] });
        if (transient === "budget-500" && url.endsWith("/budget")) return new Response(null, { status: 500 });
        if (transient === "subscription-429" && url.endsWith("/subscription")) return new Response(null, { status: 429 });
        throw new Error("network unavailable");
      }) as typeof fetch;
      const result = await fetchProviderQuotaReports(multi, true);
      expect(result.reports.some(row => row.provider === "deepseek")).toBe(true);
      expect(result.reports.some(row => row.provider === "mistral")).toBe(true);
      const row = (await fetchProviderApiKeyQuotas(multi, "mistral", true))[0];
      expect(row?.unavailable).toBe(true);
      expect(row?.quota?.customWindows).toHaveLength(2);
    }
  });
});

describe("Mistral billing transport (#8295 review)", () => {
  // The generic classifier proves only that a status maps to a condition. These cases drive the
  // real probe: a 402/429 on either billing endpoint is a transient failure of the reading, so
  // the last-good budgets stay displayed; the key row reports the reading as unavailable while
  // still carrying that last-good quota for display.
  function recordingFetch(handler: (url: string) => Response): typeof fetch {
    return (async (input, init) => {
      const url = String(input);
      calls.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-mistral-key");
      expect(init?.redirect).toBe("error");
      return handler(url);
    }) as typeof fetch;
  }

  test.each([
    [402, "budget"], [402, "subscription"], [429, "budget"], [429, "subscription"],
  ] as const)("HTTP %s on /%s keeps the last-good budgets while the key reading is unavailable", async (status, endpoint) => {
    const first = (await fetchProviderQuotaReports(config, true)).reports[0]!;
    expect(first.quota.customWindows?.map(window => window.label)).toEqual(["API budget", "Vibe budget"]);
    expect((await fetchProviderApiKeyQuotas(config, "mistral", true))[0]?.quota?.customWindows).toHaveLength(2);
    calls = [];
    globalThis.fetch = recordingFetch(url => url.endsWith(`/${endpoint}`)
      ? new Response(null, { status })
      : Response.json(url.endsWith("/subscription") ? subscription : budget));
    const after = await fetchProviderQuotaReports(config, true);
    expect(calls.sort()).toEqual(["https://api.mistral.ai/v1/billing/budget", "https://api.mistral.ai/v1/billing/subscription"]);
    // A transient rejection is not a reading: the last-good row survives with its original numbers.
    expect(after.reports[0]?.quota).toBe(first.quota);
    const row = (await fetchProviderApiKeyQuotas(config, "mistral", true))[0];
    expect(row?.unavailable).toBe(true);
    expect(row?.quota?.customWindows?.map(window => window.percent)).toEqual([12.5, 2]);
  });

  test.each([402, 429] as const)("HTTP %s on both endpoints is still transient, not a denial", async status => {
    const first = (await fetchProviderQuotaReports(config, true)).reports[0]!;
    expect((await fetchProviderApiKeyQuotas(config, "mistral", true))[0]?.quota?.customWindows).toHaveLength(2);
    calls = [];
    globalThis.fetch = recordingFetch(() => new Response(null, { status }));
    // Unlike 401/403, neither status is terminal: the row is kept, so the dashboard keeps
    // showing the last measured budgets instead of blanking them on a rate-limit response.
    const after = await fetchProviderQuotaReports(config, true);
    expect(after.reports[0]?.quota).toBe(first.quota);
    expect(after.reports[0]?.quota.customWindows?.map(window => window.percent)).toEqual([12.5, 2]);
    const row = (await fetchProviderApiKeyQuotas(config, "mistral", true))[0];
    expect(row?.unavailable).toBe(true);
    expect(row?.quota?.customWindows).toHaveLength(2);
  });
});

describe("Mistral display-only authority", () => {
  test("the probe publishes no routing evidence", async () => {
    const report = (await fetchProviderQuotaReports(config, true)).reports[0]!;
    expect(routingEvidence.get(report)).toBeUndefined();
    const direct = publishKeyReportForTests("mistral", "mistral:budget", { customWindows: [{ label: "API budget", percent: 10 }], updatedAt: Date.now() }, provider, "test-mistral-key");
    expect(direct.routing).toBeUndefined();
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

  test.each([[100, 0], [0, 100], [undefined, 100]] as const)("passive quota pool excludes Mistral display budgets (API %s, Vibe %s)", async (api, vibe) => {
    const deepseek = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-deepseek-key" } as const;
    const openrouter = { adapter: "openai-chat", authMode: "key", baseUrl: "https://openrouter.ai/api/v1", apiKey: "test-openrouter-key" } as const;
    const cfg = { ...config, providers: { mistral: provider, deepseek, openrouter } } as OcxConfig;
    const resetAt = "2099-12-01T00:00:00Z";
    globalThis.fetch = (async input => {
      const url = String(input);
      if (new URL(url).hostname === "api.deepseek.com") return Response.json({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "10", granted_balance: "0", topped_up_balance: "10" }] });
      if (new URL(url).hostname === "openrouter.ai") return Response.json({ data: { limit: 20, limit_remaining: 15 } });
      if (url.endsWith("/subscription")) return Response.json(subscription);
      return Response.json({
        api_budget: { ...budget.api_budget, usage_percentage: api, initial_budget: api === undefined ? 0 : 20, reset_at: resetAt },
        vibe_budget: { ...budget.vibe_budget, usage_percentage: vibe, reset_at: resetAt },
      });
    }) as typeof fetch;
    const reports = await fetchProviderQuotaReports(cfg, true);
    const mistral = reports.reports.find(row => row.provider === "mistral")!;
    expect(mistral.quota.customWindows?.find(row => row.label === "Vibe budget")?.percent).toBe(vibe);
    if (api === undefined) expect(mistral.quota.unknownBudgetWindows?.[0]?.label).toBe("API budget (EDU)");
    else expect(mistral.quota.customWindows?.find(row => row.label === "API budget")?.percent).toBe(api);
    expect(providerWindowObservations(mistral.quota).some(row => row.window === "custom:Vibe budget")).toBe(true);
    ensureQuotaPoolIdentity();
    let passiveFetches = 0;
    globalThis.fetch = (async () => { passiveFetches++; throw new Error("unexpected passive network request"); }) as typeof fetch;
    const result = await readQuotaPool(cfg);
    expect(passiveFetches).toBe(0);
    if (!result.ok) throw new Error(result.error);
    expect(QuotaPoolSchema.parse(result.pool)).toEqual(result.pool);
    expect(result.pool.providers.find(row => row.provider === "mistral")?.pooled).toEqual({ windows: [] });
    // Other providers keep their own pool evidence untouched, including DeepSeek's balance row.
    expect(result.pool.providers.find(row => row.provider === "deepseek")?.pooled.windows.map(row => row.id)).toEqual(["custom:API balance ($10.00)"]);
    expect(result.pool.providers.find(row => row.provider === "openrouter")?.pooled.windows.length).toBeGreaterThan(0);
  });
});

describe("Mistral unknown-budget window selection", () => {
  test("keeps only recognized budgets with a positive, finite reset clock", () => {
    expect(mistralUnknownBudgetWindows({ unknownBudgetWindows: [
      { label: "API budget", resetAt: 1_800_000_000 },
      { label: "Vibe budget (TEAM)", resetAt: 1_800_000_100 },
      { label: "Vibe budget (ENTERPRISE)", resetAt: 1_800_000_200 },
      { label: "API budget", resetAt: 0 },
      { label: "API budget", resetAt: Number.POSITIVE_INFINITY },
      { label: "API budget" },
      { label: "Other budget", resetAt: 1_800_000_300 },
    ] })).toEqual([
      { window: "custom:API budget", resetAt: 1_800_000_000 },
      { window: "custom:Vibe budget", resetAt: 1_800_000_100 },
    ]);
    expect(mistralUnknownBudgetWindows({})).toEqual([]);
  });
});
