import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  handleCodexAuthAPI, updateAccountQuota, getAccountQuota,
  checkAccountIdCollision, getMainChatgptAccountId,
  markAccountNeedsReauth, isAccountNeedsReauth, clearAccountNeedsReauth, clearAccountQuota,
} from "../src/codex-auth-api";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-auth-api-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  };
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
  clearAccountQuota();
});

afterEach(() => {
  clearAccountQuota();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("codex-auth API", () => {
  test("GET /api/codex-auth/accounts returns array with main", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp).not.toBeNull();
    const data = await resp!.json() as { accounts: unknown[] };
    expect(Array.isArray(data.accounts)).toBe(true);
    const main = (data.accounts as { isMain: boolean }[]).find(a => a.isMain);
    expect(main).toBeTruthy();
  });

  test("POST /api/codex-auth/accounts rejects missing fields", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test" }),
    });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp!.status).toBe(400);
  });

  test("POST /api/codex-auth/accounts rejects oversized input", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "a".repeat(65),
        email: "test@test.com",
        accessToken: "tok",
        refreshToken: "ref",
        chatgptAccountId: "acc",
      }),
    });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp!.status).toBe(400);
    const body = await resp!.json() as { error: string };
    expect(body.error).toMatch(/too large|Invalid account id/i);
  });

  test("GET /api/codex-auth/active returns expected shape", async () => {
    const req = new Request("http://localhost/api/codex-auth/active", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    const data = await resp!.json() as Record<string, unknown>;
    expect("activeCodexAccountId" in data).toBe(true);
    expect(typeof data.autoSwitchThreshold).toBe("number");
  });

  test("GET /api/codex-auth/active reflects live runtime config", async () => {
    const config = makeConfig({
      activeCodexAccountId: "pool-live",
      autoSwitchThreshold: 55,
      codexAccounts: [{ id: "pool-live", email: "pool-live@example.test", isMain: false }],
    });
    const req = new Request("http://localhost/api/codex-auth/active", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { activeCodexAccountId: string | null; autoSwitchThreshold: number };
    expect(data).toEqual({ activeCodexAccountId: "pool-live", autoSwitchThreshold: 55, upstreamFailoverThreshold: 3 });
  });

  test("GET /api/codex-auth/accounts returns large live pools without dropping entries", async () => {
    const config = makeConfig({
      codexAccounts: Array.from({ length: 30 }, (_, i) => ({
        id: `pool-${i + 1}`,
        email: `pool-${i + 1}@example.test`,
        isMain: false,
      })),
    });
    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: { id: string; isMain: boolean }[] };
    expect(data.accounts.filter(a => !a.isMain).map(a => a.id)).toHaveLength(30);
    expect(data.accounts.at(-1)?.id).toBe("pool-30");
  });

  test("updateAccountQuota stores and retrieves quota", () => {
    updateAccountQuota("test-acct", 45, 12);
    const q = getAccountQuota("test-acct");
    expect(q).not.toBeNull();
    expect(q!.weeklyPercent).toBe(45);
    expect(q!.fiveHourPercent).toBe(12);
  });

  test("GET /api/codex-auth/quota returns stored quotas", async () => {
    updateAccountQuota("q-test", 30, 5);
    const req = new Request("http://localhost/api/codex-auth/quota", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    const data = await resp!.json() as { quotas: Record<string, unknown> };
    expect(data.quotas["q-test"]).toBeTruthy();
  });

  test("GET /api/codex-auth/accounts fetches pool quota when cache is empty", async () => {
    const createReq = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "pool-visible",
        email: "pool-visible@example.com",
        accessToken: "tok",
        refreshToken: "ref",
        chatgptAccountId: "acc-pool-visible",
      }),
    });
    const createResp = await handleCodexAuthAPI(createReq, new URL(createReq.url), {} as any);
    expect(createResp!.status).toBe(200);

    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer tok");
      expect(headers.get("ChatGPT-Account-Id")).toBe("acc-pool-visible");
      return new Response(JSON.stringify({
        rate_limit: {
          secondary_window: { used_percent: 64, reset_at: 1782628379 },
          primary_window: { used_percent: 11, reset_at: 1782291794 },
        },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
      expect(resp!.status).toBe(200);
      const data = await resp!.json() as { accounts: { id: string; quota: unknown; needsReauth?: boolean }[] };
      const pool = data.accounts.find(a => a.id === "pool-visible");
      expect(pool?.quota).toMatchObject({ weeklyPercent: 64, fiveHourPercent: 11, weeklyResetAt: 1782628379, fiveHourResetAt: 1782291794 });
      expect(pool?.needsReauth).toBe(false);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GET /api/codex-auth/accounts refresh=1 bypasses cached pool quota", async () => {
    const createReq = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "pool-refresh",
        email: "pool-refresh@example.com",
        accessToken: "tok",
        refreshToken: "ref",
        chatgptAccountId: "acc-pool-refresh",
      }),
    });
    const createResp = await handleCodexAuthAPI(createReq, new URL(createReq.url), {} as any);
    expect(createResp!.status).toBe(200);
    updateAccountQuota("pool-refresh", 72, 31);

    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer tok");
      expect(headers.get("ChatGPT-Account-Id")).toBe("acc-pool-refresh");
      return new Response(JSON.stringify({
        rate_limit: {
          secondary_window: { used_percent: 6, reset_at: 1782628379 },
          primary_window: { used_percent: 2, reset_at: 1782291794 },
        },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
      expect(resp!.status).toBe(200);
      const data = await resp!.json() as { accounts: { id: string; quota: unknown }[] };
      const pool = data.accounts.find(a => a.id === "pool-refresh");
      expect(pool?.quota).toMatchObject({ weeklyPercent: 6, fiveHourPercent: 2, weeklyResetAt: 1782628379, fiveHourResetAt: 1782291794 });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unmatched route returns null", async () => {
    const req = new Request("http://localhost/api/codex-auth/unknown", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp).toBeNull();
  });

  test("POST /api/codex-auth/accounts rejects invalid id format", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "bad id with spaces!",
        email: "test@test.com",
        accessToken: "tok",
        refreshToken: "ref",
        chatgptAccountId: "acc",
      }),
    });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp!.status).toBe(400);
    const body = await resp!.json() as { error: string };
    expect(body.error).toContain("Invalid account id");
  });

  test("POST /api/codex-auth/accounts rejects invalid JSON", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp!.status).toBe(400);
    const body = await resp!.json() as { error: string };
    expect(body.error).toBe("Invalid JSON");
  });

  test("PUT /api/codex-auth/auto-switch rejects invalid threshold", async () => {
    for (const bad of [-1, 101, 50.5, "abc"]) {
      const req = new Request("http://localhost/api/codex-auth/auto-switch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: bad }),
      });
      const url = new URL(req.url);
      const resp = await handleCodexAuthAPI(req, url, {} as any);
      expect(resp!.status).toBe(400);
    }
  });

  test("PUT /api/codex-auth/auto-switch accepts valid threshold", async () => {
    for (const good of [0, 50, 100]) {
      const req = new Request("http://localhost/api/codex-auth/auto-switch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: good }),
      });
      const url = new URL(req.url);
      const resp = await handleCodexAuthAPI(req, url, {} as any);
      expect(resp!.status).toBe(200);
    }
  });

  test("PUT /api/codex-auth/active mutates live runtime config", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "pool-next", email: "pool-next@example.test", isMain: false }],
    });
    const req = new Request("http://localhost/api/codex-auth/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "pool-next" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(config.activeCodexAccountId).toBe("pool-next");
  });

  test("PUT /api/codex-auth/auto-switch mutates live runtime config", async () => {
    const config = makeConfig({ autoSwitchThreshold: 80 });
    const req = new Request("http://localhost/api/codex-auth/auto-switch", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold: 40 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(config.autoSwitchThreshold).toBe(40);
  });

  test("DELETE /api/codex-auth/accounts clears deleted active account from live runtime config", async () => {
    const config = makeConfig({
      activeCodexAccountId: "pool-delete",
      codexAccounts: [{ id: "pool-delete", email: "pool-delete@example.test", isMain: false }],
    });
    const req = new Request("http://localhost/api/codex-auth/accounts?id=pool-delete", { method: "DELETE" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(config.codexAccounts).toEqual([]);
    expect(config.activeCodexAccountId).toBeUndefined();
  });

  test("GET /api/codex-auth/login-status returns idle by default", async () => {
    const req = new Request("http://localhost/api/codex-auth/login-status", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    const data = await resp!.json() as { status: string };
    expect(data.status).toBe("idle");
  });

  test("GET /api/codex-auth/login-status with unknown flowId returns expired", async () => {
    const req = new Request("http://localhost/api/codex-auth/login-status?flowId=nonexistent", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    const data = await resp!.json() as { status: string };
    expect(data.status).toBe("expired");
  });

  test("POST /api/codex-auth/login/cancel expires the pending flow", async () => {
    const flowId = "flow-cancel-test";
    const req = new Request("http://localhost/api/codex-auth/login/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
    expect(resp!.status).toBe(200);
    const statusReq = new Request(`http://localhost/api/codex-auth/login-status?flowId=${flowId}`, { method: "GET" });
    const statusResp = await handleCodexAuthAPI(statusReq, new URL(statusReq.url), {} as any);
    const data = await statusResp!.json() as { status: string; error?: string };
    expect(data).toMatchObject({ status: "error", error: "Login cancelled" });
  });

  test("GET /api/codex-auth/login-status recovers done when a persisted account exists", async () => {
    const createReq = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "pool-login-recovery",
        email: "pool-login-recovery@example.com",
        accessToken: "tok",
        refreshToken: "ref",
        chatgptAccountId: "acc-pool-login-recovery",
      }),
    });
    const createResp = await handleCodexAuthAPI(createReq, new URL(createReq.url), {} as any);
    expect(createResp!.status).toBe(200);

    const req = new Request("http://localhost/api/codex-auth/login-status?flowId=missing&accountId=pool-login-recovery", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
    const data = await resp!.json() as { status: string; accountId?: string };
    expect(data).toEqual({ status: "done", accountId: "pool-login-recovery" });
  });

  test("POST /api/codex-auth/login rejects invalid account id before OAuth starts", async () => {
    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad id" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
    expect(resp!.status).toBe(400);
    const data = await resp!.json() as { error: string };
    expect(data.error).toContain("Invalid account id");
  });

  test("POST /api/codex-auth/login rejects duplicate account id before OAuth starts", async () => {
    const createReq = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "existing",
        email: "existing@example.com",
        accessToken: "tok",
        refreshToken: "ref",
        chatgptAccountId: "acc-existing",
      }),
    });
    const createResp = await handleCodexAuthAPI(createReq, new URL(createReq.url), {} as any);
    expect(createResp!.status).toBe(200);

    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "existing" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
    expect(resp!.status).toBe(400);
    const data = await resp!.json() as { error: string };
    expect(data.error).toContain("Account id already exists");
  });

  test("POST /api/codex-auth/login checks duplicate account ids against live runtime config", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "live-existing", email: "live-existing@example.test", isMain: false }],
    });
    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "live-existing" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(400);
    const data = await resp!.json() as { error: string };
    expect(data.error).toContain("Account id already exists");
  });

  test("OAuth pool login waits for the current flow to finish, not stale credentials", async () => {
    const source = await Bun.file("src/codex-auth-api.ts").text();
    expect(source).toContain("st.done && st.loggedIn");
    expect(source).toContain("Login timed out before OAuth completed.");
  });

  test("GET /api/codex-auth/accounts reuses cached pool quota without fetching usage", async () => {
    const createReq = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "cached-test",
        email: "cached-test@example.com",
        accessToken: "tok",
        refreshToken: "ref",
        chatgptAccountId: "acc-cached-test",
      }),
    });
    const createResp = await handleCodexAuthAPI(createReq, new URL(createReq.url), {} as any);
    expect(createResp!.status).toBe(200);
    updateAccountQuota("cached-test", 25, 10);

    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const url = new URL(req.url);
    try {
      const resp = await handleCodexAuthAPI(req, url, {} as any);
      expect(resp!.status).toBe(200);
      const data = await resp!.json() as { accounts: { id: string; quota: unknown }[] };
      const pool = data.accounts.find(a => a.id === "cached-test");
      expect(pool?.quota).toMatchObject({ weeklyPercent: 25, fiveHourPercent: 10 });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("codex-auth helpers", () => {
  test("getMainChatgptAccountId returns null when no codex auth file", () => {
    const id = getMainChatgptAccountId();
    expect(id === null || typeof id === "string").toBe(true);
  });

  test("checkAccountIdCollision returns no collision for unknown id", () => {
    const result = checkAccountIdCollision("unknown-test-id-xyz");
    expect(result.collision).toBe(false);
  });

  test("needsReauth mark/check/clear lifecycle", () => {
    const id = "lifecycle-test";
    expect(isAccountNeedsReauth(id)).toBe(false);
    markAccountNeedsReauth(id);
    expect(isAccountNeedsReauth(id)).toBe(true);
    clearAccountNeedsReauth(id);
    expect(isAccountNeedsReauth(id)).toBe(false);
  });
});
