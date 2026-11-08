import { describe, expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types/config";
import { providerObservationAccountKeyForTests } from "../../src/providers/quota";
import { clearProviderQuotaCache, clearProviderQuotaCacheFor, fetchProviderQuotaReports, flushProviderQuotaObservationsForTests, setProviderQuotaBeforePublishForTests } from "../../src/providers/quota";
import { setProviderQuotaBeforeObservationForTests } from "../../src/providers/quota/report-cache";
import { reconcileLiveStateStores, setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import { observeQuotaSnapshot, setQuotaResetSink } from "../../src/quota/reset-observer";
import { apiKeyPoolEntryId } from "../../src/providers/api-keys";
import { flushQuotaResetStoreForTests, resetQuotaResetStoreForTests } from "../../src/quota/reset-seen-store";
import type { QuotaResetEvent } from "../../src/quota/reset-detector";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test.each(["currency", "usage_percentage", "initial_budget"] as const)("Mistral retains a reset baseline while %s is temporarily unknown", async missing => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-mistral-unknown-reset-"));
  process.env.OPENCODEX_HOME = home;
  const cfg = { defaultProvider: "mistral", providers: { mistral: {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "fixture-mistral-key",
  } } } as OcxConfig;
  const events: QuotaResetEvent[] = [];
  const oldReset = Date.now() - 60_000;
  let api: Record<string, unknown> = { initial_budget: 100, currency: "EUR", usage_percentage: 95, reset_at: oldReset };
  let plan = "TEAM";
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? { plan_name: plan } : {
    api_budget: api, vibe_budget: { initial_budget: 10, currency: "EUR", usage_percentage: 20, reset_at: Date.now() + 3_600_000 },
  })) as typeof fetch;
  clearProviderQuotaCache(); resetQuotaResetStoreForTests(); setQuotaResetSink(event => events.push(event));
  const probe = async () => { await fetchProviderQuotaReports(cfg, true); await flushProviderQuotaObservationsForTests(); };
  try {
    await probe();
    api = { ...api, [missing]: null }; plan = "EDU";
    await probe();
    expect(events).toEqual([]);
    api = { initial_budget: 100, currency: "EUR", usage_percentage: 2, reset_at: Date.now() + 7_200_000 };
    await probe();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "scheduled", scope: "mistral", window: "custom:API budget", percentBefore: 95, percentAfter: 2 });
    await probe();
    expect(events).toHaveLength(1);
  } finally {
    setQuotaResetSink(null); clearProviderQuotaCache(); resetQuotaResetStoreForTests(); globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

test("Mistral retains a Vibe baseline through an unknown-only snapshot and restart", async () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-mistral-vibe-reset-"));
  process.env.OPENCODEX_HOME = home;
  const cfg = { defaultProvider: "mistral", providers: { mistral: {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "fixture-mistral-key",
  } } } as OcxConfig;
  const events: QuotaResetEvent[] = [];
  const oldReset = Date.now() - 60_000;
  let vibe: Record<string, unknown> = { initial_budget: 100, currency: "EUR", usage_percentage: 95, reset_at: oldReset };
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? { plan_name: "TEAM" } : { vibe_budget: vibe })) as typeof fetch;
  clearProviderQuotaCache(); resetQuotaResetStoreForTests(); setQuotaResetSink(event => events.push(event));
  const probe = async () => { await fetchProviderQuotaReports(cfg, true); await flushProviderQuotaObservationsForTests(); };
  try {
    await probe();
    vibe = { ...vibe, currency: null };
    await probe();
    expect(events).toEqual([]);
    flushQuotaResetStoreForTests(); resetQuotaResetStoreForTests();
    vibe = { initial_budget: 100, currency: "EUR", usage_percentage: 2, reset_at: Date.now() + 7_200_000 };
    await probe();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "scheduled", window: "custom:Vibe budget", percentBefore: 95, percentAfter: 2 });
  } finally {
    setQuotaResetSink(null); clearProviderQuotaCache(); resetQuotaResetStoreForTests(); globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

test.each(["changed-clock", "missing-clock", "new-key"] as const)("Mistral unknown-only snapshots do not reuse a baseline after %s", async change => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-mistral-unknown-fence-"));
  process.env.OPENCODEX_HOME = home;
  const cfg = { defaultProvider: "mistral", providers: { mistral: {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "fixture-mistral-key",
  } } } as OcxConfig;
  const events: QuotaResetEvent[] = [];
  const oldReset = Date.now() - 60_000;
  let api: Record<string, unknown> = { initial_budget: 100, currency: "EUR", usage_percentage: 95, reset_at: oldReset };
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? { plan_name: "TEAM" } : { api_budget: api })) as typeof fetch;
  clearProviderQuotaCache(); resetQuotaResetStoreForTests(); setQuotaResetSink(event => events.push(event));
  const probe = async () => { await fetchProviderQuotaReports(cfg, true); await flushProviderQuotaObservationsForTests(); };
  try {
    await probe();
    api = { ...api, currency: null, reset_at: change === "changed-clock" ? oldReset + 1000 : change === "missing-clock" ? null : oldReset };
    if (change === "new-key") cfg.providers.mistral!.apiKey = "fixture-replacement-key";
    await probe();
    api = { initial_budget: 100, currency: "EUR", usage_percentage: 2, reset_at: Date.now() + 7_200_000 };
    await probe();
    expect(events).toEqual([]);
  } finally {
    setQuotaResetSink(null); clearProviderQuotaCache(); resetQuotaResetStoreForTests(); globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

test.each(["same-key", "colliding-key", "keychain-replacement"] as const)("legacy key reset baseline is not transferred without proof (%s)", async change => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-legacy-reset-identity-"));
  process.env.OPENCODEX_HOME = home;
  const first = "fixture-collision-76466", second = "fixture-collision-176773";
  expect(apiKeyPoolEntryId(first)).toBe(apiKeyPoolEntryId(second));
  const configuredKey = change === "keychain-replacement" ? "keychain:mistral" : change === "same-key" ? first : second;
  const cfg = { defaultProvider: "mistral", providers: { mistral: {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: configuredKey,
  } } } as OcxConfig;
  const events: QuotaResetEvent[] = [];
  const oldReset = Date.now() - 60_000;
  clearProviderQuotaCache(); resetQuotaResetStoreForTests(); setQuotaResetSink(event => events.push(event));
  try {
    const legacyKey = change === "keychain-replacement" ? configuredKey : first;
    observeQuotaSnapshot({ scope: "mistral", accountKey: `mistral\0key:${apiKeyPoolEntryId(legacyKey)}`,
      windows: [{ window: "custom:API budget", percent: 95, resetAt: oldReset }] });
    flushQuotaResetStoreForTests(); resetQuotaResetStoreForTests();
    if (change === "keychain-replacement") setProviderKeychainEntryFactoryForTests(() => ({
      getPassword: () => second, setPassword: () => {}, deletePassword: () => true,
    }));
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? { plan_name: "TEAM" } : {
      api_budget: { initial_budget: 100, currency: "EUR", usage_percentage: 2, reset_at: Date.now() + 3_600_000 },
    })) as typeof fetch;
    await fetchProviderQuotaReports(cfg, true);
    await flushProviderQuotaObservationsForTests();
    expect(events).toEqual([]);
  } finally {
    setProviderKeychainEntryFactoryForTests(null); setQuotaResetSink(null); clearProviderQuotaCache();
    resetQuotaResetStoreForTests(); globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

test.each(["disabled", "removed", "key", "provider-clear", "global-clear", "other-clear", "detached-disable"] as const)("a deferred key quota reset respects %s", async change => {
  const originalFetch = globalThis.fetch;
  const provider = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "fixture-reset-key" } as const;
  const cfg = { defaultProvider: "mistral", providers: { mistral: { ...provider } } } as OcxConfig;
  const live = structuredClone(cfg);
  if (change === "detached-disable") setLiveStateStoreConfig(live);
  const events: QuotaResetEvent[] = [];
  let percent = 95, resetAt = Date.now() - 30_000;
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? { plan_name: "TEAM" } : {
    api_budget: { initial_budget: 100, currency: "EUR", usage_percentage: percent, reset_at: resetAt },
  })) as typeof fetch;
  clearProviderQuotaCache(); resetQuotaResetStoreForTests(); setQuotaResetSink(event => events.push(event));
  try {
    expect((await fetchProviderQuotaReports(cfg, true)).reports).toHaveLength(1);
    await flushProviderQuotaObservationsForTests();
    percent = 2; resetAt = Date.now() + 3_600_000;
    setProviderQuotaBeforeObservationForTests(() => {
      setProviderQuotaBeforeObservationForTests(null);
      if (change === "disabled") cfg.providers.mistral!.disabled = true;
      if (change === "removed") delete cfg.providers.mistral;
      if (change === "key") cfg.providers.mistral!.apiKey = "fixture-replacement-key";
      if (change === "provider-clear") clearProviderQuotaCacheFor("mistral");
      if (change === "global-clear") clearProviderQuotaCache();
      if (change === "other-clear") clearProviderQuotaCacheFor("other-provider");
      if (change === "detached-disable") { live.providers.mistral!.disabled = true; reconcileLiveStateStores(); }
    });
    expect((await fetchProviderQuotaReports(cfg, true)).reports).toHaveLength(1);
    await flushProviderQuotaObservationsForTests();
    expect(events).toHaveLength(change === "other-clear" ? 1 : 0);
  } finally {
    setProviderQuotaBeforeObservationForTests(null); setQuotaResetSink(null); resetQuotaResetStoreForTests();
    globalThis.fetch = originalFetch; clearProviderQuotaCache();
  }
});

