/**
 * Producer side of GOAT's `ocx.quota-pool/1` (`GET /api/quota-pool`): the assembled shape against
 * a local mirror of the contract, absent-not-zero, the window-kind mapping through the existing
 * Codex header parser, the pooled estimate computed from held account rows, and the opaque, stable
 * `accountRef`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import type { StoredAccountQuota } from "../../src/codex/quota-types";
import { codexQuotaWindows, providerQuotaWindows, readQuotaPool } from "../../src/quota-pool/assemble";
import { pooledWindows, type PooledAccountInput } from "../../src/quota-pool/pooled";
import { aggregateCodexPoolCapacity, codexCapacityWeight } from "../../src/providers/codex-capacity";
import {
  ensureQuotaPoolIdentity,
  quotaPoolIdentityPath,
  readQuotaPoolIdentity,
  resetQuotaPoolIdentityMemoForTests,
  setQuotaPoolIdentityHooksForTests,
} from "../../src/quota-pool/identity";
import { parseUpstreamQuotaHeaders } from "../../src/codex/quota";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { clearAccountQuotaCache, fetchProviderQuotaReports, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { bindProviderReportProbe, getProviderQuotaReportCache, keyReport, report, setProviderQuotaReportCache } from "../../src/providers/quota/report-cache";
import { resolveProviderApiKey, setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import { clearCachedProviderQuotas, getCachedProviderQuota, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import { registerDecisionQuotaSink, type DecisionQuotaSink } from "../../src/lib/decision-quota-sink";
import { runPassiveRead } from "../../src/lib/passive-read";
import { markDisplayOnlyQuota } from "../../src/providers/quota-types";
import { isDisplayOnlyQuota } from "../../src/providers/quota-types";
import { getCachedProviderAccountQuota, normalizeAnthropicQuota } from "../../src/providers/quota/account-cache";
import { accountHeadroomPercent } from "../../src/oauth/account-quota-rank";
import { kiroAccountEvidence } from "../../src/providers/kiro-usage";
import { nullPaths, QuotaPoolSchema } from "../helpers/quota-pool-schema";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { COLD_SPAWN_WARMUP_HOOK_BUDGET_MS, warmModuleGraph } from "../helpers/cold-spawn-warmup";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;
const ACCOUNT_EMAIL = "pool-person@example.test";
let home = "";
let priorHome: string | undefined;
let admissionPath = "";
let xaiIds: string[] = [];
const IDENTITY_RACE_SCRIPT = `const { ensureQuotaPoolIdentity } = await import(${JSON.stringify(join(import.meta.dir, "../../src/quota-pool/identity.ts"))});
await Bun.sleep(Math.max(0, Number(process.env.QP_START_AT) - Date.now()));
console.log(ensureQuotaPoolIdentity().homeId);`;
beforeAll(async () => {
  await warmModuleGraph({ graph: "quota-pool/identity-race", source: IDENTITY_RACE_SCRIPT });
}, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);

function config(): OcxConfig {
  return {
    port: 0, defaultProvider: "quiet",
    providers: {
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
      "claude-cli": { adapter: "claude-cli", baseUrl: "http://127.0.0.1:9" },
      openrouter: { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", apiKey: "fixture-openrouter-key" },
      quiet: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1" },
    },
  } as OcxConfig;
}

beforeEach(async () => {
  priorHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-quota-pool-"));
  process.env.OPENCODEX_HOME = home;
  resetQuotaPoolIdentityMemoForTests();
  for (const slot of ["a", "b"]) {
    await saveCredential("xai", {
      access: `synthetic-access-${slot}`, refresh: `synthetic-refresh-${slot}`, expires: Date.now() + HOUR,
      accountId: `xai-raw-account-${slot}`, email: ACCOUNT_EMAIL,
    } as never);
  }
  xaiIds = getAccountSet("xai")!.accounts.map(row => row.id);
  // Account a: a weekly reading only. Account b: nothing observed yet.
  setCachedProviderAccountQuotaForTests("xai", xaiIds[0]!, { weeklyPercent: 42, weeklyResetAt: NOW + 48 * HOUR, updatedAt: NOW - 60_000 });
  admissionPath = join(home, "claude-usage-admission.json");
  writeFileSync(admissionPath, JSON.stringify({
    identity: "c".repeat(64), checkedAt: NOW - 30_000,
    quota: {
      fiveHourPercent: 100, fiveHourResetAt: NOW + HOUR, weeklyPercent: 61, weeklyResetAt: NOW + 72 * HOUR, updatedAt: NOW - 30_000,
      customWindows: [{ label: "Opus", percent: 100, resetAt: NOW + 72 * HOUR, scope: "model" }],
    },
  }));
  const openrouter = config().providers.openrouter!;
  const held = keyReport("openrouter", "fixture", { creditsUsd: { used: 7.5, limit: 10, remaining: 2.5, percent: 75 }, updatedAt: NOW - 120_000 }, openrouter, "fixture-openrouter-key")!;
  setProviderQuotaReportCache({ key: "fixture", ts: NOW, response: { generatedAt: NOW, reports: [held] } });
});

afterEach(() => {
  setQuotaPoolIdentityHooksForTests();
  setProviderQuotaReportCache(null);
  clearAccountQuotaCache("xai");
  resetQuotaPoolIdentityMemoForTests();
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(home);
});

const read = () => readQuotaPool(config(), { now: () => NOW, claudeUsageStatePath: admissionPath });

for (const reader of ["provider", "pool"] as const) {
  test(`${reader} passive read checks held key ownership without side effects`, async () => {
    ensureQuotaPoolIdentity();
    const key = "fixture-original-key";
    const base = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: key } as const;
    const names = ["changed", "envchanged", "missing", "local", "oauth", "forward", "removed", "destination", "adapter", "disabled", "keychain", "coldkeychain", "unchanged", "envsame"];
    const providers: OcxConfig["providers"] = Object.fromEntries(names.map(name => [name, { ...base }]));
    providers.envchanged!.apiKey = "${OCX_TEST_PASSIVE_KEY}";
    providers.envsame!.apiKey = "${OCX_TEST_PASSIVE_SAME}";
    providers.keychain!.apiKey = "keychain:keychain";
    providers.coldkeychain!.apiKey = "keychain:coldkeychain";
    process.env.OCX_TEST_PASSIVE_KEY = key;
    process.env.OCX_TEST_PASSIVE_SAME = key;
    let keychainReads = 0;
    setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { keychainReads++; return key; }, setPassword: () => {}, deletePassword: () => true }));
    expect(resolveProviderApiKey(providers.keychain!.apiKey)).toBe(key);
    const quota = { weeklyPercent: 42, updatedAt: NOW };
    const reports = names.map(name => keyReport(name, "fixture", quota, providers[name]!, key, quota)!);
    setProviderQuotaReportCache({ key: "fixture", ts: NOW, response: { generatedAt: NOW, reports } });
    const held = getProviderQuotaReportCache();
    providers.changed!.apiKey = "fixture-replacement-key";
    delete providers.missing!.apiKey;
    process.env.OCX_TEST_PASSIVE_KEY = "fixture-replacement-key";
    providers.local!.authMode = "local";
    providers.oauth!.authMode = "oauth";
    providers.forward!.authMode = "forward";
    delete providers.removed;
    providers.destination!.baseUrl = "https://other.example.test/v1";
    providers.adapter!.adapter = "openai-responses";
    providers.disabled!.disabled = true;
    const current = { port: 0, defaultProvider: "unchanged", providers } as OcxConfig;
    const sentinel = { weeklyPercent: 19, updatedAt: NOW };
    setCachedProviderQuotaForTests("passive-sentinel", sentinel);
    let observations = 0;
    const detach = registerDecisionQuotaSink(new Proxy({} as DecisionQuotaSink, { get: () => () => { observations++; } }));
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; throw new Error("unexpected upstream call"); }) as typeof fetch;
    try {
      let found: string[];
      if (reader === "provider") {
        found = (await runPassiveRead(() => fetchProviderQuotaReports(current, true))).reports.map(row => row.provider).sort();
      } else {
        const result = await readQuotaPool(current, { now: () => NOW, claudeUsageStatePath: admissionPath });
        if (!result.ok) throw new Error(result.error);
        found = result.pool.providers.filter(row => row.pooled.windows.length > 0).map(row => row.provider).sort();
      }
      expect(found).toEqual(["envsame", "unchanged"]);
      expect(fetches).toBe(0);
      expect(keychainReads).toBe(1);
      expect(observations).toBe(0);
      expect(getCachedProviderQuota("passive-sentinel", NOW)).toEqual(sentinel);
      expect(getProviderQuotaReportCache()).toBe(held);
    } finally {
      globalThis.fetch = originalFetch;
      detach();
      clearCachedProviderQuotas();
      setProviderKeychainEntryFactoryForTests(null);
      delete process.env.OCX_TEST_PASSIVE_KEY;
      delete process.env.OCX_TEST_PASSIVE_SAME;
    }
  });
}

describe("ocx.quota-pool/1 producer", () => {
  test("uses key inference projections in the real assembled pool", async () => {
    ensureQuotaPoolIdentity();
    const providers = {
      synthetic: { adapter: "openai-chat", baseUrl: "https://api.synthetic.new/openai/v1", apiKey: "fixture-key" },
    } as OcxConfig["providers"];
    const current = { port: 0, defaultProvider: "synthetic", providers } as OcxConfig;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ data: { rollingFiveHourLimit: 10, search: { hourly: 100 } } }); }) as typeof fetch;
    try {
      const reports = await fetchProviderQuotaReports(current, true);
      expect(reports.reports[0]?.quota.customWindows?.[0]?.percent).toBe(100);
      expect(calls).toBe(1);
      const result = await readQuotaPool(current);
      if (!result.ok) throw new Error(result.error);
      expect(QuotaPoolSchema.parse(result.pool)).toEqual(result.pool);
      expect(result.pool.providers[0]?.pooled.windows.map(w => [w.id, w.usedPercent, w.exhausted])).toEqual([["5h", 10, false]]);
      expect(calls).toBe(1);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("key reports require inference evidence while OAuth reports and positive projections remain usable", async () => {
    ensureQuotaPoolIdentity();
    const base = { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture-key" } as const;
    const providers = { positive: { ...base }, absent: { ...base }, mistral: { ...base }, override: { ...base }, multiple: { ...base }, oauth: { ...base, authMode: "oauth" } } as OcxConfig["providers"];
    const current = { port: 0, defaultProvider: "positive", providers } as OcxConfig;
    const quota = { weeklyPercent: 100, updatedAt: NOW };
    const reports = [
      keyReport("positive", "fixture", quota, providers.positive!, "fixture-key", quota)!,
      keyReport("absent", "fixture", quota, providers.absent!, "fixture-key")!,
      keyReport("mistral", "fixture", markDisplayOnlyQuota({ ...quota }), providers.mistral!, "fixture-key")!,
      keyReport("override", "fixture", quota, providers.override!, "fixture-key", quota)!,
      keyReport("multiple", "fixture", quota, providers.multiple!, "fixture-key", quota)!,
      { provider: "oauth", label: "oauth", source: "oauth", quota, updatedAt: NOW },
    ];
    providers.override!.headers = { Authorization: "fixture-override" };
    providers.multiple!.apiKeyPool = [{ id: "one", key: "fixture-key" }, { id: "two", key: "fixture-key-two" }];
    setProviderQuotaReportCache({ key: "fixture", ts: NOW, response: { generatedAt: NOW, reports } });
    // No OAuth rows: an untagged account report remains usable as before.
    const result = await readQuotaPool(current, { now: () => NOW });
    if (!result.ok) throw new Error(result.error);
    expect(QuotaPoolSchema.parse(result.pool)).toEqual(result.pool);
    const byName = Object.fromEntries(result.pool.providers.map(row => [row.provider, row.pooled.windows]));
    expect(byName.positive?.map(w => [w.id, w.exhausted])).toEqual([["weekly", true]]);
    expect(byName.absent).toEqual([]);
    expect(byName.mistral).toEqual([]);
    expect(byName.override).toEqual([]);
    expect(byName.multiple).toEqual([]);
    expect(byName.oauth?.map(w => [w.id, w.exhausted])).toEqual([["weekly", true]]);
  });

  test("Mistral budget producer remains display-only in the assembled pool", async () => {
    ensureQuotaPoolIdentity();
    const current = { port: 0, defaultProvider: "mistral", providers: { mistral: { adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1", apiKey: "fixture-key" } } } as OcxConfig;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input) => {
      calls++;
      return Response.json(String(input).includes("subscription") ? { plan_name: "FREE" } : {
        api_budget: { initial_budget: 10, usage_percentage: 100, currency: "USD" },
      });
    }) as typeof fetch;
    try {
      const reports = await fetchProviderQuotaReports(current, true);
      expect(reports.reports[0]?.quota.customWindows?.[0]?.percent).toBe(100);
      expect(calls).toBe(2);
      const result = await readQuotaPool(current);
      if (!result.ok) throw new Error(result.error);
      expect(result.pool.providers[0]?.pooled.windows).toEqual([]);
      expect(calls).toBe(2);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("OpenRouter's inference-wide key cap remains in the assembled pool", async () => {
    ensureQuotaPoolIdentity();
    const current = { port: 0, defaultProvider: "openrouter", providers: { openrouter: { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", apiKey: "fixture-key" } } } as OcxConfig;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ data: { usage: 20, limit: 20, limit_remaining: 0 } }); }) as typeof fetch;
    try {
      expect((await fetchProviderQuotaReports(current, true)).reports).toHaveLength(1);
      const result = await readQuotaPool(current);
      if (!result.ok) throw new Error(result.error);
      expect(result.pool.providers[0]?.pooled.windows).toMatchObject([{ usedPercent: 100, exhausted: true }]);
      expect(calls).toBe(1);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("preserves display-only account provenance through normalization and decisions", async () => {
    ensureQuotaPoolIdentity();
    await saveCredential("anthropic", { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + HOUR, accountId: "fixture-anthropic" } as never);
    const id = getAccountSet("anthropic")!.accounts[0]!.id;
    const now = Date.now();
    const quota = markDisplayOnlyQuota({ fiveHourPercent: 100, weeklyPercent: 25, weeklyResetAt: now - HOUR, updatedAt: now });
    const normalized = normalizeAnthropicQuota(quota, now)!;
    expect(normalized).not.toBe(quota);
    expect(isDisplayOnlyQuota(normalized)).toBe(true);
    setCachedProviderAccountQuotaForTests("anthropic", id, quota);
    expect(getCachedProviderAccountQuota("anthropic", id)).toBeNull();
    expect(accountHeadroomPercent("anthropic", id)).toBeNull();
    const current = { port: 0, defaultProvider: "anthropic", providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } } } as OcxConfig;
    const result = await readQuotaPool(current);
    if (!result.ok) throw new Error(result.error);
    expect(result.pool.providers[0]?.accounts[0]?.state).toBe("unknown");
    expect(result.pool.providers[0]?.pooled.windows).toEqual([]);
    clearAccountQuotaCache("anthropic");
  });
  test("display-only account quota is unknown and cannot constrain the pool", async () => {
    ensureQuotaPoolIdentity();
    setCachedProviderAccountQuotaForTests("xai", xaiIds[0]!, markDisplayOnlyQuota({
      weeklyPercent: 100, weeklyResetAt: NOW + HOUR, updatedAt: NOW,
    }));
    expect(getCachedProviderAccountQuota("xai", xaiIds[0]!)).toBeNull();
    expect(accountHeadroomPercent("xai", xaiIds[0]!)).toBeNull();
    const result = await read();
    if (!result.ok) throw new Error(result.error);
    const xai = result.pool.providers.find(row => row.provider === "xai")!;
    expect(xai.accounts.map(account => account.state)).toEqual(["unknown", "unknown"]);
    expect(xai.accounts.every(account => account.windows.length === 0)).toBe(true);
    expect(xai.pooled).toEqual({ windows: [] });
  });

  test("Kiro's separate account evidence reader excludes display-only quota", async () => {
    await saveCredential("kiro", { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + HOUR, accountId: "fixture-kiro" } as never);
    const account = getAccountSet("kiro")!.accounts[0]!;
    setCachedProviderAccountQuotaForTests("kiro", account.id, markDisplayOnlyQuota({ monthlyPercent: 100, updatedAt: Date.now() }));
    expect(kiroAccountEvidence(account, Date.now(), { hydrate: false }).quotaPercent).toBeUndefined();
    clearAccountQuotaCache("kiro");
  });

  test("reports the identity as unavailable instead of minting one on the read path", async () => {
    expect(await read()).toEqual({ ok: false, error: "quota_pool_identity_unavailable" });
    expect(() => readFileSync(quotaPoolIdentityPath())).toThrow();
  });

  test("assembles the contract shape from held caches", async () => {
    const identity = ensureQuotaPoolIdentity();
    const result = await read();
    if (!result.ok) throw new Error(result.error);
    const pool = result.pool;
    expect(QuotaPoolSchema.parse(pool)).toEqual(pool);
    expect(nullPaths(pool)).toEqual([]);
    expect(pool.producer).toEqual({ version: expect.any(String), role: "standalone", homeId: identity.homeId });
    expect(identity.homeId).toMatch(/^home_[0-9a-f]{32}$/);

    // Shape snapshot with the opaque references and clocks normalized.
    const shape = JSON.parse(JSON.stringify(pool, (key, value) => key === "accountRef" ? "<ref>" : value));
    expect(shape).toEqual({
      schema: "ocx.quota-pool/1",
      producer: { version: expect.any(String), role: "standalone", homeId: identity.homeId },
      generatedAt: "2026-10-21T12:00:00.000Z",
      providers: [
        {
          provider: "claude-cli",
          accounts: [{
            provider: "claude-cli", accountRef: "<ref>", state: "exhausted",
            windows: [
              { id: "5h", kind: "burst_5h", label: "5-hour", usedPercent: 100, resetsAt: "2026-10-21T13:00:00.000Z",
                source: "measured", observedAt: "2026-10-21T11:59:30.000Z", exhausted: true },
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 61, resetsAt: "2026-10-24T12:00:00.000Z",
                source: "measured", observedAt: "2026-10-21T11:59:30.000Z", exhausted: false },
              { id: "family:opus", kind: "custom", label: "Opus", usedPercent: 100, scopeModel: "family:opus",
                resetsAt: "2026-10-24T12:00:00.000Z", source: "measured", observedAt: "2026-10-21T11:59:30.000Z", exhausted: true },
            ],
          }],
          // The only account is blocked by its 5-hour window: the pool is unavailable until it
          // resets, while the weekly window itself still has room.
          pooled: {
            windows: [
              { id: "5h", kind: "burst_5h", label: "5-hour", usedPercent: 100, resetsAt: "2026-10-21T13:00:00.000Z",
                source: "estimated", observedAt: "2026-10-21T11:59:30.000Z", exhausted: true },
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 61, resetsAt: "2026-10-24T12:00:00.000Z",
                source: "estimated", observedAt: "2026-10-21T11:59:30.000Z", exhausted: false },
              { id: "family:opus", kind: "custom", label: "Opus", usedPercent: 100, scopeModel: "family:opus",
                resetsAt: "2026-10-24T12:00:00.000Z", source: "estimated", observedAt: "2026-10-21T11:59:30.000Z", exhausted: true },
              { id: "availability", kind: "custom", label: "Pool availability", resetsAt: "2026-10-21T13:00:00.000Z",
                source: "estimated", observedAt: "2026-10-21T11:59:30.000Z", exhausted: true },
            ],
            nextResetAt: "2026-10-21T13:00:00.000Z",
          },
        },
        {
          provider: "openrouter",
          accounts: [],
          pooled: { windows: [{
            id: "credits:usd", kind: "credits", label: "USD credits", unit: "usd", used: 7.5, limit: 10, usedPercent: 75,
            source: "measured", observedAt: "2026-10-21T11:58:00.000Z", exhausted: false,
          }] },
        },
        {
          provider: "xai",
          accounts: [
            { provider: "xai", accountRef: "<ref>", label: expect.stringMatching(/^o[0-9a-f]{6}$/), state: "available",
              windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 42, resetsAt: "2026-10-23T12:00:00.000Z",
                source: "measured", observedAt: "2026-10-21T11:59:00.000Z", exhausted: false }] },
            // Nothing observed: unknown with no windows, never a 0% bar.
            { provider: "xai", accountRef: "<ref>", label: expect.stringMatching(/^o[0-9a-f]{6}$/), state: "unknown", windows: [] },
          ],
          // No provider report is held for xai: the pool comes from the account rows, and the
          // unobserved account is left out instead of averaged in as 0%.
          pooled: {
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 42, resetsAt: "2026-10-23T12:00:00.000Z",
              source: "estimated", observedAt: "2026-10-21T11:59:00.000Z", exhausted: false }],
            nextResetAt: "2026-10-23T12:00:00.000Z",
          },
        },
      ],
    });
  });

  test("a held report never stands in for the account rows of a tracked provider", async () => {
    ensureQuotaPoolIdentity();
    // A report claiming a newer, emptier pool than the rows it would have been computed from.
    const held = report("xai", "fixture", { weeklyPercent: 3, weeklyResetAt: NOW + 48 * HOUR, updatedAt: NOW })!;
    await bindProviderReportProbe(Promise.resolve(held), "xai", config().providers.xai!);
    setProviderQuotaReportCache({ key: "fixture", ts: NOW, response: { generatedAt: NOW, reports: [held] } });
    const result = await read();
    if (!result.ok) throw new Error(result.error);
    const xai = result.pool.providers.find(provider => provider.provider === "xai")!;
    expect(xai.pooled.windows.map(window => [window.id, window.usedPercent, window.source, window.observedAt]))
      .toEqual([["weekly", 42, "estimated", "2026-10-21T11:59:00.000Z"]]);
  });

  test("a per-account provider configured with an API key keeps its key's report as the pool", async () => {
    ensureQuotaPoolIdentity();
    const keyed = config();
    keyed.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "fixture-xai-key" };
    const held = keyReport("xai", "fixture", { weeklyPercent: 3, weeklyResetAt: NOW + 48 * HOUR, updatedAt: NOW - 120_000 }, keyed.providers.xai, "fixture-xai-key")!;
    setProviderQuotaReportCache({ key: "fixture", ts: NOW, response: { generatedAt: NOW, reports: [held] } });
    const result = await readQuotaPool(keyed, { now: () => NOW, claudeUsageStatePath: admissionPath });
    if (!result.ok) throw new Error(result.error);
    const xai = result.pool.providers.find(provider => provider.provider === "xai")!;
    expect(xai.accounts).toHaveLength(2);
    expect(xai.pooled.windows.map(window => [window.id, window.usedPercent, window.source, window.observedAt]))
      .toEqual([["weekly", 3, "measured", "2026-10-21T11:58:00.000Z"]]);
  });

  test("accountRef is opaque, stable across restarts and distinct per provider and account", async () => {
    ensureQuotaPoolIdentity();
    const first = await read();
    resetQuotaPoolIdentityMemoForTests(); // a restart re-reads the persisted secret
    const second = await read();
    if (!first.ok || !second.ok) throw new Error("identity unavailable");
    const refs = (pool: typeof first.pool) => pool.providers.flatMap(provider => provider.accounts.map(account => account.accountRef));
    expect(refs(second.pool)).toEqual(refs(first.pool));
    const all = refs(first.pool);
    expect(new Set(all).size).toBe(all.length);
    for (const ref of all) expect(ref).toMatch(/^acct_[A-Za-z0-9_-]{22}$/);
    const body = JSON.stringify(first.pool);
    for (const secret of [ACCOUNT_EMAIL, "xai-raw-account-a", "synthetic-access-a", "c".repeat(64), ...xaiIds]) {
      expect(body).not.toContain(secret);
    }
    // Removing the file rotates the install secret, and with it every reference.
    unlinkSync(quotaPoolIdentityPath());
    resetQuotaPoolIdentityMemoForTests();
    ensureQuotaPoolIdentity();
    const rotated = await read();
    if (!rotated.ok) throw new Error(rotated.error);
    expect(refs(rotated.pool).some(ref => all.includes(ref))).toBe(false);
  });
});

describe("quota-pool identity creation", () => {
  test("a symlink or malformed file at the path is refused and left untouched", () => {
    const decoy = join(home, "decoy.txt");
    writeFileSync(decoy, "unrelated");
    symlinkSync(decoy, quotaPoolIdentityPath());
    expect(() => ensureQuotaPoolIdentity()).toThrow();
    expect(readFileSync(decoy, "utf8")).toBe("unrelated");
    expect(lstatSync(quotaPoolIdentityPath()).isSymbolicLink()).toBe(true);
    unlinkSync(quotaPoolIdentityPath());
    writeFileSync(quotaPoolIdentityPath(), "{}");
    expect(() => ensureQuotaPoolIdentity()).toThrow();
    expect(readFileSync(quotaPoolIdentityPath(), "utf8")).toBe("{}");
    expect(readQuotaPoolIdentity()).toBeNull();
  });

  test("a winner published between the absence read and the existence check is adopted, not refused", () => {
    const winner = { homeId: `home_${"a".repeat(32)}`, secret: "b".repeat(64) };
    setQuotaPoolIdentityHooksForTests({
      // Another server links its complete file in exactly inside this process's check window.
      afterAbsentRead: path => writeFileSync(path, `${JSON.stringify({ version: 1, ...winner })}\n`, { mode: 0o600 }),
    });
    expect(ensureQuotaPoolIdentity()).toEqual(winner);
    expect(readFileSync(quotaPoolIdentityPath(), "utf8")).toContain(winner.homeId);
  });

  test("losing the hard-link race (EEXIST) adopts the winner's complete file", () => {
    const winner = { homeId: `home_${"c".repeat(32)}`, secret: "d".repeat(64) };
    setQuotaPoolIdentityHooksForTests({
      // The winner links its complete file first; this process's own link then reports EEXIST.
      link: (_temp, target) => {
        writeFileSync(target, `${JSON.stringify({ version: 1, ...winner })}\n`, { mode: 0o600 });
        throw Object.assign(new Error("file exists"), { code: "EEXIST" });
      },
    });
    expect(ensureQuotaPoolIdentity()).toEqual(winner);
    expect(readQuotaPoolIdentity()).toEqual(winner);
    // The loser's private temp file is cleaned up.
    expect(readdirSync(home).filter(name => name.startsWith("quota-pool-identity.json.") && name.endsWith(".tmp"))).toEqual([]);
  });

  test("an in-place create seen before its bytes land is never adopted or memoized", () => {
    const seen: { read?: unknown; concurrent?: unknown; concurrentError?: string } = {};
    let writerPaused = false;
    setQuotaPoolIdentityHooksForTests({
      // No hard links on this filesystem: publication falls back to exclusive create in place.
      link: () => { throw Object.assign(new Error("hard links unsupported"), { code: "EPERM" }); },
      publishedReadAttempts: 2,
      afterCreate: path => {
        if (path !== quotaPoolIdentityPath() || writerPaused) return;
        writerPaused = true;
        // The file exists and is still empty: a reader and a concurrent loser look now.
        seen.read = readQuotaPoolIdentity();
        try { seen.concurrent = ensureQuotaPoolIdentity(); } catch (error) { seen.concurrentError = (error as Error).message; }
      },
    });
    const identity = ensureQuotaPoolIdentity();
    expect(writerPaused).toBe(true);
    expect(seen.read).toBeNull();
    expect(seen.concurrent).toBeUndefined();
    expect(seen.concurrentError).toContain("not a valid regular file");
    expect(identity.homeId).toMatch(/^home_[0-9a-f]{32}$/);
    // Nothing invalid was memoized: a fresh read returns the writer's complete identity.
    resetQuotaPoolIdentityMemoForTests();
    expect(readQuotaPoolIdentity()).toEqual(identity);
  });

  test.each([0, 1, 2])("servers racing on a fresh home agree on one identity (round %i)", async () => {
      const dir = mkdtempSync(join(home, "race-"));
      const startAt = String(Date.now() + 400);
      const runs = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", IDENTITY_RACE_SCRIPT], {
        env: { ...process.env, OPENCODEX_HOME: dir, QP_START_AT: startAt }, stdout: "pipe", stderr: "pipe",
      }));
      // Read each child to completion (stdout, stderr and exit) so a loser that fails names its error.
      const results = await Promise.all(runs.map(async run => {
        const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
        return { id: out.trim(), code, error: err.trim() };
      }));
      resetQuotaPoolIdentityMemoForTests();
      const persisted = readQuotaPoolIdentity(dir)!.homeId;
      expect(results).toEqual(Array.from({ length: 4 }, () => ({ id: persisted, code: 0, error: "" })));
  });
});

describe("window mapping", () => {
  test("a declared short primary maps to burst_5h and the secondary to weekly, via the header parser", () => {
    const parsed = parseUpstreamQuotaHeaders(new Headers({
      "x-codex-primary-used-percent": "37", "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(Math.floor((NOW + HOUR) / 1000)),
      "x-codex-secondary-used-percent": "12", "x-codex-secondary-reset-at": String(Math.floor((NOW + 96 * HOUR) / 1000)),
    }))!;
    const windows = codexQuotaWindows({ ...parsed, updatedAt: NOW }, "header", NOW);
    expect(windows.map(window => [window.id, window.kind, window.usedPercent, window.windowSeconds, window.source])).toEqual([
      ["5h", "burst_5h", 37, 18_000, "header"],
      ["weekly", "weekly", 12, undefined, "header"],
    ]);
    expect(windows[0]!.resetsAt).toBe("2026-10-21T13:00:00.000Z");
  });

  test("a weekly-only reading yields no burst window at all", () => {
    const parsed = parseUpstreamQuotaHeaders(new Headers({ "x-codex-primary-used-percent": "5" }))!;
    const windows = codexQuotaWindows({ ...parsed, updatedAt: NOW }, "measured", NOW);
    expect(windows.map(window => window.kind)).toEqual(["weekly"]);
  });

  test("absent, negative and elapsed readings are omitted, never zero-filled", () => {
    expect(providerQuotaWindows({ updatedAt: NOW }, "measured", NOW)).toEqual([]);
    expect(codexQuotaWindows({ updatedAt: NOW }, "measured", NOW)).toEqual([]);
    expect(providerQuotaWindows({ weeklyPercent: -1, updatedAt: NOW }, "measured", NOW)).toEqual([]);
    // The reset passed, so the reading no longer describes the current window.
    expect(providerQuotaWindows({ fiveHourPercent: 90, fiveHourResetAt: NOW - 1, updatedAt: NOW - HOUR }, "measured", NOW)).toEqual([]);
    const kiro = providerQuotaWindows({ kiroCreditsUsed: 10, updatedAt: NOW }, "measured", NOW);
    expect(kiro).toEqual([{ id: "credits:kiro", kind: "credits", label: "Kiro credits", unit: "credits", used: 10,
      source: "measured", observedAt: "2026-10-21T12:00:00.000Z" }]);
  });

  test("model scope and refusal verdicts are preserved; unscoped exact-model rows are dropped", () => {
    const windows = providerQuotaWindows({
      updatedAt: NOW,
      customWindows: [
        { label: "Gemini Pro", percent: 20 },
        { label: "gemini-4-argon", percent: 20, modelId: "gemini-4-argon" },
        { label: "Sonnet", percent: 3, scope: "model", passiveObservedAt: NOW - 5_000 },
        { label: "Burst", percent: 40, rejected: true },
      ],
    }, "measured", NOW);
    expect(windows.map(window => [window.id, window.scopeModel, window.exhausted, window.source])).toEqual([
      ["custom:Gemini Pro", undefined, false, "measured"],
      ["family:sonnet", "family:sonnet", false, "header"],
      ["custom:Burst", undefined, true, "measured"],
    ]);
  });
});

describe("pooled windows", () => {
  const MINUTE = 60_000;
  const codex = (plan: string, quota: Omit<StoredAccountQuota, "updatedAt">, options: { eligible?: boolean; at?: number } = {}): PooledAccountInput => ({
    eligible: options.eligible ?? true,
    weight: codexCapacityWeight(plan),
    windows: codexQuotaWindows({ ...quota, updatedAt: options.at ?? NOW - MINUTE } as StoredAccountQuota, "measured", NOW),
  });
  const weekly = (percent: number) => ({ weeklyPercent: percent, weeklyResetAt: NOW + 72 * HOUR });
  const summary = (accounts: PooledAccountInput[]) =>
    pooledWindows(accounts, NOW).map(window => [window.id, window.usedPercent, window.exhausted]);

  test("weights the routable accounts by plan with a cold report cache: main 98 / pool 6 / paused 45 at Pro is 52", () => {
    const rows = [codex("pro", weekly(98)), codex("pro", weekly(6)), codex("pro", weekly(45), { eligible: false })];
    const [pooled] = pooledWindows(rows, NOW);
    expect(pooled).toEqual({
      id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 52, resetsAt: "2026-10-24T12:00:00.000Z",
      source: "estimated", observedAt: "2026-10-21T11:59:00.000Z", exhausted: false,
    });
    // The same estimate the dashboard's capacity aggregate reports for these accounts.
    const capacity = aggregateCodexPoolCapacity([98, 6, 45].map((percent, index) => ({
      isMain: index === 0, plan: "pro", paused: index === 2, quota: { weeklyPercent: percent, updatedAt: NOW - MINUTE },
    })), NOW);
    expect(capacity.quota?.weeklyPercent).toBe(52);
  });

  test("mixes plan weights", () => {
    expect(summary([codex("plus", weekly(90)), codex("pro", weekly(10))])).toEqual([["weekly", (90 + 20 * 10) / 21, false]]);
  });

  test("paused, reauth and routing-excluded accounts neither count nor keep the pool open", () => {
    const excluded = codex("pro", weekly(5), { eligible: false });
    expect(summary([codex("plus", weekly(100)), excluded, excluded])).toEqual([["weekly", 100, true], ["availability", undefined, true]]);
    expect(summary([excluded])).toEqual([]);
  });

  test("a stale reading is left out, and the pooled observation is the oldest contributing one", () => {
    const stale = codex("pro", weekly(0), { at: NOW - 31 * MINUTE });
    const older = codex("plus", weekly(30), { at: NOW - 20 * MINUTE });
    const pooled = pooledWindows([stale, older, codex("plus", weekly(50))], NOW);
    expect(pooled.map(window => [window.usedPercent, window.observedAt])).toEqual([[40, "2026-10-21T11:40:00.000Z"]]);
    expect(pooledWindows([stale], NOW)).toEqual([]);
  });

  test("a window whose reset passed is unknown, never counted as 0%", () => {
    const elapsed: PooledAccountInput = { eligible: true, weight: 1, windows: [{
      id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 0, resetsAt: new Date(NOW - 1).toISOString(),
      source: "measured", observedAt: new Date(NOW - MINUTE).toISOString(),
    }] };
    const mapped = codex("plus", { weeklyPercent: 0, weeklyResetAt: NOW - 1 });
    expect(summary([elapsed, mapped, codex("plus", weekly(80))])).toEqual([["weekly", 80, false]]);
  });

  test("an account without a reading for a window is unknown there, not 0%", () => {
    const shortOnly = codex("plus", { shortPercent: 30, shortResetAt: NOW + HOUR, shortObservedAt: NOW - MINUTE });
    expect(summary([shortOnly, codex("plus", weekly(70))])).toEqual([["5h", 30, false], ["weekly", 70, false]]);
  });

  test("accounts blocked on different windows make the pool unavailable even though each average has room", () => {
    const a = codex("plus", { shortPercent: 100, shortResetAt: NOW + HOUR, ...weekly(40) });
    const b = codex("plus", { shortPercent: 20, shortResetAt: NOW + HOUR, ...weekly(100) });
    expect(summary([a, b])).toEqual([["5h", 60, false], ["weekly", 70, false], ["availability", undefined, true]]);
    // The pool returns when the first account recovers: a's 5-hour reset.
    expect(pooledWindows([a, b], NOW).at(-1)?.resetsAt).toBe("2026-10-21T13:00:00.000Z");
    // An eligible account with no evidence yet is one routing would still try.
    expect(summary([a, b, codex("plus", {})])).toEqual([["5h", 60, false], ["weekly", 70, false]]);
  });

  test("the block's timing comes from the window that proves it, not from the percentage windows", () => {
    const blocked = codex("plus", { shortPercent: 100, shortResetAt: NOW + MINUTE, shortObservedAt: NOW - 29 * MINUTE, ...weekly(20) });
    const pooled = pooledWindows([blocked], NOW);
    expect(pooled.map(window => [window.id, window.exhausted, window.resetsAt, window.observedAt])).toEqual([
      ["5h", true, "2026-10-21T12:01:00.000Z", "2026-10-21T11:31:00.000Z"],
      ["weekly", false, "2026-10-24T12:00:00.000Z", "2026-10-21T11:59:00.000Z"],
      ["availability", true, "2026-10-21T12:01:00.000Z", "2026-10-21T11:31:00.000Z"],
    ]);
  });

  test("refusal evidence with no percentage still makes the pool unavailable", () => {
    const refused: PooledAccountInput = { eligible: true, weight: 1, windows: [{
      id: "refusal", kind: "custom", label: "Claude CLI limit", exhausted: true, resetsAt: new Date(NOW + HOUR).toISOString(),
      source: "estimated", observedAt: new Date(NOW - MINUTE).toISOString(),
    }] };
    expect(pooledWindows([refused], NOW)).toEqual([{
      id: "availability", kind: "custom", label: "Pool availability", resetsAt: "2026-10-21T13:00:00.000Z",
      source: "estimated", observedAt: "2026-10-21T11:59:00.000Z", exhausted: true,
    }]);
  });

  test("a model-scoped window exhausts only its family", () => {
    const anthropic = (opus: number, week: number): PooledAccountInput => ({ eligible: true, weight: 1, windows: providerQuotaWindows({
      weeklyPercent: week, weeklyResetAt: NOW + 72 * HOUR, updatedAt: NOW - MINUTE,
      customWindows: [{ label: "Opus", percent: opus, resetAt: NOW + 72 * HOUR, scope: "model" }],
    }, "measured", NOW) });
    const pooled = pooledWindows([anthropic(100, 30), anthropic(100, 20)], NOW);
    expect(pooled.map(window => [window.id, window.usedPercent, window.scopeModel, window.exhausted])).toEqual([
      ["weekly", 25, undefined, false],
      ["family:opus", 100, "family:opus", true],
    ]);
    expect(summary([anthropic(100, 30), anthropic(50, 20)])).toEqual([["weekly", 25, false], ["family:opus", 75, false]]);
    // One account blocked outright, the other only for Opus: Opus cannot run anywhere, other models can.
    const outright: PooledAccountInput = { eligible: true, weight: 1, windows: providerQuotaWindows({
      fiveHourPercent: 100, fiveHourResetAt: NOW + HOUR, updatedAt: NOW - MINUTE,
    }, "measured", NOW) };
    expect(pooledWindows([outright, anthropic(100, 20)], NOW).map(window => [window.id, window.scopeModel, window.exhausted, window.resetsAt]))
      .toEqual([
        ["5h", undefined, false, "2026-10-21T13:00:00.000Z"],
        ["weekly", undefined, false, "2026-10-24T12:00:00.000Z"],
        ["family:opus", "family:opus", false, "2026-10-24T12:00:00.000Z"],
        ["availability:family:opus", "family:opus", true, "2026-10-21T13:00:00.000Z"],
      ]);
  });
});
