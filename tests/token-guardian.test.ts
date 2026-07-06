import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/oauth/store";
import { getConfigPath } from "../src/config";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { __resetGuardianState, guardianSweep } from "../src/oauth/token-guardian";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origFetch = globalThis.fetch;
let tmp: string;

// kimi refresh is a single token POST (no OAuth discovery hop), so a blanket 200 mock exercises the
// real getValidAccessToken → refreshKimiToken → saveCredential path cleanly.
function kimiProvider(refreshPolicy?: OcxProviderConfig["refreshPolicy"]): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: "https://api.moonshot.ai/v1", authMode: "oauth", ...(refreshPolicy ? { refreshPolicy } : {}) };
}

function writeConfig(partial: Partial<OcxConfig>): void {
  const providers = partial.providers ?? { kimi: kimiProvider() };
  const defaultProvider = partial.defaultProvider ?? Object.keys(providers)[0] ?? "kimi";
  const cfg: OcxConfig = { port: 10100, ...partial, providers, defaultProvider };
  writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2));
}

beforeEach(() => {
  tmp = join(tmpdir(), `token-guardian-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  mkdirSync(join(tmp, "ocx"), { recursive: true });
  __resetGuardianState();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  globalThis.fetch = origFetch;
  rmSync(tmp, { recursive: true, force: true });
});

function mockFetchOk(body: object): { count: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { count: () => calls };
}

const OK_TOKEN = { access_token: "a2", refresh_token: "r2", expires_in: 3600 };

describe("token guardian", () => {
  test("disabled by default → no refresh, no fetch", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({}); // no tokenGuardian
    saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 1000 });
    const res = await guardianSweep(Date.now());
    expect(res.enabled).toBe(false);
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("proactive provider with soon-expiring token is refreshed", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { kimi: kimiProvider("proactive") },
    });
    saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
    const res = await guardianSweep(Date.now());
    expect(res.enabled).toBe(true);
    // Multiauth keys are oauth:<provider>:<accountId>
    expect(res.refreshed.some(k => k.startsWith("oauth:kimi:"))).toBe(true);
    expect(mock.count()).toBeGreaterThan(0);
  });

  test("lazy-only policy is left untouched even when enabled", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { kimi: kimiProvider("lazy-only") },
    });
    saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("token far from expiry is not refreshed", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { kimi: kimiProvider("proactive") },
    });
    saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 3600_000 }); // beyond 120s horizon
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("anthropic default policy is disabled → never refreshed even when enabled", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      // no explicit refreshPolicy → falls back to the built-in "disabled" default for anthropic
      providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
    });
    saveCredential("anthropic", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("codex pool refreshed only when chatgpt policy is proactive", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", refreshPolicy: "proactive" } },
    });
    saveCodexAccountCredential("acct-1", {
      accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 5_000, chatgptAccountId: "cg-1",
    });
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toContain("codex:acct-1");
    expect(mock.count()).toBeGreaterThan(0);
  });
});
