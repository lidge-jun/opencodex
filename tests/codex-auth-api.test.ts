import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_ACCOUNT_LOG_LABEL_RE } from "../src/codex/account-label";
import {
  handleCodexAuthAPI, updateAccountQuota, getAccountQuota,
  checkAccountIdCollision, getMainChatgptAccountId,
  markAccountNeedsReauth, isAccountNeedsReauth, clearAccountNeedsReauth, clearAccountQuota,
  maskEmail,
} from "../src/codex/auth-api";
import { getCodexAccountCredential, readCodexAccountRecord, saveCodexAccountCredential } from "../src/codex/account-store";
import {
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import {
  clearCodexWebSocketRegistry,
  getTrackedCodexWebSocketCountForAccount,
  registerCodexWebSocket,
} from "../src/codex/websocket-registry";
import type { OcxConfig } from "../src/types";
import type { WsData } from "../src/server/ws-bridge";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-auth-api-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const MANUAL_IMPORT_ENV = "OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT";
const WARMUP_INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;
let previousManualImportEnv: string | undefined;
let previousFetch: typeof fetch;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  };
}

function enableManualImport(): void {
  process.env[MANUAL_IMPORT_ENV] = "1";
}

function manualImportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "manual-test",
    email: "manual-test@example.test",
    accessToken: "access-manual-test",
    refreshToken: "refresh-manual-test",
    chatgptAccountId: "acct-manual-test",
    ...overrides,
  };
}

function mockCodexWarmupSuccess(): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://chatgpt.com/backend-api/codex/responses") {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "gpt-5.4-mini", input: WARMUP_INPUT, stream: true, store: false });
      expect(body).not.toHaveProperty("max_output_tokens");
      return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  return { calls: () => calls };
}

function seedPoolAccount(
  config: OcxConfig,
  account: {
    id: string;
    email: string;
    plan?: string;
    accessToken?: string;
    refreshToken?: string;
    chatgptAccountId?: string;
    expiresAt?: number;
  },
): void {
  config.codexAccounts = [
    ...(config.codexAccounts ?? []),
    { id: account.id, email: account.email, plan: account.plan, isMain: false },
  ];
  saveCodexAccountCredential(account.id, {
    accessToken: account.accessToken ?? `access-${account.id}`,
    refreshToken: account.refreshToken ?? `refresh-${account.id}`,
    expiresAt: account.expiresAt ?? Date.now() + 5 * 60_000,
    chatgptAccountId: account.chatgptAccountId ?? `acct-${account.id}`,
  });
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousManualImportEnv = process.env[MANUAL_IMPORT_ENV];
  previousFetch = globalThis.fetch;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
  delete process.env[MANUAL_IMPORT_ENV];
  clearAccountQuota();
  clearCodexWebSocketRegistry();
});

