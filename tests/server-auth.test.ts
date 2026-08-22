import { waitForNativeMainStartupGate } from "../src/codex/native-profile-startup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logsFromApiBody } from "./helpers/logs-api";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearCodexWebSocketRegistry, getTrackedCodexWebSocketCountForAccount } from "../src/codex/websocket-registry";
import { INTERNAL_DEADLINE_MS, SERVER_BUDGET_MS } from "./helpers/test-budget";
import { clearAccountNeedsReauth, clearAccountQuota, getAccountQuota, isAccountNeedsReauth, markAccountNeedsReauth, updateAccountQuota } from "../src/codex/auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexQuotaHealthSnapshot,
  getCodexUpstreamHealth,
  isCodexAccountSoftAvoided,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import { loadConfig, saveConfig } from "../src/config";
import { clearUpstreamHostHealth, getUpstreamHostHealth, recordUpstreamHostFailure, upstreamHostHealthKey } from "../src/codex/upstream-host-health";
import { deriveProviderPresets } from "../src/providers/derive";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import {
  assertServerAuthConfig,
  corsHeaders,
  disableResponsesRequestTimeout,
  hasValidApiAuth,
  isApiAuthRequired,
  isLoopbackHostname,
  resolveGuiFilePath,
  rootFallbackPayload,
  safeConfigDTO,
  startServer,
} from "../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../src/server/request-log";
import { handleManagementAPI } from "../src/server/management-api";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { ownedServiceHomeInspection } from "./helpers/owned-service-home-inspection";
import { configuredAdminToken } from "../src/lib/admin-secrets";
import { SYSTEM_RESTART_CAPABILITY_VERSION } from "../src/lib/system-restart-contract";
import { LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION } from "../src/lib/local-provider-reload-contract";
import { resetCodexModelEntitlementCacheForTests } from "../src/codex/model-entitlements";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";

import { watchdogMs } from "./helpers/ci-watchdog";
const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalGlobalFetch = globalThis.fetch;
// A per-run directory, not a fixed path. This used to be
// join(import.meta.dir, ".tmp-server-auth-test"), the exact same literal that
// management-provider-validation.test.ts also declared, and both files delete and
// recreate it while pointing OPENCODEX_HOME there. `bun test --isolate` gives each file
// its own module registry but shares one process and one filesystem, so whichever run was
// mid-test when the other wiped the directory lost its config and credentials and started
// answering 401 where the test expected the upstream's original 400. That also breaks two
// concurrent runs of THIS file alone, which a rename could not fix. mkdtempSync matches the
// isolation convention already used by tests/helpers/isolated-codex-home.ts.
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-server-auth-"));
let isolatedCodexHome: IsolatedCodexHome | null = null;

function config(hostname?: string): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        headers: { "X-Custom": "provider-secret" },
        defaultModel: "gpt-test",
      },
    },
  };
}

function managementHeaders(initial?: HeadersInit): Headers {
  const token = configuredAdminToken();
  if (!token) throw new Error("management token was not initialized");
  const headers = new Headers(initial);
  headers.set("x-opencodex-api-key", token);
  return headers;
}

const canonicalDirect = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

function poolProviders(): OcxConfig["providers"] {
  return {
    openai: { ...canonicalDirect, codexAccountMode: "pool" },
  };
}

function redirectCanonicalCodexTo(baseUrl: string): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const prefix = "/backend-api/codex";
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
      const target = new URL(`${url.pathname.slice(prefix.length)}${url.search}`, baseUrl);
      return originalGlobalFetch(target, init);
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}

function stubModelDiscoveryFor(...origins: string[]): void {
  const allowed = new Set(origins);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (allowed.has(url.origin) && url.pathname.endsWith("/models")) {
      return Promise.resolve(Response.json({ data: [] }));
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-auth-codex-");
});

afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
  clearAccountQuota();
  resetCodexModelEntitlementCacheForTests();
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

const POOL_RETRY_MODEL = "gpt-5.6-sol";

function unsupportedModelBody(model = POOL_RETRY_MODEL): string {
  return JSON.stringify({
    detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
  });
}

type PoolRetryHarness = {
  config: OcxConfig;
  dispatches: string[];
  request: (init?: {
    stream?: boolean;
    signal?: AbortSignal;
    model?: string;
    path?: "/v1/responses" | "/v1/responses/compact";
    callerBearer?: boolean;
    extraBody?: Record<string, unknown>;
  }) => Promise<Response>;
  restoreFetch: () => void;
  server: ReturnType<typeof startServer>;
  upstream: ReturnType<typeof Bun.serve>;
};

async function removeTestDirBestEffort(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  // Windows can keep the prior harness's ACL/icacls handles for a beat after
  // stop; a single EBUSY must not take down the rest of the file.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
      await Bun.sleep(25 * (attempt + 1));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

async function startPoolRetryHarness(
  reply: (accountId: string, request: Request) => Response | Promise<Response>,
  options: {
    secondAccount?: boolean;
    streamMode?: "legacy-tee" | "eager-relay";
    accountMode?: "direct" | "pool";
    activeAccountId?: string;
    accountNamespaces?: Record<string, string>;
    noVisionModels?: string[];
    visionSidecarModel?: string;
    websockets?: boolean;
    forwardApiKey?: string;
    pausedAccountIds?: string[];
    reauthAccountIds?: string[];
    omitCredentialAccountIds?: string[];
    combos?: OcxConfig["combos"];
    modelRosterByAccount?: Record<string, string[]>;
  } = {},
): Promise<PoolRetryHarness> {
  await removeTestDirBestEffort(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  resetCodexModelEntitlementCacheForTests();
  clearRequestLogsForTests();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
  // The registry is process-global and survives a harness teardown. WS-REBIND-01
  // asserts exact per-account socket counts, so a socket leaked by any earlier test
  // in this file shifts its snapshots and fails it in milliseconds — which reads as
  // a flake next to the timeouts, but is ordinary shared state. Reset it with the
  // rest rather than leaving one of six kinds of state uncleaned.
  clearCodexWebSocketRegistry();

  const dispatches: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const accountId = request.headers.get("chatgpt-account-id") ?? "missing";
      if (new URL(request.url).pathname === "/models") {
        return Response.json({
          models: (options.modelRosterByAccount?.[accountId] ?? []).map(slug => ({
            slug,
            supported_in_api: true,
            visibility: "list",
          })),
        });
      }
      dispatches.push(accountId);
      return reply(accountId, request);
    },
  });
  redirectCanonicalCodexTo(upstream.url.toString());
  const redirectedFetch = globalThis.fetch;

  const secondAccount = options.secondAccount ?? true;
  const config = {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        ...canonicalDirect,
        codexAccountMode: options.accountMode ?? "pool",
        ...(options.noVisionModels ? { noVisionModels: options.noVisionModels } : {}),
        ...(options.forwardApiKey ? { apiKey: options.forwardApiKey } : {}),
      },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ...(secondAccount
        ? [{ id: "pool-b", email: "pool-b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" }]
        : []),
    ],
    activeCodexAccountId: options.activeAccountId ?? "pool-a",
    ...(options.accountNamespaces ? { codexAccountNamespaces: options.accountNamespaces } : {}),
    ...(options.pausedAccountIds ? { pausedCodexAccountIds: options.pausedAccountIds } : {}),
    ...(options.visionSidecarModel ? { visionSidecar: { model: options.visionSidecarModel } } : {}),
    ...(options.websockets ? { websockets: true } : {}),
    ...(options.streamMode ? { streamMode: options.streamMode } : {}),
    ...(options.combos ? { combos: options.combos } : {}),
  } as OcxConfig;
  saveConfig(config);
  if (!options.omitCredentialAccountIds?.includes("pool-a")) {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-a-token",
      refreshToken: "pool-a-refresh",
      expiresAt: Date.now() + 10 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });
  }
  updateAccountQuota("pool-a", 10);
  if (secondAccount) {
    if (!options.omitCredentialAccountIds?.includes("pool-b")) {
      saveCodexAccountCredential("pool-b", {
        accessToken: "pool-b-token",
        refreshToken: "pool-b-refresh",
        expiresAt: Date.now() + 10 * 60_000,
        chatgptAccountId: "acct-pool-b",
      });
    }
    updateAccountQuota("pool-b", 20);
  }
  for (const accountId of options.reauthAccountIds ?? []) markAccountNeedsReauth(accountId);

  const server = startServer(0);
  return {
    config,
    dispatches,
    restoreFetch: () => {
      if (globalThis.fetch === redirectedFetch) globalThis.fetch = originalGlobalFetch;
    },
    server,
    upstream,
    request: ({
      stream = false,
      signal,
      model = POOL_RETRY_MODEL,
      path = "/v1/responses",
      callerBearer = true,
      extraBody = {},
    } = {}) => originalGlobalFetch(new URL(path, server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(callerBearer ? { authorization: "Bearer inbound-token" } : {}),
      },
      body: JSON.stringify({ model, input: path.endsWith("/compact") ? [] : "hello", stream, ...extraBody }),
      signal,
    }),
  };
}

async function stopPoolRetryHarness(harness: PoolRetryHarness): Promise<void> {
  harness.restoreFetch();
  await harness.server.stop(true);
  await harness.upstream.stop(true);
}

function rejectionResponse(body: BodyInit, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 400,
    statusText: "Account Model Rejected",
    headers: { "content-type": "application/json", "x-pool-retry-test": "original", ...headers },
  });
}

async function expectOriginal400(response: Response, body: string): Promise<void> {
  expect(response.status).toBe(400);
  expect(response.headers.get("x-pool-retry-test")).toBe("original");
  expect(await response.text()).toBe(body);
}

