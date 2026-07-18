/**
 * /v1/alpha/search relay: codex-rs's built-in web search client POSTs this path against the
 * injected base_url, so the proxy must relay it to the ChatGPT forward provider instead of the
 * /v1/* JSON-404 guard.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, ".tmp-server-search-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-search-codex-");
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountQuota();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountQuota();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

interface CapturedRequest {
  path: string;
  headers: Headers;
  body: unknown;
}

function fakeSearchUpstream(captured: CapturedRequest[], status = 200, payload?: unknown) {
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json(),
      });
      return Response.json(
        payload ?? { encrypted_output: "ciphertext", output: "search result" },
        { status },
      );
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const prefix = "/backend-api/codex";
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
      const target = new URL(`${url.pathname.slice(prefix.length)}${url.search}`, upstream.url);
      return originalFetch(target, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return upstream;
}

function forwardConfig(_baseUrl = ""): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

test("POST /v1/alpha/search relays to the ChatGPT forward provider with forwarded auth", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured);
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer chatgpt-user-token",
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({
        id: "search-session",
        model: "gpt-test",
        commands: { search_query: [{ q: "OpenAI news" }] },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ encrypted_output: "ciphertext", output: "search result" });

    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/alpha/search");
    expect(captured[0].headers.get("authorization")).toBe("Bearer chatgpt-user-token");
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(captured[0].body).toMatchObject({ id: "search-session", model: "gpt-test" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("a routed pool account's token overrides the caller bearer on the search relay", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured);
  saveConfig({
    ...forwardConfig(upstream.url.toString().replace(/\/$/, "")),
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    activeCodexAccountId: "pool-a",
  } as OcxConfig);
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool-access-token",
    refreshToken: "pool-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: "acct-pool-a",
  });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer pool-access-token");
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-pool-a");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("zstd-compressed search request bodies are decoded before the relay", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured);
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const raw = JSON.stringify({ id: "compressed-search", model: "gpt-test" });
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
        authorization: "Bearer chatgpt-user-token",
      },
      body: Bun.zstdCompressSync(Buffer.from(raw)),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("content-encoding")).toBeNull();
    expect(captured[0].body).toMatchObject({ id: "compressed-search", model: "gpt-test" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an unauthenticated search request gets 401", async () => {
  saveConfig(forwardConfig("https://chatgpt.example/backend-api/codex"));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(401);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("ChatGPT auth");
  } finally {
    await server.stop(true);
  }
});

test("returns an honest 400 when no ChatGPT forward provider is configured", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "groq",
    openaiProviderTierVersion: 2,
    providers: {
      groq: { adapter: "openai-chat", baseUrl: "https://api.groq.example/v1", apiKey: "gsk-x" },
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("ChatGPT forward provider");
    expect(json.error.message).toContain("/v1/alpha/search");
  } finally {
    await server.stop(true);
  }
});

test("relays search upstream error status and body verbatim", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured, 403, {
    error: { message: "Search is not available for this account.", type: "forbidden" },
  });
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-user-token" },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(403);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toBe("Search is not available for this account.");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("a hung search upstream times out with 504 after config.search.timeoutMs", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      return new Promise<Response>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("client aborted")), { once: true });
      });
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(url.pathname.slice("/backend-api/codex".length), upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    ...forwardConfig(upstream.url.toString().replace(/\/$/, "")),
    search: { timeoutMs: 100 },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-user-token" },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(504);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("timed out");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
}, 5_000);

test("a short connectTimeoutMs does NOT cut a slow search (total deadline is search.timeoutMs)", async () => {
  // Regression: alpha/search is non-streaming, so its headers arrive only when the search
  // completes. Reusing connectTimeoutMs as the relay deadline killed every search longer than
  // the header-arrival budget (often ~10s in real configs).
  const upstream = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise(resolve => setTimeout(resolve, 300));
      return Response.json({ output: "slow but fine" });
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(url.pathname.slice("/backend-api/codex".length), upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    ...forwardConfig(upstream.url.toString().replace(/\/$/, "")),
    connectTimeoutMs: 50,
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-user-token" },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: "slow but fine" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
}, 5_000);

test("GET /v1/alpha/search still falls through to the JSON 404 guard", async () => {
  saveConfig(forwardConfig("https://chatgpt.example/backend-api/codex"));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  } finally {
    await server.stop(true);
  }
});

test("search routes require API auth and local Origin on non-loopback bindings", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
  saveConfig({
    ...forwardConfig("https://chatgpt.example/backend-api/codex"),
    hostname: "0.0.0.0",
  });

  const server = startServer(0);
  const searchUrl = `http://127.0.0.1:${server.port}/v1/alpha/search`;
  try {
    const missingAuth = await fetch(searchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "search-session" }),
    });
    expect(missingAuth.status).toBe(401);

    const badOrigin = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencodex-api-key": "local-secret",
        origin: "https://attacker.test",
      },
      body: JSON.stringify({ id: "search-session" }),
    });
    expect(badOrigin.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});

test("the proxy admission secret is never relayed to the search upstream", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured);
  saveConfig({ ...forwardConfig(), hostname: "0.0.0.0" });

  const server = startServer(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/alpha/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-secret" },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(401);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("admission credentials");
    expect(captured).toHaveLength(0);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});
