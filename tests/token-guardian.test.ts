import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/oauth/store";
import { getConfigPath } from "../src/config";
import { markCodexAccountValidated, readCodexAccountRecord, saveCodexAccountCredential } from "../src/codex/account-store";
import { __resetGuardianState, guardianSweep } from "../src/oauth/token-guardian";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origCodexHome = process.env.CODEX_HOME;
const origFetch = globalThis.fetch;
const WARMUP_INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
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
  process.env.CODEX_HOME = join(tmp, "codex");
  mkdirSync(join(tmp, "ocx"), { recursive: true });
  mkdirSync(join(tmp, "codex"), { recursive: true });
  __resetGuardianState();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
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

function mockWarmupFetch(): { calls: () => number; body: () => Record<string, unknown> | undefined } {
  let calls = 0;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (String(input) === "https://chatgpt.com/backend-api/codex/responses") {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(OK_TOKEN), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls: () => calls, body: () => requestBody };
}

const OK_TOKEN = { access_token: "a2", refresh_token: "r2", expires_in: 3600 };

describe("token guardian", () => {
  test("disabled by default → no refresh, no fetch", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({}); // no tokenGuardian
    await saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 1000 });
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
    await saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
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
    await saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
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
    await saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 3600_000 }); // beyond 120s horizon
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
    await saveCredential("anthropic", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("codex pool refreshed only when canonical openai policy is proactive", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", refreshPolicy: "proactive" } },
    });
    saveCodexAccountCredential("acct-1", {
      accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 5_000, chatgptAccountId: "cg-1",
    });
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toContain("codex:acct-1");
    expect(mock.count()).toBeGreaterThan(0);
  });

  test("codex pool warmup is opt-in even when validation is stale", async () => {
    const mock = mockWarmupFetch();
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", refreshPolicy: "proactive" } },
    });
    saveCodexAccountCredential("acct-stale", {
      accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 3600_000, chatgptAccountId: "cg-1",
    });
    const res = await guardianSweep(Date.now());
    expect(res.warmed).toEqual([]);
    expect(mock.calls()).toBe(0);
  });

  test("codex pool warmup validates stale far-from-expiry accounts when explicitly enabled", async () => {
    const mock = mockWarmupFetch();
    writeConfig({
      tokenGuardian: {
        enabled: true,
        tickSeconds: 60,
        leadSeconds: 60,
        codexWarmupEnabled: true,
        codexWarmupMaxAgeSeconds: 60,
      },
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", refreshPolicy: "proactive" } },
    });
    saveCodexAccountCredential("acct-warm", {
      accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 3600_000, chatgptAccountId: "cg-1",
    });
    markCodexAccountValidated("acct-warm", Date.now() - 120_000);

    const res = await guardianSweep(Date.now());

    expect(res.refreshed).toEqual([]);
    expect(res.warmed).toContain("codex:acct-warm");
    expect(mock.body()).toMatchObject({ model: "gpt-5.4-mini", input: WARMUP_INPUT, stream: true, store: false });
    expect(readCodexAccountRecord("acct-warm")?.lastCodexValidationStatus).toBe("ok");
    expect(readCodexAccountRecord("acct-warm")?.lastCodexValidatedAt).toBeGreaterThan(Date.now() - 30_000);
  });

  test("direct mode warms main only and never enumerates the added-account store", async () => {
    const accountStore = join(tmp, "ocx", "codex-accounts.json");
    writeFileSync(accountStore, "invalid-added-store");
    writeFileSync(join(tmp, "codex", "auth.json"), JSON.stringify({
      tokens: { access_token: "main-access", account_id: "main-chatgpt-id" },
    }));
    const mock = mockWarmupFetch();
    writeConfig({
      tokenGuardian: {
        enabled: true,
        tickSeconds: 60,
        leadSeconds: 60,
        codexWarmupEnabled: true,
      },
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct", refreshPolicy: "proactive" } },
    });

    const res = await guardianSweep(Date.now());

    expect(res.warmed).toEqual(["codex:__main__"]);
    expect(mock.calls()).toBe(1);
    expect(readFileSync(accountStore, "utf8")).toBe("invalid-added-store");
  });
});
