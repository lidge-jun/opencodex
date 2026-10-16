import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { saveConfig, loadConfig } from "../../src/config";
import { handleOauthAccountRoutes } from "../../src/server/management/oauth-account-routes";
import { writeAnthropicPoolSettings } from "../../src/server/management/anthropic-pool-settings";
import { poolSettingsCapability } from "../../src/oauth/pool-settings-capability";
import { getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { getProviderQuotaReportCache, setProviderQuotaReportCache, type ProviderQuotaReport } from "../../src/providers/quota/report-cache";
import { getCachedProviderQuota, replaceCachedProviderQuotas } from "../../src/providers/quota-routing-cache";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
let home: TempHome;
let config: OcxConfig;
beforeEach(() => {
  home = createTempHome("ocx-anthropic2-management-");
  config = { providers: {
    anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    anthropic2: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", anthropicOAuthInstance: "anthropic2", anthropicAccountPool: { enabled: true, autoSwitchThreshold: 37 } },
  }, anthropicAccountPool: { enabled: true, autoSwitchThreshold: 91 } };
  saveConfig(config);
  const account = { id: "same", credential: { access: "fixture-access", refresh: "fixture-refresh", expires: 9999999999999 } };
  writeFileSync(home.path("auth.json"), JSON.stringify(Object.fromEntries(["anthropic", "anthropic2"].map(provider => [provider, { activeAccountId: "same", accounts: [account] }]))), { mode: 0o600 });
});
afterEach(() => { setPersistedConfigMutationBeforeCommitForTests(null); home.remove(); });
async function route(path: string, method = "GET", body?: unknown) {
  const req = new Request("http://localhost" + path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const response = await handleOauthAccountRoutes({ req, url: new URL(req.url), config, deps: {}, principal: "admin-token" } as never);
  if (!response) throw new Error("Missing route");
  return response;
}
test("both B pool writers persist nested settings and preserve A", async () => {
  const a = structuredClone(config.anthropicAccountPool);
  for (const path of ["/api/pool/settings", "/api/oauth/accounts/pool"]) {
    const response = await route(path, "PUT", { provider: "anthropic2", autoSwitchThreshold: 42, stickyLimit: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: "anthropic2", autoSwitchThreshold: 42, stickyLimit: 3 });
    expect(loadConfig().providers.anthropic2!.anthropicAccountPool?.autoSwitchThreshold).toBe(42);
    expect(loadConfig().anthropicAccountPool).toEqual(a);
    expect(config.anthropicAccountPool).toEqual(a);
  }
});
test("equal account IDs keep B thresholds, selection, pause and removal separate", async () => {
  const a = JSON.parse(readFileSync(home.path("auth.json"), "utf8")).anthropic;
  expect((await route("/api/oauth/accounts/auto-switch", "PUT", { provider: "anthropic2", accountId: "same", threshold: 12 })).status).toBe(200);
  const list = await route("/api/oauth/accounts?provider=anthropic2");
  expect(await list.json()).toMatchObject({ provider: "anthropic2", accounts: [{ id: "same", autoSwitchThresholdOverride: 12, effectiveAutoSwitchThreshold: 12, autoSwitchThreshold: 37 }] });
  expect((await route("/api/oauth/accounts/active", "PUT", { provider: "anthropic2", accountId: "same" })).status).toBe(200);
  expect((await route("/api/oauth/accounts/pause", "PUT", { provider: "anthropic2", accountId: "same", paused: true })).status).toBe(200);
  expect((await route("/api/oauth/accounts?provider=anthropic2&id=same", "DELETE")).status).toBe(200);
  expect(JSON.parse(readFileSync(home.path("auth.json"), "utf8")).anthropic).toEqual(a);
});
test("missing, disabled and unmarked B never mutate pool or account state", async () => {
  const row = structuredClone(config.providers.anthropic2!);
  for (const invalid of [undefined, { ...row, disabled: true }, { ...row, anthropicOAuthInstance: undefined }]) {
    if (invalid) config.providers.anthropic2 = invalid;
    else delete config.providers.anthropic2;
    expect(poolSettingsCapability("anthropic2", invalid)).toBeNull();
    expect(() => writeAnthropicPoolSettings(config, "anthropic2", {})).toThrow();
    for (const [path, method] of [["/api/pool/settings", "PUT"], ["/api/oauth/accounts/pool", "PUT"], ["/api/oauth/accounts/auto-switch", "PUT"], ["/api/oauth/accounts/active", "PUT"], ["/api/oauth/accounts/clear-cooldown", "POST"]] as const) {
      const response = await route(path, method, { provider: "anthropic2", accountId: "same", threshold: 1, enabled: false });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(JSON.parse(readFileSync(home.path("auth.json"), "utf8")).anthropic2.accounts[0].autoSwitchThresholdOverride).toBeUndefined();
  }
});

test("a concurrent B row removal is not recreated by settings publication", async () => {
  const a = structuredClone(config.anthropicAccountPool);
  setPersistedConfigMutationBeforeCommitForTests(() => {
    setPersistedConfigMutationBeforeCommitForTests(null);
    const stored = JSON.parse(readFileSync(home.path("config.json"), "utf8"));
    delete stored.providers.anthropic2;
    writeFileSync(home.path("config.json"), JSON.stringify(stored), { mode: 0o600 });
  });
  const response = await route("/api/pool/settings", "PUT", { provider: "anthropic2", autoSwitchThreshold: 22 });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "config_save_state_unknown" });
  expect(loadConfig().providers.anthropic2).toBeUndefined();
  expect(loadConfig().anthropicAccountPool).toEqual(a);
  expect(config.providers.anthropic2!.anthropicAccountPool?.autoSwitchThreshold).toBe(37);
});

test("a stale live B row after a durable save answers saved with the bookkeeping warning", async () => {
  setPersistedConfigMutationBeforeCommitForTests(() => {
    setPersistedConfigMutationBeforeCommitForTests(null);
    config.providers.anthropic2 = { ...config.providers.anthropic2!, disabled: true };
  });
  const response = await route("/api/pool/settings", "PUT", { provider: "anthropic2", autoSwitchThreshold: 22 });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ warning: "config_bookkeeping_failed" });
  expect(loadConfig().providers.anthropic2!.anthropicAccountPool?.autoSwitchThreshold).toBe(22);
});

