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
