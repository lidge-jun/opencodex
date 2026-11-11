import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const WHAM = "https://chatgpt.com/backend-api/wham/usage";
const originalFetch = globalThis.fetch;
let testDir = "";
let previousHome: string | undefined;
let isolated: IsolatedCodexHome | null = null;
let whamCalls: string[] = [];

function setup(details?: { reason: string; pausedAt: number }): void {
  saveConfig({
    port: 0, hostname: "127.0.0.1", defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    codexAccounts: [{ id: "pool-paused", email: "paused@example.test", isMain: false }, { id: "pool-live", email: "live@example.test", isMain: false }],
    activeCodexAccountId: "pool-live",
    pausedCodexAccountIds: ["pool-paused", MAIN_CODEX_ACCOUNT_ID],
    codexAccountPauseState: {
      "pool-paused": { revision: "rev-1", ...(details ? { details } : {}) },
      [MAIN_CODEX_ACCOUNT_ID]: { revision: "rev-main", details: { reason: "subscription_expired", pausedAt: 1 } },
    },
  } as unknown as OcxConfig);
  for (const id of ["pool-paused", "pool-live"]) {
    saveCodexAccountCredential(id, { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 60 * 60_000, chatgptAccountId: `acct-${id}` });
  }
}

function stubWham(status: number): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === WHAM) {
      whamCalls.push(new Headers(init?.headers).get("authorization") ?? "");
      return status === 200
        ? Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 20, reset_after_seconds: 600, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 40, reset_after_seconds: 6000, limit_window_seconds: 604800 } } })
        : new Response("{}", { status });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function resume(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request("http://localhost/api/codex-auth/accounts/pause", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const response = await handleCodexAuthAPI(req, new URL(req.url), loadConfig());
  return { status: response!.status, json: await response!.json() as Record<string, unknown> };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolated = installIsolatedCodexHome("ocx-codex-resume-health-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-codex-resume-health-"));
  process.env.OPENCODEX_HOME = testDir;
  whamCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolated?.restore();
  isolated = null;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("Codex resume --if-healthy (#8398)", () => {
  test("a fresh quota read by the live credential resumes an automatically paused account", async () => {
    setup({ reason: "subscription_expired", pausedAt: 1 });
    stubWham(200);
    const result = await resume({ id: "pool-paused", paused: false, ifHealthy: true });
    expect(result.status).toBe(200);
    expect(whamCalls).toEqual(["Bearer access-pool-paused"]);
    expect(loadConfig().pausedCodexAccountIds ?? []).not.toContain("pool-paused");
  });

  test("a failed quota read keeps the pause", async () => {
    setup({ reason: "subscription_expired", pausedAt: 1 });
    stubWham(500);
    const result = await resume({ id: "pool-paused", paused: false, ifHealthy: true });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: "resume_refused" });
    expect(loadConfig().pausedCodexAccountIds).toContain("pool-paused");
  });

  test("a permanent reason, the main account and a pause request are refused without a read", async () => {
    setup({ reason: "account_permission_denied", pausedAt: 1 });
    stubWham(200);
    expect((await resume({ id: "pool-paused", paused: false, ifHealthy: true })).json).toMatchObject({ code: "resume_refused", reason: "pause_not_remote_clearable" });
    expect((await resume({ id: MAIN_CODEX_ACCOUNT_ID, paused: false, ifHealthy: true })).json).toMatchObject({ code: "resume_refused", reason: "health_check_unsupported" });
    expect((await resume({ id: "pool-paused", paused: true, ifHealthy: true })).status).toBe(400);
    expect(whamCalls).toEqual([]);
    expect(loadConfig().pausedCodexAccountIds).toEqual(expect.arrayContaining(["pool-paused", MAIN_CODEX_ACCOUNT_ID]));
  });
});

describe("Codex resume --if-healthy across linked accounts (#8398 review)", () => {
  test("a permanent reason on a linked account refuses the whole resume", async () => {
    setup({ reason: "subscription_expired", pausedAt: 1 });
    const config = loadConfig();
    config.codexAccounts = [...(config.codexAccounts ?? []), { id: "pool-twin", email: "paused@example.test", isMain: false }];
    config.pausedCodexAccountIds = [...(config.pausedCodexAccountIds ?? []), "pool-twin"];
    config.codexAccountPauseState = { ...config.codexAccountPauseState, "pool-twin": { revision: "rev-twin", details: { reason: "oauth_organization_disabled", pausedAt: 1 } } };
    saveConfig(config);
    saveCodexAccountCredential("pool-twin", { accessToken: "access-twin", refreshToken: "refresh-twin", expiresAt: Date.now() + 60 * 60_000, chatgptAccountId: "acct-pool-paused" });
    stubWham(200);
    const result = await resume({ id: "pool-paused", paused: false, ifHealthy: true });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: "resume_refused", reason: "pause_not_remote_clearable" });
    expect(loadConfig().pausedCodexAccountIds).toEqual(expect.arrayContaining(["pool-paused", "pool-twin"]));
  });

  test("an account that is not paused when checked is a no-op", async () => {
    setup({ reason: "subscription_expired", pausedAt: 1 });
    stubWham(200);
    const before = loadConfig().codexAccountPauseState?.["pool-live"];
    const result = await resume({ id: "pool-live", paused: false, ifHealthy: true });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, unchanged: true });
    expect(loadConfig().codexAccountPauseState?.["pool-live"]).toEqual(before);
    expect(whamCalls).toEqual([]);
  });
});

describe("Codex health verdicts and races (#8398 review)", () => {
  test("a probe that needs reauthentication refuses with needs_reauth", async () => {
    setup({ reason: "subscription_expired", pausedAt: 1 });
    const { checkCodexResumeHealth } = await import("../../src/codex/account-resume-health");
    const verdict = await checkCodexResumeHealth(loadConfig(), "pool-paused", async () => ({ quota: null, needsReauth: true }));
    expect(verdict).toEqual({ ok: false, reason: "needs_reauth" });
  });

  test("an operator re-pause during the read keeps the pause", async () => {
    setup({ reason: "subscription_expired", pausedAt: 1 });
    stubWham(200);
    const { setCodexAccountPaused } = await import("../../src/codex/account-pause");
    const config = loadConfig();
    const read = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // The operator pauses the same account by hand while the health read is in flight.
      setCodexAccountPaused(config, "pool-paused", true);
      return read(input, init);
    }) as typeof fetch;
    const req = new Request("http://localhost/api/codex-auth/accounts/pause", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pool-paused", paused: false, ifHealthy: true }) });
    const response = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(response!.status).toBe(409);
    expect(await response!.json()).toMatchObject({ code: "resume_refused", reason: "account_changed" });
    expect(config.pausedCodexAccountIds).toContain("pool-paused");
  });
});