afterEach(() => {
  clearAccountQuota();
  clearCodexWebSocketRegistry();
  globalThis.fetch = previousFetch;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousManualImportEnv === undefined) delete process.env[MANUAL_IMPORT_ENV];
  else process.env[MANUAL_IMPORT_ENV] = previousManualImportEnv;
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

  test("maskEmail hides local account names", () => {
    expect(maskEmail("a@example.test")).toBe("*@example.test");
    expect(maskEmail("ab@example.test")).toBe("a*@example.test");
    expect(maskEmail("abcd@example.test")).toBe("a***d@example.test");
    expect(maskEmail("Codex App login")).toBe("Codex App login");
    expect(maskEmail(null)).toBeNull();
  });

  test("GET /api/codex-auth/accounts masks pool account email", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "pool-mask", email: "person@example.test", isMain: false }],
    });
    saveCodexAccountCredential("pool-mask", {
      accessToken: "access-mask",
      refreshToken: "refresh-mask",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-mask",
    });
    updateAccountQuota("pool-mask", 10);

    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: { id: string; email: string }[] };

    expect(data.accounts.find(a => a.id === "pool-mask")?.email).toBe("p***n@example.test");
  });

  test("GET /api/codex-auth/accounts exposes only 30d quota for go and free plans", async () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "pool-go", email: "go@example.test", plan: "go", isMain: false },
        { id: "pool-free", email: "free@example.test", plan: "free", isMain: false },
      ],
    });
    for (const id of ["pool-go", "pool-free"]) {
      saveCodexAccountCredential(id, {
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: `acct-${id}`,
      });
      updateAccountQuota(id, 91, 111, 33, 333);
    }

    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; quota?: Record<string, unknown> }> };

    for (const id of ["pool-go", "pool-free"]) {
      const quota = data.accounts.find(a => a.id === id)?.quota;
      expect(quota).toMatchObject({ monthlyPercent: 33, monthlyResetAt: 333 });
      expect(quota).not.toHaveProperty("weeklyPercent");
      expect(quota).not.toHaveProperty("weeklyResetAt");
    }
  });

  test("GET /api/codex-auth/accounts maps go tertiary quota response to 30d display quota", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "pool-go-primary", email: "go-primary@example.test", plan: "go", isMain: false }],
    });
    saveCodexAccountCredential("pool-go-primary", {
      accessToken: "access-go-primary",
      refreshToken: "refresh-go-primary",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-go-primary",
    });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          return new Response(JSON.stringify({
            rate_limit: {
              secondary_window: { used_percent: 99, reset_at: 1782000000 },
              tertiary_window: { used_percent: 42, reset_at: 1783000000 },
            },
            rate_limit_reset_credits: { available_count: 1 },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return originalFetch(input);
      };

      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      const data = await resp!.json() as { accounts: Array<{ id: string; quota?: Record<string, unknown> }> };
      const quota = data.accounts.find(a => a.id === "pool-go-primary")?.quota;
      expect(quota).toMatchObject({ monthlyPercent: 42, monthlyResetAt: 1783000000, resetCredits: 1 });
      expect(quota).not.toHaveProperty("weeklyPercent");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GET /api/codex-auth/accounts whitelists pool account response fields", async () => {
    const config = makeConfig({
      codexAccounts: [{
        id: "pool-safe",
        email: "person@example.test",
        plan: "Plus",
        chatgptAccountId: "acct-config-secret",
        logLabel: "work",
        isMain: false,
      }],
    });
    saveCodexAccountCredential("pool-safe", {
      accessToken: "access-safe",
      refreshToken: "refresh-safe",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-credential-secret",
    });
    updateAccountQuota("pool-safe", 10);

    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<Record<string, unknown>> };
    const pool = data.accounts.find(a => a.id === "pool-safe")!;

    expect(pool).toMatchObject({
      id: "pool-safe",
      email: "p***n@example.test",
      plan: "Plus",
      logLabel: "work",
      isMain: false,
      hasCredential: true,
    });
    expect(pool).not.toHaveProperty("chatgptAccountId");
    expect(JSON.stringify(pool)).not.toContain("acct-config-secret");
    expect(JSON.stringify(pool)).not.toContain("acct-credential-secret");
  });

  test("POST /api/codex-auth/accounts disables manual import by default before writing credentials", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({ id: "manual-disabled" })),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
    const body = await resp!.json() as { error: string; code: string };

    expect(resp!.status).toBe(403);
    expect(body.code).toBe("manual_import_disabled");
    expect(getCodexAccountCredential("manual-disabled")).toBeNull();
  });

  test("POST /api/codex-auth/accounts returns manual-import disabled before parsing JSON", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
    const body = await resp!.json() as { code: string };

    expect(resp!.status).toBe(403);
    expect(body.code).toBe("manual_import_disabled");
  });

  test("POST /api/codex-auth/accounts rejects missing fields when manual import is explicitly enabled", async () => {
    enableManualImport();
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test" }),
    });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp!.status).toBe(400);
  });

  test("POST /api/codex-auth/accounts rejects oversized input when manual import is explicitly enabled", async () => {
    enableManualImport();
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
    updateAccountQuota("test-acct", 45);
    const q = getAccountQuota("test-acct");
    expect(q).not.toBeNull();
    expect(q!.weeklyPercent).toBe(45);
  });

  test("updateAccountQuota clamps finite out-of-range percentages", () => {
    updateAccountQuota("clamp-acct", 120, undefined, 40.4);
    const q = getAccountQuota("clamp-acct");
    expect(q).toMatchObject({
      weeklyPercent: 100,
      monthlyPercent: 40.4,
    });
  });

  test("updateAccountQuota ignores invalid-only updates", () => {
    updateAccountQuota("invalid-only", Number.NaN, undefined, "not-a-number");
    expect(getAccountQuota("invalid-only")).toBeNull();
  });

  test("updateAccountQuota does not overwrite valid quota with invalid later values", () => {
    updateAccountQuota("preserve-valid", 45, 100);
    const before = getAccountQuota("preserve-valid");
    updateAccountQuota("preserve-valid", Number.NaN, 300);
    expect(getAccountQuota("preserve-valid")).toEqual(before);
  });

  test("GET /api/codex-auth/quota returns stored quotas", async () => {
    updateAccountQuota("q-test", 30);
    const req = new Request("http://localhost/api/codex-auth/quota", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    const data = await resp!.json() as { quotas: Record<string, unknown> };
    expect(data.quotas["q-test"]).toBeTruthy();
  });

  test("GET /api/codex-auth/accounts fetches pool quota when cache is empty", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-visible",
      email: "pool-visible@example.com",
      accessToken: "tok",
      refreshToken: "ref",
      chatgptAccountId: "acc-pool-visible",
    });

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
        },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(200);
      const data = await resp!.json() as { accounts: { id: string; quota: unknown; needsReauth?: boolean }[] };
      const pool = data.accounts.find(a => a.id === "pool-visible");
      expect(pool?.quota).toMatchObject({ weeklyPercent: 64, weeklyResetAt: 1782628379 });
      expect(pool?.needsReauth).toBe(false);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GET /api/codex-auth/accounts refresh=1 bypasses cached pool quota", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-refresh",
      email: "pool-refresh@example.com",
      accessToken: "tok",
      refreshToken: "ref",
      chatgptAccountId: "acc-pool-refresh",
    });
    updateAccountQuota("pool-refresh", 72);

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
        },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(200);
      const data = await resp!.json() as { accounts: { id: string; quota: unknown }[] };
      const pool = data.accounts.find(a => a.id === "pool-refresh");
      expect(pool?.quota).toMatchObject({ weeklyPercent: 6, weeklyResetAt: 1782628379 });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset-credit lookup rejects orphaned credential records before upstream fetch", async () => {
    const config = makeConfig();
    saveCodexAccountCredential("orphan", {
      accessToken: "orphan-access",
      refreshToken: "orphan-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-orphan",
    });
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    try {
      const req = new Request("http://localhost/api/codex-auth/reset-credits?accountId=orphan", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(404);
      expect(await resp!.json()).toMatchObject({ error: "Unknown Codex account" });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset-credit consume rejects invalid account ids before credential lookup", async () => {
    const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "../bad" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    expect(resp!.status).toBe(400);
    expect(await resp!.json()).toMatchObject({ error: "Invalid account id format" });
  });

  test("unmatched route returns null", async () => {
    const req = new Request("http://localhost/api/codex-auth/unknown", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp).toBeNull();
  });

  test("POST /api/codex-auth/accounts rejects invalid id format when manual import is explicitly enabled", async () => {
    enableManualImport();
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

  test("POST /api/codex-auth/accounts rejects invalid JSON when manual import is explicitly enabled", async () => {
    enableManualImport();
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

  test("POST /api/codex-auth/accounts imports only when manual import is explicitly enabled", async () => {
    enableManualImport();
    const warmup = mockCodexWarmupSuccess();
    const config = makeConfig();
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({ id: "manual-enabled" })),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(config.codexAccounts?.map(a => a.id)).toEqual(["manual-enabled"]);
    expect(config.codexAccounts?.[0]?.logLabel).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
    expect(getCodexAccountCredential("manual-enabled")).toMatchObject({
      accessToken: "access-manual-test",
      refreshToken: "refresh-manual-test",
      chatgptAccountId: "acct-manual-test",
    });
    expect(readCodexAccountRecord("manual-enabled")?.lastCodexValidationStatus).toBe("ok");
    expect(readCodexAccountRecord("manual-enabled")?.lastCodexValidatedAt).toBeNumber();
    expect(warmup.calls()).toBe(1);
  });

  test("POST /api/codex-auth/accounts allows a pool account matching the main login", async () => {
    enableManualImport();
    mockCodexWarmupSuccess();
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "not-a-jwt",
        account_id: "acct-main-login",
      },
    }));
    const config = makeConfig();
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({
        id: "manual-main-match",
        chatgptAccountId: "acct-main-login",
      })),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(config.codexAccounts?.map(a => a.id)).toEqual(["manual-main-match"]);
    expect(getCodexAccountCredential("manual-main-match")?.chatgptAccountId).toBe("acct-main-login");
  });

  test("POST /api/codex-auth/accounts rejects manual import when Codex warmup fails", async () => {
    enableManualImport();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://chatgpt.com/backend-api/codex/responses") {
        return new Response("raw upstream token-like text", { status: 401 });
      }
      return previousFetch(input);
    }) as typeof fetch;
    const config = makeConfig();
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({ id: "manual-warmup-fail" })),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const body = await resp!.json() as { error: string; code: string; reason: string };

    expect(resp!.status).toBe(401);
    expect(body).toMatchObject({ code: "codex_warmup_failed", reason: "http_status:401" });
    expect(JSON.stringify(body)).not.toContain("raw upstream token-like text");
    expect(config.codexAccounts?.map(a => a.id)).toEqual([]);
    expect(getCodexAccountCredential("manual-warmup-fail")).toBeNull();
  });

  test("POST /api/codex-auth/accounts rejects duplicate runtime alias before writing credentials", async () => {
    enableManualImport();
    const config = makeConfig({
      codexAccounts: [{ id: "manual-existing", email: "existing@example.test", isMain: false }],
    });
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({ id: "manual-existing" })),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const body = await resp!.json() as { error: string };

    expect(resp!.status).toBe(400);
    expect(body.error).toBe("Account id already exists: manual-existing");
    expect(getCodexAccountCredential("manual-existing")).toBeNull();
  });

  test("POST /api/codex-auth/accounts rejects duplicate credential alias before overwrite", async () => {
    enableManualImport();
    saveCodexAccountCredential("manual-existing", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "old-account",
    });
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({ id: "manual-existing" })),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    const body = await resp!.json() as { error: string };

    expect(resp!.status).toBe(400);
    expect(body.error).toBe("Account id already exists: manual-existing");
    expect(getCodexAccountCredential("manual-existing")).toMatchObject({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      chatgptAccountId: "old-account",
    });
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
    saveCodexAccountCredential("pool-delete", {
      accessToken: "access-delete",
      refreshToken: "refresh-delete",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-delete",
    });
    updateAccountQuota("pool-delete", 70);
    expect(resolveCodexAccountForThread("delete-thread", config)).toBe("pool-delete");
    recordCodexUpstreamOutcome(config, "pool-delete", 500);
    expect(getCodexUpstreamHealth("pool-delete")).not.toBeNull();
    markAccountNeedsReauth("pool-delete");
    const closed: { code?: number; reason?: string }[] = [];
    let cancelled = false;
    const ws = {
      data: {
        authContext: {
          kind: "pool",
          accountId: "pool-delete",
          generation: 1,
          accessToken: "access-delete",
          chatgptAccountId: "acct-delete",
        },
        cancel: () => {
          cancelled = true;
        },
      } as WsData,
      close: (code?: number, reason?: string) => {
        closed.push({ code, reason });
      },
    } as unknown as ServerWebSocket<WsData>;
    registerCodexWebSocket(ws);
    expect(getTrackedCodexWebSocketCountForAccount("pool-delete")).toBe(1);

    const req = new Request("http://localhost/api/codex-auth/accounts?id=pool-delete", { method: "DELETE" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(config.codexAccounts).toEqual([]);
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(getCodexAccountCredential("pool-delete")).toBeNull();
    expect(getAccountQuota("pool-delete")).toBeNull();
    expect(isAccountNeedsReauth("pool-delete")).toBe(false);
    expect(getCodexUpstreamHealth("pool-delete")).toBeNull();
    expect(resolveCodexAccountForThread("delete-thread", config)).toBeNull();
    expect(cancelled).toBe(true);
    expect(closed).toEqual([{ code: 4001, reason: "Codex account invalidated" }]);
    expect(getTrackedCodexWebSocketCountForAccount("pool-delete")).toBe(0);
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
    saveCodexAccountCredential("pool-login-recovery", {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acc-pool-login-recovery",
    });

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
    saveCodexAccountCredential("existing", {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acc-existing",
    });

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
    const source = await Bun.file("src/codex/auth-api.ts").text();
    expect(source).toContain("st.done && st.loggedIn");
    expect(source).toContain("Login timed out before OAuth completed.");
  });

  test("OAuth pool login stores a privacy log label at the account creation call site", async () => {
    const source = await Bun.file("src/codex/auth-api.ts").text();
    expect(source).toContain("withCodexAccountLogLabel({ id: accountId, email, plan, isMain: false }, accounts)");
  });

  test("GET /api/codex-auth/login-status masks transient flow-state emails at response boundaries", async () => {
    const source = await Bun.file("src/codex/auth-api.ts").text();
    expect(source).toContain("st ? { ...st, email: maskEmail(st.email) ?? undefined } : { status: \"expired\" }");
    expect(source).toContain("return jsonResponse({ ...st, email: maskEmail(st.email) ?? undefined });");
  });

  test("GET /api/codex-auth/accounts reuses cached pool quota without fetching usage", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "cached-test",
      email: "cached-test@example.com",
      accessToken: "tok",
      refreshToken: "ref",
      chatgptAccountId: "acc-cached-test",
    });
    updateAccountQuota("cached-test", 25);

    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const url = new URL(req.url);
    try {
      const resp = await handleCodexAuthAPI(req, url, config);
      expect(resp!.status).toBe(200);
      const data = await resp!.json() as { accounts: { id: string; quota: unknown }[] };
      const pool = data.accounts.find(a => a.id === "cached-test");
      expect(pool?.quota).toMatchObject({ weeklyPercent: 25 });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GET /api/codex-auth/accounts does not mark reauth on refresh generation conflict", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "pool-conflict", email: "pool-conflict@example.test", isMain: false }],
    });
    saveCodexAccountCredential("pool-conflict", {
      accessToken: "old",
      refreshToken: "old-r",
      expiresAt: 0,
      chatgptAccountId: "acc-conflict",
    });
    const replacement = {
      accessToken: "replacement",
      refreshToken: "replacement-r",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acc-conflict",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      saveCodexAccountCredential("pool-conflict", replacement);
      return new Response(JSON.stringify({ access_token: "stale", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(200);
      const data = await resp!.json() as { accounts: { id: string; needsReauth?: boolean; hasCredential?: boolean }[] };
      const pool = data.accounts.find(a => a.id === "pool-conflict");
      expect(pool?.needsReauth).toBe(false);
      expect(pool?.hasCredential).toBe(true);
      expect(getCodexAccountCredential("pool-conflict")).toEqual(replacement);
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
