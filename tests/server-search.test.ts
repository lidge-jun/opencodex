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
import { setCodexAccountPaused } from "../src/codex/account-pause";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../src/server/request-log";
import { handleSearch, SEARCH_RESPONSE_MAX_BYTES } from "../src/server/search";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, ".tmp-server-search-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;
const DIRECT_CHATGPT_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-search-codex-");
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
  clearAccountQuota();
  clearRequestLogsForTests();
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
  clearAccountNeedsReauth("pool-b");
  clearAccountQuota();
  clearRequestLogsForTests();
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

function exactSearchConfig(): OcxConfig {
  return {
    ...forwardConfig(),
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        // Exercise the exact-account override of global Direct mode.
        codexAccountMode: "direct",
      },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "private-a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      { id: "pool-b", email: "private-b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" },
    ],
    activeCodexAccountId: "pool-b",
    codexAccountNamespaces: { side: "pool-a" },
  } as OcxConfig;
}

function saveExactSearchCredentials(): void {
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool-a-token",
    refreshToken: "pool-a-refresh",
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: "acct-pool-a",
  });
  saveCodexAccountCredential("pool-b", {
    accessToken: "pool-b-token",
    refreshToken: "pool-b-refresh",
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: "acct-pool-b",
  });
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
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
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
    expect(captured[0].headers.get("authorization")).toBe(`Bearer ${DIRECT_CHATGPT_TOKEN}`);
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

test("an account-qualified search model uses that exact account and sends the bare model upstream", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured);
  saveConfig(exactSearchConfig());
  saveExactSearchCredentials();

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "search-session", model: "side/gpt-test" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer pool-a-token");
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-pool-a");
    expect(captured[0].body).toMatchObject({ id: "search-session", model: "gpt-test" });
    expect(loadConfig().activeCodexAccountId).toBe("pool-b");

    const entry = getRequestLogEntries().findLast(candidate => candidate.model === "side/gpt-test");
    expect(entry?.provider).toBe("openai-side");
    const serialized = JSON.stringify(entry);
    for (const privateValue of ["pool-a", "acct-pool-a", "pool-a-token", "private-a@example.test"]) {
      expect(serialized).not.toContain(privateValue);
    }
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an exact search 429 never switches to the active Pool account and reports only its public selector", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured, 429, { error: { message: "rate limited" } });
  saveConfig(exactSearchConfig());
  saveExactSearchCredentials();

  const server = startServer(0);
  try {
    const requestExactSearch = () => fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "search-session", model: "side/gpt-test" }),
    });

    const first = await requestExactSearch();
    expect(first.status).toBe(429);
    expect(captured.map(request => request.headers.get("chatgpt-account-id"))).toEqual(["acct-pool-a"]);
    expect(loadConfig().activeCodexAccountId).toBe("pool-b");

    const second = await requestExactSearch();
    expect(second.status).toBe(429);
    const message = ((await second.json()) as { error: { message: string } }).error.message;
    expect(message).toContain("selector (side)");
    expect(message).toContain("pinned to that selector");
    for (const privateValue of ["pool-a", "acct-pool-a", "private-a@example.test"]) {
      expect(message).not.toContain(privateValue);
    }
    expect(captured).toHaveLength(1);
    expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    expect(getCodexUpstreamHealth("pool-b")).toBeNull();
    const entry = getRequestLogEntries().findLast(candidate => candidate.model === "side/gpt-test");
    expect(entry?.provider).toBe("openai-side");
    expect(JSON.stringify(entry)).not.toContain("pool-a");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an unavailable exact search account fails closed without dispatching the active Pool account", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured);
  const config = exactSearchConfig();
  setCodexAccountPaused(config, "pool-a", true);
  saveConfig(config);
  saveExactSearchCredentials();

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "search-session", model: "side/gpt-test" }),
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { message: string } }).error.message)
      .toBe("Selected Codex account is unavailable");
    expect(captured).toHaveLength(0);
    expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    expect(getCodexUpstreamHealth("pool-b")).toBeNull();
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an exact search account needing reauthentication fails closed with an actionable error", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeSearchUpstream(captured);
  const config = exactSearchConfig();
  saveConfig(config);
  saveExactSearchCredentials();
  recordCodexUpstreamOutcome(config, "pool-a", 401, {
    fixedAccount: true,
    modelId: "gpt-test",
  });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "search-session", model: "side/gpt-test" }),
    });
    expect(response.status).toBe(401);
    const message = ((await response.json()) as { error: { message: string } }).error.message;
    expect(message).toBe("Selected Codex account needs reauthentication");
    for (const privateValue of ["pool-a", "acct-pool-a", "private-a@example.test"]) {
      expect(message).not.toContain(privateValue);
    }
    expect(captured).toHaveLength(0);
    expect(loadConfig().activeCodexAccountId).toBe("pool-b");
    expect(getCodexUpstreamHealth("pool-b")).toBeNull();
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
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
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
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
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