describe("provider observation account key", () => {
  function configWithKey(apiKey: string): OcxConfig {
    return {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com/v1",
          authMode: "key",
          apiKey,
        },
      },
    } as OcxConfig;
  }

  test("two different API keys for one provider do not share an observation identity", () => {
    // A key-auth provider has NO account set, so `activeAccountId ?? "default"` collapsed every
    // key in the pool onto one identity: rotating from a spent key to a fresh one inherited the
    // spent key's usage history and read as a reset (measured 97% -> 12% fired a false
    // surprise). The report cache already discriminates these via apiKeyPoolEntryId.
    const spent = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-spent-key-aaa"));
    const fresh = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-fresh-key-bbb"));

    expect(spent).not.toBe(fresh);
    // Neither may be the bare provider name, which is what collapsed them.
    expect(spent).not.toBe("deepseek");
  });

  test("the same key resolves to the same identity across calls", () => {
    // Stability is what makes the persisted baseline usable at all.
    const first = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-stable-key"));
    const second = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-stable-key"));
    expect(first).toBe(second);
  });

  test("a provider with no key at all still yields a usable identity", () => {
    const config = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "ollama",
      providers: { ollama: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" } },
    } as OcxConfig;
    expect(providerObservationAccountKeyForTests("ollama", config)).toContain("ollama");
  });
});