test("B account mutations retire only B provider-level, routing and account quota rows", async () => {
  const now = Date.now();
  const report = (provider: string, fiveHourPercent: number): ProviderQuotaReport => ({
    provider, label: provider, source: "anthropic:oauth-usage", quota: { fiveHourPercent, updatedAt: now }, updatedAt: now,
  });
  const reports = [report("anthropic", 11), report("anthropic2", 22)];
  for (const [path, method, body] of [
    ["/api/oauth/accounts/active", "PUT", { provider: "anthropic2", accountId: "same" }],
    ["/api/oauth/accounts?provider=anthropic2&id=same", "DELETE", undefined],
  ] as const) {
    setProviderQuotaReportCache({ key: "fixture", ts: now, response: { generatedAt: now, reports } });
    replaceCachedProviderQuotas(reports);
    for (const provider of ["anthropic", "anthropic2"]) setCachedProviderAccountQuotaForTests(provider, "same", { fiveHourPercent: 5, updatedAt: now });
    expect((await route(path, method, body)).status).toBe(200);
    expect(getProviderQuotaReportCache()?.response.reports.map(row => row.provider)).toEqual(["anthropic"]);
    expect(getCachedProviderQuota("anthropic", now)?.fiveHourPercent).toBe(11);
    expect(getCachedProviderQuota("anthropic2", now)).toBeNull();
    expect(getCachedProviderAccountQuota("anthropic", "same")?.fiveHourPercent).toBe(5);
    expect(getCachedProviderAccountQuota("anthropic2", "same")).toBeNull();
  }
});