test("relays arbitrary search response bytes and content type verbatim", async () => {
  const payload = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x28]);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname === "chatgpt.com") {
      return new Response(payload, { status: 418, headers: { "content-type": "application/octet-stream" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig(forwardConfig());

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(418);
    expect(response.headers.get("content-type")).toContain("application/octet-stream");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(payload));
  } finally {
    await server.stop(true);
  }
});

test("cancels an oversized streaming search response without draining the stream", async () => {
  const cap = SEARCH_RESPONSE_MAX_BYTES;
  let upstreamCanceled = false;
  let tailPulled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname !== "chatgpt.com") return originalFetch(input, init);
    const chunks = [
      new Uint8Array(cap),
      new Uint8Array([0x01]),
      new Uint8Array([0x7f]),
      new Uint8Array([0x7e]),
    ];
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (!chunk) return controller.close();
        if (chunk.byteLength === 1 && chunk[0] === 0x7e) tailPulled = true;
        controller.enqueue(chunk);
      },
      cancel() { upstreamCanceled = true; },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  saveConfig(forwardConfig());

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { message: string } }).error.message)
      .toContain("search response too large");
    expect(upstreamCanceled).toBe(true);
    // WHATWG streams may prefetch one queued chunk, but cancellation must stop further draining.
    expect(tailPulled).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("a search body that stalls after headers retains the total 504 deadline", async () => {
  let upstreamCanceled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname === "chatgpt.com") {
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { upstreamCanceled = true; },
      }), { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({ ...forwardConfig(), search: { timeoutMs: 50 } } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/alpha/search", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    });
    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("timed out");
    expect(upstreamCanceled).toBe(true);
  } finally {
    await server.stop(true);
  }
}, 5_000);

test("a client abort during search body reading maps to 499 and cancels upstream", async () => {
  let markBodyStarted: (() => void) | undefined;
  const bodyStarted = new Promise<void>(resolve => { markBodyStarted = resolve; });
  let upstreamCanceled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname === "chatgpt.com") {
      return new Response(new ReadableStream<Uint8Array>({
        pull() { markBodyStarted?.(); },
        cancel() { upstreamCanceled = true; },
      }), { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const parent = new AbortController();
  const request = new Request("http://127.0.0.1/v1/alpha/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
      "chatgpt-account-id": "acct-123",
    },
    body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    signal: parent.signal,
  });
  const reading = handleSearch(request, forwardConfig(), { model: "", provider: "" });
  await bodyStarted;
  parent.abort(new Error("client stopped"));

  const response = await reading;
  expect(response.status).toBe(499);
  expect(upstreamCanceled).toBe(true);
});

test("a client abort before the search reader attaches cancels the untouched upstream body", async () => {
  const parent = new AbortController();
  let upstreamCanceled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname === "chatgpt.com") {
      const response = new Response(new ReadableStream<Uint8Array>({
        cancel() { upstreamCanceled = true; },
      }), { headers: { "content-type": "application/json" } });
      parent.abort(new Error("client stopped before body read"));
      return response;
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const request = new Request("http://127.0.0.1/v1/alpha/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
      "chatgpt-account-id": "acct-123",
    },
    body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    signal: parent.signal,
  });

  const response = await handleSearch(request, forwardConfig(), { model: "", provider: "" });
  expect(response.status).toBe(499);
  expect(upstreamCanceled).toBe(true);
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
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
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
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
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
