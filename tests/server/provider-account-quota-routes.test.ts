import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOauthAccountRoutes } from "../../src/server/management/oauth-account-routes";
import { clearAccountQuotaCache, clearProviderQuotaCache } from "../../src/providers/quota";
import * as quotaApi from "../../src/providers/quota";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const originalFixtureKey = process.env.OCX_QUOTA_ROW_FIXTURE;
let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-quota-rows-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
  clearProviderQuotaCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountQuotaCache();
  clearProviderQuotaCache();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (originalFixtureKey === undefined) delete process.env.OCX_QUOTA_ROW_FIXTURE;
  else process.env.OCX_QUOTA_ROW_FIXTURE = originalFixtureKey;
  removeTreeWithRetry(home);
});

function keyConfig(): OcxConfig {
  return { port: 0, defaultProvider: "openrouter", providers: { openrouter: {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "fixture-first", apiKeyPool: [
      { id: "first", key: "fixture-first" }, { id: "second", key: "fixture-second" },
    ],
  } } };
}

async function read(path: string, config: OcxConfig) {
  const req = new Request(`http://localhost${path}`);
  const response = await handleOauthAccountRoutes({
    req, url: new URL(req.url), config, version: "test", deps: {},
    convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }),
    syncClaudeAgentDefsBestEffort: async () => {},
  });
  if (!response) throw new Error("unhandled fixture route");
  return response;
}

test("cheap and refresh-only key lists advertise capability without probing or changing config", async () => {
  const config = keyConfig();
  const before = JSON.stringify(config);
  let probes = 0;
  globalThis.fetch = (async () => { probes++; throw new Error("unexpected quota request"); }) as typeof fetch;
  for (const suffix of ["", "&refresh=1"]) {
    const response = await read(`/api/providers/keys?name=openrouter${suffix}`, config);
    const body = await response.json();
    expect(body.keys.map((row: { quotaMode: string }) => row.quotaMode)).toEqual(["probe", "probe"]);
    expect(body.keys.every((row: { quota?: unknown }) => row.quota === undefined)).toBe(true);
  }
  expect(probes).toBe(0);
  expect(JSON.stringify(config)).toBe(before);
});

test("enriched key rows retain per-key values without activating or exposing credentials", async () => {
  const config = keyConfig();
  const before = JSON.stringify(config);
  const tokens: string[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://openrouter.ai/api/v1/key");
    const token = new Headers(init?.headers).get("authorization")!;
    tokens.push(token);
    return Response.json({ data: { limit: 100, limit_remaining: token.endsWith("first") ? 80 : 40 } });
  }) as typeof fetch;
  const body = await (await read("/api/providers/keys?name=openrouter&quota=1&refresh=1", config)).json();
  expect(body.activeId).toBe("first");
  expect(body.keys.map((row: { quota: { customWindows: { percent: number }[] } }) => row.quota.customWindows[0]?.percent)).toEqual([20, 60]);
  expect(tokens.sort()).toEqual(["Bearer fixture-first", "Bearer fixture-second"]);
  expect(body.keys.every((row: { quotaMode: string; quotaUnavailable: boolean }) => row.quotaMode === "probe" && row.quotaUnavailable === false)).toBe(true);
  const wire = JSON.stringify(body);
  expect(wire).not.toContain("fixture-first");
  expect(wire).not.toContain("fixture-second");
  expect(wire).not.toContain("isCurrent");
  expect(JSON.stringify(config)).toBe(before);
});

test("a removed key cannot return in an in-flight enrichment response", async () => {
  const config = keyConfig();
  globalThis.fetch = (async (_input, init) => {
    if (new Headers(init?.headers).get("authorization")?.endsWith("second")) {
      config.providers.openrouter.apiKeyPool = config.providers.openrouter.apiKeyPool!.filter(row => row.id !== "second");
    }
    return Response.json({ data: { limit: 100, limit_remaining: 50 } });
  }) as typeof fetch;
  const body = await (await read("/api/providers/keys?name=openrouter&quota=1", config)).json();
  expect(body.keys.map((row: { id: string }) => row.id)).toEqual(["first"]);
});

test("unsupported key destinations do not resolve or probe credentials", async () => {
  const config = keyConfig();
  config.providers.openrouter.baseUrl = "https://quota-fixture.invalid/api/v1";
  let probes = 0;
  globalThis.fetch = (async () => { probes++; throw new Error("must not probe"); }) as typeof fetch;
  const body = await (await read("/api/providers/keys?name=openrouter&quota=1&refresh=1", config)).json();
  expect(body.keys.every((row: { quotaMode: string; quota?: unknown }) => row.quotaMode === "unsupported" && row.quota === undefined)).toBe(true);
  expect(probes).toBe(0);
});

test("same-id environment credential replacement cannot inherit a settled old quota", async () => {
  const config = keyConfig();
  process.env.OCX_QUOTA_ROW_FIXTURE = "fixture-old";
  config.providers.openrouter.apiKey = "${OCX_QUOTA_ROW_FIXTURE}";
  config.providers.openrouter.apiKeyPool = [{ id: "same-id", key: "${OCX_QUOTA_ROW_FIXTURE}" }];
  globalThis.fetch = (async () => {
    const response = Response.json({ data: { limit: 100, limit_remaining: 80 } });
    process.env.OCX_QUOTA_ROW_FIXTURE = "fixture-new";
    return response;
  }) as typeof fetch;
  const body = await (await read("/api/providers/keys?name=openrouter&quota=1", config)).json();
  expect(body.keys[0].id).toBe("same-id");
  expect(body.keys[0].quota).toBeNull();
  expect(body.keys[0].quotaUnavailable).toBe(true);
});

