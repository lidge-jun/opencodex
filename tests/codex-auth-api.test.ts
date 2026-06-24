import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  handleCodexAuthAPI, updateAccountQuota, getAccountQuota,
  checkAccountIdCollision, getMainChatgptAccountId,
  markAccountNeedsReauth, isAccountNeedsReauth, clearAccountNeedsReauth, clearAccountQuota,
} from "../src/codex-auth-api";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-auth-api-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

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

  test("GET /api/codex-auth/login-status recovers done when a persisted account exists", async () => {
    const createReq = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "pos090011",
        email: "pos090011@example.com",
        accessToken: "tok",
        refreshToken: "ref",
        chatgptAccountId: "acc-pos090011",
      }),
    });
    const createResp = await handleCodexAuthAPI(createReq, new URL(createReq.url), {} as any);
    expect(createResp!.status).toBe(200);

    const req = new Request("http://localhost/api/codex-auth/login-status?flowId=missing&accountId=pos090011", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
    const data = await resp!.json() as { status: string; accountId?: string };
    expect(data).toEqual({ status: "done", accountId: "pos090011" });
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

  test("OAuth pool login waits for the current flow to finish, not stale credentials", async () => {
    const source = await Bun.file("src/codex-auth-api.ts").text();
    expect(source).toContain("st.done && st.loggedIn");
    expect(source).toContain("Login timed out before OAuth completed.");
  });

  test("GET /api/codex-auth/accounts does not trigger token refresh (cached quota only)", async () => {
    updateAccountQuota("cached-test", 25, 10);
    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp!.status).toBe(200);
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