test("keychain replacement keeps Mistral reset baselines bound to the probed credential", async () => {
  const originalFetch = globalThis.fetch;
  const events: QuotaResetEvent[] = [];
  const firstKey = "synthetic-reset-key-one";
  const secondKey = "synthetic-reset-key-two";
  let key = firstKey;
  let percent = 97;
  let resetAt = Date.now() - 60_000;
  const seenKeys: string[] = [];
  const config = {
    defaultProvider: "mistral",
    providers: { mistral: { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "keychain:mistral" } },
  } as OcxConfig;
  const installKeychain = () => setProviderKeychainEntryFactoryForTests(() => ({
    getPassword: () => key, setPassword: () => {}, deletePassword: () => true,
  }));
  installKeychain();
  resetQuotaResetStoreForTests();
  clearProviderQuotaCache();
  setQuotaResetSink(event => events.push(event));
  globalThis.fetch = (async (input, init) => {
    seenKeys.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json(String(input).endsWith("/subscription") ? { plan_name: "TEAM" } : {
      api_budget: { initial_budget: 100, currency: "EUR", usage_percentage: percent, reset_at: resetAt },
    });
  }) as typeof fetch;
  const probe = async () => {
    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(key);
    await flushProviderQuotaObservationsForTests();
  };
  try {
    await probe();
    key = secondKey;
    installKeychain(); // Mirrors invalidation after replacing the item under the same reference.
    percent = 12;
    resetAt = Date.now() + 3_600_000;
    await probe();
    expect(events).toEqual([]);
    percent = 96;
    resetAt = Date.now() - 60_000;
    await probe();
    percent = 2;
    resetAt = Date.now() + 7_200_000;
    await probe();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "scheduled", scope: "mistral", window: "custom:API budget", percentBefore: 96, percentAfter: 2 });
    expect(seenKeys).toEqual([firstKey, firstKey, secondKey, secondKey, secondKey, secondKey, secondKey, secondKey].map(value => `Bearer ${value}`));

    // Invalidation and credential changes while a probe is in flight cannot publish its reset.
    percent = 95;
    resetAt = Date.now() - 30_000;
    await probe();
    percent = 3;
    resetAt = Date.now() + 14_400_000;
    setProviderQuotaBeforePublishForTests(() => {
      setProviderQuotaBeforePublishForTests(null);
      key = firstKey;
      installKeychain();
    });
    const stale = await fetchProviderQuotaReports(config, true);
    expect(stale.reports).toEqual([]);
    await flushProviderQuotaObservationsForTests();
    expect(events).toHaveLength(1);
    key = secondKey;
    installKeychain();
    setProviderQuotaBeforePublishForTests(() => {
      setProviderQuotaBeforePublishForTests(null);
      clearProviderQuotaCacheFor("mistral");
    });
    const invalidated = await fetchProviderQuotaReports(config, true);
    expect(invalidated.reports).toEqual([]);
    await flushProviderQuotaObservationsForTests();
    expect(events).toHaveLength(1);
    await probe();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: "scheduled", percentBefore: 95, percentAfter: 3 });
    flushQuotaResetStoreForTests();
    const state = readFileSync(join(process.env.OPENCODEX_HOME!, "quota-reset-state.json"), "utf8");
    expect(state).not.toContain(firstKey);
    expect(state).not.toContain(secondKey);
  } finally {
    globalThis.fetch = originalFetch;
    setProviderQuotaBeforePublishForTests(null);
    setQuotaResetSink(null);
    clearProviderQuotaCache();
    setProviderKeychainEntryFactoryForTests(null);
    resetQuotaResetStoreForTests();
  }
});

