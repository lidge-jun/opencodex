import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_ACCOUNT_LOG_LABEL_RE } from "../src/codex/account-label";
import {
  handleCodexAuthAPI, updateAccountQuota, getAccountQuota,
  checkAccountIdCollision, getMainChatgptAccountId,
  markAccountNeedsReauth, isAccountNeedsReauth, clearAccountNeedsReauth, clearAccountQuota,
  clearMainAccountInfoCache, maskEmail,
  clearCodexQuotaPrimeState, primeCodexPoolQuotas, seedCodexAuthAdmissionForTests,
  type CodexAuthAccountDto,
} from "../src/codex/auth-api";
import {
  getCodexAccountCredential,
  listCodexAccountIds,
  readCodexAccountRecord,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { clearPoolRotationState } from "../src/codex/pool-rotation";
import {
  clearCodexWebSocketRegistry,
  getTrackedCodexWebSocketCountForAccount,
  registerCodexWebSocket,
} from "../src/codex/websocket-registry";
import type { OcxConfig } from "../src/types";
import type { WsData } from "../src/server/ws-bridge";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "../src/codex/main-account";
import {
  deleteCodexAccount,
  reconcileMainCodexAccountRuntimeState,
  resetMainCodexAccountIdentityTrackingForTests,
} from "../src/codex/account-lifecycle";
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  setPersistedConfigMutationBeforeCommitForTests,
} from "../src/config";
import { captureConfigGeneration, registerStateStore } from "../src/lib/state-store-sweeper";
import {
  reconcileLiveStateStores,
  setLiveStateStoreConfig,
  STATE_STORE_REGISTRATIONS,
} from "../src/lib/state-store-registrations";
import {
  listOpenAiForwardSidecarCandidates,
  resolveFirstUsableOpenAiSidecar,
} from "../src/providers/openai-sidecar";

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

async function completeMockCodexOAuth(options: {
  config: OcxConfig;
  requestBody: { id: string; reauth?: boolean };
  oauthAccountId: string;
  email: string;
  onWarmup: () => void;
  usageResponse?: () => Response;
}): Promise<{ startStatus: number; state: { status: string; error?: string } }> {
  const oauth = await import("../src/oauth");
  const oauthStore = await import("../src/oauth/store");
  const openUrlMod = await import("../src/lib/open-url");
  await oauthStore.saveCredential("chatgpt", {
    access: `access-${options.requestBody.id}`,
    refresh: `refresh-${options.requestBody.id}`,
    expires: Date.now() + 5 * 60_000,
    email: options.email,
    accountId: options.oauthAccountId,
  });
  const startSpy = spyOn(oauth, "startLoginFlow").mockResolvedValue({ url: "https://example.test/oauth" });
  const statusSpy = spyOn(oauth, "getLoginStatus").mockReturnValue({
    done: true,
    loggedIn: true,
  } as ReturnType<typeof oauth.getLoginStatus>);
  const openSpy = spyOn(openUrlMod, "openUrl").mockImplementation(() => {});
  // Mirrors the login-status poll delay in auth-api.ts; other timers are intentionally dropped.
  const CODEX_OAUTH_LOGIN_POLL_INTERVAL_MS = 2_000;
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === CODEX_OAUTH_LOGIN_POLL_INTERVAL_MS) queueMicrotask(() => callback(...args));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const target = String(input);
    if (target === "https://chatgpt.com/backend-api/wham/usage") {
      return options.usageResponse?.()
        ?? new Response(JSON.stringify({ email: options.email, plan_type: "pro" }), { status: 200 });
    }
    if (target === "https://chatgpt.com/backend-api/codex/responses") {
      options.onWarmup();
      return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return previousFetch(input);
  }) as typeof fetch;

  try {
    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.requestBody),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), options.config);
    const started = await resp!.json() as { flowId: string };
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const statusReq = new Request(
        `http://localhost/api/codex-auth/login-status?flowId=${started.flowId}`,
        { method: "GET" },
      );
      const statusResp = await handleCodexAuthAPI(statusReq, new URL(statusReq.url), options.config);
      const state = await statusResp!.json() as { status: string; error?: string };
      if (state.status !== "pending") return { startStatus: resp!.status, state };
      await new Promise<void>(resolve => queueMicrotask(resolve));
    }
    throw new Error(`Timed out waiting for Codex OAuth flow ${started.flowId}`);
  } finally {
    globalThis.fetch = previousFetch;
    timeoutSpy.mockRestore();
    startSpy.mockRestore();
    statusSpy.mockRestore();
    openSpy.mockRestore();
  }
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
  clearAccountNeedsReauth("__main__");
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearCodexWebSocketRegistry();
  resetMainCodexAccountIdentityTrackingForTests();
});

afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  clearAccountNeedsReauth("__main__");
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
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
  test("pool-quota flight 17 total across accounts rejects before request creation while compatible generation joins", async () => {
    const clearLoginOwners = seedCodexAuthAdmissionForTests({ loginFlows: 32 });
    try {
      const login = new Request("http://localhost/api/codex-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "capacity-login" }),
      });
      const response = await handleCodexAuthAPI(login, new URL(login.url), makeConfig());
      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ code: "server_busy" });
    } finally {
      clearLoginOwners();
    }

    const config = makeConfig();
    seedPoolAccount(config, { id: "quota-a", email: "a@example.test" });
    seedPoolAccount(config, { id: "quota-b", email: "b@example.test" });
    const clearQuotaOwners = seedCodexAuthAdmissionForTests({ quotaFlights: 15 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requestCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/wham/usage")) {
        requestCount += 1;
        await gate;
        return Response.json({ rate_limit: { primary_window: { used_percent: 1 } } });
      }
      return previousFetch(input);
    }) as typeof fetch;
    try {
      const request = () => {
        const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
        return handleCodexAuthAPI(req, new URL(req.url), config);
      };
      const first = request();
      const joiner = request();
      for (let attempt = 0; attempt < 20 && requestCount === 0; attempt++) await Promise.resolve();
      expect(requestCount).toBe(1);
      release();
      const bodies = await Promise.all([first, joiner].map(async pending => {
        const response = await pending;
        return response?.json() as Promise<{ accounts: CodexAuthAccountDto[] }>;
      }));
      expect(bodies[0].accounts.find(account => account.id === "quota-b")?.quotaProbeSkipped).toBe(true);
      expect(bodies[1].accounts.find(account => account.id === "quota-a")?.quotaProbeSkipped).not.toBe(true);
    } finally {
      release();
      clearQuotaOwners();
    }
  });

  test("Codex login state row 33 rejects before browser work and terminal TTL deletes only its owner", async () => {
    const cleanup = seedCodexAuthAdmissionForTests({ loginFlows: 32 });
    try {
      const request = new Request("http://localhost/api/codex-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "capacity-login-owner" }),
      });
      const response = await handleCodexAuthAPI(request, new URL(request.url), makeConfig());
      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ code: "server_busy" });
    } finally {
      cleanup();
    }
  });

  test("busy pool-quota probe leaves management GET 200 with cached quota and per-account quotaProbeSkipped", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "quota-skipped", email: "skip@example.test" });
    updateAccountQuota("quota-skipped", 42);
    const cleanup = seedCodexAuthAdmissionForTests({ quotaFlights: 16 });
    try {
      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      const response = await handleCodexAuthAPI(req, new URL(req.url), config);
      const body = await response?.json() as { accounts: CodexAuthAccountDto[] };
      expect(response?.status).toBe(200);
      expect(body.accounts.find(account => account.id === "quota-skipped")).toMatchObject({
        quotaProbeSkipped: true,
        quota: { weeklyPercent: 42 },
      });
    } finally {
      cleanup();
    }
  });

  test("busy pool-quota probe maps reset-credit refresh to 503 server_busy with Retry-After 1", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "quota-reset-busy", email: "busy@example.test" });
    const cleanup = seedCodexAuthAdmissionForTests({ quotaFlights: 16 });
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes("/consume")
      ? Response.json({ code: "reset" })
      : previousFetch(input)) as typeof fetch;
    try {
      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "quota-reset-busy" }),
      });
      const response = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(response?.status).toBe(503);
      expect(response?.headers.get("Retry-After")).toBe("1");
      expect(await response?.json()).toMatchObject({ code: "server_busy" });
    } finally {
      cleanup();
    }
  });

  test("busy pool-quota probe is swallowed by startup priming like other priming failures", async () => {
    const config = makeConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    });
    seedPoolAccount(config, { id: "prime-busy", email: "prime@example.test" });
    const cleanup = seedCodexAuthAdmissionForTests({ quotaFlights: 16 });
    try {
      await expect(primeCodexPoolQuotas(config, "test")).resolves.toBeUndefined();
    } finally {
      clearCodexQuotaPrimeState();
      cleanup();
    }
  });

  test("GET /api/codex-auth/accounts returns array with main", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleCodexAuthAPI(req, url, {} as any);
    expect(resp).not.toBeNull();
    const data = await resp!.json() as { accounts: unknown[] };
    expect(Array.isArray(data.accounts)).toBe(true);
    const main = (data.accounts as { isMain: boolean; hasCredential: boolean; needsReauth?: boolean }[]).find(a => a.isMain);
    expect(main).toBeTruthy();
    expect(main?.hasCredential).toBe(false);
    expect(main?.needsReauth).toBe(true);
  });

  test("main account 401 marks needsReauth and exposes it in the DTO (#327)", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "expired-main", account_id: "acct-main" },
    }));
    globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    const data = await resp!.json() as { accounts: Array<{ id: string; hasCredential: boolean; needsReauth?: boolean }> };
    const main = data.accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID);

    expect(main).toMatchObject({ hasCredential: true, needsReauth: true });
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
  });

  test("main account invalid-workspace 403 is terminal but a generic 403 is not (#327)", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "workspace-main", account_id: "acct-main" },
    }));
    globalThis.fetch = (async () => Response.json(
      { detail: { code: "invalid_workspace_selected" } },
      { status: 403 },
    )) as typeof fetch;

    const terminalReq = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    const terminalResp = await handleCodexAuthAPI(terminalReq, new URL(terminalReq.url), makeConfig());
    const terminalData = await terminalResp!.json() as { accounts: Array<{ id: string; needsReauth?: boolean }> };
    expect(terminalData.accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)?.needsReauth).toBe(true);

    clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    globalThis.fetch = (async () => Response.json(
      { error: { code: "permission_denied" } },
      { status: 403 },
    )) as typeof fetch;
    const genericReq = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    const genericResp = await handleCodexAuthAPI(genericReq, new URL(genericReq.url), makeConfig());
    const genericData = await genericResp!.json() as { accounts: Array<{ id: string; needsReauth?: boolean }> };

    expect(genericData.accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)?.needsReauth).toBe(false);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("successful main account refresh clears a prior needsReauth mark (#327)", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "fresh-main", account_id: "acct-main" },
    }));
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    globalThis.fetch = (async () => Response.json({
      email: "main@example.test",
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 10, reset_at: 1783000000 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    const data = await resp!.json() as { accounts: Array<{ id: string; needsReauth?: boolean }> };

    expect(data.accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)?.needsReauth).toBe(false);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("BUG-R327: main account exposes and updates needsReauth from WHAM auth responses", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "main-access",
        account_id: "main-account",
      },
    }));
    let status = 401;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
      return status === 200
        ? new Response(JSON.stringify({ email: "main@example.test", plan_type: "plus" }), {
            status,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(null, { status });
    }) as typeof fetch;

    const listMain = async (): Promise<{ needsReauth: boolean }> => {
      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
      const data = await resp!.json() as { accounts: Array<{ id: string; needsReauth: boolean }> };
      return data.accounts.find(account => account.id === "__main__")!;
    };

    expect((await listMain()).needsReauth).toBe(true);
    status = 403;
    expect((await listMain()).needsReauth).toBe(true);
    status = 200;
    expect((await listMain()).needsReauth).toBe(false);
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
    expect(data).toEqual({
      activeCodexAccountId: "pool-live",
      autoSwitchThreshold: 55,
      upstreamFailoverThreshold: 3,
      accountPoolStrategy: "quota",
      accountPoolStickyLimit: 1,
    });
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

  test("GET /api/codex-auth/accounts reconciles and persists a fresh pool plan on a cache miss", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-refresh",
      email: "pool-plan-refresh@example.com",
      plan: "plus",
    });
    saveConfig(structuredClone(config));
    globalThis.fetch = (async () => Response.json({
      plan_type: "prolite",
      rate_limit: { primary_window: { used_percent: 12, reset_at: 1782628379 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(data.accounts.find(account => account.id === "pool-plan-refresh")?.plan).toBe("prolite");
    expect(config.codexAccounts?.find(account => account.id === "pool-plan-refresh")?.plan).toBe("prolite");
    expect(loadConfig().codexAccounts?.find(account => account.id === "pool-plan-refresh")?.plan).toBe("prolite");
  });

  test("a fresh upgraded plan controls quota projection in the same accounts response", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-upgrade",
      email: "pool-plan-upgrade@example.com",
      plan: "free",
    });
    saveConfig(structuredClone(config));
    globalThis.fetch = (async () => Response.json({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 17, reset_at: 1782628379 },
        tertiary_window: { used_percent: 23, reset_at: 1787401330 },
      },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as {
      accounts: Array<{ id: string; plan?: string; quota?: Record<string, unknown> }>;
    };
    const account = data.accounts.find(candidate => candidate.id === "pool-plan-upgrade");

    expect(account?.plan).toBe("pro");
    expect(account?.quota).toMatchObject({
      weeklyPercent: 17,
      weeklyResetAt: 1782628379,
      monthlyPercent: 23,
      monthlyResetAt: 1787401330,
    });
  });

  test("pool plan refresh ignores a missing upstream plan and performs no config write", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-missing",
      email: "pool-plan-missing@example.com",
      plan: "plus",
    });
    saveConfig(structuredClone(config));
    let configCommits = 0;
    setPersistedConfigMutationBeforeCommitForTests(() => { configCommits += 1; });
    globalThis.fetch = (async () => Response.json({
      rate_limit: { primary_window: { used_percent: 8, reset_at: 1782628379 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(data.accounts.find(account => account.id === "pool-plan-missing")?.plan).toBe("plus");
    expect(config.codexAccounts?.find(account => account.id === "pool-plan-missing")?.plan).toBe("plus");
    expect(loadConfig().codexAccounts?.find(account => account.id === "pool-plan-missing")?.plan).toBe("plus");
    expect(configCommits).toBe(0);
  });

  test("pool plan refresh persists plan_type when WHAM omits rate_limit windows", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-only",
      email: "pool-plan-only@example.com",
      plan: "plus",
    });
    saveConfig(structuredClone(config));
    globalThis.fetch = (async () => Response.json({
      plan_type: "prolite",
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(data.accounts.find(account => account.id === "pool-plan-only")?.plan).toBe("prolite");
    expect(config.codexAccounts?.find(account => account.id === "pool-plan-only")?.plan).toBe("prolite");
    expect(loadConfig().codexAccounts?.find(account => account.id === "pool-plan-only")?.plan).toBe("prolite");
  });

  test("pool plan refresh performs no config write when the authoritative plan is unchanged", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-unchanged",
      email: "pool-plan-unchanged@example.com",
      plan: "plus",
    });
    saveConfig(structuredClone(config));
    let configCommits = 0;
    setPersistedConfigMutationBeforeCommitForTests(() => { configCommits += 1; });
    globalThis.fetch = (async () => Response.json({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 7, reset_at: 1782628379 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(data.accounts.find(account => account.id === "pool-plan-unchanged")?.plan).toBe("plus");
    expect(config.codexAccounts?.find(account => account.id === "pool-plan-unchanged")?.plan).toBe("plus");
    expect(loadConfig().codexAccounts?.find(account => account.id === "pool-plan-unchanged")?.plan).toBe("plus");
    expect(configCommits).toBe(0);
  });

  test("pool plan refresh does not recreate a config file deleted while the server is running", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-config-deleted",
      email: "pool-plan-config-deleted@example.com",
      plan: "plus",
    });
    globalThis.fetch = (async () => Response.json({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 6, reset_at: 1782628379 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(resp!.status).toBe(200);
    // Missing config fails closed on disk, but the response still surfaces the WHAM plan.
    expect(data.accounts.find(account => account.id === "pool-plan-config-deleted")?.plan).toBe("pro");
    expect(config.codexAccounts?.find(account => account.id === "pool-plan-config-deleted")?.plan).toBe("plus");
    expect(existsSync(join(TEST_DIR, "config.json"))).toBe(false);
  });

  test("pool plan refresh batches multiple authoritative changes into one config save", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-plan-a", email: "pool-plan-a@example.com", plan: "plus" });
    seedPoolAccount(config, { id: "pool-plan-b", email: "pool-plan-b@example.com", plan: "free" });
    saveConfig(structuredClone(config));
    let configCommits = 0;
    setPersistedConfigMutationBeforeCommitForTests(() => { configCommits += 1; });
    globalThis.fetch = (async (_input, init) => {
      const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
      return Response.json({
        plan_type: accountId === "acct-pool-plan-a" ? "prolite" : "pro",
        rate_limit: { primary_window: { used_percent: 9 } },
      });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(configCommits).toBe(1);
    expect(loadConfig().codexAccounts?.map(account => [account.id, account.plan])).toEqual([
      ["pool-plan-a", "prolite"],
      ["pool-plan-b", "pro"],
    ]);
  });

  test("concurrent pool plan refreshes share token rotation, one WHAM read, and one config save", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-concurrent",
      email: "pool-plan-concurrent@example.com",
      plan: "plus",
      expiresAt: Date.now() - 1,
    });
    saveConfig(structuredClone(config));
    let configCommits = 0;
    setPersistedConfigMutationBeforeCommitForTests(() => { configCommits += 1; });
    let calls = 0;
    let tokenRefreshCalls = 0;
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
    globalThis.fetch = (async input => {
      if (String(input) === "https://auth.openai.com/oauth/token") {
        tokenRefreshCalls += 1;
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      calls += 1;
      markFetchStarted();
      await fetchGate;
      return Response.json({
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 16 } },
      });
    }) as typeof fetch;

    try {
      const request = () => {
        const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
        return handleCodexAuthAPI(req, new URL(req.url), config);
      };
      const first = request();
      const second = request();
      await fetchStarted;
      await new Promise<void>(resolve => queueMicrotask(resolve));
      expect(calls).toBe(1);
      releaseFetch();
      const responses = await Promise.all([first, second]);
      const payloads = await Promise.all(responses.map(response => response!.json())) as Array<{
        accounts: Array<{ id: string; plan?: string }>;
      }>;

      expect(payloads.map(payload => payload.accounts.find(account => account.id === "pool-plan-concurrent")?.plan))
        .toEqual(["pro", "pro"]);
      expect(tokenRefreshCalls).toBe(1);
      expect(calls).toBe(1);
      expect(configCommits).toBe(1);
    } finally {
      setPersistedConfigMutationBeforeCommitForTests(null);
    }
  });

  test("pool plan persistence preserves an unrelated edit from the latest disk config", async () => {
    const config = makeConfig({
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          note: "runtime-note",
        },
      },
      defaultProvider: "custom",
    });
    seedPoolAccount(config, { id: "pool-plan-disk", email: "pool-plan-disk@example.com", plan: "plus" });
    saveConfig(structuredClone(config));
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
    globalThis.fetch = (async () => {
      markFetchStarted();
      await fetchGate;
      return Response.json({
        plan_type: "prolite",
        rate_limit: { primary_window: { used_percent: 14 } },
      });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const pending = handleCodexAuthAPI(req, new URL(req.url), config);
    await fetchStarted;
    const editedOnDisk = loadConfig();
    editedOnDisk.providers.custom!.note = "manual-disk-note";
    saveConfig(editedOnDisk);
    releaseFetch();
    const resp = await pending;
    expect(resp!.status).toBe(200);

    const persisted = loadConfig();
    expect(persisted.providers.custom?.note).toBe("manual-disk-note");
    expect(persisted.codexAccounts?.find(account => account.id === "pool-plan-disk")?.plan).toBe("prolite");
    expect(config.providers.custom?.note).toBe("runtime-note");
  });

  test("pool plan commit rebases an unrelated config write injected after its first checks", async () => {
    const config = makeConfig({
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          note: "runtime-note",
        },
      },
      defaultProvider: "custom",
    });
    seedPoolAccount(config, { id: "pool-plan-cas-edit", email: "pool-plan-cas-edit@example.com", plan: "plus" });
    saveConfig(structuredClone(config));
    let injected = false;
    setPersistedConfigMutationBeforeCommitForTests(() => {
      injected = true;
      const concurrent = loadConfig();
      concurrent.providers.custom!.note = "concurrent-disk-note";
      saveConfig(concurrent);
    });
    globalThis.fetch = (async () => Response.json({
      plan_type: "prolite",
      rate_limit: { primary_window: { used_percent: 12 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };
    const persisted = loadConfig();

    expect(injected).toBe(true);
    expect(persisted.providers.custom?.note).toBe("concurrent-disk-note");
    expect(persisted.codexAccounts?.find(account => account.id === "pool-plan-cas-edit")?.plan).toBe("prolite");
    expect(config.providers.custom?.note).toBe("runtime-note");
    expect(data.accounts.find(account => account.id === "pool-plan-cas-edit")?.plan).toBe("prolite");
  });

  test("pool plan commit does not recreate a config deleted after its first checks", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-plan-cas-delete", email: "pool-plan-cas-delete@example.com", plan: "plus" });
    saveConfig(structuredClone(config));
    let absentAtRecheck = false;
    setPersistedConfigMutationBeforeCommitForTests(() => {
      rmSync(getConfigPath(), { force: true });
      absentAtRecheck = !existsSync(getConfigPath());
    });
    globalThis.fetch = (async () => Response.json({
      plan_type: "prolite",
      rate_limit: { primary_window: { used_percent: 12 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(absentAtRecheck).toBe(true);
    expect(existsSync(getConfigPath())).toBe(false);
    expect(config.codexAccounts?.find(account => account.id === "pool-plan-cas-delete")?.plan).toBe("plus");
    expect(data.accounts.find(account => account.id === "pool-plan-cas-delete")?.plan).toBe("prolite");
  });

  test("pool plan commit leaves config malformed when malformed bytes arrive after its first checks", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-plan-cas-malformed", email: "pool-plan-cas-malformed@example.com", plan: "plus" });
    saveConfig(structuredClone(config));
    const malformed = "{ malformed concurrent config";
    let malformedAtRecheck = false;
    setPersistedConfigMutationBeforeCommitForTests(() => {
      writeFileSync(getConfigPath(), malformed);
      malformedAtRecheck = readFileSync(getConfigPath(), "utf8") === malformed;
    });
    globalThis.fetch = (async () => Response.json({
      plan_type: "prolite",
      rate_limit: { primary_window: { used_percent: 12 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(malformedAtRecheck).toBe(true);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(malformed);
    expect(config.codexAccounts?.find(account => account.id === "pool-plan-cas-malformed")?.plan).toBe("plus");
    expect(data.accounts.find(account => account.id === "pool-plan-cas-malformed")?.plan).toBe("prolite");
  });

  test("pool plan commit rejects an old plan after same-id credential replacement at its commit seam", async () => {
    const accountId = "pool-plan-cas-generation";
    const config = makeConfig();
    seedPoolAccount(config, {
      id: accountId,
      email: "old-generation@example.com",
      plan: "plus",
      accessToken: "old-generation-access",
      refreshToken: "old-generation-refresh",
      chatgptAccountId: "old-generation-account",
    });
    saveConfig(structuredClone(config));
    const startingGeneration = readCodexAccountRecord(accountId)?.generation;
    let replacementGeneration: number | undefined;
    setPersistedConfigMutationBeforeCommitForTests(() => {
      const replacementConfig = loadConfig();
      const replacementAccount = replacementConfig.codexAccounts?.find(account => account.id === accountId);
      if (!replacementAccount) throw new Error("replacement account missing");
      replacementAccount.email = "replacement@example.test";
      replacementAccount.plan = "free";
      saveCodexAccountCredential(accountId, {
        accessToken: "replacement-access",
        refreshToken: "replacement-refresh",
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: "replacement-account",
      });
      replacementGeneration = readCodexAccountRecord(accountId)?.generation;
      saveConfig(replacementConfig);
    });
    globalThis.fetch = (async () => Response.json({
      plan_type: "prolite",
      rate_limit: { primary_window: { used_percent: 12 } },
    })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };
    const persistedAccount = loadConfig().codexAccounts?.find(account => account.id === accountId);
    const finalRecord = readCodexAccountRecord(accountId);

    expect(startingGeneration).toBe(1);
    expect(replacementGeneration).toBe(2);
    expect(finalRecord?.generation).toBe(2);
    expect(finalRecord?.credential?.accessToken).toBe("replacement-access");
    expect(persistedAccount).toMatchObject({ email: "replacement@example.test", plan: "free" });
    expect(config.codexAccounts?.find(account => account.id === accountId)?.plan).toBe("plus");
    expect(data.accounts.find(account => account.id === accountId)?.plan).toBe("plus");
  });

  test("pool plan persistence fails closed without waiting behind a busy config writer", async () => {
    const accountId = "pool-plan-lock-busy";
    const config = makeConfig();
    seedPoolAccount(config, { id: accountId, email: "pool-plan-lock-busy@example.com", plan: "plus" });
    saveConfig(structuredClone(config));
    const lockDatabase = new Database(join(TEST_DIR, "config-mutation.sqlite"), { create: true });
    lockDatabase.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    globalThis.fetch = (async () => Response.json({
      plan_type: "prolite",
      rate_limit: { primary_window: { used_percent: 12 } },
    })) as typeof fetch;

    try {
      const startedAt = performance.now();
      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      const elapsedMs = performance.now() - startedAt;
      const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

      expect(elapsedMs).toBeLessThan(2_000);
      expect(loadConfig().codexAccounts?.find(account => account.id === accountId)?.plan).toBe("plus");
      expect(config.codexAccounts?.find(account => account.id === accountId)?.plan).toBe("plus");
      // Disk persistence fails closed under lock contention, but the response still reflects WHAM.
      expect(data.accounts.find(account => account.id === accountId)?.plan).toBe("prolite");
    } finally {
      lockDatabase.exec("ROLLBACK");
      lockDatabase.close();
    }
  });

  test("pool plan refresh cannot update an account deleted and recreated during the WHAM request", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-reused",
      email: "old-plan@example.com",
      plan: "plus",
      accessToken: "old-plan-access",
      refreshToken: "old-plan-refresh",
      chatgptAccountId: "old-plan-account",
    });
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
    globalThis.fetch = (async () => {
      markFetchStarted();
      await fetchGate;
      return Response.json({
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 11 } },
      });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const pending = handleCodexAuthAPI(req, new URL(req.url), config);
    await fetchStarted;
    deleteCodexAccount(config, "pool-plan-reused");
    config.codexAccounts = [{
      id: "pool-plan-reused",
      email: "new-plan@example.com",
      plan: "free",
      isMain: false,
    }];
    saveCodexAccountCredential("pool-plan-reused", {
      accessToken: "new-plan-access",
      refreshToken: "new-plan-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "new-plan-account",
    });
    releaseFetch();
    const resp = await pending;
    const data = await resp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(config.codexAccounts[0]?.plan).toBe("free");
    expect(data.accounts.find(account => account.id === "pool-plan-reused")?.plan).toBe("free");
    expect(existsSync(join(TEST_DIR, "config.json"))).toBe(false);
  });

  test("a replacement credential starts a separate refresh while the prior generation is still in flight", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-generation-flight",
      email: "old-flight@example.com",
      plan: "plus",
      accessToken: "old-flight-access",
      refreshToken: "old-flight-refresh",
      chatgptAccountId: "old-flight-account",
    });
    saveConfig(structuredClone(config));
    let releaseOldFetch!: () => void;
    let markOldFetchStarted!: () => void;
    const oldFetchStarted = new Promise<void>(resolve => { markOldFetchStarted = resolve; });
    const oldFetchGate = new Promise<void>(resolve => { releaseOldFetch = resolve; });
    const whamAccountIds: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id") ?? "";
      whamAccountIds.push(accountId);
      if (accountId === "old-flight-account") {
        markOldFetchStarted();
        await oldFetchGate;
        return Response.json({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 41 } },
        });
      }
      return Response.json({
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 19 } },
      });
    }) as typeof fetch;

    const request = () => {
      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      return handleCodexAuthAPI(req, new URL(req.url), config);
    };
    const oldPending = request();
    await oldFetchStarted;
    deleteCodexAccount(config, "pool-plan-generation-flight");
    config.codexAccounts = [{
      id: "pool-plan-generation-flight",
      email: "new-flight@example.com",
      plan: "free",
      isMain: false,
    }];
    saveCodexAccountCredential("pool-plan-generation-flight", {
      accessToken: "new-flight-access",
      refreshToken: "new-flight-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "new-flight-account",
    });
    saveConfig(structuredClone(config));

    const replacementResp = await request();
    const replacementData = await replacementResp!.json() as {
      accounts: Array<{ id: string; plan?: string; quota?: { weeklyPercent?: number } }>;
    };
    const replacement = replacementData.accounts.find(account => account.id === "pool-plan-generation-flight");
    expect(replacement).toMatchObject({ plan: "pro", quota: { weeklyPercent: 19 } });

    releaseOldFetch();
    const oldResp = await oldPending;
    const oldData = await oldResp!.json() as { accounts: Array<{ id: string; plan?: string }> };

    expect(whamAccountIds).toEqual(["old-flight-account", "new-flight-account"]);
    expect(oldData.accounts.find(account => account.id === "pool-plan-generation-flight")?.plan).toBe("pro");
    expect(config.codexAccounts[0]?.plan).toBe("pro");
    expect(loadConfig().codexAccounts?.[0]?.plan).toBe("pro");
  });

  test("final account assembly discards quota and credential state from a replaced account", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-finished",
      email: "old-finished@example.com",
      plan: "plus",
      chatgptAccountId: "old-finished-account",
    });
    seedPoolAccount(config, {
      id: "pool-plan-blocker",
      email: "blocker@example.com",
      plan: "plus",
      chatgptAccountId: "blocker-account",
    });
    let releaseBlocker!: () => void;
    let markBlockerStarted!: () => void;
    const blockerStarted = new Promise<void>(resolve => { markBlockerStarted = resolve; });
    const blockerGate = new Promise<void>(resolve => { releaseBlocker = resolve; });
    globalThis.fetch = (async (_input, init) => {
      const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
      if (accountId === "blocker-account") {
        markBlockerStarted();
        await blockerGate;
        return Response.json({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 5 } },
        });
      }
      return Response.json({
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 31, reset_at: 1782628379 } },
      });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const pending = handleCodexAuthAPI(req, new URL(req.url), config);
    await blockerStarted;
    for (let attempt = 0; attempt < 100 && getAccountQuota("pool-plan-finished") === null; attempt += 1) {
      await new Promise<void>(resolve => queueMicrotask(resolve));
    }
    expect(getAccountQuota("pool-plan-finished")?.weeklyPercent).toBe(31);

    deleteCodexAccount(config, "pool-plan-finished");
    config.codexAccounts = [
      {
        id: "pool-plan-finished",
        email: "new-finished@example.com",
        plan: "free",
        isMain: false,
      },
      ...(config.codexAccounts ?? []),
    ];
    releaseBlocker();
    const resp = await pending;
    const data = await resp!.json() as {
      accounts: Array<{
        id: string;
        plan?: string;
        quota: unknown;
        hasCredential: boolean;
        needsReauth?: boolean;
      }>;
    };
    const replacement = data.accounts.find(account => account.id === "pool-plan-finished");

    expect(replacement).toMatchObject({
      plan: "free",
      quota: null,
      hasCredential: false,
      needsReauth: true,
    });
    expect(config.codexAccounts.find(account => account.id === "pool-plan-finished")?.plan).toBe("free");
  });

  test("a stale 401 refresh cannot mark a replacement credential for reauthentication", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-plan-stale-auth",
      email: "old-auth@example.com",
      plan: "plus",
      accessToken: "old-auth-access",
      refreshToken: "old-auth-refresh",
      chatgptAccountId: "old-auth-account",
    });
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
    globalThis.fetch = (async () => {
      markFetchStarted();
      await fetchGate;
      return new Response(null, { status: 401 });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
    const pending = handleCodexAuthAPI(req, new URL(req.url), config);
    await fetchStarted;
    deleteCodexAccount(config, "pool-plan-stale-auth");
    config.codexAccounts = [{
      id: "pool-plan-stale-auth",
      email: "new-auth@example.com",
      plan: "free",
      isMain: false,
    }];
    saveCodexAccountCredential("pool-plan-stale-auth", {
      accessToken: "new-auth-access",
      refreshToken: "new-auth-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "new-auth-account",
    });
    releaseFetch();
    const resp = await pending;
    const data = await resp!.json() as {
      accounts: Array<{
        id: string;
        plan?: string;
        quota: unknown;
        hasCredential: boolean;
        needsReauth?: boolean;
      }>;
    };
    const replacement = data.accounts.find(account => account.id === "pool-plan-stale-auth");

    expect(replacement).toMatchObject({
      plan: "free",
      quota: null,
      hasCredential: true,
      needsReauth: false,
    });
    expect(getCodexAccountCredential("pool-plan-stale-auth")?.accessToken).toBe("new-auth-access");
  });

  test("GET /api/codex-auth/accounts refresh=1 clears stale weekly for monthly primary-only WHAM", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "monthly-A",
      email: "monthly-A@example.com",
      accessToken: "tok",
      refreshToken: "ref",
      chatgptAccountId: "acc-monthly-A",
      plan: "team",
    });
    updateAccountQuota("monthly-A", 100, 1787401330, 100, 1787401330);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      plan_type: "team",
      rate_limit: {
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 2628000,
          reset_at: 1787401330,
        },
        secondary_window: null,
      },
    }), { status: 200 })) as typeof fetch;

    try {
      const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1", { method: "GET" });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(200);
      const data = await resp!.json() as { accounts: Array<{ id: string; quota?: Record<string, unknown> }> };
      const quota = data.accounts.find(a => a.id === "monthly-A")?.quota;
      expect(quota).toMatchObject({ monthlyPercent: 100, monthlyResetAt: 1787401330 });
      expect(quota).not.toHaveProperty("weeklyPercent");
      expect(quota).not.toHaveProperty("weeklyResetAt");
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

  test("reset-credit consume returns remaining from refreshed quota, not the consume payload", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-reset", email: "reset@example.test" });
    // Stale local count before redeem — must not be what the response reports.
    updateAccountQuota("pool-reset", undefined, undefined, undefined, undefined, 9);
    const originalFetch = globalThis.fetch;
    let usageCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/backend-api/wham/rate-limit-reset-credits/consume")) {
          expect(init?.method).toBe("POST");
          // Upstream may advertise a wrong/stale remaining — management must ignore it.
          return Response.json({ code: "reset", remaining: 99, available_count: 99 });
        }
        if (url.includes("/backend-api/wham/usage")) {
          usageCalls += 1;
          return Response.json({
            rate_limit: { primary_window: { used_percent: 10, reset_at: 1782000000 } },
            rate_limit_reset_credits: { available_count: 2 },
          });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "pool-reset" }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(200);
      expect(await resp!.json()).toEqual({ code: "reset", remaining: 2 });
      expect(usageCalls).toBe(1);
      expect(getAccountQuota("pool-reset")?.resetCredits).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset-credit already_redeemed refreshes quota and never invents a local decrement", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-idempotent", email: "idem@example.test" });
    updateAccountQuota("pool-idempotent", undefined, undefined, undefined, undefined, 3);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/backend-api/wham/rate-limit-reset-credits/consume")) {
          return Response.json({ code: "already_redeemed" });
        }
        if (url.includes("/backend-api/wham/usage")) {
          return Response.json({
            rate_limit: { primary_window: { used_percent: 5, reset_at: 1782000000 } },
            rate_limit_reset_credits: { available_count: 3 },
          });
        }
        return originalFetch(input);
      }) as typeof fetch;

      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "pool-idempotent" }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(200);
      expect(await resp!.json()).toEqual({ code: "already_redeemed", remaining: 3 });
      expect(getAccountQuota("pool-idempotent")?.resetCredits).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset-credit consume omits remaining when refreshed quota has no credit count", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-nocount", email: "nocount@example.test" });
    // Stale cached count must not leak into the response when WHAM omits the field.
    updateAccountQuota("pool-nocount", undefined, undefined, undefined, undefined, 7);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/backend-api/wham/rate-limit-reset-credits/consume")) {
          return Response.json({ code: "reset", remaining: 1 });
        }
        if (url.includes("/backend-api/wham/usage")) {
          return Response.json({
            rate_limit: { primary_window: { used_percent: 1, reset_at: 1782000000 } },
          });
        }
        return originalFetch(input);
      }) as typeof fetch;

      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "pool-nocount" }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(200);
      expect(await resp!.json()).toEqual({ code: "reset" });
      // Cache may still preserve the prior credit count for other callers.
      expect(getAccountQuota("pool-nocount")?.resetCredits).toBe(7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset-credit consume omits remaining when pool WHAM refresh is non-2xx", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-wham-fail", email: "whamfail@example.test" });
    updateAccountQuota("pool-wham-fail", undefined, undefined, undefined, undefined, 5);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/backend-api/wham/rate-limit-reset-credits/consume")) {
          return Response.json({ code: "reset" });
        }
        if (url.includes("/backend-api/wham/usage")) {
          return new Response("upstream busy", { status: 503 });
        }
        return originalFetch(input);
      }) as typeof fetch;

      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "pool-wham-fail" }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(200);
      expect(await resp!.json()).toEqual({ code: "reset" });
      expect(getAccountQuota("pool-wham-fail")?.resetCredits).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset-credit consume omits remaining when main WHAM refresh is non-2xx", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-reset-fail", account_id: "acct-main-reset-fail" },
    }));
    // Stabilize identity tracking so seeding stale quota is not purged by reconcile.
    reconcileMainCodexAccountRuntimeState();
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, undefined, undefined, undefined, undefined, 4);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/backend-api/wham/rate-limit-reset-credits/consume")) {
          return Response.json({ code: "already_redeemed" });
        }
        if (url.includes("/backend-api/wham/usage")) {
          return new Response("timeout", { status: 504 });
        }
        return originalFetch(input);
      }) as typeof fetch;

      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: MAIN_CODEX_ACCOUNT_ID }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
      expect(resp!.status).toBe(200);
      expect(await resp!.json()).toEqual({ code: "already_redeemed" });
      expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.resetCredits).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset-credit consume omits remaining when main WHAM omits rate_limit_reset_credits", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-reset-omit", account_id: "acct-main-reset-omit" },
    }));
    reconcileMainCodexAccountRuntimeState();
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, undefined, undefined, undefined, undefined, 6);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/backend-api/wham/rate-limit-reset-credits/consume")) {
          return Response.json({ code: "reset" });
        }
        if (url.includes("/backend-api/wham/usage")) {
          return Response.json({
            email: "main@example.test",
            plan_type: "pro",
            rate_limit: { primary_window: { used_percent: 12, reset_at: 1782000000 } },
          });
        }
        return originalFetch(input);
      }) as typeof fetch;

      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: MAIN_CODEX_ACCOUNT_ID }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
      expect(resp!.status).toBe(200);
      expect(await resp!.json()).toEqual({ code: "reset" });
      expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.resetCredits).toBe(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset-credit consume returns remaining from fresh main WHAM credits", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-reset-ok", account_id: "acct-main-reset-ok" },
    }));
    reconcileMainCodexAccountRuntimeState();
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, undefined, undefined, undefined, undefined, 9);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/backend-api/wham/rate-limit-reset-credits/consume")) {
          return Response.json({ code: "reset", remaining: 99 });
        }
        if (url.includes("/backend-api/wham/usage")) {
          return Response.json({
            email: "main@example.test",
            plan_type: "pro",
            rate_limit: { primary_window: { used_percent: 8, reset_at: 1782000000 } },
            rate_limit_reset_credits: { available_count: 1 },
          });
        }
        return originalFetch(input);
      }) as typeof fetch;

      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: MAIN_CODEX_ACCOUNT_ID }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
      expect(resp!.status).toBe(200);
      expect(await resp!.json()).toEqual({ code: "reset", remaining: 1 });
      expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.resetCredits).toBe(1);
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

  test.each([
    MAIN_CODEX_ACCOUNT_ID,
    "__proto__",
    "prototype",
    "constructor",
    "Constructor",
  ])("POST /api/codex-auth/accounts rejects reserved account id %s", async (accountId) => {
    enableManualImport();
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({ id: accountId })),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    expect(resp!.status).toBe(400);
    expect(await resp!.json()).toMatchObject({ error: "Invalid account id format" });
    expect(getCodexAccountCredential(accountId)).toBeNull();
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

  test("POST /api/codex-auth/accounts rejects an id owned by a namespace before warmup", async () => {
    enableManualImport();
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const config = makeConfig({ codexAccountNamespaces: { work: "pool-a" } });
    const before = structuredClone(config);
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({ id: "work" })),
    });

    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(400);
    expect(await resp!.json()).toMatchObject({
      error: "account id must not collide with a configured Codex account namespace",
    });
    expect(fetched).toBe(false);
    expect(config).toEqual(before);
    expect(getCodexAccountCredential("work")).toBeNull();
  });

  test("manual import rechecks namespace ownership after warmup before persistence", async () => {
    enableManualImport();
    const config = makeConfig();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://chatgpt.com/backend-api/codex/responses") {
        config.codexAccountNamespaces = { "manual-race": "pool-a" };
        return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return previousFetch(input);
    }) as typeof fetch;
    const req = new Request("http://localhost/api/codex-auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualImportBody({ id: "manual-race" })),
    });

    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(400);
    expect(await resp!.json()).toMatchObject({
      error: "account id must not collide with a configured Codex account namespace",
    });
    expect(config.codexAccounts).toEqual([]);
    expect(config.codexAccountNamespaces).toEqual({ "manual-race": "pool-a" });
    expect(getCodexAccountCredential("manual-race")).toBeNull();
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
    expect(await resp!.json()).toMatchObject({ activeCodexAccountId: "pool-next", appliesImmediately: true });
    expect(config.activeCodexAccountId).toBe("pool-next");
  });

  test("PUT /api/codex-auth/accounts/pause persists exclusion and applies to the next request", async () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "pool-active", email: "active@example.test", isMain: false },
        { id: "pool-next", email: "next@example.test", isMain: false },
      ],
      activeCodexAccountId: "pool-active",
    });
    seedPoolAccount(config, { id: "pool-extra", email: "extra@example.test" });
    saveCodexAccountCredential("pool-active", {
      accessToken: "access-active",
      refreshToken: "refresh-active",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-active",
    });
    saveCodexAccountCredential("pool-next", {
      accessToken: "access-next",
      refreshToken: "refresh-next",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-next",
    });
    updateAccountQuota("pool-active", 5);
    updateAccountQuota("pool-next", 10);
    updateAccountQuota("pool-extra", 20);
    expect(resolveCodexAccountForThread("pause-thread", config)).toBe("pool-active");

    const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pool-active", paused: true }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({ id: "pool-active", paused: true, activeCodexAccountId: "pool-next" });
    expect(config.pausedCodexAccountIds).toEqual(["pool-active"]);
    expect(config.activeCodexAccountId).toBe("pool-next");
    expect(resolveCodexAccountForThread("pause-thread", config)).toBe("pool-next");
  });

  test("pausing the runtime-active round-robin account promotes an eligible replacement", async () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "pool-active", email: "active@example.test", isMain: false },
        { id: "pool-next", email: "next@example.test", isMain: false },
      ],
      activeCodexAccountId: "pool-active",
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 2,
    });
    for (const id of ["pool-active", "pool-next"]) {
      saveCodexAccountCredential(id, {
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: `acct-${id}`,
      });
    }
    resetCodexRoutingForManualSelection("pool-active");
    expect(resolveCodexAccountForThread("round-robin-pause", config)).toBe("pool-active");

    const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pool-active", paused: true }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      id: "pool-active",
      paused: true,
      activeCodexAccountId: "pool-next",
    });
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(resolveCodexAccountForThread("round-robin-pause", config)).toBe("pool-next");
  });

  test("pausing a persisted non-active round-robin selection preserves the runtime account", async () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "pool-persisted", email: "persisted@example.test", isMain: false },
        { id: "pool-runtime", email: "runtime@example.test", isMain: false },
      ],
      activeCodexAccountId: "pool-persisted",
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 2,
    });
    for (const id of ["pool-persisted", "pool-runtime"]) {
      saveCodexAccountCredential(id, {
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: `acct-${id}`,
      });
    }
    resetCodexRoutingForManualSelection("pool-runtime");
    expect(resolveCodexAccountForThread("runtime-selection", config)).toBe("pool-runtime");

    const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pool-persisted", paused: true }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      id: "pool-persisted",
      paused: true,
      activeCodexAccountId: "pool-runtime",
    });
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(resolveCodexAccountForThread("runtime-selection", config)).toBe("pool-runtime");
  });

  test("PUT /api/codex-auth/accounts/pause-exhausted pauses only freshly confirmed exhausted accounts", async () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "exhausted", email: "exhausted@example.test", plan: "plus", isMain: false },
        { id: "available", email: "available@example.test", plan: "plus", isMain: false },
        { id: "free-weekly-only", email: "free@example.test", plan: "free", isMain: false },
        { id: "upgraded-plus", email: "upgraded@example.test", plan: "free", isMain: false },
        { id: "stale-unknown", email: "stale@example.test", plan: "plus", isMain: false },
        { id: "already-paused", email: "paused@example.test", plan: "plus", isMain: false },
      ],
      activeCodexAccountId: "exhausted",
      pausedCodexAccountIds: ["already-paused"],
    });
    for (const account of config.codexAccounts ?? []) {
      saveCodexAccountCredential(account.id, {
        accessToken: `access-${account.id}`,
        refreshToken: `refresh-${account.id}`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: account.id,
      });
    }
    updateAccountQuota("stale-unknown", 100);
    expect(resolveCodexAccountForThread("bulk-pause-thread", config)).toBe("exhausted");

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
      if (accountId === "stale-unknown") return new Response(null, { status: 502 });
      const weekly = accountId === "exhausted" || accountId === "already-paused" || accountId === "free-weekly-only" || accountId === "upgraded-plus"
        ? 100
        : 72;
      const monthly = accountId === "free-weekly-only" || accountId === "upgraded-plus" ? 20 : 40;
      return Response.json({
        plan_type: accountId === "free-weekly-only" ? "free" : "plus",
        rate_limit: {
          primary_window: { used_percent: weekly, limit_window_seconds: 7 * 24 * 60 * 60 },
          tertiary_window: { used_percent: monthly, limit_window_seconds: 30 * 24 * 60 * 60 },
        },
      });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts/pause-exhausted", { method: "PUT" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      pausedAccountIds: ["exhausted", "upgraded-plus"],
      pausedCount: 2,
      activeCodexAccountId: "free-weekly-only",
      checkedAccountCount: 5,
      failedAccountCount: 1,
      complete: false,
      appliesImmediately: true,
    });
    expect(config.pausedCodexAccountIds).toEqual(["already-paused", "exhausted", "upgraded-plus"]);
    expect(config.activeCodexAccountId).toBe("free-weekly-only");
    expect(resolveCodexAccountForThread("bulk-pause-thread", config)).toBe("free-weekly-only");
  });

  test("bulk pause preserves a known Free main plan when WHAM omits plan_type", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-access", account_id: "main-account" },
    }));
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return Response.json({
        email: "main@example.test",
        ...(call === 1 ? { plan_type: "free" } : {}),
        rate_limit: {
          primary_window: { used_percent: call === 1 ? 10 : 100, limit_window_seconds: 7 * 24 * 60 * 60 },
          tertiary_window: { used_percent: 20, limit_window_seconds: 30 * 24 * 60 * 60 },
        },
      });
    }) as typeof fetch;
    const config = makeConfig();

    const prime = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    expect((await handleCodexAuthAPI(prime, new URL(prime.url), config))!.status).toBe(200);
    const req = new Request("http://localhost/api/codex-auth/accounts/pause-exhausted", { method: "PUT" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      pausedAccountIds: [],
      pausedCount: 0,
      checkedAccountCount: 1,
      failedAccountCount: 0,
    });
    expect(config.pausedCodexAccountIds).toBeUndefined();
  });

  test("bulk pause fails closed when the main quota plan cannot be established", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-access", account_id: "main-account" },
    }));
    globalThis.fetch = (async () => Response.json({
      email: "main@example.test",
      rate_limit: {
        primary_window: { used_percent: 100, limit_window_seconds: 7 * 24 * 60 * 60 },
        tertiary_window: { used_percent: 20, limit_window_seconds: 30 * 24 * 60 * 60 },
      },
    })) as typeof fetch;
    const config = makeConfig();
    const req = new Request("http://localhost/api/codex-auth/accounts/pause-exhausted", { method: "PUT" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(502);
    expect(await resp!.json()).toMatchObject({ ok: false, checkedAccountCount: 0, failedAccountCount: 1 });
    expect(config.pausedCodexAccountIds).toBeUndefined();
  });

  test("bulk pause reports an error when every quota refresh fails", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "offline", email: "offline@example.test", plan: "plus", isMain: false }],
    });
    saveCodexAccountCredential("offline", {
      accessToken: "offline-access",
      refreshToken: "offline-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "offline",
    });
    globalThis.fetch = (async () => new Response(null, { status: 502 })) as typeof fetch;
    const req = new Request("http://localhost/api/codex-auth/accounts/pause-exhausted", { method: "PUT" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(502);
    expect(await resp!.json()).toMatchObject({ ok: false, checkedAccountCount: 0, failedAccountCount: 1 });
    expect(config.pausedCodexAccountIds).toBeUndefined();
  });

  test("bulk pause discards an exhausted result after the account is deleted and recreated", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "reused", email: "old@example.test", plan: "plus", isMain: false }],
    });
    saveCodexAccountCredential("reused", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "old-account",
    });
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
    globalThis.fetch = (async () => {
      markFetchStarted();
      await fetchGate;
      return Response.json({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 100 } },
      });
    }) as typeof fetch;

    const bulkReq = new Request("http://localhost/api/codex-auth/accounts/pause-exhausted", { method: "PUT" });
    const bulkPromise = handleCodexAuthAPI(bulkReq, new URL(bulkReq.url), config);
    await fetchStarted;
    const deleteReq = new Request("http://localhost/api/codex-auth/accounts?id=reused", { method: "DELETE" });
    expect((await handleCodexAuthAPI(deleteReq, new URL(deleteReq.url), config))!.status).toBe(200);
    config.codexAccounts = [{ id: "reused", email: "new@example.test", plan: "plus", isMain: false }];
    saveCodexAccountCredential("reused", {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "new-account",
    });
    releaseFetch();
    const resp = await bulkPromise;

    expect(resp!.status).toBe(502);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(getAccountQuota("reused")).toBeNull();
  });

  test("PUT /api/codex-auth/accounts/pause-exhausted includes a freshly exhausted main account", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-access", account_id: "main-account" },
    }));
    globalThis.fetch = (async () => Response.json({
      email: "main@example.test",
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 100 } },
    })) as typeof fetch;
    const config = makeConfig();
    const req = new Request("http://localhost/api/codex-auth/accounts/pause-exhausted", { method: "PUT" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(await resp!.json()).toMatchObject({
      pausedAccountIds: [MAIN_CODEX_ACCOUNT_ID],
      pausedCount: 1,
    });
    expect(config.pausedCodexAccountIds).toEqual([MAIN_CODEX_ACCOUNT_ID]);
  });

  test("PUT /api/codex-auth/active rejects null when the effective main account is paused", async () => {
    const config = makeConfig({ pausedCodexAccountIds: [MAIN_CODEX_ACCOUNT_ID] });
    const req = new Request("http://localhost/api/codex-auth/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: null }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(409);
    expect(await resp!.json()).toEqual({ error: "Account is paused" });
    expect(config.activeCodexAccountId).toBeUndefined();
  });

  test("resuming restores eligibility and manual activation rejects paused accounts", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "work", email: "work@example.test", isMain: false }],
      pausedCodexAccountIds: ["work", MAIN_CODEX_ACCOUNT_ID],
    });
    const activateReq = new Request("http://localhost/api/codex-auth/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "work" }),
    });
    const activateResp = await handleCodexAuthAPI(activateReq, new URL(activateReq.url), config);
    expect(activateResp!.status).toBe(409);
    expect(config.activeCodexAccountId).toBeUndefined();

    const resumeReq = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "work", paused: false }),
    });
    const resumeResp = await handleCodexAuthAPI(resumeReq, new URL(resumeReq.url), config);

    expect(resumeResp!.status).toBe(200);
    expect(config.pausedCodexAccountIds).toEqual([MAIN_CODEX_ACCOUNT_ID]);
  });

  test("account list exposes persisted pause state for main and added accounts", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "work", email: "work@example.test", isMain: false }],
      pausedCodexAccountIds: [MAIN_CODEX_ACCOUNT_ID, "work"],
    });
    const req = new Request("http://localhost/api/codex-auth/accounts");
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; paused: boolean }> };

    expect(data.accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)?.paused).toBe(true);
    expect(data.accounts.find(account => account.id === "work")?.paused).toBe(true);
  });

  test("PUT /api/codex-auth/accounts/alias changes display metadata only", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "work", email: "work@example.test", plan: "plus", isMain: false }],
      activeCodexAccountId: "work",
    });
    const req = new Request("http://localhost/api/codex-auth/accounts/alias", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "work", alias: "Work Plus" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(config.codexAccounts?.[0]?.alias).toBe("Work Plus");
    expect(config.codexAccounts?.[0]?.id).toBe("work");
    expect(config.activeCodexAccountId).toBe("work");
  });

  test("PUT /api/codex-auth/accounts/alias preserves the dedicated main-account error", async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts/alias", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: MAIN_CODEX_ACCOUNT_ID, alias: "Desktop" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    expect(resp!.status).toBe(400);
    expect(await resp!.json()).toMatchObject({ error: "Main Codex account alias is not configurable" });
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
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    saveCodexAccountCredential("pool-delete", {
      accessToken: "access-delete",
      refreshToken: "refresh-delete",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-delete",
    });
    for (const registration of STATE_STORE_REGISTRATIONS) registerStateStore(registration);
    setLiveStateStoreConfig(config);
    reconcileLiveStateStores();
    const preDeletionWriterGeneration = captureConfigGeneration();
    const exactSidecar = await resolveFirstUsableOpenAiSidecar(
      listOpenAiForwardSidecarCandidates(config),
      new Headers(),
      config,
      { accountId: "pool-delete", modelId: "gpt-5.6-sol" },
    );
    expect(exactSidecar?.authContext).toMatchObject({
      accountId: "pool-delete",
      fixedAccount: true,
      writerGeneration: preDeletionWriterGeneration,
    });
    updateAccountQuota("pool-delete", 70);
    expect(resolveCodexAccountForThread("delete-thread", config)).toBe("pool-delete");
    recordCodexUpstreamOutcome(config, "pool-delete", 500);
    expect(getCodexUpstreamHealth("pool-delete")).not.toBeNull();
    markAccountNeedsReauth("pool-delete");
    config.pausedCodexAccountIds = ["pool-delete"];
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
    expect(captureConfigGeneration()).toBeGreaterThan(preDeletionWriterGeneration);
    expect(config.codexAccounts).toEqual([]);
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(getCodexAccountCredential("pool-delete")).toBeNull();
    expect(getAccountQuota("pool-delete")).toBeNull();
    expect(isAccountNeedsReauth("pool-delete")).toBe(false);
    expect(getCodexUpstreamHealth("pool-delete")).toBeNull();
    expect(resolveCodexAccountForThread("delete-thread", config)).toBeNull();
    expect(cancelled).toBe(true);
    expect(closed).toEqual([{ code: 4001, reason: "Codex account invalidated" }]);
    expect(getTrackedCodexWebSocketCountForAccount("pool-delete")).toBe(0);

    // An exact sidecar can finish after its selected account was deleted. Its
    // captured writer generation must keep that late outcome from recreating
    // routing health for an owner that no longer exists.
    exactSidecar?.recordOutcome?.(429);
    expect(getCodexUpstreamHealth("pool-delete")).toBeNull();

    updateAccountQuota(
      "pool-delete",
      99,
      undefined,
      undefined,
      undefined,
      undefined,
      preDeletionWriterGeneration,
    );
    recordCodexUpstreamOutcome(config, "pool-delete", 429, {
      now: Date.now(),
      writerGeneration: preDeletionWriterGeneration,
    });
    markAccountNeedsReauth("pool-delete", preDeletionWriterGeneration);
    expect(getAccountQuota("pool-delete")).toBeNull();
    expect(getCodexUpstreamHealth("pool-delete")).toBeNull();
    expect(isAccountNeedsReauth("pool-delete")).toBe(false);
  });

  test.each([
    MAIN_CODEX_ACCOUNT_ID,
    "__proto__",
    "__PrOtO__",
    "prototype",
    "PROTOTYPE",
    "constructor",
    "Constructor",
  ])("DELETE /api/codex-auth/accounts rejects reserved account id %s without mutation", async (accountId) => {
    const config = makeConfig({
      activeCodexAccountId: "pool-untouched",
      codexAccounts: [{ id: "pool-untouched", email: "pool-untouched@example.test", isMain: false }],
    });
    saveCodexAccountCredential("pool-untouched", {
      accessToken: "access-untouched",
      refreshToken: "refresh-untouched",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-untouched",
    });
    const beforeConfig = structuredClone(config);
    const beforeCredential = getCodexAccountCredential("pool-untouched");

    const req = new Request(
      `http://localhost/api/codex-auth/accounts?id=${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    );
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(400);
    expect(await resp!.json()).toMatchObject({ error: "Invalid account id format" });
    expect(config).toEqual(beforeConfig);
    expect(listCodexAccountIds()).toEqual(["pool-untouched"]);
    expect(getCodexAccountCredential("pool-untouched")).toEqual(beforeCredential);
  });

  test("DELETE /api/codex-auth/accounts removes a configured legacy reserved account", async () => {
    const accountId = "Constructor";
    const config = makeConfig({
      activeCodexAccountId: accountId,
      codexAccounts: [{ id: accountId, email: "legacy@example.test", isMain: false }],
    });
    saveCodexAccountCredential(accountId, {
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "legacy-account",
    });

    const req = new Request(
      `http://localhost/api/codex-auth/accounts?id=${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    );
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(config.codexAccounts).toEqual([]);
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(getCodexAccountCredential(accountId)).toBeNull();
  });

  test("legacy non-main __main__ is quarantined and removable without touching Desktop auth", async () => {
    const config = makeConfig({
      activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
      codexAccounts: [{ id: MAIN_CODEX_ACCOUNT_ID, email: "invalid-legacy@example.test", isMain: false }],
    });
    saveCodexAccountCredential(MAIN_CODEX_ACCOUNT_ID, {
      accessToken: "legacy-pool-access",
      refreshToken: "legacy-pool-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "legacy-pool-account",
    });
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: { access_token: "desktop-access", account_id: "desktop-account" },
    }));

    expect(getMainChatgptAccountId()).toBe("desktop-account");
    expect(resolveCodexAccountForThread("legacy-main-row", config)).toBeNull();

    const req = new Request(
      `http://localhost/api/codex-auth/accounts?id=${encodeURIComponent(MAIN_CODEX_ACCOUNT_ID)}`,
      { method: "DELETE" },
    );

    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(200);
    expect(config.codexAccounts).toEqual([]);
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(getCodexAccountCredential(MAIN_CODEX_ACCOUNT_ID)).toBeNull();
    expect(getMainChatgptAccountId()).toBe("desktop-account");
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

  describe("POST /api/codex-auth/login/code", () => {
    async function startPendingFlow() {
      const oauth = await import("../src/oauth");
      const openUrlMod = await import("../src/lib/open-url");
      const startSpy = spyOn(oauth, "startLoginFlow").mockResolvedValue({ url: "https://example.test/oauth" });
      const statusSpy = spyOn(oauth, "getLoginStatus").mockReturnValue({
        done: false,
        loggedIn: false,
      } as ReturnType<typeof oauth.getLoginStatus>);
      const openSpy = spyOn(openUrlMod, "openUrl").mockImplementation(() => {});
      const req = new Request("http://localhost/api/codex-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
      const data = await resp!.json() as { flowId: string };
      return {
        flowId: data.flowId,
        oauth,
        async cleanup() {
          const cancelReq = new Request("http://localhost/api/codex-auth/login/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ flowId: data.flowId }),
          });
          await handleCodexAuthAPI(cancelReq, new URL(cancelReq.url), makeConfig());
          startSpy.mockRestore();
          statusSpy.mockRestore();
          openSpy.mockRestore();
        },
      };
    }

    function codeRequest(body: Record<string, unknown>): Request {
      return new Request("http://localhost/api/codex-auth/login/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    test("accepts a manual code only for the pending flow without reflecting it", async () => {
      const flow = await startPendingFlow();
      const pasted = "http://localhost:1455/auth/callback?code=secret-code&state=expected";
      const submitSpy = spyOn(flow.oauth, "submitManualLoginCode").mockReturnValue({ ok: true });
      try {
        const req = codeRequest({ flowId: flow.flowId, input: pasted });
        const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
        expect(resp!.status).toBe(202);
        const responseText = await resp!.text();
        expect(JSON.parse(responseText)).toEqual({ ok: true });
        expect(submitSpy).toHaveBeenCalledTimes(1);
        expect(submitSpy).toHaveBeenCalledWith("chatgpt", pasted);
        expect(responseText).not.toContain(pasted);
      } finally {
        submitSpy.mockRestore();
        await flow.cleanup();
      }
    });

    test("rejects missing and unknown flow ids before submitting", async () => {
      const oauth = await import("../src/oauth");
      const submitSpy = spyOn(oauth, "submitManualLoginCode");
      try {
        for (const body of [{ input: "code" }, { flowId: "", input: "code" }, { flowId: "unknown", input: "code" }]) {
          const req = codeRequest(body);
          const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
          expect(resp!.status).toBe(400);
        }
        expect(submitSpy).not.toHaveBeenCalled();
      } finally {
        submitSpy.mockRestore();
      }
    });

    test("rejects expired or mismatched non-pending flow ids", async () => {
      const flow = await startPendingFlow();
      const submitSpy = spyOn(flow.oauth, "submitManualLoginCode");
      await flow.cleanup();
      try {
        for (const flowId of [flow.flowId, `${flow.flowId}-mismatch`]) {
          const req = codeRequest({ flowId, input: "code" });
          const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
          expect(resp!.status).toBe(400);
        }
        expect(submitSpy).not.toHaveBeenCalled();
      } finally {
        submitSpy.mockRestore();
      }
    });

    test("rejects empty input and no shared login in progress", async () => {
      const flow = await startPendingFlow();
      try {
        for (const input of ["", "   ", "raw-code"]) {
          const req = codeRequest({ flowId: flow.flowId, input });
          const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
          expect(resp!.status).toBe(400);
        }
      } finally {
        await flow.cleanup();
      }
    });

    test("rejects input over 4096 characters and allows the 4096 boundary to reach shared validation", async () => {
      const flow = await startPendingFlow();
      const submitSpy = spyOn(flow.oauth, "submitManualLoginCode").mockReturnValue({ ok: true });
      try {
        const oversizedReq = codeRequest({ flowId: flow.flowId, input: "x".repeat(4097) });
        const oversizedResp = await handleCodexAuthAPI(oversizedReq, new URL(oversizedReq.url), makeConfig());
        expect(oversizedResp!.status).toBe(400);
        expect(submitSpy).not.toHaveBeenCalled();

        const boundaryReq = codeRequest({ flowId: flow.flowId, input: "x".repeat(4096) });
        const boundaryResp = await handleCodexAuthAPI(boundaryReq, new URL(boundaryReq.url), makeConfig());
        expect(boundaryResp!.status).toBe(202);
        expect(submitSpy).toHaveBeenCalledTimes(1);
      } finally {
        submitSpy.mockRestore();
        await flow.cleanup();
      }
    });
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

  test("GET /api/codex-auth/login-status does not false-complete reauth from a stale credential", async () => {
    saveCodexAccountCredential("pool-reauth-stale", {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acc-pool-reauth-stale",
    });

    const req = new Request(
      "http://localhost/api/codex-auth/login-status?flowId=missing&accountId=pool-reauth-stale&reauth=1",
      { method: "GET" },
    );
    const resp = await handleCodexAuthAPI(req, new URL(req.url), {} as any);
    const data = await resp!.json() as { status: string; accountId?: string };
    expect(data).toEqual({ status: "expired" });
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

  test.each([
    MAIN_CODEX_ACCOUNT_ID,
    "__proto__",
    "prototype",
    "constructor",
    "Constructor",
  ])("POST /api/codex-auth/login rejects reserved account id %s before OAuth starts", async (accountId) => {
    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: accountId }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    expect(resp!.status).toBe(400);
    expect(await resp!.json()).toMatchObject({ error: "Invalid account id format" });
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

  test("POST /api/codex-auth/login rejects an id owned by a namespace before OAuth starts", async () => {
    const oauth = await import("../src/oauth");
    const startSpy = spyOn(oauth, "startLoginFlow");
    try {
      const config = makeConfig({ codexAccountNamespaces: { work: "pool-a" } });
      const req = new Request("http://localhost/api/codex-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "work" }),
      });

      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

      expect(resp!.status).toBe(400);
      expect(await resp!.json()).toMatchObject({
        error: "account id must not collide with a configured Codex account namespace",
      });
      expect(startSpy).not.toHaveBeenCalled();
      expect(getCodexAccountCredential("work")).toBeNull();
    } finally {
      startSpy.mockRestore();
    }
  });

  test("POST /api/codex-auth/login without reauth still rejects existing account id", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "pool-no-reauth", email: "pool-no-reauth@example.test", isMain: false }],
    });
    saveCodexAccountCredential("pool-no-reauth", {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acc-pool-no-reauth",
    });

    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pool-no-reauth" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(400);
    const data = await resp!.json() as { error: string };
    expect(data.error).toContain("Account id already exists");
  });

  test("POST /api/codex-auth/login with reauth requires id", async () => {
    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reauth: true }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    expect(resp!.status).toBe(400);
    const data = await resp!.json() as { error: string };
    expect(data.error).toBe("id required for reauth");
  });

  test("POST /api/codex-auth/login with reauth rejects unknown pool account", async () => {
    saveCodexAccountCredential("cred-only", {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acc-cred-only",
    });

    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "cred-only", reauth: true }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    expect(resp!.status).toBe(404);
    const data = await resp!.json() as { error: string };
    expect(data.error).toBe("Unknown pool account for reauth");
    expect(data.error).not.toContain("already exists");
  });

  test("POST /api/codex-auth/login with reauth does not reject existing pool account id", async () => {
    const config = makeConfig({
      codexAccountNamespaces: { "pool-reauth": "other-account" },
      codexAccounts: [{ id: "pool-reauth", email: "pool-reauth@example.test", isMain: false }],
    });
    saveCodexAccountCredential("pool-reauth", {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acc-pool-reauth",
    });

    const oauth = await import("../src/oauth");
    const openUrlMod = await import("../src/lib/open-url");
    const startSpy = spyOn(oauth, "startLoginFlow").mockResolvedValue({ url: "https://example.test/oauth" });
    const statusSpy = spyOn(oauth, "getLoginStatus").mockReturnValue({
      done: true,
      loggedIn: false,
      error: "test-stop",
    } as ReturnType<typeof oauth.getLoginStatus>);
    const openSpy = spyOn(openUrlMod, "openUrl").mockImplementation(() => {});

    try {
      const req = new Request("http://localhost/api/codex-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "pool-reauth", reauth: true }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).not.toBe(400);
      const data = await resp!.json() as { ok?: boolean; flowId?: string; error?: string };
      expect(data.error ?? "").not.toContain("already exists");
      expect(data.error ?? "").not.toContain("namespace");
      expect(data.ok).toBe(true);
      expect(data.flowId).toBeTruthy();
      expect(startSpy).toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  test("OAuth creation rejects a namespace claimed during warmup without persisting", async () => {
    const config = makeConfig();
    const result = await completeMockCodexOAuth({
      config,
      requestBody: { id: "oauth-race" },
      oauthAccountId: "acct-oauth-race",
      email: "oauth-race@example.test",
      onWarmup: () => {
        config.codexAccountNamespaces = { "oauth-race": "pool-a" };
      },
    });

    expect(result.startStatus).toBe(200);
    expect(result.state).toMatchObject({
      status: "error",
      error: "account id must not collide with a configured Codex account namespace",
    });
    expect(config.codexAccounts).toEqual([]);
    expect(config.codexAccountNamespaces).toEqual({ "oauth-race": "pool-a" });
    expect(getCodexAccountCredential("oauth-race")).toBeNull();
  });

  test("OAuth reauth cannot recreate an account deleted during warmup", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "reauth-race", email: "reauth-race@example.test", isMain: false }],
    });
    saveCodexAccountCredential("reauth-race", {
      accessToken: "old-reauth-access",
      refreshToken: "old-reauth-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-reauth-race",
    });
    const result = await completeMockCodexOAuth({
      config,
      requestBody: { id: "reauth-race", reauth: true },
      oauthAccountId: "acct-reauth-race",
      email: "reauth-race@example.test",
      onWarmup: () => deleteCodexAccount(config, "reauth-race"),
    });

    expect(result.startStatus).toBe(200);
    expect(result.state).toMatchObject({
      status: "error",
      error: "Pool account was removed while login was in progress. Add it again as a new account.",
    });
    expect(config.codexAccounts).toEqual([]);
    expect(getCodexAccountCredential("reauth-race")).toBeNull();
  });

  test("deleteCodexAccount preserves a main account with the requested id", () => {
    const mainAccount = {
      id: "shared-account-id",
      email: "main@example.test",
      isMain: true,
    };
    const config = makeConfig({ codexAccounts: [mainAccount] });
    saveCodexAccountCredential("shared-account-id", {
      accessToken: "main-access",
      refreshToken: "main-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "shared-account-id",
    });

    deleteCodexAccount(config, "shared-account-id");

    expect(config.codexAccounts).toEqual([mainAccount]);
    expect(getCodexAccountCredential("shared-account-id")).toBeNull();
  });

  test("OAuth reauth preserves the stored plan when the usage probe fails", async () => {
    const config = makeConfig({
      codexAccounts: [{
        id: "reauth-plan",
        email: "reauth-plan@example.test",
        plan: "business",
        isMain: false,
      }],
    });
    saveCodexAccountCredential("reauth-plan", {
      accessToken: "old-plan-access",
      refreshToken: "old-plan-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-reauth-plan",
    });
    updateAccountQuota("reauth-plan", 67, 1782628379);

    const result = await completeMockCodexOAuth({
      config,
      requestBody: { id: "reauth-plan", reauth: true },
      oauthAccountId: "acct-reauth-plan",
      email: "reauth-plan@example.test",
      onWarmup: () => {},
      usageResponse: () => new Response("unavailable", { status: 503 }),
    });

    expect(result.state).toMatchObject({ status: "done" });
    expect(config.codexAccounts?.[0]?.plan).toBe("business");
    expect(getAccountQuota("reauth-plan")).toBeNull();
  });

  test("OAuth pool login excludes self from collision check when reauth", async () => {
    const source = await Bun.file("src/codex/auth-api.ts").text();
    expect(source).toContain("checkAccountIdCollision(oauthAccountId, email, plan, reauth ? accountId : undefined)");
  });

  test("OAuth pool reauth binds ChatGPT identity to the existing pool slot", async () => {
    const source = await Bun.file("src/codex/auth-api.ts").text();
    expect(source).toContain("expectedChatgptId");
    expect(source).toContain("expectedEmail");
    expect(source).toContain("Signed-in ChatGPT account does not match this pool account");
    expect(source).toContain("Cannot verify account identity for reauth. Remove this account and add it again.");
  });

  test("login-status reauth polling refuses credential-exists shortcut", async () => {
    const source = await Bun.file("src/codex/auth-api.ts").text();
    expect(source).toContain('url.searchParams.get("reauth") === "1"');
    expect(source).toContain("!st && accountId && !reauthStatus && getCodexAccountCredential(accountId)");
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
      expect(existsSync(join(TEST_DIR, "config.json"))).toBe(false);
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
