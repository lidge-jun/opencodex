import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { getTrackedCodexWebSocketCountForAccount } from "../src/codex/websocket-registry";
import { clearAccountNeedsReauth, clearAccountQuota, getAccountQuota, isAccountNeedsReauth, markAccountNeedsReauth, updateAccountQuota } from "../src/codex/auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import { loadConfig, saveConfig } from "../src/config";
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
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalGlobalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, ".tmp-server-auth-test");
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
  request: (init?: { stream?: boolean; signal?: AbortSignal }) => Promise<Response>;
  server: ReturnType<typeof startServer>;
  upstream: ReturnType<typeof Bun.serve>;
};

async function startPoolRetryHarness(
  reply: (accountId: string, request: Request) => Response | Promise<Response>,
  options: { secondAccount?: boolean; streamMode?: "legacy-tee" | "eager-relay" } = {},
): Promise<PoolRetryHarness> {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");

  const dispatches: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const accountId = request.headers.get("chatgpt-account-id") ?? "missing";
      dispatches.push(accountId);
      return reply(accountId, request);
    },
  });
  redirectCanonicalCodexTo(upstream.url.toString());

  const secondAccount = options.secondAccount ?? true;
  const config = {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: poolProviders(),
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ...(secondAccount
        ? [{ id: "pool-b", email: "pool-b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" }]
        : []),
    ],
    activeCodexAccountId: "pool-a",
    ...(options.streamMode ? { streamMode: options.streamMode } : {}),
  } as OcxConfig;
  saveConfig(config);
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool-a-token",
    refreshToken: "pool-a-refresh",
    expiresAt: Date.now() + 10 * 60_000,
    chatgptAccountId: "acct-pool-a",
  });
  updateAccountQuota("pool-a", 10);
  if (secondAccount) {
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool-b-token",
      refreshToken: "pool-b-refresh",
      expiresAt: Date.now() + 10 * 60_000,
      chatgptAccountId: "acct-pool-b",
    });
    updateAccountQuota("pool-b", 20);
  }

  const server = startServer(0);
  return {
    config,
    dispatches,
    server,
    upstream,
    request: ({ stream = false, signal } = {}) => originalGlobalFetch(
      new URL("/v1/responses", server.url),
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
        body: JSON.stringify({ model: POOL_RETRY_MODEL, input: "hello", stream }),
        signal,
      },
    ),
  };
}

