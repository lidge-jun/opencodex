import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, selectProactiveApiKey } from "../../src/providers/key-failover";
import { fetchProviderApiKeyQuotas } from "../../src/providers/quota";
import { cachedApiKeyQuota, clearProviderApiKeyQuotaCache } from "../../src/providers/quota-key-accounts";
import { ACCOUNT_QUOTA_TTL_MS } from "../../src/providers/quota-wire";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-key-quota-scope-"));
  process.env.OPENCODEX_HOME = home;
  clearProviderApiKeyQuotaCache();
  clearKeyCooldowns();
  forgetApiKeyRotationCursor();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  clearProviderApiKeyQuotaCache();
  clearKeyCooldowns();
  forgetApiKeyRotationCursor();
  removeTreeWithRetry(home);
});

function config(name: string, baseUrl: string, strategy: "quota" | "fill-first" | "round-robin" = "quota"): OcxConfig {
  const value: OcxConfig = { port: 0, defaultProvider: name, providers: { [name]: {
    adapter: "openai-chat", authMode: "key", baseUrl, apiKey: "fixture-not-in-pool",
    apiKeyPoolStrategy: strategy,
    apiKeyPool: [{ id: "a", key: "fixture-key-a" }, { id: "b", key: "fixture-key-b" }],
  } } };
  saveConfig(value);
  return value;
}

test("Synthetic key selection ranks inference while retaining search in display", async () => {
  const value = config("synthetic", "https://api.synthetic.new/openai/v1");
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const key = new Headers(init?.headers).get("authorization");
    return Response.json({ data: key === "Bearer fixture-key-a"
      ? { rollingFiveHourLimit: 10, search: { hourly: 100 } }
      : { rollingFiveHourLimit: 80, search: { hourly: 0 } } });
  }) as typeof fetch;
  const rows = await fetchProviderApiKeyQuotas(value, "synthetic", true);
  expect(rows[0]?.quota?.customWindows).toEqual([{ label: "Search hourly", percent: 100 }]);
  expect(rows[1]?.quota?.customWindows).toEqual([{ label: "Search hourly", percent: 0 }]);
  expect(selectProactiveApiKey(value, "synthetic")?.apiKey).toBe("fixture-key-a");
  expect(calls).toBe(2);
});

test("search-only Synthetic rows are unknown while inferred exhaustion remains measured", async () => {
  const value = config("synthetic", "https://api.synthetic.new/openai/v1");
  globalThis.fetch = (async (_url, init) => Response.json({ data:
    new Headers(init?.headers).get("authorization") === "Bearer fixture-key-a"
      ? { rollingFiveHourLimit: 100, search: { hourly: 0 } }
      : { search: { hourly: 100 } },
  })) as typeof fetch;
  const rows = await fetchProviderApiKeyQuotas(value, "synthetic", true);
  expect(rows[1]?.quota?.customWindows?.[0]?.percent).toBe(100);
  expect(cachedApiKeyQuota("synthetic", value.providers.synthetic!, "b", "fixture-key-b")).toBeNull();
  expect(selectProactiveApiKey(value, "synthetic")?.apiKey).toBe("fixture-key-b");
});

test("Mistral display-only budgets do not rank keys", async () => {
  const value = config("mistral", "https://api.mistral.ai/v1");
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/subscription")) return Response.json({ plan_name: "TEAM" });
    const a = new Headers(init?.headers).get("authorization") === "Bearer fixture-key-a";
    return Response.json({ api_budget: { initial_budget: 10, currency: "USD", usage_percentage: a ? 100 : 10 } });
  }) as typeof fetch;
  const rows = await fetchProviderApiKeyQuotas(value, "mistral", true);
  expect(rows[0]?.quota?.customWindows?.[0]?.percent).toBe(100);
  expect(cachedApiKeyQuota("mistral", value.providers.mistral!, "a", "fixture-key-a")).toBeNull();
  expect(selectProactiveApiKey(value, "mistral")?.apiKey).toBe("fixture-key-a");
});

test("OpenRouter key caps rank independently and remain bound to identity and authentication", async () => {
  const value = config("openrouter", "https://openrouter.ai/api/v1");
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const a = new Headers(init?.headers).get("authorization") === "Bearer fixture-key-a";
    return Response.json({ data: { limit: 10, limit_remaining: a ? 1 : 9 } });
  }) as typeof fetch;
  const rows = await fetchProviderApiKeyQuotas(value, "openrouter", true);
  const provider = value.providers.openrouter!;
  expect(rows.map(row => row.quota?.customWindows?.[0]?.percent)).toEqual([90, 10]);
  expect(cachedApiKeyQuota("openrouter", provider, "a", "fixture-key-a")?.customWindows?.[0]?.percent).toBe(90);
  expect(cachedApiKeyQuota("openrouter", provider, "b", "fixture-key-a")).toBeNull();
  expect(cachedApiKeyQuota("openrouter", { ...provider, baseUrl: "https://example.test" }, "a", "fixture-key-a")).toBeNull();
  expect(cachedApiKeyQuota("openrouter", { ...provider, headers: { Authorization: "Bearer other" } }, "a", "fixture-key-a")).toBeNull();
  expect(cachedApiKeyQuota("openrouter", { ...provider, authMode: "oauth" }, "a", "fixture-key-a")).toBeNull();
  expect(selectProactiveApiKey(value, "openrouter")?.apiKey).toBe("fixture-key-b");
  expect(calls).toBe(2);
});

test("failed refresh retains display last-good but drops selection evidence; successful evidence expires", async () => {
  const value = config("synthetic", "https://api.synthetic.new/openai/v1");
  let fail = false;
  globalThis.fetch = (async () => fail ? new Response("unavailable", { status: 503 })
    : Response.json({ data: { rollingFiveHourLimit: 10, search: { hourly: 100 } } })) as typeof fetch;
  await fetchProviderApiKeyQuotas(value, "synthetic", true);
  const provider = value.providers.synthetic!;
  expect(cachedApiKeyQuota("synthetic", provider, "a", "fixture-key-a")?.fiveHourPercent).toBe(10);
  const now = Date.now;
  Date.now = () => now() + ACCOUNT_QUOTA_TTL_MS + 1;
  try { expect(cachedApiKeyQuota("synthetic", provider, "a", "fixture-key-a")).toBeNull(); }
  finally { Date.now = now; }
  fail = true;
  const rows = await fetchProviderApiKeyQuotas(value, "synthetic", true);
  expect(rows[0]?.unavailable).toBe(true);
  expect(rows[0]?.quota?.customWindows?.[0]?.percent).toBe(100);
  expect(cachedApiKeyQuota("synthetic", provider, "a", "fixture-key-a")).toBeNull();
});

test.each(["fill-first", "round-robin"] as const)("%s keeps its own ordering", async strategy => {
  const value = config("synthetic", "https://api.synthetic.new/openai/v1", strategy);
  globalThis.fetch = (async (_url, init) => Response.json({ data: {
    rollingFiveHourLimit: new Headers(init?.headers).get("authorization") === "Bearer fixture-key-a" ? 100 : 10,
  } })) as typeof fetch;
  await fetchProviderApiKeyQuotas(value, "synthetic", true);
  expect(selectProactiveApiKey(value, "synthetic")?.apiKey).toBe("fixture-key-a");
});