test("a credential changed and restored during collection cannot publish a mismatched report", async () => {
  const originalFetch = globalThis.fetch;
  const events: QuotaResetEvent[] = [];
  const a = "synthetic-race-key-a";
  const b = "synthetic-race-key-b";
  let key = a;
  let race = false;
  let percent = 95;
  let resetAt = Date.now() - 60_000;
  const mistral = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "keychain:mistral" } as const;
  const config = { defaultProvider: "mistral", providers: { mistral } } as OcxConfig;
  const multi = { ...config, providers: {
    deepseek: { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.deepseek.com/v1", apiKey: "synthetic-other-key" },
    mistral,
  } } as OcxConfig;
  const installKeychain = () => setProviderKeychainEntryFactoryForTests(() => ({
    getPassword: () => key, setPassword: () => {}, deletePassword: () => true,
  }));
  installKeychain();
  resetQuotaResetStoreForTests();
  clearProviderQuotaCache();
  setQuotaResetSink(event => events.push(event));
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("deepseek.com")) {
      key = b;
      installKeychain();
      return Response.json({ balance_infos: [{ currency: "USD", total_balance: 10 }] });
    }
    if (race) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${b}`);
      key = a;
      installKeychain();
    }
    return Response.json(String(input).endsWith("/subscription") ? { plan_name: "TEAM" } : {
      api_budget: { initial_budget: 100, currency: "EUR", usage_percentage: percent, reset_at: resetAt },
    });
  }) as typeof fetch;
  try {
    expect((await fetchProviderQuotaReports(config, true)).reports).toHaveLength(1);
    await flushProviderQuotaObservationsForTests();
    percent = 2;
    resetAt = Date.now() + 3_600_000;
    race = true;
    const mismatched = await fetchProviderQuotaReports(multi, true);
    await flushProviderQuotaObservationsForTests();
    expect(mismatched.reports.some(row => row.provider === "mistral")).toBe(false);
    expect(events).toEqual([]);
    race = false;
    expect((await fetchProviderQuotaReports(config, true)).reports).toHaveLength(1);
    await flushProviderQuotaObservationsForTests();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "scheduled", percentBefore: 95, percentAfter: 2 });
  } finally {
    globalThis.fetch = originalFetch;
    setQuotaResetSink(null);
    clearProviderQuotaCache();
    setProviderKeychainEntryFactoryForTests(null);
    resetQuotaResetStoreForTests();
  }
});

test.each(["removed", "oauth", "forward", "local", "destination", "adapter", "disabled"] as const)("a key-probe report is not published when the provider becomes %s", async change => {
  const originalFetch = globalThis.fetch;
  const config = { defaultProvider: "mistral", providers: { mistral: {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "synthetic-swap-key",
  } } } as OcxConfig;
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? { plan_name: "TEAM" } : {
    api_budget: { initial_budget: 100, currency: "EUR", usage_percentage: 20 },
  })) as typeof fetch;
  try {
    clearProviderQuotaCache();
    setProviderQuotaBeforePublishForTests(() => {
      if (change === "removed") delete config.providers.mistral;
      else if (change === "destination") config.providers.mistral!.baseUrl = "https://other.example/v1";
      else if (change === "adapter") config.providers.mistral!.adapter = "anthropic";
      else if (change === "disabled") config.providers.mistral!.disabled = true;
      else config.providers.mistral!.authMode = change;
    });
    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    setProviderQuotaBeforePublishForTests(null);
    clearProviderQuotaCache();
  }
});