test("the final route projection checks private identity even for a non-null completed reading", async () => {
  const config = keyConfig();
  let checked = 0;
  const probe = spyOn(quotaApi, "fetchProviderApiKeyQuotas").mockResolvedValue([{
    keyId: "first", quota: { weeklyPercent: 77, updatedAt: Date.now() },
    isCurrent: () => { checked++; return false; },
  }]);
  try {
    const body = await (await read("/api/providers/keys?name=openrouter&quota=1", config)).json();
    expect(checked).toBe(1);
    expect(body.keys[0].quota).toBeNull();
    expect(body.keys[0].quotaUnavailable).toBe(true);
    expect(JSON.stringify(body)).not.toContain("weeklyPercent");
    expect(JSON.stringify(body)).not.toContain("isCurrent");
  } finally {
    probe.mockRestore();
  }
});

test("OAuth cheap rows carry probe mode and enriched rows clear stale failure flags", async () => {
  await saveCredential("anthropic", { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000, accountId: "fixture-upstream" });
  const config: OcxConfig = { port: 0, defaultProvider: "anthropic", providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" } } };
  const before = getAccountSet("anthropic")?.activeAccountId;
  let fail = true;
  let probes = 0;
  globalThis.fetch = (async () => {
    probes++;
    return fail ? new Response(null, { status: 503 }) : Response.json({ five_hour: { utilization: 0 }, seven_day: { utilization: 12 } });
  }) as typeof fetch;
  const plain = await (await read("/api/oauth/accounts?provider=anthropic", config)).json();
  expect(plain.accounts[0].quotaMode).toBe("probe");
  expect(probes).toBe(0);
  const failed = await (await read("/api/oauth/accounts?provider=anthropic&quota=1&refresh=1", config)).json();
  expect(failed.accounts[0].quotaUnavailable).toBe(true);
  fail = false;
  const ok = await (await read("/api/oauth/accounts?provider=anthropic&quota=1&refresh=1", config)).json();
  expect(ok.accounts[0].quotaUnavailable).toBe(false);
  expect(ok.accounts[0].quota.fiveHourPercent).toBe(0);
  expect(getAccountSet("anthropic")?.activeAccountId).toBe(before);
});

test("OAuth final projection rejects quota from a replaced stored identity", async () => {
  await saveCredential("anthropic", { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000, accountId: "fixture-upstream" });
  const accountId = getAccountSet("anthropic")!.activeAccountId;
  const config: OcxConfig = { port: 0, defaultProvider: "anthropic", providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" } } };
  let checked = 0;
  const probe = spyOn(quotaApi, "fetchProviderAccountQuotas").mockResolvedValue([{
    accountId, quota: { weeklyPercent: 77, updatedAt: Date.now() },
    isCurrent: () => { checked++; return false; },
  }]);
  try {
    const body = await (await read("/api/oauth/accounts?provider=anthropic&quota=1", config)).json();
    expect(checked).toBe(1);
    expect(body.accounts[0].quota).toBeNull();
    expect(body.accounts[0].quotaUnavailable).toBe(true);
  } finally {
    probe.mockRestore();
  }
});

test("OAuth final projection rejects a replaced configured provider object", async () => {
  await saveCredential("anthropic", { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000, accountId: "fixture-upstream" });
  const accountId = getAccountSet("anthropic")!.activeAccountId;
  const config: OcxConfig = { port: 0, defaultProvider: "anthropic", providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" } } };
  const probe = spyOn(quotaApi, "fetchProviderAccountQuotas").mockImplementation(async () => {
    config.providers.anthropic = { ...config.providers.anthropic, disabled: true };
    return [{ accountId, quota: { weeklyPercent: 77, updatedAt: Date.now() }, isCurrent: () => true }];
  });
  try {
    const body = await (await read("/api/oauth/accounts?provider=anthropic&quota=1", config)).json();
    expect(body.accounts[0].quota).toBeNull();
    expect(body.accounts[0].quotaUnavailable).toBe(true);
  } finally {
    probe.mockRestore();
  }
});

test("passive account refresh reports unobserved without sending a quota request", async () => {
  await saveCredential("meta-muse", { access: "fixture-passive", refresh: "", expires: Date.now() + 3600000, accountId: "fixture-passive-account" });
  const config: OcxConfig = { port: 0, defaultProvider: "meta-muse", providers: { "meta-muse": { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://example.invalid" } } };
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("passive readers must not probe"); }) as typeof fetch;
  const body = await (await read("/api/oauth/accounts?provider=meta-muse&quota=1&refresh=1", config)).json();
  expect(body.accounts).toHaveLength(1);
  expect(body.accounts[0].quotaMode).toBe("passive");
  expect(body.accounts[0].quota).toBeUndefined();
  expect(body.accounts[0].quotaUnavailable).toBeUndefined();
  expect(requests).toBe(0);
});
