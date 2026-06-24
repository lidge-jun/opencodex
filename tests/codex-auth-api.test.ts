import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleCodexAuthAPI, updateAccountQuota, getAccountQuota } from "../src/codex-auth-api";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-auth-api-test");

describe("codex-auth API", () => {
  beforeEach(() => {
    process.env.OPENCODEX_HOME = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    delete process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

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
    expect(body.error).toContain("too large");
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
});