describe("server local API auth", () => {
  test("responses timeout helper disables Bun request timeout when available", () => {
    const req = new Request("http://localhost/v1/responses", { method: "POST" });
    const calls: Array<[Request, number]> = [];
    const server = {
      timeout(request: Request, seconds: number) {
        calls.push([request, seconds]);
      },
    };

    expect(disableResponsesRequestTimeout(req, server)).toBe(true);
    expect(calls).toEqual([[req, 0]]);
  });

  test("responses timeout helper is safe when the runtime hook is unavailable", () => {
    const req = new Request("http://localhost/v1/responses", { method: "POST" });

    expect(disableResponsesRequestTimeout(req, undefined)).toBe(false);
    expect(disableResponsesRequestTimeout(req, {
      timeout() {
        throw new Error("unsupported");
      },
    })).toBe(false);
  });

  test("responses handler keeps the request timeout until the body is fully accepted", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const cfg = config();
    cfg.defaultProvider = "fixture";
    cfg.providers = {
      fixture: { ...cfg.providers.openai!, disabled: true },
    };
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    let accepted = false;
    const responsePromise = handleResponses(req, cfg, {
      model: "unknown",
      provider: "unknown",
    }, {
      onRequestBodyRead: () => {
        accepted = true;
      },
    });

    controller.enqueue(new TextEncoder().encode('{"model":"fixture/gpt-test","input":"hello"'));
    await Bun.sleep(10);
    expect(accepted).toBe(false);

    controller.enqueue(new TextEncoder().encode("}"));
    controller.close();
    const response = await responsePromise;
    expect(accepted).toBe(true);
    expect(response.status).toBe(404);
  });

  test("responses handler classifies an aborted pending body as client cancellation", async () => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        bodyController = value;
      },
    });
    const abortController = new AbortController();
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: abortController.signal,
    });
    let accepted = false;
    const responsePromise = handleResponses(req, config(), {
      model: "unknown",
      provider: "unknown",
    }, {
      abortSignal: abortController.signal,
      onRequestBodyRead: () => {
        accepted = true;
      },
    });

    bodyController.enqueue(new TextEncoder().encode('{"model":"openai/gpt-test","input":"hello"'));
    await Bun.sleep(10);
    expect(accepted).toBe(false);

    abortController.abort();
    const response = await responsePromise;
    expect(response.status).toBe(499);
    expect(accepted).toBe(false);
  });

  test("responses handler accepts a combo body exactly once across failover children", async () => {
    const upstreamModels: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json() as { model?: string };
        upstreamModels.push(body.model ?? "missing");
        return Response.json({ error: { message: "rate limited; try the next combo target" } }, {
          status: 429,
          headers: { "retry-after": "1" },
        });
      },
    });
    const baseUrl = `${upstream.url.toString().replace(/\/$/, "")}/v1`;
    const cfg: OcxConfig = {
      port: 0,
      defaultProvider: "first",
      providers: {
        first: { adapter: "openai-responses", baseUrl, apiKey: "first-key", allowPrivateNetwork: true },
        second: { adapter: "openai-responses", baseUrl, apiKey: "second-key", allowPrivateNetwork: true },
      },
      combos: {
        request_timeout: {
          strategy: "failover",
          targets: [
            { provider: "first", model: "first-model" },
            { provider: "second", model: "second-model" },
          ],
        },
      },
    };
    let acceptedCount = 0;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/request_timeout", input: "hello", stream: false }),
      }), cfg, { model: "unknown", provider: "unknown" }, {
        onRequestBodyRead: () => {
          acceptedCount += 1;
        },
      });

      expect(response.status).toBe(429);
      expect(acceptedCount).toBe(1);
      expect(upstreamModels).toEqual(["first-model", "second-model"]);
    } finally {
      await upstream.stop(true);
    }
  });

  test("loopback hostnames do not require opencodex API auth", () => {
    expect(isLoopbackHostname(undefined)).toBe(true);
    expect(isLoopbackHostname("")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isApiAuthRequired(config())).toBe(false);
    expect(isApiAuthRequired(config("127.0.0.1"))).toBe(false);
  });

  test("non-loopback binding requires env token before startup", () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    expect(isApiAuthRequired(config("0.0.0.0"))).toBe(true);
    expect(() => assertServerAuthConfig(config("0.0.0.0"))).toThrow("OPENCODEX_API_AUTH_TOKEN");

    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    expect(() => assertServerAuthConfig(config("0.0.0.0"))).not.toThrow();
  });

  test("auth header must match env token when non-loopback auth is required", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    const cfg = config("0.0.0.0");

    expect(hasValidApiAuth(new Request("http://localhost/api/config"), cfg)).toBe(false);
    expect(hasValidApiAuth(new Request("http://localhost/api/config", {
      headers: { "x-opencodex-api-key": "wrong" },
    }), cfg)).toBe(false);
    expect(hasValidApiAuth(new Request("http://localhost/api/config", {
      headers: { "x-opencodex-api-key": "local-secret" },
    }), cfg)).toBe(true);
  });

  test("loopback remains allowed even when env token exists", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    expect(hasValidApiAuth(new Request("http://localhost/api/config"), config("127.0.0.1"))).toBe(true);
  });

  test("CORS preflight permits the opencodex API key header", () => {
    const allowed = corsHeaders()["Access-Control-Allow-Headers"];
    expect(allowed).toContain("X-OpenCodex-API-Key");
    expect(allowed).toContain("ChatGPT-Account-Id");
  });

  test("CORS preflight echoes vendor SDK request headers only for an allowed origin (#1773)", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    const loopbackOrigin = `http://127.0.0.1:${server.port}`;
    const stainless = "x-stainless-lang, x-stainless-runtime, x-stainless-retry-count";
    try {
      // Every browser-SDK inbound route must answer the same preflight contract; a route that
      // omits one Stainless header blocks the real request before it is ever sent.
      for (const path of ["/v1/messages", "/v1/responses", "/v1/chat/completions"]) {
        const res = await fetch(new URL(path, server.url), {
          method: "OPTIONS",
          headers: {
            origin: loopbackOrigin,
            "access-control-request-method": "POST",
            "access-control-request-headers": `content-type, ${stainless}`,
          },
        });
        expect(res.status).toBe(204);
        const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
        for (const header of stainless.split(",").map(h => h.trim())) {
          expect(allowed).toContain(header);
        }
        // The static contract survives alongside the echoed headers, and content-type is not
        // duplicated just because the caller also asked for it.
        expect(allowed).toContain("x-opencodex-api-key");
        expect(allowed.split(",").filter(h => h.trim() === "content-type")).toHaveLength(1);
        expect(res.headers.get("vary")).toContain("Access-Control-Request-Headers");
      }

      // A rejected origin never reaches the echo: it is refused before any allow-list is built.
      const rejected = await fetch(new URL("/v1/responses", server.url), {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-stainless-lang",
        },
      });
      expect(rejected.status).toBe(403);
      expect((rejected.headers.get("access-control-allow-headers") ?? "").toLowerCase())
        .not.toContain("x-stainless-lang");
    } finally {
      await server.stop(true);
    }
  });

  test("safeConfigDTO redacts provider secrets and exposes booleans", () => {
    const unsafe = config("127.0.0.1");
    unsafe.openaiProviderTierVersion = 1;
    unsafe.codexAccountNamespaces = { side: "private-account-id" };
    Object.assign(unsafe.providers.openai as unknown as Record<string, unknown>, {
      apiKeyPool: [{ id: "pool-id", key: "pool-secret", label: "private-pool-label" }],
      modelMaxInputTokens: { "gpt-test": 1000 },
      codexAccountMode: "pool",
      reasoningWireFormat: "gateway-object",
      virtualModels: { "gpt-test-pro": { wireModelId: "gpt-test", reasoningMode: "pro" } },
      codexAuthContext: { accessToken: "runtime-token" },
      selectedForwardHeaders: { authorization: "Bearer runtime-token" },
      sidecarOutcomeRecorder: "recorder-runtime",
      _codexAccountOverride: { accessToken: "override-token" },
      _codexAccountRequired: true,
    });
    const dto = safeConfigDTO(unsafe) as {
      providers: Record<string, Record<string, unknown>>;
    };
    const serialized = JSON.stringify(dto);
    for (const forbidden of [
      "sk-secret-value", "provider-secret", "openaiProviderTierVersion",
      "apiKeyPool", "pool-secret", "private-pool-label", "modelMaxInputTokens",
      "virtualModels", "codexAuthContext", "selectedForwardHeaders",
      "sidecarOutcomeRecorder", "recorder-runtime", "_codexAccountOverride",
      "_codexAccountRequired", "runtime-token", "override-token",
      "codexAccountNamespaces", "private-account-id",
    ]) expect(serialized).not.toContain(forbidden);
    expect(dto.providers.openai).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      defaultModel: "gpt-test",
      hasApiKey: true,
      hasHeaders: true,
      codexAccountMode: "pool",
      reasoningWireFormat: "gateway-object",
    });
    expect(dto.providers.openai).not.toHaveProperty("apiKey");
    expect(dto.providers.openai).not.toHaveProperty("headers");
    expect(dto.providers.openai.disabled).toBeUndefined();
  });

  test("safeConfigDTO preserves reasoning placeholder policies without adjacent secrets", () => {
    const dto = safeConfigDTO({
      ...config("127.0.0.1"),
      providers: {
        required: {
          adapter: "openai-chat",
          baseUrl: "https://user:password@example.test/v1?token=url-secret",
          apiKey: "required-api-secret",
          headers: { Authorization: "Bearer required-header-secret" },
          requiresReasoningPlaceholderModels: ["deepseek-reasoner"],
        },
        optedOut: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          apiKey: "opt-out-api-secret",
          headers: { "X-Private-Key": "opt-out-header-secret" },
          requiresReasoningPlaceholderModels: [],
        },
      },
    } as OcxConfig) as {
      providers: Record<string, Record<string, unknown>>;
    };

    expect(dto.providers.required.requiresReasoningPlaceholderModels).toEqual(["deepseek-reasoner"]);
    expect(dto.providers.optedOut.requiresReasoningPlaceholderModels).toEqual([]);
    expect(dto.providers.required).not.toHaveProperty("apiKey");
    expect(dto.providers.required).not.toHaveProperty("headers");
    expect(dto.providers.optedOut).not.toHaveProperty("apiKey");
    expect(dto.providers.optedOut).not.toHaveProperty("headers");
    const serialized = JSON.stringify(dto);
    for (const secret of [
      "password",
      "url-secret",
      "required-api-secret",
      "required-header-secret",
      "opt-out-api-secret",
      "opt-out-header-secret",
    ]) expect(serialized).not.toContain(secret);
  });

  test("safeConfigDTO exposes keyOptional for saved free-tier providers", () => {
    const dto = safeConfigDTO({
      ...config("127.0.0.1"),
      providers: {
        "opencode-free": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/v1",
          authMode: "key",
          keyOptional: true,
        },
        "mimo-free": {
          adapter: "mimo-free",
          baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
          authMode: "key",
          keyOptional: true,
        },
      },
    } as OcxConfig) as {
      providers: Record<string, Record<string, unknown>>;
    };

    expect(dto.providers["opencode-free"]).toMatchObject({
      adapter: "openai-chat",
      authMode: "key",
      keyOptional: true,
      hasApiKey: false,
    });
    expect(dto.providers["opencode-free"].note).toBeTruthy();
    expect(dto.providers["mimo-free"]).toMatchObject({
      adapter: "mimo-free",
      authMode: "key",
      keyOptional: true,
      hasApiKey: false,
    });
  });

  test("safeConfigDTO strips URL-embedded provider secrets", () => {
    const dto = safeConfigDTO({
      ...config("127.0.0.1"),
      providers: {
        leaky: {
          adapter: "openai-chat",
          baseUrl: "https://user:pass@example.test/v1?token=secret#frag",
          apiKey: "sk-secret-value",
        },
      },
    } as OcxConfig) as { providers: Record<string, { baseUrl: string }> };

    expect(dto.providers.leaky.baseUrl).toBe("https://example.test/v1");
    expect(JSON.stringify(dto)).not.toContain("pass");
    expect(JSON.stringify(dto)).not.toContain("secret");
  });

  test("safeConfigDTO does not echo malformed provider URLs back to the GUI", () => {
    const dto = safeConfigDTO({
      ...config("127.0.0.1"),
      providers: {
        malformed: {
          adapter: "openai-chat",
          baseUrl: "not a url with pasted-token-sk-secret",
        },
        file: {
          adapter: "openai-chat",
          baseUrl: "file:///tmp/sk-secret",
        },
      },
    } as OcxConfig) as { providers: Record<string, { baseUrl: string }> };

    expect(dto.providers.malformed.baseUrl).toBe("(invalid URL)");
    expect(dto.providers.file.baseUrl).toBe("(invalid URL)");
    expect(JSON.stringify(dto)).not.toContain("pasted-token-sk-secret");
    expect(JSON.stringify(dto)).not.toContain("/tmp/sk-secret");
  });

  test("root fallback explains missing dashboard build", () => {
    expect(rootFallbackPayload()).toMatchObject({
      status: "ok",
      service: "opencodex",
      dashboard: { available: false },
      endpoints: {
        health: "/healthz",
        models: "/v1/models",
        responses: "/v1/responses",
        chatCompletions: "/v1/chat/completions",
        management: "/api/*",
      },
    });
  });

  test("GUI static file resolver stays inside gui/dist", () => {
    const root = join(TEST_DIR, "gui", "dist");

    expect(resolveGuiFilePath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveGuiFilePath(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
    expect(resolveGuiFilePath(root, "/../config.json")).toBeNull();
    expect(resolveGuiFilePath(root, "/%2e%2e/config.json")).toBeNull();
    expect(resolveGuiFilePath(root, "/..%2fconfig.json")).toBeNull();
    expect(resolveGuiFilePath(root, "/%00")).toBeNull();
  });

  test("/v1/models requires API auth and local Origin on non-loopback bindings", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: "chatgpt",
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    const modelsUrl = `http://127.0.0.1:${server.port}/v1/models`;
    try {
      const missingAuth = await fetch(modelsUrl);
      expect(missingAuth.status).toBe(401);

      const badOrigin = await fetch(modelsUrl, {
        headers: { "x-opencodex-api-key": "local-secret", origin: "https://attacker.test" },
      });
      expect(badOrigin.status).toBe(403);

      const ok = await fetch(modelsUrl, {
        headers: { "x-opencodex-api-key": "local-secret" },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toHaveProperty("data");

      const sameOrigin = await fetch(modelsUrl, {
        headers: { "x-opencodex-api-key": "local-secret", origin: new URL(modelsUrl).origin },
      });
      expect(sameOrigin.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, 15_000);

  test("safeConfigDTO exposes the freeTier badge flag (WP040)", async () => {
    const { safeConfigDTO } = await import("../src/server/auth-cors");
    const dto = safeConfigDTO({
      port: 0,
      defaultProvider: "nvidia",
      providers: {
        nvidia: { adapter: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1", freeTier: true },
        venice: { adapter: "openai-chat", baseUrl: "https://api.venice.ai/api/v1" },
      },
    } as OcxConfig) as { providers: Record<string, { freeTier?: boolean }> };
    expect(dto.providers.nvidia.freeTier).toBe(true);
    expect(dto.providers.venice.freeTier).toBeUndefined();
  });
  test("management GET rejects non-local Origin even with a valid API key", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      ...config("0.0.0.0"),
      port: 0,
    });

    const server = startServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: managementHeaders({ origin: "https://attacker.test" }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "cross-origin request blocked" });

      const ok = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: managementHeaders({ origin: `http://127.0.0.1:${server.port}` }),
      });
      expect(ok.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("/api/system/memory stays gated while /healthz exposes only bounded capability metadata (#314 WP3)", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      ...config("0.0.0.0"),
      port: 0,
    });

    const server = startServer(0);
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/api/system/memory`);
      expect(missing.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${server.port}/api/system/memory`, {
        headers: managementHeaders(),
      });
      expect(ok.status).toBe(200);
      const body = await ok.json() as { rss?: number; bunVersion?: string };
      expect(body.rss).toBeGreaterThan(0);
      expect(body.bunVersion).toBe(Bun.version);

      // /healthz must NOT gain memory/runtime introspection — it is unauthenticated.
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      const healthBody = await health.json() as Record<string, unknown>;
      expect(Object.keys(healthBody).sort()).toEqual([
        "pid",
        "port",
        "providerReloadCapability",
        "restartCapability",
        "service",
        "status",
        "uptime",
        "version",
      ]);
      expect(healthBody.restartCapability).toBe(SYSTEM_RESTART_CAPABILITY_VERSION);
      expect(healthBody.providerReloadCapability).toBe(LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION);
      expect("rss" in healthBody).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("OPTIONS preflight rejects non-local Origin before CORS headers are trusted", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    const loopbackOrigin = `http://127.0.0.1:${server.port}`;
    try {
      const rejected = await fetch(new URL("/api/settings", server.url), {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.test",
          "access-control-request-method": "GET",
        },
      });
      expect(rejected.status).toBe(403);

      const accepted = await fetch(new URL("/api/settings", server.url), {
        method: "OPTIONS",
        headers: {
          origin: loopbackOrigin,
          "access-control-request-method": "GET",
        },
      });
      expect(accepted.status).toBe(204);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(loopbackOrigin);
    } finally {
      await server.stop(true);
    }
  });

  test("extension allowlist gates preflight and data-plane requests by authority", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const extensionOrigin = "chrome-extension://modkelfkcfjpgbfmnbnllalkiogfofh";
    saveConfig({
      ...config("127.0.0.1"),
      corsAllowOrigins: [extensionOrigin],
    });
    stubModelDiscoveryFor("https://api.example.test");

    const server = startServer(0);
    const modelsUrl = new URL("/v1/models", server.url);
    try {
      const preflight = await fetch(modelsUrl, {
        method: "OPTIONS",
        headers: {
          origin: extensionOrigin,
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(extensionOrigin);

      const accepted = await fetch(modelsUrl, { headers: { origin: extensionOrigin } });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(extensionOrigin);

      const rejected = await fetch(modelsUrl, {
        headers: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      });
      expect(rejected.status).toBe(403);

      // The management plane shares isExtraAllowedOrigin: the configured extension gets
      // its preflight echoed, any other extension is refused before reaching /api/*.
      const managementUrl = new URL("/api/settings", server.url);
      const managementPreflight = await fetch(managementUrl, {
        method: "OPTIONS",
        headers: {
          origin: extensionOrigin,
          "access-control-request-method": "GET",
        },
      });
      expect(managementPreflight.status).toBe(204);
      expect(managementPreflight.headers.get("access-control-allow-origin")).toBe(extensionOrigin);

      const managementRejected = await fetch(managementUrl, {
        method: "OPTIONS",
        headers: {
          origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "access-control-request-method": "GET",
        },
      });
      expect(managementRejected.status).toBe(403);
      expect(managementRejected.headers.get("access-control-allow-origin")).not.toBe(
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
    } finally {
      await server.stop(true);
    }
  });

  test("loopback management API rejects host-header same-origin rebinding", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const attackerOrigin = `http://attacker.test:${server.port}`;
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: {
          host: `attacker.test:${server.port}`,
          origin: attackerOrigin,
          "x-opencodex-api-key": configuredAdminToken() ?? "missing-admin-token",
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "cross-origin request blocked" });
    } finally {
      await server.stop(true);
    }
  });

  test("management CORS echoes validated loopback Origin and covers delegated codex-auth responses", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const settings = await fetch(new URL("/api/settings", server.url), {
        headers: managementHeaders({ origin }),
      });
      expect(settings.status).toBe(200);
      expect(settings.headers.get("access-control-allow-origin")).toBe(origin);
      expect(settings.headers.get("vary")).toContain("Origin");

      const active = await fetch(new URL("/api/codex-auth/active", server.url), {
        headers: managementHeaders({ origin }),
      });
      expect(active.status).toBe(200);
      expect(active.headers.get("access-control-allow-origin")).toBe(origin);
    } finally {
      await server.stop(true);
    }
  });

  test("non-loopback management API allows same-origin GUI requests with API token", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      ...config("0.0.0.0"),
      port: 0,
    });

    const server = startServer(0);
    const origin = `http://lan.example.test:${server.port}`;
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        headers: {
          host: `lan.example.test:${server.port}`,
          origin,
        },
      });
      expect(missing.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        headers: managementHeaders({
          host: `lan.example.test:${server.port}`,
          origin,
        }),
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
    } finally {
      await server.stop(true);
    }
  });

  test("websocket upgrade rejects hostile Origin even with a valid API token", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      ...config("0.0.0.0"),
      port: 0,
      websockets: true,
    });

    const server = startServer(0);
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({
          hostname: "127.0.0.1",
          port: server.port,
          path: "/v1/responses",
          method: "GET",
          headers: {
            authorization: "Bearer inbound-main-token",
            connection: "Upgrade",
            upgrade: "websocket",
            origin: "https://attacker.test",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
            "x-opencodex-api-key": "local-secret",
          },
        }, incoming => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", chunk => {
            body += chunk;
          });
          incoming.on("end", () => {
            resolve({ status: incoming.statusCode ?? 0, body });
          });
        });
        req.setTimeout(5_000, () => {
          req.destroy(new Error("hostile websocket handshake timed out"));
        });
        req.on("upgrade", (incoming, socket) => {
          socket.destroy();
          resolve({ status: incoming.statusCode ?? 0, body: "" });
        });
        req.on("error", reject);
        req.end();
      });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { code: "origin_rejected" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("websocket upgrade returns 426 when the WS transport is disabled", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    saveConfig({ ...config(), port: 0, websockets: false });

    const server = startServer(0);
    try {
      // codex-rs maps a connect-time 426 to a clean session-scoped HTTP fallback
      // (WebsocketStreamOutcome::FallbackToHttp) — this must NOT accept the socket.
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "GET",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
        },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toMatchObject({
        error: { type: "upgrade_required" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("after a 426'd upgrade the same client can immediately fall back to HTTP POST", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          id: "chatcmpl-fb", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "http fallback ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        });
      },
    });
    saveConfig({
      port: 0, websockets: false, defaultProvider: "routed-fb",
      providers: {
        "routed-fb": { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true, apiKey: "key-fb-000111222333" },
      },
    } as never);

    const server = startServer(0);
    try {
      // codex-rs FallbackToHttp: the 426 must leave the connection/session fully usable for HTTP.
      const upgrade = await fetch(new URL("/v1/responses", server.url), {
        method: "GET",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      expect(upgrade.status).toBe(426);
      const post = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "routed-fb/some-model", input: "hello", stream: false }),
      });
      expect(post.status).toBe(200);
      const json = await post.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(o => o.type === "message")?.content?.[0]?.text).toBe("http fallback ok");
    } finally {
      await server.stop(true);
      upstream.stop(true);
    }
  });

  test("compact v1 on a routed model propagates a summarizer failure instead of fabricating history", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: { message: "summarizer exploded" } }), {
          status: 500, headers: { "content-type": "application/json" },
        });
      },
    });
    saveConfig({
      port: 0, defaultProvider: "routed-cmp",
      providers: {
        "routed-cmp": { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true, apiKey: "key-cmp-000111222333" },
      },
    } as never);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "routed-cmp/some-model",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "long history" }] }],
        }),
      });
      expect(response.ok).toBe(false);
      const body = await response.json() as { error?: { message?: string } };
      expect(body.error?.message ?? "").toContain("500");
    } finally {
      await server.stop(true);
      upstream.stop(true);
    }
  });

  test("unknown /v1/* paths return JSON 404, never GUI index.html", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    saveConfig({ ...config(), port: 0 });

    const server = startServer(0);
    try {
      // Unsupported codex-rs endpoint clients (memories/*, realtime/*) must get a clean 404
      // instead of a 200 HTML page that fails serde with a confusing decode error.
      // (/v1/images/* and /v1/alpha/search are real relay routes covered by dedicated tests.)
      for (const path of ["/v1/realtime/sessions", "/v1/memories/trace_summarize"]) {
        const response = await fetch(new URL(path, server.url), { method: "POST" });
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/json");
      }
    } finally {
      await server.stop(true);
    }
  });

  test("POST /v1/responses/compact on a routed model returns v1 replacement history", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        // Anthropic non-stream response carrying the summarizer's text.
        return Response.json({
          content: [{ type: "text", text: "compact summary body" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "anthropic-test",
      providers: {
        "anthropic-test": {
          adapter: "anthropic",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          allowPrivateNetwork: true,
          apiKey: "provider-key",
          defaultModel: "claude-fable-5",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic-test/claude-fable-5",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "original ask" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "work done" }] },
          ],
          instructions: "base instructions",
        }),
      });
      expect(response.status).toBe(200);
      const json = await response.json() as { output: { type: string; role?: string; content?: { text: string }[] }[] };
      expect(Array.isArray(json.output)).toBe(true);
      // Retained real user message + summary user message; codex-rs installs this as history.
      expect(json.output[0]).toMatchObject({ type: "message", role: "user" });
      expect(json.output[0].content?.[0].text).toBe("original ask");
      const last = json.output[json.output.length - 1];
      expect(last.role).toBe("user");
      expect(last.content?.[0].text).toContain("compact summary body");
      // No ocx1 envelope may leak into v1 output.
      expect(JSON.stringify(json)).not.toContain("ocx1:");
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  // Windows CI under the full suite can spend >1s opening WS turns and >5s on this
  // multi-server matrix; tight budgets flake as "tier websocket timeout" and cascade
  // into the next test via a late fetch restore (502 instead of the mocked 500).
  /**
   * This matrix points OPENCODEX_HOME at its own temp dir, so the service
   * installed on the developer's machine is not evidence about it.
   * See tests/helpers/owned-service-home.ts.
   */
  const inspectNativeCodexOwnership = ownedServiceHomeInspection("OpenAI option auth matrix test");

  test("OpenAI option auth matrix keeps direct, pool, and API credentials independent", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";

    const seen: Array<{ host: string; authorization: string | null; chatgptAccountId: string | null }> = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({
          host: req.headers.get("x-test-original-host") ?? "",
          authorization: req.headers.get("authorization"),
          chatgptAccountId: req.headers.get("chatgpt-account-id"),
        });
        return Response.json({ id: "resp_tier", object: "response", status: "completed", output: [] });
      },
    });
    let whamRequests = 0;
    const matrixFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/wham/")) {
        whamRequests += 1;
        return Promise.resolve(Response.json({ rate_limit: { primary_window: { used_percent: 10 } } }));
      }
      if (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com") {
        const headers = new Headers(init?.headers);
        headers.set("x-test-original-host", url.hostname);
        const prefix = url.hostname === "chatgpt.com" ? "/backend-api/codex" : "";
        return originalGlobalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, upstream.url), { ...init, headers });
      }
      return originalGlobalFetch(input, init);
    }) as typeof fetch;
    globalThis.fetch = matrixFetch;

    const request = (server: ReturnType<typeof startServer>, headers?: HeadersInit, model = "gpt-test") => {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("content-type", "application/json");
      requestHeaders.set("x-opencodex-api-key", "local-secret");
      return fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ model, input: "hello", stream: false }),
      });
    };
    const compact = (server: ReturnType<typeof startServer>, headers?: HeadersInit, model = "gpt-test") => {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("content-type", "application/json");
      requestHeaders.set("x-opencodex-api-key", "local-secret");
      return fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ model, input: [] }),
      });
    };
    const wsTurn = (server: ReturnType<typeof startServer>, headers?: Record<string, string>, model = "gpt-test") => {
      const url = new URL("/v1/responses", server.url);
      url.protocol = "ws:";
      const ws = new WebSocket(url, { headers: { "x-opencodex-api-key": "local-secret", ...(headers ?? {}) } } as unknown as string[]);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("tier websocket timeout")), watchdogMs(5_000));
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "response.create", model, input: "hello" }));
        }, { once: true });
        ws.addEventListener("message", event => {
          clearTimeout(timer);
          const text = typeof event.data === "string" ? event.data : "";
          ws.close();
          resolve(text);
        }, { once: true });
        ws.addEventListener("error", () => reject(new Error("tier websocket failed")), { once: true });
      });
    };

    try {
      const directConfig = {
        port: 0,
        hostname: "0.0.0.0",
        websockets: true,
        defaultProvider: "openai",
        openaiProviderTierVersion: 2,
        providers: { openai: canonicalDirect },
        codexAccounts: [{ id: "direct-unusable", email: "pool@example.test", isMain: false }],
        activeCodexAccountId: "direct-unusable",
      } as OcxConfig;
      saveCodexAccountCredential("direct-unusable", {
        accessToken: "unusable-pool-token",
        refreshToken: "unusable-pool-refresh",
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: "unusable-pool-account",
      });
      updateAccountQuota("direct-unusable", 99);
      markAccountNeedsReauth("direct-unusable");
      recordCodexUpstreamOutcome(directConfig, "direct-unusable", 429, { retryAfter: "60" });
      saveConfig(directConfig);
      const direct = startServer(0, { inspectNativeCodexOwnership });
      const directBaseline = {
        config: readFileSync(join(TEST_DIR, "config.json"), "utf8"),
        accounts: readFileSync(join(TEST_DIR, "codex-accounts.json"), "utf8"),
        quota: structuredClone(getAccountQuota("direct-unusable")),
        health: structuredClone(getCodexUpstreamHealth("direct-unusable")),
        reauth: isAccountNeedsReauth("direct-unusable"),
        active: loadConfig().activeCodexAccountId,
        whamRequests,
      };
      try {
        expect((await request(direct)).status).toBe(401);
        expect((await compact(direct)).status).toBe(401);
        expect(await wsTurn(direct)).toContain("401");
        expect(seen).toHaveLength(0);
        const directSeenStart = seen.length;
        expect((await request(direct, { authorization: "Bearer caller-codex" })).status).toBe(200);
        expect((await compact(direct, { authorization: "Bearer caller-codex" })).status).toBe(200);
        expect(await wsTurn(direct, { authorization: "Bearer caller-codex" })).toContain("resp_tier");
        expect(seen.slice(directSeenStart)).toEqual(Array.from({ length: 3 }, () => ({
          host: "chatgpt.com",
          authorization: "Bearer caller-codex",
          chatgptAccountId: null,
        })));
        expect(readFileSync(join(TEST_DIR, "config.json"), "utf8")).toBe(directBaseline.config);
        expect(readFileSync(join(TEST_DIR, "codex-accounts.json"), "utf8")).toBe(directBaseline.accounts);
        expect(getAccountQuota("direct-unusable")).toEqual(directBaseline.quota);
        expect(getCodexUpstreamHealth("direct-unusable")).toEqual(directBaseline.health);
        expect(isAccountNeedsReauth("direct-unusable")).toBe(directBaseline.reauth);
        expect(loadConfig().activeCodexAccountId).toBe(directBaseline.active);
        expect(whamRequests).toBe(directBaseline.whamRequests);
      } finally {
        await direct.stop(true);
      }

      const mainOnlyConfig = (): OcxConfig => ({
        port: 0,
        websockets: true,
        defaultProvider: "openai",
        openaiProviderTierVersion: 2,
        providers: poolProviders(),
        codexAccounts: [],
        autoSwitchThreshold: 0,
      });
      const writeMainToken = (accessToken: string) => writeFileSync(
        join(isolatedCodexHome!.path, "auth.json"),
        JSON.stringify({ tokens: { access_token: accessToken, account_id: "main-account" } }),
      );
      const expiredPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url");
      for (const state of ["expired", "reauth", "cooldown"] as const) {
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        clearCodexUpstreamHealth();
        const cfg = mainOnlyConfig();
        writeMainToken(state === "expired" ? `header.${expiredPayload}.signature` : "opaque-live-main-token");
        saveConfig(cfg);
        const before = seen.length;
        const unusableMain = startServer(0, { inspectNativeCodexOwnership });
        try {
          await waitForNativeMainStartupGate();
          if (state === "reauth") markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
          if (state === "cooldown") recordCodexUpstreamOutcome(cfg, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "60" });
          expect((await request(unusableMain)).status).toBe(401);
          expect((await compact(unusableMain)).status).toBe(401);
          expect(await wsTurn(unusableMain)).toContain("401");
          expect(seen).toHaveLength(before);
        } finally {
          await unusableMain.stop(true);
        }
      }
      clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
      clearCodexUpstreamHealth();
      rmSync(join(isolatedCodexHome!.path, "auth.json"), { force: true });

      saveConfig({
        port: 0,
        hostname: "0.0.0.0",
        websockets: true,
        defaultProvider: "openai",
        openaiProviderTierVersion: 2,
        providers: poolProviders(),
        codexAccounts: [{ id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" }],
        activeCodexAccountId: "pool-a",
        autoSwitchThreshold: 0,
      } as OcxConfig);
      const beforeMissingPool = seen.length;
      const missingPool = startServer(0, { inspectNativeCodexOwnership });
      try {
        expect((await request(missingPool)).status).toBe(401);
        expect((await compact(missingPool)).status).toBe(401);
        expect(await wsTurn(missingPool)).toContain("401");
        expect(seen).toHaveLength(beforeMissingPool);
      } finally {
        await missingPool.stop(true);
      }
      clearAccountNeedsReauth("pool-a");
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-access-token",
        refreshToken: "pool-refresh-token",
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: "acct-pool-a",
      });
      const cooldownCfg = {
        ...poolProviders(),
      };
      recordCodexUpstreamOutcome({
        port: 0,
        defaultProvider: "openai",
        providers: cooldownCfg,
      } as OcxConfig, "pool-a", 429, { retryAfter: "60" });
      const beforeCooldown = seen.length;
      const cooledMulti = startServer(0, { inspectNativeCodexOwnership });
      try {
        expect((await compact(cooledMulti)).status).toBe(429);
        expect(seen).toHaveLength(beforeCooldown);
      } finally {
        await cooledMulti.stop(true);
      }
      clearCodexUpstreamHealth();
      const multi = startServer(0, { inspectNativeCodexOwnership });
      try {
        expect((await request(multi, { authorization: "Bearer local-secret" })).status).toBe(200);
        expect((await compact(multi, { authorization: "Bearer local-secret" })).status).toBe(200);
        expect(await wsTurn(multi, { authorization: "Bearer local-secret" })).toContain("resp_tier");
        expect(seen.at(-1)).toEqual({
          host: "chatgpt.com",
          authorization: "Bearer pool-access-token",
          chatgptAccountId: "acct-pool-a",
        });
      } finally {
        await multi.stop(true);
      }

      saveConfig({
        port: 0,
        hostname: "0.0.0.0",
        websockets: true,
        defaultProvider: "openai-apikey",
        openaiProviderTierVersion: 2,
        providers: {
          openai: { ...canonicalDirect, disabled: true },
          "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-platform" },
        },
      } as OcxConfig);
      const api = startServer(0, { inspectNativeCodexOwnership });
      try {
        expect((await request(api, { authorization: "Bearer local-secret" }, "openai-apikey/gpt-test")).status).toBe(200);
        expect((await compact(api, { authorization: "Bearer local-secret" }, "openai-apikey/gpt-test")).status).toBe(200);
        expect(await wsTurn(api, { authorization: "Bearer local-secret" }, "openai-apikey/gpt-test")).toContain("resp_tier");
        expect(seen.at(-1)).toEqual({
          host: "api.openai.com",
          authorization: "Bearer sk-platform",
          chatgptAccountId: null,
        });
      } finally {
        await api.stop(true);
      }

      saveCodexAccountCredential("pool-b", {
        accessToken: "pool-b-access-token",
        refreshToken: "pool-b-refresh-token",
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: "acct-pool-b",
      });
      saveConfig({
        port: 0,
        hostname: "0.0.0.0",
        websockets: true,
        defaultProvider: "openai",
        openaiProviderTierVersion: 2,
        providers: {
          openai: { ...canonicalDirect, codexAccountMode: "pool" },
          "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-platform" },
        },
        codexAccounts: [
          { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
          { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" },
        ],
        activeCodexAccountId: "pool-a",
        autoSwitchThreshold: 0,
      } as OcxConfig);
      clearAccountNeedsReauth("pool-a");
      clearAccountNeedsReauth("pool-b");
      const sequential = startServer(0);
      const wsUrl = new URL("/v1/responses", sequential.url);
      wsUrl.protocol = "ws:";
      const beforeHandshake = seen.length;
      const ws = new WebSocket(wsUrl, {
        headers: {
          "x-opencodex-api-key": "local-secret",
          authorization: "Bearer caller-codex",
        },
      } as unknown as string[]);
      const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("sequential websocket failed to open")), { once: true });
      });
      const sendFrame = async (model: string) => {
        const before = seen.length;
        const message = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`sequential websocket timeout: ${model}`)), watchdogMs(5_000));
          const onMessage = (event: MessageEvent) => {
            const value = typeof event.data === "string" ? event.data : "";
            if (!value.includes('"type":"response.completed"')) return;
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            resolve(value);
          };
          ws.addEventListener("message", onMessage);
        });
        ws.send(JSON.stringify({ type: "response.create", model, input: "hello" }));
        expect(await message).toContain("resp_tier");
        expect(seen).toHaveLength(before + 1);
      };
      try {
        await opened;
        expect(seen).toHaveLength(beforeHandshake); // handshake performs no upstream request

        await sendFrame("openai/gpt-test");
        expect(seen.at(-1)?.authorization).toBe("Bearer pool-access-token");
        expect(getTrackedCodexWebSocketCountForAccount("pool-a")).toBe(1);
        await sendFrame("openai-apikey/gpt-test");
        expect(seen.at(-1)?.authorization).toBe("Bearer sk-platform");
        expect(getTrackedCodexWebSocketCountForAccount("pool-a")).toBe(0);
        await sendFrame("openai/gpt-test");
        expect(seen.at(-1)?.authorization).toBe("Bearer pool-access-token");

        const switched = await fetch(new URL("/api/codex-auth/active", sequential.url), {
          method: "PUT",
          headers: managementHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ accountId: "pool-b" }),
        });
        expect(switched.status).toBe(200);
        await sendFrame("openai/gpt-test");
        expect(seen.at(-1)?.authorization).toBe("Bearer pool-b-access-token");
        expect(getTrackedCodexWebSocketCountForAccount("pool-b")).toBe(1);
      } finally {
        ws.close();
        await sequential.stop(true);
      }
    } finally {
      // Only clear our mock if a later/timeout race has not already replaced it.
      // afterEach always restores originalGlobalFetch once this test settles.
      if (globalThis.fetch === matrixFetch) globalThis.fetch = originalGlobalFetch;
      await upstream.stop(true);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("internal web-search and vision never forward a non-ChatGPT bearer as Direct sidecar auth", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "dedicated-x-key";
    const outbound: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      outbound.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    saveConfig({
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: "routed",
      openaiProviderTierVersion: 2,
      apiKeys: [{ id: "bearer", name: "Bearer admission", key: "bearer-admission-secret", createdAt: "2026-07-17" }],
      providers: {
        routed: {
          adapter: "openai-chat",
          baseUrl: "https://routed.example/v1",
          apiKey: "routed-key",
          noVisionModels: ["text-model"],
        },
        openai: canonicalDirect,
      },
    });
    const server = startServer(0);
    try {
      for (const authorization of [
        "Bearer bearer-admission-secret",
        "Bearer sk-provider-secret",
      ]) {
        for (const body of [
          { model: "routed/text-model", input: "search", tools: [{ type: "web_search" }] },
          {
            model: "routed/text-model",
            input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGk=" }] }],
          },
        ]) {
          const response = await originalGlobalFetch(`http://127.0.0.1:${server.port}/v1/responses`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencodex-api-key": "dedicated-x-key",
              authorization,
              "chatgpt-account-id": "acct-forged",
            },
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(500);
        }
      }
      expect(outbound).toHaveLength(4);
      expect(outbound.every(row => row.url.startsWith("https://routed.example/"))).toBe(true);
      expect(outbound.every(row => row.authorization === "Bearer routed-key")).toBe(true);
    } finally {
      globalThis.fetch = originalGlobalFetch;
      await server.stop(true);
    }
  });

  test("internal vision sidecar still accepts a canonical ChatGPT bearer for Direct sidecar auth", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "dedicated-x-key";
    const outbound: Array<{ url: string; authorization: string | null; accountId: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      outbound.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        accountId: new Headers(init?.headers).get("chatgpt-account-id"),
      });
      if (url.startsWith("https://chatgpt.com/backend-api/codex")) {
        return new Response([
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "caption" })}`,
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-sidecar",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    saveConfig({
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: "routed",
      openaiProviderTierVersion: 2,
      providers: {
        routed: {
          adapter: "openai-chat",
          baseUrl: "https://routed.example/v1",
          apiKey: "routed-key",
          noVisionModels: ["text-model"],
        },
        openai: canonicalDirect,
      },
    });
    const server = startServer(0);
    try {
      const token = fakeChatGptJwt({ chatgpt_account_id: "acct-direct" });
      const response = await originalGlobalFetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencodex-api-key": "dedicated-x-key",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-direct",
        },
        body: JSON.stringify({
          model: "routed/text-model",
          input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGk=" }] }],
        }),
      });
      expect(response.status).toBe(200);
      const chatgptCalls = outbound.filter(row => row.url.startsWith("https://chatgpt.com/backend-api/codex"));
      expect(chatgptCalls).toHaveLength(1);
      expect(chatgptCalls.every(row => row.authorization === `Bearer ${token}`)).toBe(true);
      expect(chatgptCalls.every(row => row.accountId === "acct-direct")).toBe(true);
    } finally {
      globalThis.fetch = originalGlobalFetch;
      await server.stop(true);
    }
  });

  test("expired thread affinity returns 409 before HTTP passthrough and WS resolves auth per frame", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");
    clearAccountQuota();

    let upstreamRequests = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        upstreamRequests += 1;
        return Response.json({ id: "resp_test", object: "response", status: "completed", output: [] });
      },
    });
    redirectCanonicalCodexTo(upstream.url.toString());
    const now = 1_800_000_000_000;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      websockets: true,
      providers: poolProviders(),
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 10 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });
    updateAccountQuota("pool-a", 10, 5);

    const originalNow = Date.now;
    const server = startServer(0);
    try {
      Date.now = () => now;
      for (const threadId of ["expired-http", "expired-compact", "expired-ws"]) {
        const response = await fetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer inbound-main-token",
            "x-codex-parent-thread-id": threadId,
          },
          body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
        });
        expect(response.status).toBe(200);
      }
      expect(upstreamRequests).toBe(3);

      Date.now = () => now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1;
      const httpResponse = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
          "x-codex-parent-thread-id": "expired-compact",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      });
      expect(httpResponse.status).toBe(409);

      const compactResponse = await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
          "x-codex-parent-thread-id": "expired-http",
        },
        body: JSON.stringify({ model: "gpt-test", input: [] }),
      });
      expect(compactResponse.status).toBe(409);

      const wsUrl = new URL("/v1/responses", server.url);
      wsUrl.protocol = "ws:";
      const ws = new WebSocket(wsUrl, {
        headers: {
          authorization: "Bearer inbound-main-token",
          "x-codex-parent-thread-id": "expired-ws",
        },
      } as unknown as string[]);
      const wsFailure = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket affinity timeout")), watchdogMs(1000));
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "hello" }));
        }, { once: true });
        ws.addEventListener("message", event => {
          const text = typeof event.data === "string" ? event.data : "";
          if (!text.includes("409") && !text.includes("affinity")) return;
          clearTimeout(timer);
          resolve(text);
          ws.close();
        });
        ws.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      expect(await wsFailure).toContain("409");
      expect(upstreamRequests).toBe(3);
    } finally {
      Date.now = originalNow;
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("websocket passthrough refreshes pool auth for each response.create turn", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    const seenAuth: Array<string | null> = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization"));
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    redirectCanonicalCodexTo(upstream.url.toString());
    const now = 1_800_000_000_000;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      websockets: true,
      providers: poolProviders(),
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: now + 120_000,
      chatgptAccountId: "acct-pool-a",
    });
    updateAccountQuota("pool-a", 10, 5);

    const originalNow = Date.now;
    const originalFetch = globalThis.fetch;
    const server = startServer(0);
    const wsUrl = new URL("/v1/responses", server.url);
    wsUrl.protocol = "ws:";
    try {
      Date.now = () => now;
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "https://auth.openai.com/oauth/token") {
          return new Response(JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const ws = new WebSocket(wsUrl);
      const waitForOpen = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      const waitForTerminal = () => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket terminal timeout")), watchdogMs(1000));
        const onMessage = (event: MessageEvent) => {
          const text = typeof event.data === "string" ? event.data : "";
          if (text.includes('"type":"response.completed"')) {
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            resolve();
          }
        };
        ws.addEventListener("message", onMessage);
      });

      await waitForOpen;
      ws.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "hello" }));
      await waitForTerminal();
      Date.now = () => now + 180_000;
      ws.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "again" }));
      await waitForTerminal();
      ws.close();

      expect(seenAuth).toEqual(["Bearer old-access-token", "Bearer new-access-token"]);
      const logs = logsFromApiBody(await fetch(new URL("/api/logs?tail=2", server.url), { headers: managementHeaders() }).then(r => r.json()));
      expect(logs.map(entry => entry.status)).toEqual([200, 200]);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("websocket routed adapter records completed usage in request logs", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response([
          'event: message_start\n',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n',
          'event: content_block_delta\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
          'event: message_delta\n',
          'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
          'event: message_stop\n',
          'data: {"type":"message_stop"}\n\n',
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "anthropic-test",
      websockets: true,
      providers: {
        "anthropic-test": {
          adapter: "anthropic",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          allowPrivateNetwork: true,
          apiKey: "provider-key",
          defaultModel: "claude-fable-5",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    const wsUrl = new URL("/v1/responses", server.url);
    wsUrl.protocol = "ws:";
    try {
      const ws = new WebSocket(wsUrl);
      const waitForOpen = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      const waitForTerminal = () => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket terminal timeout")), watchdogMs(1000));
        const onMessage = (event: MessageEvent) => {
          const text = typeof event.data === "string" ? event.data : "";
          if (text.includes('"type":"response.completed"')) {
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            resolve();
          }
        };
        ws.addEventListener("message", onMessage);
      });

      await waitForOpen;
      ws.send(JSON.stringify({ type: "response.create", model: "anthropic-test/claude-fable-5", input: "hello" }));
      await waitForTerminal();
      ws.close();

      const logs = logsFromApiBody(await fetch(new URL("/api/logs?tail=1", server.url), { headers: managementHeaders() }).then(r => r.json()));
      expect(logs.at(-1)).toMatchObject({
        status: 200,
        terminalStatus: "completed",
        closeReason: "terminal",
        usageStatus: "reported",
        // inputTokens (25) is already inclusive of cache read (3) + write (2); total = 25 + 4
        totalTokens: 29,
        usage: {
          inputTokens: 25,
          outputTokens: 4,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 2,
        },
      });
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("Activation A: allow-listed 400 retries once on another eligible pool account", async () => {
    setDebugSettings({ debug: true });
    const harness = await startPoolRetryHarness(accountId => accountId === "acct-pool-a"
      ? rejectionResponse(unsupportedModelBody())
      : Response.json({ id: "retry-success", status: "completed", output: [] }));
    try {
      const response = await harness.request();
      expect(response.status).toBe(200);
      expect((await response.json() as { id: string }).id).toBe("retry-success");
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getCodexUpstreamHealth("pool-b")).toBeNull();
      expect(harness.config.activeCodexAccountId).toBe("pool-a");
      const affinity = getDebugLogEntries()
        .map(entry => entry.line)
        .filter(line => line.startsWith("[ocx:codex:affinity] "))
        .map(line => JSON.parse(line.slice("[ocx:codex:affinity] ".length)) as {
          status: number;
          authKind: string;
          credentialSubstituted: boolean;
        });
      expect(affinity).toEqual([
        expect.objectContaining({ status: 400, authKind: "pool", credentialSubstituted: true }),
        expect.objectContaining({ status: 200, authKind: "pool", credentialSubstituted: true }),
      ]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#2097: account-gated model selection skips an unentitled active Pool account", async () => {
    const model = "gpt-daybreak-blue-latest";
    const harness = await startPoolRetryHarness(
      accountId => Response.json({ id: accountId, status: "completed", output: [] }),
      {
        modelRosterByAccount: {
          "acct-pool-a": ["gpt-5.6-sol"],
          "acct-pool-b": ["gpt-5.6-sol", model],
        },
      },
    );
    try {
      const response = await harness.request({ model });
      expect(response.status).toBe(200);
      expect((await response.json() as { id: string }).id).toBe("acct-pool-b");
      expect(harness.dispatches).toEqual(["acct-pool-b"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#2097: Daybreak keeps its entitlement identity but uses the stable wire model", async () => {
    const model = "gpt-daybreak-blue-latest";
    let upstreamBody: Record<string, unknown> | undefined;
    const harness = await startPoolRetryHarness(
      async (_accountId, request) => {
        upstreamBody = await request.json() as Record<string, unknown>;
        return Response.json({ id: "canonical-wire-success", status: "completed", output: [] });
      },
      {
        secondAccount: false,
        modelRosterByAccount: { "acct-pool-a": ["gpt-5.6-sol", model] },
      },
    );
    try {
      const response = await harness.request({
        model,
        extraBody: { prompt_cache_retention: "24h" },
      });
      expect(response.status).toBe(200);
      expect(upstreamBody?.model).toBe("gpt-5.6-sol");
      expect(upstreamBody).not.toHaveProperty("prompt_cache_retention");
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#2097: Daybreak compact uses the stable wire model without retention", async () => {
    const model = "gpt-daybreak-blue-latest";
    let upstreamBody: Record<string, unknown> | undefined;
    let upstreamUrl = "";
    const harness = await startPoolRetryHarness(
      async (_accountId, request) => {
        upstreamUrl = request.url;
        upstreamBody = await request.json() as Record<string, unknown>;
        return new Response([
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","encrypted_content":"gAAAAAB-test-opaque"}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
          '',
          'data: [DONE]',
          '',
        ].join("\n"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      {
        secondAccount: false,
        modelRosterByAccount: { "acct-pool-a": ["gpt-5.6-sol", model] },
      },
    );
    try {
      const response = await harness.request({
        model,
        path: "/v1/responses/compact",
        extraBody: { prompt_cache_retention: "24h" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        output: [{ type: "compaction", encrypted_content: "gAAAAAB-test-opaque" }],
      });
      expect(upstreamUrl).toEndWith("/responses");
      expect(upstreamBody?.model).toBe("gpt-5.6-sol");
      expect(upstreamBody?.stream).toBe(true);
      expect(upstreamBody).not.toHaveProperty("prompt_cache_retention");
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#2097: a confirmed entitled account survives two transient unsupported-model 400s in place", async () => {
    const model = "gpt-daybreak-blue-latest";
    let attempts = 0;
    const harness = await startPoolRetryHarness(
      () => ++attempts <= 2
        ? rejectionResponse(unsupportedModelBody(model))
        : Response.json({ id: "same-account-success", status: "completed", output: [] }),
      {
        secondAccount: false,
        modelRosterByAccount: { "acct-pool-a": ["gpt-5.6-sol", model] },
      },
    );
    try {
      const response = await harness.request({ model });
      expect(response.status).toBe(200);
      expect((await response.json() as { id: string }).id).toBe("same-account-success");
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-a", "acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#2097: an exact account-gated selector may retry only its confirmed account in place", async () => {
    const model = "gpt-daybreak-blue-latest";
    let attempts = 0;
    const harness = await startPoolRetryHarness(
      () => ++attempts <= 2
        ? rejectionResponse(unsupportedModelBody(model))
        : Response.json({ id: "same-exact-account-success", status: "completed", output: [] }),
      {
        accountMode: "direct",
        activeAccountId: "pool-b",
        accountNamespaces: { side: "pool-a" },
        modelRosterByAccount: { "acct-pool-a": ["gpt-5.6-sol", model] },
      },
    );
    try {
      const response = await harness.request({ model: `side/${model}`, callerBearer: false });
      expect(response.status).toBe(200);
      expect((await response.json() as { id: string }).id).toBe("same-exact-account-success");
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-a", "acct-pool-a"]);
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#2097: repeated gated-model rejection remains bounded at eight total sends", async () => {
    const model = "gpt-daybreak-blue-latest";
    const body = unsupportedModelBody(model);
    const harness = await startPoolRetryHarness(
      () => rejectionResponse(body),
      {
        secondAccount: false,
        modelRosterByAccount: { "acct-pool-a": ["gpt-5.6-sol", model] },
      },
    );
    try {
      const response = await harness.request({ model });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(body);
      expect(harness.dispatches).toEqual(Array(8).fill("acct-pool-a"));
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#2097: an account-gated model with no confirmed grant fails before upstream dispatch", async () => {
    const model = "gpt-daybreak-blue-latest";
    const harness = await startPoolRetryHarness(
      () => Response.json({ id: "must-not-dispatch" }),
      {
        modelRosterByAccount: {
          "acct-pool-a": ["gpt-5.6-sol"],
          "acct-pool-b": ["gpt-5.6-sol"],
        },
      },
    );
    try {
      const response = await harness.request({ model });
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("No eligible Codex account supports this model");
      expect(harness.dispatches).toEqual([]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test.each([400, 402, 429])("exact account selector preserves the original %d without switching accounts", async status => {
    const body = status === 400
      ? unsupportedModelBody()
      : JSON.stringify({ error: { message: "rate limited" } });
    const harness = await startPoolRetryHarness(() => new Response(body, {
      status,
      headers: {
        "content-type": "application/json",
        "x-exact-response": "original",
        ...(status === 400 ? {} : { "retry-after": "60" }),
      },
    }), {
      accountMode: "direct",
      activeAccountId: "pool-b",
      accountNamespaces: { side: "pool-a" },
    });
    try {
      const response = await harness.request({ model: `side/${POOL_RETRY_MODEL}`, callerBearer: false });
      expect(response.status).toBe(status);
      expect(response.headers.get("x-exact-response")).toBe("original");
      expect(await response.text()).toBe(body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
      if (status !== 400) {
        const cooldown = await (await harness.request({ model: `side/${POOL_RETRY_MODEL}`, callerBearer: false })).text();
        expect(cooldown).toContain("selector (side)");
        expect(cooldown).not.toContain("pool-a");
        expect(harness.dispatches).toEqual(["acct-pool-a"]);
      }

      const entry = getRequestLogEntries().findLast(log => log.requestedModel === `side/${POOL_RETRY_MODEL}`);
      expect(entry?.provider).toBe("openai-side");
      const serialized = JSON.stringify(entry);
      for (const privateValue of ["pool-a", "acct-pool-a", "pool-a-token", "pool-a-refresh"]) {
        expect(serialized).not.toContain(privateValue);
      }
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("inline vision sidecar preserves an exact account binding", async () => {
    const caption = "caption from the exact account";
    const imageBytes = "ZXhhY3QtYWNjb3VudC1pbWFnZQ==";
    const upstreamBodies: string[] = [];
    const authorizationHeaders: Array<string | null> = [];
    const harness = await startPoolRetryHarness(async (_accountId, request) => {
      authorizationHeaders.push(request.headers.get("authorization"));
      upstreamBodies.push(await request.text());
      if (upstreamBodies.length === 1) {
        return new Response([
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: caption })}`,
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "exact-vision", status: "completed", output: [] });
    }, {
      activeAccountId: "pool-b",
      accountNamespaces: { side: "pool-a" },
      noVisionModels: [POOL_RETRY_MODEL],
    });
    try {
      const response = await originalGlobalFetch(new URL("/v1/responses", harness.server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `side/${POOL_RETRY_MODEL}`,
          stream: false,
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: `data:image/png;base64,${imageBytes}` }],
          }],
        }),
      });

      expect(response.status).toBe(200);
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-a"]);
      expect(authorizationHeaders).toEqual(["Bearer pool-a-token", "Bearer pool-a-token"]);
      expect(upstreamBodies).toHaveLength(2);
      expect(upstreamBodies[0]).toContain(imageBytes);
      expect(JSON.parse(upstreamBodies[0]) as { model?: string }).not.toMatchObject({ model: POOL_RETRY_MODEL });
      expect(JSON.parse(upstreamBodies[1]) as { model?: string }).toMatchObject({ model: POOL_RETRY_MODEL });
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("inline vision sidecar checks exact-account cooldown using the helper model", async () => {
    const sidecarModel = "gpt-5.3-codex-spark";
    const upstreamModels: string[] = [];
    const harness = await startPoolRetryHarness(async (_accountId, request) => {
      const body = await request.json() as { model?: string };
      upstreamModels.push(body.model ?? "missing");
      if (body.model === sidecarModel) {
        return new Response([
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "unexpected sidecar dispatch" })}`,
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "exact-vision-cooldown", status: "completed", output: [] });
    }, {
      activeAccountId: "pool-b",
      accountNamespaces: { side: "pool-a" },
      noVisionModels: [POOL_RETRY_MODEL],
      visionSidecarModel: sidecarModel,
    });
    try {
      const now = Date.now();
      recordCodexUpstreamOutcome(harness.config, "pool-a", 429, {
        now,
        resetAt: now + 60_000,
        modelId: sidecarModel,
        fixedAccount: true,
      });

      const response = await originalGlobalFetch(new URL("/v1/responses", harness.server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `side/${POOL_RETRY_MODEL}`,
          stream: false,
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: "data:image/png;base64,Y29vbGRvd24=" }],
          }],
        }),
      });

      expect(response.status).toBe(200);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
      expect(upstreamModels).toEqual([POOL_RETRY_MODEL]);
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("compact and WebSocket transports preserve an exact account binding", async () => {
    const wireModels: string[] = [];
    const authorizationHeaders: string[] = [];
    const harness = await startPoolRetryHarness(async (_accountId, request) => {
      const body = await request.json() as { model?: string };
      wireModels.push(body.model ?? "missing");
      authorizationHeaders.push(request.headers.get("authorization") ?? "missing");
      if (request.url.endsWith("/responses/compact")) {
        return Response.json({ output: [] });
      }
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"exact-ws","status":"completed","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }, {
      accountMode: "direct",
      activeAccountId: "pool-b",
      accountNamespaces: { side: "pool-a" },
      websockets: true,
      forwardApiKey: "configured-forward-key",
    });
    let ws: WebSocket | undefined;
    try {
      const compact = await harness.request({
        model: `side/${POOL_RETRY_MODEL}`,
        path: "/v1/responses/compact",
        callerBearer: false,
      });
      expect(compact.status).toBe(200);
      expect(authorizationHeaders).toEqual(["Bearer pool-a-token"]);

      const wsUrl = new URL("/v1/responses", harness.server.url);
      wsUrl.protocol = "ws:";
      ws = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("exact websocket timed out")),
          INTERNAL_DEADLINE_MS,
        );
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "response.create", model: `side/${POOL_RETRY_MODEL}`, input: "hello" }));
        }, { once: true });
        ws.addEventListener("message", event => {
          if (!String(event.data).includes("response.completed")) return;
          clearTimeout(timer);
          resolve();
        });
        ws.addEventListener("error", () => reject(new Error("exact websocket failed")), { once: true });
      });

      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-a"]);
      expect(authorizationHeaders).toEqual(["Bearer pool-a-token", "Bearer pool-a-token"]);
      expect(wireModels).toEqual([POOL_RETRY_MODEL, POOL_RETRY_MODEL]);
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    } finally {
      ws?.close();
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("translated Chat Completions and Claude Messages preserve an exact account binding", async () => {
    const wireModels: string[] = [];
    const authorizationHeaders: string[] = [];
    const harness = await startPoolRetryHarness(async (_accountId, request) => {
      const body = await request.json() as { model?: string };
      wireModels.push(body.model ?? "missing");
      authorizationHeaders.push(request.headers.get("authorization") ?? "missing");
      return Response.json({
        id: "resp_exact_translated",
        object: "response",
        status: "completed",
        model: POOL_RETRY_MODEL,
        output: [{
          id: "msg_exact_translated",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }, {
      accountMode: "direct",
      activeAccountId: "pool-b",
      accountNamespaces: { side: "pool-a" },
    });
    try {
      const cases = [
        {
          path: "/v1/chat/completions",
          headers: {},
          body: {
            model: `side/${POOL_RETRY_MODEL}`,
            messages: [{ role: "user", content: "hello" }],
          },
        },
        {
          path: "/v1/messages",
          headers: { "anthropic-version": "2023-06-01" },
          body: {
            model: `side/${POOL_RETRY_MODEL}`,
            max_tokens: 32,
            messages: [{ role: "user", content: "hello" }],
          },
        },
      ] as const;

      for (const { path, headers, body } of cases) {
        const response = await originalGlobalFetch(new URL(path, harness.server.url), {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }

      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-a"]);
      expect(authorizationHeaders).toEqual(["Bearer pool-a-token", "Bearer pool-a-token"]);
      expect(wireModels).toEqual([POOL_RETRY_MODEL, POOL_RETRY_MODEL]);
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test.each([
    ["paused", { pausedAccountIds: ["pool-a"] }, "Selected Codex account is unavailable"],
    ["reauth", { reauthAccountIds: ["pool-a"] }, "Selected Codex account needs reauthentication"],
    ["missing credential", { omitCredentialAccountIds: ["pool-a"] }, "Selected Codex account is unavailable"],
  ] as const)("WebSocket exact-account %s failures stay 401 and never fall back", async (_state, options, expectedMessage) => {
    const harness = await startPoolRetryHarness(
      () => Response.json({ id: "unexpected-dispatch", status: "completed", output: [] }),
      {
        accountMode: "direct",
        activeAccountId: "pool-b",
        accountNamespaces: { side: "pool-a" },
        websockets: true,
        ...options,
      },
    );
    const wsUrl = new URL("/v1/responses", harness.server.url);
    wsUrl.protocol = "ws:";
    const ws = new WebSocket(wsUrl);
    try {
      const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("exact websocket auth failure timed out")),
          INTERNAL_DEADLINE_MS,
        );
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "response.create", model: `side/${POOL_RETRY_MODEL}`, input: "hello" }));
        }, { once: true });
        ws.addEventListener("message", event => {
          const candidate = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (candidate.type !== "error") return;
          clearTimeout(timer);
          resolve(candidate);
        });
        ws.addEventListener("error", () => reject(new Error("exact websocket auth failure failed")), { once: true });
      });

      expect(frame).toMatchObject({
        type: "error",
        status: 401,
        error: { type: "authentication_error", message: expectedMessage },
      });
      const serialized = JSON.stringify(frame);
      for (const privateValue of ["pool-a", "acct-pool-a", "pool-a-token", "pool-a@example.test"]) {
        expect(serialized).not.toContain(privateValue);
      }
      expect(harness.dispatches).toEqual([]);
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getCodexUpstreamHealth("pool-b")).toBeNull();
    } finally {
      ws.close();
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("WebSocket exact-account cooldown errors expose only the public selector and never dispatch another account", async () => {
    const harness = await startPoolRetryHarness(
      () => Response.json({ id: "unexpected-dispatch", status: "completed", output: [] }),
      {
        accountMode: "direct",
        activeAccountId: "pool-b",
        accountNamespaces: { side: "pool-a" },
        websockets: true,
      },
    );
    recordCodexUpstreamOutcome(harness.config, "pool-a", 429, {
      retryAfter: "60",
      fixedAccount: true,
    });
    const wsUrl = new URL("/v1/responses", harness.server.url);
    wsUrl.protocol = "ws:";
    const ws = new WebSocket(wsUrl);
    try {
      const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("exact websocket cooldown timed out")),
          INTERNAL_DEADLINE_MS,
        );
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "response.create", model: `side/${POOL_RETRY_MODEL}`, input: "hello" }));
        }, { once: true });
        ws.addEventListener("message", event => {
          const candidate = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (candidate.type !== "error") return;
          clearTimeout(timer);
          resolve(candidate);
        });
        ws.addEventListener("error", () => reject(new Error("exact websocket cooldown failed")), { once: true });
      });

      expect(frame).toMatchObject({
        type: "error",
        status: 429,
        error: { type: "rate_limit_error" },
      });
      const message = String((frame.error as { message?: unknown }).message);
      expect(message).toContain("selector (side)");
      expect(message).toContain("pinned to that selector");
      for (const privateValue of ["pool-a", "acct-pool-a", "pool-a-token", "pool-a@example.test"]) {
        expect(message).not.toContain(privateValue);
      }
      expect(harness.dispatches).toEqual([]);
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
      expect(getCodexUpstreamHealth("pool-b")).toBeNull();
    } finally {
      ws.close();
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("#584: pre-stream 429 retries once on another eligible pool account", async () => {
    const harness = await startPoolRetryHarness(accountId => accountId === "acct-pool-a"
      ? new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      })
      : Response.json({ id: "quota-failover-success", status: "completed", output: [] }));
    try {
      const response = await harness.request();
      expect(response.status).toBe(200);
      expect((await response.json() as { id: string }).id).toBe("quota-failover-success");
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({ cooldownUntil: expect.any(Number) });
      // Server persists the rotated active account; the harness snapshot may be stale.
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#584: Retry-After cools the first account even when its account retry fails", async () => {
    const harness = await startPoolRetryHarness(accountId => accountId === "acct-pool-a"
      ? new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      })
      : new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }));
    try {
      const response = await harness.request();
      expect(response.status).toBe(503);
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      const health = getCodexUpstreamHealth("pool-a");
      expect(health).toMatchObject({
        cooldownSource: "retry-after",
      });
      expect(health?.cooldownUntil).toBeGreaterThan(Date.now());
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("combo reset deferral still cools the first account when its account retry succeeds", async () => {
    const harness = await startPoolRetryHarness(
      accountId => accountId === "acct-pool-a"
        ? new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
          },
        })
        : Response.json({ id: "combo-account-retry-success", status: "completed", output: [] }),
      {
        combos: {
          quota: {
            strategy: "failover",
            targets: [
              { provider: "openai", model: POOL_RETRY_MODEL },
              { provider: "openai", model: `${POOL_RETRY_MODEL}-fallback` },
            ],
          },
        },
      },
    );
    try {
      const response = await harness.request({ model: "combo/quota" });
      expect(response.status).toBe(200);
      expect((await response.json() as { id: string }).id).toBe("combo-account-retry-success");
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      expect(getCodexQuotaHealthSnapshot("pool-a", "shared")).toMatchObject({
        cooldownUntil: expect.any(Number),
        cooldownSource: "reset-derived",
        quotaScope: "shared",
      });
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("combo reset deferral preserves the first account when its account retry also fails", async () => {
    const harness = await startPoolRetryHarness(
      async (accountId, request) => {
        const body = await request.json() as { model?: string };
        if (body.model === `${POOL_RETRY_MODEL}-fallback`) {
          return Response.json({ id: "combo-later-model-success", status: "completed", output: [] });
        }
        if (accountId === "acct-pool-a") {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
            },
          });
        }
        return new Response(JSON.stringify({ error: { message: "retry later" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        });
      },
      {
        combos: {
          quota: {
            strategy: "failover",
            targets: [
              { provider: "openai", model: POOL_RETRY_MODEL },
              { provider: "openai", model: `${POOL_RETRY_MODEL}-fallback` },
            ],
          },
        },
      },
    );
    try {
      const response = await harness.request({ model: "combo/quota" });
      expect(response.status).toBe(200);
      expect((await response.json() as { id: string }).id).toBe("combo-later-model-success");
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b", "acct-pool-a"]);
      expect(getCodexQuotaHealthSnapshot("pool-a", "shared")).toBeNull();
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("#584: pre-stream 429 with one eligible account preserves the original 429", async () => {
    const body = JSON.stringify({ error: { message: "rate limited" } });
    const harness = await startPoolRetryHarness(
      () => new Response(body, {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60", "x-pool-retry-test": "original" },
      }),
      { secondAccount: false },
    );
    try {
      const response = await harness.request();
      expect(response.status).toBe(429);
      expect(response.headers.get("x-pool-retry-test")).toBe("original");
      expect(await response.text()).toBe(body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("#584: streamed pre-stream 429 retries before SSE relay", async () => {
    const harness = await startPoolRetryHarness(accountId => accountId === "acct-pool-a"
      ? new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      })
      : new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"from-b","status":"completed","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ));
    try {
      const text = await (await harness.request({ stream: true })).text();
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      expect(text).toContain('"id":"from-b"');
      expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("Activation B: allow-listed 400 with one eligible account preserves the original response", async () => {
    const body = unsupportedModelBody();
    const harness = await startPoolRetryHarness(() => rejectionResponse(body), { secondAccount: false });
    try {
      await expectOriginal400(await harness.request(), body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(harness.config.activeCodexAccountId).toBe("pool-a");
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("Activation C: malformed-input 400 never authorizes a pool retry", async () => {
    const body = JSON.stringify({ detail: "Invalid request: malformed tool schema" });
    const harness = await startPoolRetryHarness(() => rejectionResponse(body));
    try {
      await expectOriginal400(await harness.request(), body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getCodexUpstreamHealth("pool-b")).toBeNull();
      expect(isAccountNeedsReauth("pool-a")).toBe(false);
      expect(isAccountNeedsReauth("pool-b")).toBe(false);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("Activation D: second allow-listed 400 is returned without a third dispatch", async () => {
    const bodyA = unsupportedModelBody();
    const bodyB = `${unsupportedModelBody()}\n`;
    const harness = await startPoolRetryHarness(accountId => rejectionResponse(
      accountId === "acct-pool-a" ? bodyA : bodyB,
      { "x-pool-retry-test": accountId },
    ));
    try {
      const response = await harness.request();
      expect(response.status).toBe(400);
      expect(response.headers.get("x-pool-retry-test")).toBe("acct-pool-b");
      expect(await response.text()).toBe(bodyB);
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getCodexUpstreamHealth("pool-b")).toBeNull();
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("Activation E: both stream modes retry only before response relay construction", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      for (const streamMode of ["legacy-tee", "eager-relay"] as const) {
        const positive = await startPoolRetryHarness(accountId => accountId === "acct-pool-a"
          ? rejectionResponse(unsupportedModelBody())
          : new Response(
              'event: response.completed\ndata: {"type":"response.completed","response":{"id":"from-b","status":"completed","output":[]}}\n\n',
              { headers: { "content-type": "text/event-stream" } },
            ), { streamMode });
        try {
          const text = await (await positive.request({ stream: true })).text();
          expect(positive.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
          expect(text).toContain('"id":"from-b"');
        } finally {
          await stopPoolRetryHarness(positive);
        }

        const failedDetail = unsupportedModelBody().slice(10, -1);
        const negative = await startPoolRetryHarness(() => new Response(
          `event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":${JSON.stringify(failedDetail)}}}}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ), { streamMode });
        try {
          const text = await (await negative.request({ stream: true })).text();
          expect(negative.dispatches).toEqual(["acct-pool-a"]);
          expect(text).toContain("response.failed");
          expect(text).toContain("not supported when using Codex");
        } finally {
          await stopPoolRetryHarness(negative);
        }
      }
    } finally {
      if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("oversized 400 body never authorizes a pool retry", async () => {
    const body = `${unsupportedModelBody()}${"x".repeat(65_536)}`;
    const harness = await startPoolRetryHarness(() => rejectionResponse(body));
    try {
      await expectOriginal400(await harness.request(), body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getCodexUpstreamHealth("pool-b")).toBeNull();
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  // Stall past BOUNDED_BODY_TIMEOUT_MS (5s). The old 7s test budget left ~1.9s of
  // headroom and timed out on windows-latest under runner contention.
  test("stalled 400 body timeout never authorizes a pool retry", async () => {
    const prefix = unsupportedModelBody().slice(0, -1);
    const suffix = "}";
    const body = prefix + suffix;
    const harness = await startPoolRetryHarness(() => rejectionResponse(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(suffix));
          controller.close();
        }, 5_100);
      },
    })));
    try {
      const response = await harness.request();
      expect(response.status).toBe(400);
      expect(response.headers.get("x-pool-retry-test")).toBe("original");
      expect(await response.text()).toBe(body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  // Same windows-latest contention budget as the stalled-body case above: abort
  // teardown and harness stop can exceed Bun's default 5s under runner load.
  test("aborted 400 inspection never authorizes a pool retry", async () => {
    let releaseDispatch!: () => void;
    const dispatched = new Promise<void>(resolve => { releaseDispatch = resolve; });
    const harness = await startPoolRetryHarness(() => {
      releaseDispatch();
      return rejectionResponse(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(unsupportedModelBody().slice(0, -1)));
        },
      }));
    });
    const controller = new AbortController();
    try {
      const pending = harness.request({ signal: controller.signal });
      await dispatched;
      controller.abort(new DOMException("test abort", "AbortError"));
      await expect(pending).rejects.toThrow();
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("invalid JSON 400 never authorizes a pool retry", async () => {
    const body = '{"detail":';
    const harness = await startPoolRetryHarness(() => rejectionResponse(body));
    try {
      await expectOriginal400(await harness.request(), body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("missing or non-string detail never authorizes a pool retry", async () => {
    const bodies = ["{}", '{"detail":null}', '{"detail":400}', '{"detail":{"message":"unsupported"}}'];
    let nextBody = 0;
    const harness = await startPoolRetryHarness(() => rejectionResponse(bodies[nextBody++]!));
    try {
      for (const body of bodies) {
        const priorDispatches = harness.dispatches.length;
        await expectOriginal400(await harness.request(), body);
        expect(harness.dispatches.slice(priorDispatches)).toEqual(["acct-pool-a"]);
      }
      expect(nextBody).toBe(bodies.length);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("wrong model id in exact sentence never authorizes a pool retry", async () => {
    const body = unsupportedModelBody("other-model");
    const harness = await startPoolRetryHarness(() => rejectionResponse(body));
    try {
      await expectOriginal400(await harness.request(), body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("normalization near-misses never authorize a pool retry", async () => {
    const exact = `The '${POOL_RETRY_MODEL}' model is not supported when using Codex with a ChatGPT account.`;
    const cases = [
      exact.slice(0, -1),
      exact.replaceAll("'", "\u2019"),
      `prefix ${exact}`,
      `${exact} suffix`,
      exact.replace("ChatGPT account.", "ChatGPT account"),
    ];
    const negativeBodies = cases.map(detail => JSON.stringify({ detail }));
    let nextNegative = 0;
    const negative = await startPoolRetryHarness(() => rejectionResponse(negativeBodies[nextNegative++]!));
    try {
      for (const body of negativeBodies) {
        const priorDispatches = negative.dispatches.length;
        await expectOriginal400(await negative.request(), body);
        expect(negative.dispatches.slice(priorDispatches)).toEqual(["acct-pool-a"]);
      }
      expect(nextNegative).toBe(negativeBodies.length);
    } finally {
      await stopPoolRetryHarness(negative);
    }
    const positive = await startPoolRetryHarness(accountId => accountId === "acct-pool-a"
      ? rejectionResponse(JSON.stringify({ detail: `  THE   '${POOL_RETRY_MODEL}' MODEL IS NOT SUPPORTED\nWHEN USING CODEX WITH A CHATGPT ACCOUNT.  ` }))
      : Response.json({ id: "normalized", status: "completed", output: [] }));
    try {
      expect((await (await positive.request()).json() as { id: string }).id).toBe("normalized");
      expect(positive.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
    } finally {
      await stopPoolRetryHarness(positive);
    }
  }, 12_000);

  test("valid JSON wrong top-level shape never authorizes a pool retry", async () => {
    // One harness, five bodies — same reason as the sibling above. Each
    // startPoolRetryHarness() wipes and recreates TEST_DIR, binds a server, and
    // redirects global fetch; five of those did not fit Bun's 5s default on a
    // Windows runner, and the request still in flight when the budget expired
    // raced the next test through that same global fetch.
    const bodies = ['"string"', "42", "true", "null", '["detail"]'];
    let nextBody = 0;
    const harness = await startPoolRetryHarness(() => rejectionResponse(bodies[nextBody++]!));
    try {
      for (const body of bodies) {
        const priorDispatches = harness.dispatches.length;
        await expectOriginal400(await harness.request(), body);
        expect(harness.dispatches.slice(priorDispatches)).toEqual(["acct-pool-a"]);
      }
      expect(nextBody).toBe(bodies.length);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("alternate account resolution failure preserves the original 400", async () => {
    const body = unsupportedModelBody();
    const harness = await startPoolRetryHarness(() => rejectionResponse(body));
    markAccountNeedsReauth("pool-b");
    try {
      await expectOriginal400(await harness.request(), body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("retry-dispatch transport failure records only B and never triple-dispatches", async () => {
    const harness = await startPoolRetryHarness(() => rejectionResponse(unsupportedModelBody()));
    const redirectedFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const accountId = new Headers(init?.headers).get("chatgpt-account-id");
      if (accountId === "acct-pool-b") {
        harness.dispatches.push(accountId);
        throw new Error("synthetic retry connect failure");
      }
      return redirectedFetch(input, init);
    }) as typeof fetch;
    try {
      const response = await harness.request();
      expect(response.status).toBe(502);
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getCodexUpstreamHealth("pool-b")).toMatchObject({
        consecutiveFailures: 1,
        lastFailureStatus: 0,
      });
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("WS-REBIND-01: successful retry migrates the WebSocket registry from A to B", async () => {
    const registrySnapshots: Array<[number, number]> = [];
    const harness = await startPoolRetryHarness(accountId => {
      registrySnapshots.push([
        getTrackedCodexWebSocketCountForAccount("pool-a"),
        getTrackedCodexWebSocketCountForAccount("pool-b"),
      ]);
      return accountId === "acct-pool-a"
        ? rejectionResponse(unsupportedModelBody())
        : new Response(
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"ws-b","status":"completed","output":[]}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
    });
    harness.config.websockets = true;
    saveConfig(harness.config);
    await harness.server.stop(true);
    harness.server = startServer(0);
    const wsUrl = new URL("/v1/responses", harness.server.url);
    wsUrl.protocol = "ws:";
    const ws = new WebSocket(wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "response.create", model: POOL_RETRY_MODEL, input: "hello" }));
        }, { once: true });
        ws.addEventListener("message", event => {
          if (String(event.data).includes("response.completed")) resolve();
        });
        ws.addEventListener("error", () => reject(new Error("websocket retry failed")), { once: true });
        // This 1s was the real cause of WS-REBIND-01 failing at 748ms on windows-latest:
        // an internal deadline, not Bun's test budget, which is why it died far too fast
        // to look like a timeout. The test stops and restarts a real server, opens a real
        // WebSocket, and waits for a two-hop retry across accounts — a second of that on a
        // contended runner is optimistic. The assertions below are unchanged; only the
        // room to reach them grew.
        setTimeout(() => reject(new Error("websocket retry timed out")), INTERNAL_DEADLINE_MS);
      });
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      expect(registrySnapshots).toEqual([[1, 0], [0, 1]]);
      expect(getTrackedCodexWebSocketCountForAccount("pool-a")).toBe(0);
      expect(getTrackedCodexWebSocketCountForAccount("pool-b")).toBe(1);
    } finally {
      ws.close();
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: 30_000 });

  test("passthrough connect failure records selected pool account health", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    redirectCanonicalCodexTo("http://127.0.0.1:9/");
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: poolProviders(),
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
      connectTimeoutMs: 200,
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });
    // Known low quota keeps "pool-a" the deterministic active (this case tests
    // failure-health recording, not the all-unknown rotation added in Phase 10).
    updateAccountQuota("pool-a", 10, 5);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      });

      expect(response.status).toBe(502);
      // #914: a dead-port refusal is pre-connection — host-wide, not account
      // evidence. Account health stays untouched; the (provider, host) ledger
      // records the failure instead.
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getUpstreamHostHealth(upstreamHostHealthKey("openai", "https://chatgpt.com")))
        .toMatchObject({ consecutiveFailures: 1, lastFailureCode: "ConnectionRefused" });
    } finally {
      await server.stop(true);
    }
  });

  test("passthrough pool send relays a 307 with Location and records no health evidence (#914)", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");
    clearUpstreamHostHealth();

    // The upstream answers 307 -> dead.invalid. Manual redirects must relay it
    // (with Location) instead of following into a dead-host rejection.
    const redirectTarget = "https://dead.invalid/x";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      if (url.hostname === "chatgpt.com") {
        // The test would only reach this branch if the proxy wrongly followed
        // the redirect itself — fail loudly instead of hanging on dead.invalid.
        expect(url.hostname).not.toBe("dead.invalid");
        return new Response(null, { status: 307, headers: { location: redirectTarget } });
      }
      return originalGlobalFetch(input, init);
    }) as typeof fetch;

    saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: poolProviders(),
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
      connectTimeoutMs: 200,
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });
    updateAccountQuota("pool-a", 10, 5);

    // Seed a pre-connection streak: the 307 is also a real HTTP response and
    // must clear it.
    const hostKey = upstreamHostHealthKey("openai", "https://chatgpt.com");
    recordUpstreamHostFailure(hostKey, { code: "ECONNREFUSED" });

    const server = startServer(0);
    try {
      const response = await originalGlobalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
        redirect: "manual",
      });

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(redirectTarget);
      // Neutral class: no account streak, no soft-avoid, no rotation, and the
      // real response cleared the seeded host streak.
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(isCodexAccountSoftAvoided("pool-a")).toBe(false);
      expect(getUpstreamHostHealth(hostKey)).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("passthrough SSE terminal failure is recorded without clearing health on initial 200", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    redirectCanonicalCodexTo(upstream.url.toString());
    const cfg = {
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: poolProviders(),
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
    } as OcxConfig;
    saveConfig(cfg);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });
    updateAccountQuota("pool-a", 10, 5);
    recordCodexUpstreamOutcome(cfg, "pool-a", 503);
    recordCodexUpstreamOutcome(cfg, "pool-a", 503);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      await response.text();
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        consecutiveFailures: 3,
        lastFailureStatus: 502,
      });
      const logs = logsFromApiBody(await fetch(new URL("/api/logs?tail=1", server.url), { headers: managementHeaders() }).then(r => r.json()));
      expect(logs.at(-1)).toMatchObject({
        status: 502,
        errorCode: "upstream_server_error",
        terminalStatus: "failed",
        closeReason: "terminal",
      });
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("passthrough SSE cyber terminal is logged as 400 cyber_policy", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearRequestLogsForTests();

    const message = "This content was flagged for possible cybersecurity risk. To get authorized for security work, join the Trusted Access for Cyber program.";
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response([
          "event: response.failed",
          `data: ${JSON.stringify({
            type: "response.failed",
            response: {
              status: "failed",
              error: { type: "invalid_request_error", code: "cyber_policy", message },
            },
          })}`,
          "",
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      },
    });
    redirectCanonicalCodexTo(upstream.url.toString());
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: poolProviders(),
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("response.failed");
      const logs = logsFromApiBody(await fetch(new URL("/api/logs?tail=1", server.url), { headers: managementHeaders() }).then(r => r.json()));
      expect(logs.at(-1)).toMatchObject({
        status: 400,
        errorCode: "cyber_policy",
        terminalStatus: "failed",
        closeReason: "terminal",
        upstreamError: message,
        attempts: [expect.objectContaining({ status: 400, errorCode: "cyber_policy" })],
      });
    } finally {
      await server.stop(true);
      await upstream.stop(true);
      clearRequestLogsForTests();
    }
  });

  test("native passthrough SSE records completed usage without pool terminal tracking", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            "event: response.completed",
            'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-5.5","usage":{"input_tokens":11,"output_tokens":7,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-responses",
          baseUrl: upstream.url.toString(),
          allowPrivateNetwork: true,
          apiKey: "provider-key",
          defaultModel: "gpt-5.5",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-openai/gpt-5.5", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      await response.text();
      const logs = logsFromApiBody(await fetch(new URL("/api/logs?tail=1", server.url), { headers: managementHeaders() }).then(r => r.json()));
      expect(logs.at(-1)).toMatchObject({
        status: 200,
        terminalStatus: "completed",
        closeReason: "terminal",
        usageStatus: "reported",
        totalTokens: 18,
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cachedInputTokens: 3,
          reasoningOutputTokens: 2,
        },
      });

      const usage = await fetch(new URL("/api/usage?range=all&surface=codex", server.url), { headers: managementHeaders() }).then(r => r.json()) as {
        surface: string;
        summary: { requests: number; reportedRequests: number; totalTokens: number };
        models: Array<{ provider: string; model: string; reportedRequests: number; totalTokens: number }>;
      };
      expect(usage.surface).toBe("codex");
      expect(usage.summary).toMatchObject({ requests: 1, reportedRequests: 1, totalTokens: 18 });
      expect(usage.models.at(-1)).toMatchObject({
        provider: "test-openai",
        model: "gpt-5.5",
        reportedRequests: 1,
        totalTokens: 18,
      });

      const claudeUsage = await fetch(new URL("/api/usage?range=all&surface=claude", server.url), { headers: managementHeaders() }).then(r => r.json()) as {
        surface: string;
        summary: { requests: number };
      };
      expect(claudeUsage.surface).toBe("claude");
      expect(claudeUsage.summary.requests).toBe(0);
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("passthrough SSE client cancel aborts the upstream request", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;

    let releaseAbort!: () => void;
    const upstreamAborted = new Promise<void>(resolve => { releaseAbort = resolve; });
    const originalFetch = globalThis.fetch;
    const enc = new TextEncoder();
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://upstream.example/backend-api/codex/v1/responses") {
        init?.signal?.addEventListener("abort", releaseAbort, { once: true });
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(enc.encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
                return;
              }
              return new Promise<void>(() => {});
            },
            cancel() {
              releaseAbort();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-responses",
          baseUrl: "https://upstream.example/backend-api/codex",
          apiKey: "provider-key",
          defaultModel: "gpt-test",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const clientAbort = new AbortController();
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-openai/gpt-test", input: "hello", stream: true }),
        signal: clientAbort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      clientAbort.abort("client gone");
      await reader.cancel("client gone").catch(() => {});

      await Promise.race([
        upstreamAborted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("upstream was not aborted")), 500)),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await server.stop(true);
    }
  });

  test("non-forward generated stream does not mutate active pool health", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
            'data: {"error":{"message":"upstream failed","code":"server_error"}}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-chat",
          baseUrl: `${upstream.url}v1`,
          allowPrivateNetwork: true,
          apiKey: "provider-key",
          defaultModel: "gpt-test",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "test-openai/gpt-test", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.failed");
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });
});
