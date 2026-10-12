import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAccountLease } from "../../../src/oauth/kiro-account-load";
import { clearGenericFailoverHealth, preferredInitialAccount, rotateGenericOAuthAccountOnRefusal } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { genericPoolSettingsDto, parseGenericPoolStrategy, parseKiroAccountCap, unifiedPoolSettingsDto } from "../../../src/oauth/pool-settings-capability";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { saveConfig, loadConfig } from "../../../src/config";
import { startServer } from "../../../src/server";
import { managementFetch } from "../../helpers/management-auth";
import { installIsolatedCodexHome } from "../../helpers/isolated-codex-home";

const oldHome = process.env.OPENCODEX_HOME;
let home = "";
const held: Array<{ release(): void }> = [];
afterEach(() => {
  held.splice(0).forEach(lease => lease.release());
  clearGenericFailoverHealth();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function seed(provider = "kiro") {
  home = mkdtempSync(join(tmpdir(), "ocx-load-settings-"));
  process.env.OPENCODEX_HOME = home;
  for (let i = 0; i < 3; i++) await saveCredential(provider, {
    access: `load-${i}`, refresh: `refresh-${i}`, expires: Date.now() + 3_600_000,
    accountId: `account-${i}`,
  }, { addAccount: true });
  const ids = getAccountSet(provider)!.accounts.map(row => row.id);
  await setActiveAccount(provider, ids[0]!);
  return ids;
}

function config(strategy: "least-loaded" | "quota" = "least-loaded", enabled = true): OcxConfig {
  return { pool: { kernel: true }, providers: { kiro: { adapter: "kiro", authMode: "oauth",
    baseUrl: "https://runtime.us-east-1.kiro.dev", models: ["claude-sonnet-4.5"],
    oauthAccountFailover: { strategy, enabled, maxConcurrentPerAccount: 1 } } } } as OcxConfig;
}

test("Kiro reads least-loaded and maxConcurrentPerAccount in both DTOs", () => {
  const cfg = config();
  expect(genericPoolSettingsDto("kiro", cfg.providers.kiro).strategy).toBe("least-loaded");
  expect(genericPoolSettingsDto("kiro", cfg.providers.kiro).maxConcurrentPerAccount).toBe(1);
  const dto = unifiedPoolSettingsDto(cfg, "kiro", "generic");
  expect(dto.supported).toContain("maxConcurrentPerAccount");
  expect(dto.maxConcurrentPerAccount).toBe(1);
  expect(unifiedPoolSettingsDto(cfg, "anthropic", "anthropic").maxConcurrentPerAccount).toBeNull();
});

test("Kiro persists and reads least-loaded and maxConcurrentPerAccount", async () => {
  await seed();
  const isolated = installIsolatedCodexHome("ocx-load-settings-codex-");
  const saved = config("quota");
  saved.providers.xai = { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://api.x.ai/v1",
    models: ["test"] };
  saveConfig({ ...saved, defaultProvider: "kiro", hostname: "127.0.0.1", port: 0 } as OcxConfig);
  const server = startServer(0);
  try {
    const write = await managementFetch(new URL("/api/pool/settings", server.url), { method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "kiro", strategy: "least-loaded", maxConcurrentPerAccount: 2 }) });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ strategy: "least-loaded", maxConcurrentPerAccount: 2 });
    const legacy = await managementFetch(new URL("/api/oauth/accounts/pool?provider=kiro", server.url));
    expect(await legacy.json()).toMatchObject({ strategy: "least-loaded", maxConcurrentPerAccount: 2 });
    expect(loadConfig().providers.kiro.oauthAccountFailover).toMatchObject({ strategy: "least-loaded", maxConcurrentPerAccount: 2 });
    const configFile = join(home, "config.json");
    const before = statSync(configFile).mtimeMs;
    for (const body of [
      { provider: "kiro", maxConcurrentPerAccount: 0 },
      { provider: "kiro", maxConcurrentPerAccount: 1.5 },
      { provider: "kiro", maxConcurrentPerAccount: 101 },
      { provider: "kiro", maxConcurrentPerAccount: "2" },
      { provider: "xai", maxConcurrentPerAccount: 1 },
      { provider: "xai", strategy: "least-loaded" },
    ]) {
      const invalid = await managementFetch(new URL("/api/pool/settings", server.url), { method: "PUT",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(invalid.status).toBe(400);
    }
    expect(statSync(configFile).mtimeMs).toBe(before);
  } finally { await server.stop(true); isolated.restore(); }
});

test("non-Kiro strategy and cap values are rejected by the provider parser", () => {
  expect(parseGenericPoolStrategy("least-loaded", "xai")).toBeNull();
  expect(parseGenericPoolStrategy("least-loaded", "kiro")).toBe("least-loaded");
  for (const bad of [0, 101, 1.5, "2", null]) expect(parseKiroAccountCap(bad)).toBeNull();
});

test("least-loaded skips an account at its cap and picks the fewest in flight", async () => {
  const [a, b, c] = await seed();
  held.push((await acquireAccountLease("kiro", a!))!);
  held.push((await acquireAccountLease("kiro", b!))!);
  expect(preferredInitialAccount(config(), "kiro")).toBe(c);
  held.push((await acquireAccountLease("kiro", c!))!);
  expect(preferredInitialAccount(config(), "kiro")).toBeNull();
});

test("least-loaded is inert when proactive preference is off", async () => {
  const [a, b] = await seed();
  held.push((await acquireAccountLease("kiro", a!))!);
  expect(preferredInitialAccount(config("least-loaded", false), "kiro")).toBeNull();
  expect(preferredInitialAccount({ ...config(), pool: { kernel: false } } as OcxConfig, "kiro")).toBeNull();
  expect(b).toBeTruthy();
});

test("the rotator prefers a sibling with room when a cap is configured", async () => {
  const [a, b, c] = await seed();
  held.push((await acquireAccountLease("kiro", b!))!);
  expect(rotateGenericOAuthAccountOnRefusal(config("quota"), "kiro", a!, "rate", null)).toBe(c);
});

test("a non-Kiro 429 rotation's candidates are unchanged", async () => {
  const [a, b] = await seed("xai");
  const cfg = { providers: { xai: { adapter: "openai-chat", authMode: "oauth",
    oauthAccountFailover: { strategy: "least-loaded", maxConcurrentPerAccount: 1 } } },
    pool: { kernel: true } } as OcxConfig;
  held.push((await acquireAccountLease("xai", b!))!);
  expect(rotateGenericOAuthAccountOnRefusal(cfg, "xai", a!, "rate", null)).toBe(b);
});