async function stopPoolRetryHarness(harness: PoolRetryHarness): Promise<void> {
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

  test("safeConfigDTO redacts provider secrets and exposes booleans", () => {
    const unsafe = config("127.0.0.1");
    unsafe.openaiProviderTierVersion = 1;
    Object.assign(unsafe.providers.openai as unknown as Record<string, unknown>, {
      apiKeyPool: [{ id: "pool-id", key: "pool-secret", label: "private-pool-label" }],
      modelMaxInputTokens: { "gpt-test": 1000 },
      codexAccountMode: "pool",
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
    ]) expect(serialized).not.toContain(forbidden);
    expect(dto.providers.openai).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      defaultModel: "gpt-test",
      hasApiKey: true,
      hasHeaders: true,
      codexAccountMode: "pool",
    });
    expect(dto.providers.openai).not.toHaveProperty("apiKey");
    expect(dto.providers.openai).not.toHaveProperty("headers");
    expect(dto.providers.openai.disabled).toBeUndefined();
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
        headers: { "x-opencodex-api-key": "local-secret", origin: "https://attacker.test" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "cross-origin request blocked" });

      const ok = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: { "x-opencodex-api-key": "local-secret", origin: `http://127.0.0.1:${server.port}` },
      });
      expect(ok.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("/api/system/memory rides the management auth gate; /healthz shape unchanged (#314 WP3)", async () => {
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
        headers: { "x-opencodex-api-key": "local-secret" },
      });
      expect(ok.status).toBe(200);
      const body = await ok.json() as { rss?: number; bunVersion?: string };
      expect(body.rss).toBeGreaterThan(0);
      expect(body.bunVersion).toBe(Bun.version);

      // /healthz must NOT gain memory/runtime introspection — it is unauthenticated.
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      const healthBody = await health.json() as Record<string, unknown>;
      expect(Object.keys(healthBody).sort()).toEqual(["pid", "port", "service", "status", "uptime", "version"]);
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
        headers: { origin },
      });
      expect(settings.status).toBe(200);
      expect(settings.headers.get("access-control-allow-origin")).toBe(origin);
      expect(settings.headers.get("vary")).toContain("Origin");

      const active = await fetch(new URL("/api/codex-auth/active", server.url), {
        headers: { origin },
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
        headers: {
          host: `lan.example.test:${server.port}`,
          origin,
          "x-opencodex-api-key": "local-secret",
        },
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
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "GET",
        headers: {
          authorization: "Bearer inbound-main-token",
          connection: "Upgrade",
          upgrade: "websocket",
          origin: "https://attacker.test",
          "x-opencodex-api-key": "local-secret",
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
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
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
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
        const timer = setTimeout(() => reject(new Error("tier websocket timeout")), 1000);
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
      const direct = startServer(0);
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
        if (state === "reauth") markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        if (state === "cooldown") recordCodexUpstreamOutcome(cfg, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "60" });
        saveConfig(cfg);
        const before = seen.length;
        const unusableMain = startServer(0);
        try {
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
      const missingPool = startServer(0);
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
      const cooledMulti = startServer(0);
      try {
        expect((await compact(cooledMulti)).status).toBe(429);
        expect(seen).toHaveLength(beforeCooldown);
      } finally {
        await cooledMulti.stop(true);
      }
      clearCodexUpstreamHealth();
      const multi = startServer(0);
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
      const api = startServer(0);
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
          const timer = setTimeout(() => reject(new Error(`sequential websocket timeout: ${model}`)), 1000);
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
          headers: { "content-type": "application/json", "x-opencodex-api-key": "local-secret" },
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
      globalThis.fetch = originalGlobalFetch;
      await upstream.stop(true);
    }
  });

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
        const timer = setTimeout(() => reject(new Error("websocket affinity timeout")), 1000);
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
        const timer = setTimeout(() => reject(new Error("websocket terminal timeout")), 1000);
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
      const logs = await fetch(new URL("/api/logs?tail=2", server.url)).then(r => r.json()) as Array<{ status: number }>;
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
        const timer = setTimeout(() => reject(new Error("websocket terminal timeout")), 1000);
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

      const logs = await fetch(new URL("/api/logs?tail=1", server.url)).then(r => r.json()) as Array<{
        status: number;
        terminalStatus?: string;
        closeReason?: string;
        usageStatus?: string;
        totalTokens?: number;
        usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
      }>;
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
  });

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
  }, 7_000);

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
  });

  test("invalid JSON 400 never authorizes a pool retry", async () => {
    const body = '{"detail":';
    const harness = await startPoolRetryHarness(() => rejectionResponse(body));
    try {
      await expectOriginal400(await harness.request(), body);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  });

  test("missing or non-string detail never authorizes a pool retry", async () => {
    for (const body of ["{}", '{"detail":null}', '{"detail":400}', '{"detail":{"message":"unsupported"}}']) {
      const harness = await startPoolRetryHarness(() => rejectionResponse(body));
      try {
        await expectOriginal400(await harness.request(), body);
        expect(harness.dispatches).toEqual(["acct-pool-a"]);
      } finally {
        await stopPoolRetryHarness(harness);
      }
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
    for (const detail of cases) {
      const body = JSON.stringify({ detail });
      const harness = await startPoolRetryHarness(() => rejectionResponse(body));
      try {
        await expectOriginal400(await harness.request(), body);
        expect(harness.dispatches).toEqual(["acct-pool-a"]);
      } finally {
        await stopPoolRetryHarness(harness);
      }
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
  });

  test("valid JSON wrong top-level shape never authorizes a pool retry", async () => {
    for (const body of ['"string"', "42", "true", "null", '["detail"]']) {
      const harness = await startPoolRetryHarness(() => rejectionResponse(body));
      try {
        await expectOriginal400(await harness.request(), body);
        expect(harness.dispatches).toEqual(["acct-pool-a"]);
      } finally {
        await stopPoolRetryHarness(harness);
      }
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
        setTimeout(() => reject(new Error("websocket retry timed out")), 1_000);
      });
      expect(harness.dispatches).toEqual(["acct-pool-a", "acct-pool-b"]);
      expect(registrySnapshots).toEqual([[1, 0], [0, 1]]);
      expect(getTrackedCodexWebSocketCountForAccount("pool-a")).toBe(0);
      expect(getTrackedCodexWebSocketCountForAccount("pool-b")).toBe(1);
    } finally {
      ws.close();
      await stopPoolRetryHarness(harness);
    }
  });

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
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        consecutiveFailures: 1,
        lastFailureStatus: 0,
      });
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
      const logs = await fetch(new URL("/api/logs?tail=1", server.url)).then(r => r.json()) as Array<{ status: number; errorCode?: string; terminalStatus?: string; closeReason?: string }>;
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
      const logs = await fetch(new URL("/api/logs?tail=1", server.url)).then(r => r.json()) as Array<{
        status: number;
        terminalStatus?: string;
        closeReason?: string;
        usageStatus?: string;
        totalTokens?: number;
        usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningOutputTokens?: number };
      }>;
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

      const usage = await fetch(new URL("/api/usage?range=all&surface=codex", server.url)).then(r => r.json()) as {
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

      const claudeUsage = await fetch(new URL("/api/usage?range=all&surface=claude", server.url)).then(r => r.json()) as {
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
