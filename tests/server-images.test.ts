/**
 * /v1/images/{generations,edits} relay (issue #83): codex-rs's image_gen extension POSTs these
 * paths against the injected base_url, so the proxy must relay them to an OpenAI-family upstream
 * instead of the /v1/* JSON-404 guard.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { selectImagesProvider } from "../src/providers/openai-sidecar";
import { startServer } from "../src/server";
import { saveCredential } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";
import { ANTIGRAVITY_REQUEST_UA } from "../src/adapters/google-antigravity-wire";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousImagesApiKey = process.env.OPENCODEX_TEST_IMAGES_API_KEY;
const originalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, ".tmp-server-images-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;
const DIRECT_CHATGPT_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OPENCODEX_TEST_IMAGES_API_KEY = "custom-images-key";
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-images-codex-");
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
  if (previousImagesApiKey === undefined) delete process.env.OPENCODEX_TEST_IMAGES_API_KEY;
  else process.env.OPENCODEX_TEST_IMAGES_API_KEY = previousImagesApiKey;
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

function fakeImagesUpstream(captured: CapturedRequest[], status = 200, payload?: unknown) {
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json(),
      });
      return Response.json(
        payload ?? { created: 1_767_000_000, data: [{ b64_json: "aGVsbG8=" }] },
        { status },
      );
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    let path: string | undefined;
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      path = url.pathname.slice("/backend-api/codex".length);
    } else if (url.hostname === "api.openai.com" && url.pathname.startsWith("/v1")) {
      path = url.pathname;
    }
    if (path) return originalFetch(new URL(`${path}${url.search}`, upstream.url), init);
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

const disabledOpenAiProvider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  disabled: true,
} as const;

const canonicalOpenAiProvider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

function keyedProvider(_baseUrl = "") {
  return { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-platform-key" };
}

test("POST /v1/images/generations relays to the ChatGPT forward provider with forwarded auth", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({ prompt: "a halftone gothic hero", model: "gpt-image-2", size: "auto" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: 1_767_000_000, data: [{ b64_json: "aGVsbG8=" }] });

    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/images/generations");
    expect(captured[0].headers.get("authorization")).toBe(`Bearer ${DIRECT_CHATGPT_TOKEN}`);
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(captured[0].body).toMatchObject({ prompt: "a halftone gothic hero", model: "gpt-image-2" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("POST /v1/images/edits relays to the /images/edits upstream path", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/edits", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({
        prompt: "add gold ink",
        model: "gpt-image-2",
        images: [{ image_url: "data:image/png;base64,aGk=" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/images/edits");
    expect(captured[0].body).toMatchObject({ prompt: "add gold ink" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("a routed pool account's token overrides the caller bearer on the forward relay", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    ...forwardConfig(upstream.url.toString().replace(/\/$/, "")),
    defaultProvider: "openai",
    providers: {
      openai: { ...canonicalOpenAiProvider, codexAccountMode: "pool" },
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
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    // Pool routing selected pool-a; the caller token must NOT reach upstream.
    expect(captured[0].headers.get("authorization")).toBe("Bearer pool-access-token");
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-pool-a");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("zstd-compressed request bodies are decoded before the relay", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const raw = JSON.stringify({ prompt: "compressed prompt", model: "gpt-image-2" });
    const response = await fetch(new URL("/v1/images/generations", server.url), {
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
    expect(captured[0].body).toMatchObject({ prompt: "compressed prompt" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("falls back to a keyed openai-responses provider when no forward provider exists", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "openai-apikey",
    openaiProviderTierVersion: 2,
    providers: {
      openai: disabledOpenAiProvider,
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The caller's ChatGPT OAuth token must NOT reach a platform API-key upstream.
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
      },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-platform-key");
    // Keyed baseUrl had no /v1 suffix — the relay normalizes to the platform path.
    expect(captured[0].path).toBe("/v1/images/generations");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an explicit custom Images provider uses its configured endpoint, key, and headers", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json(),
      });
      return Response.json({ created: 1_767_000_000, data: [{ b64_json: "aGVsbG8=" }] });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "custom-images",
    openaiProviderTierVersion: 2,
    providers: {
      "custom-images": {
        adapter: "openai-responses",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        allowPrivateNetwork: true,
        authMode: "key",
        apiKey: "${OPENCODEX_TEST_IMAGES_API_KEY}",
        headers: { "x-provider-route": "images" },
      },
    },
    images: { provider: "custom-images" },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
      },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/images/generations");
    expect(captured[0].headers.get("authorization")).toBe("Bearer custom-images-key");
    expect(captured[0].headers.get("x-provider-route")).toBe("images");
    expect(captured[0].body).toMatchObject({ prompt: "a cat", model: "gpt-image-2" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an explicit Images provider accepts bearer admission without leaking the proxy secret", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "proxy-admission-secret";
  const captured: CapturedRequest[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json(),
      });
      return Response.json({ created: 1_767_000_000, data: [{ b64_json: "aGVsbG8=" }] });
    },
  });
  saveConfig({
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "custom-images",
    openaiProviderTierVersion: 2,
    providers: {
      "custom-images": {
        adapter: "openai-responses",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        allowPrivateNetwork: true,
        authMode: "key",
        apiKey: "${OPENCODEX_TEST_IMAGES_API_KEY}",
      },
    },
    images: { provider: "custom-images" },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer proxy-admission-secret",
      },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer custom-images-key");
    expect([...captured[0].headers.values()].some(value => value.includes("proxy-admission-secret"))).toBe(false);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an invalid explicit Images provider returns 400 after bearer admission", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "proxy-admission-secret";
  saveConfig({
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "custom-images",
    openaiProviderTierVersion: 2,
    providers: {
      "custom-images": {
        adapter: "openai-chat",
        baseUrl: "https://images.example.test/v1",
        apiKey: "custom-images-key",
      },
    },
    images: { provider: "custom-images" },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer proxy-admission-secret",
      },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("must be an API-key openai-responses provider");
  } finally {
    await server.stop(true);
  }
});

test("an invalid explicit Images provider fails closed instead of using another upstream", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "openai-apikey",
    openaiProviderTierVersion: 2,
    providers: {
      openai: disabledOpenAiProvider,
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
      "custom-images": {
        adapter: "openai-chat",
        baseUrl: "https://images.example.test/v1",
        apiKey: "custom-images-key",
      },
    },
    images: { provider: "custom-images" },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(400);
    expect(captured).toHaveLength(0);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("must be an API-key openai-responses provider");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an explicit Images provider cannot reuse a registry-managed provider id", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "openai-apikey",
    openaiProviderTierVersion: 2,
    providers: {
      openai: disabledOpenAiProvider,
      "openai-apikey": keyedProvider(),
    },
    images: { provider: "openai-apikey" },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("must name a custom provider");
  } finally {
    await server.stop(true);
  }
});

test.each([
  ["missing", undefined, "is not configured"],
  ["disabled", { adapter: "openai-responses", baseUrl: "https://images.example.test/v1", apiKey: "key", disabled: true }, "is disabled"],
  ["wrong adapter", { adapter: "openai-chat", baseUrl: "https://images.example.test/v1", apiKey: "key" }, "must be an API-key openai-responses provider"],
  ["forward auth", { adapter: "openai-responses", baseUrl: "https://images.example.test/v1", apiKey: "key", authMode: "forward" }, "must be an API-key openai-responses provider"],
  ["oauth auth", { adapter: "openai-responses", baseUrl: "https://images.example.test/v1", apiKey: "key", authMode: "oauth" }, "must be an API-key openai-responses provider"],
  ["local auth", { adapter: "openai-responses", baseUrl: "https://images.example.test/v1", apiKey: "key", authMode: "local" }, "must be an API-key openai-responses provider"],
  ["missing key", { adapter: "openai-responses", baseUrl: "https://images.example.test/v1", authMode: "key" }, "has no usable API key"],
] as const)("explicit Images provider rejects %s configuration", (_case, provider, expectedError) => {
  const selection = selectImagesProvider({
    port: 0,
    defaultProvider: "custom-images",
    providers: provider ? { "custom-images": provider } : {},
    images: { provider: "custom-images" },
  } as OcxConfig);

  expect(selection.keyed).toBeUndefined();
  expect(selection.forwardCandidates).toHaveLength(0);
  expect(selection.error).toContain(expectedError);
});

test("keyed baseUrl with a /v1 suffix is normalized (no double /v1)", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "openai-apikey",
    openaiProviderTierVersion: 2,
    providers: {
      openai: disabledOpenAiProvider,
      "openai-apikey": keyedProvider(`${upstream.url.toString().replace(/\/$/, "")}/v1`),
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/images/generations");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an unauthenticated request skips the forward provider when a keyed provider exists", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      // ENABLED forward provider: an accidental forward relay would fail loudly (port 1).
      openai: canonicalOpenAiProvider,
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-platform-key");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an unauthenticated request gets 401 when only the forward provider exists", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: { openai: canonicalOpenAiProvider },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(401);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("ChatGPT auth");
  } finally {
    await server.stop(true);
  }
});

test("pool auth failure is not hidden by the keyed API provider", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: { ...canonicalOpenAiProvider, codexAccountMode: "pool" },
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    // pool-a has NO stored credential, so forward-auth resolution throws CodexAuthContextError.
    activeCodexAccountId: "pool-a",
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(401);
    expect(captured).toHaveLength(0);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("reauthentication");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("forward-auth failure surfaces its own error when no keyed provider exists", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: { ...canonicalOpenAiProvider, codexAccountMode: "pool" },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    activeCodexAccountId: "pool-a",
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(401);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("reauthentication");
  } finally {
    await server.stop(true);
  }
});

test("returns an honest 400 when no OpenAI-family upstream is configured", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "groq",
    openaiProviderTierVersion: 2,
    providers: {
      openai: disabledOpenAiProvider,
      groq: { adapter: "openai-chat", baseUrl: "https://api.groq.example/v1", apiKey: "gsk-x" },
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    // 4xx (not 5xx): codex retries every 5xx up to 5 total attempts, and this is a permanent
    // configuration state. The actionable part is the message, which codex Debug-prints into
    // the model-visible tool failure.
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { type: string; message: string } };
    expect(json.error.message).toContain("image generation");
    expect(json.error.message).toContain("disable image_generation");
  } finally {
    await server.stop(true);
  }
});

test("relays upstream error status and body verbatim", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured, 403, {
    error: { message: "Your plan does not allow image generation.", type: "forbidden" },
  });
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(403);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toBe("Your plan does not allow image generation.");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("a hung upstream times out with 504 after config.images.timeoutMs", async () => {
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
    images: { timeoutMs: 100 },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(504);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("timed out");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
}, 5_000);

test("GET /v1/images/generations still falls through to the JSON 404 guard", async () => {
  saveConfig(forwardConfig("https://chatgpt.example/backend-api/codex"));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  } finally {
    await server.stop(true);
  }
});

test("images routes require API auth and local Origin on non-loopback bindings", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
  saveConfig({
    ...forwardConfig("https://chatgpt.example/backend-api/codex"),
    hostname: "0.0.0.0",
  });

  const server = startServer(0);
  const imagesUrl = `http://127.0.0.1:${server.port}/v1/images/generations`;
  try {
    const missingAuth = await fetch(imagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(missingAuth.status).toBe(401);

    const badOrigin = await fetch(imagesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencodex-api-key": "local-secret",
        origin: "https://attacker.test",
      },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(badOrigin.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});

test("the proxy admission secret is never relayed to the forward upstream", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: canonicalOpenAiProvider,
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    // Authorization carries the proxy's OWN admission token — it authenticates the caller to the
    // proxy, but must be stripped before upstream selection (else it would leak to chatgpt.com).
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-secret" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(401);
    expect(captured).toHaveLength(0);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

// ── Google Antigravity (CCA) image generation fallback ──

/**
 * CCA config for image tests. The config-level baseUrl is deliberately set to an
 * attacker host to prove the CCA path pins to the registry entry
 * (daily-cloudcode-pa.googleapis.com) and ignores this override. The OAuth token
 * comes from the credential store via getValidAccessToken, not from config apiKey.
 */
function ccaConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "google-antigravity",
    openaiProviderTierVersion: 2,
    providers: {
      openai: disabledOpenAiProvider,
      "google-antigravity": {
        adapter: "google",
        baseUrl: "https://attacker.example.com",
        googleMode: "cloud-code-assist",
      } as OcxConfig["providers"][string],
    },
  } as OcxConfig;
}

interface CcaFetchRequest {
  url: string;
  headers: Headers;
  body: unknown;
}

/**
 * Stub globalThis.fetch for CCA image tests: requests to the registry host
 * (daily-cloudcode-pa.googleapis.com) get a canned response and are recorded in
 * `registryHits`; requests to any other non-localhost host are recorded in
 * `otherHits` (to prove the attacker host is never contacted); localhost requests
 * pass through to the real network stack (the test proxy server).
 */
function ccaFetchMock(
  registryHits: CcaFetchRequest[],
  otherHits: CcaFetchRequest[],
  response?: { status?: number; payload?: unknown },
) {
  const status = response?.status ?? 200;
  const payload = response?.payload ?? {
    response: {
      candidates: [{
        content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] },
      }],
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const headers = new Headers(init?.headers);
    let parsedBody: unknown;
    if (init?.body && typeof init.body === "string") {
      try { parsedBody = JSON.parse(init.body); } catch { /* non-JSON body */ }
    }
    if (url.hostname === "daily-cloudcode-pa.googleapis.com") {
      registryHits.push({ url: requestUrl, headers, body: parsedBody });
      return Response.json(payload, { status });
    }
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      otherHits.push({ url: requestUrl, headers, body: parsedBody });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

const CCA_CREDENTIAL = {
  access: "cca-access-token",
  refresh: "cca-refresh-token",
  expires: Date.now() + 3_600_000,
  projectId: "cca-project-123",
} as const;

test("CCA image fallback generates images via Google Antigravity when no OpenAI upstream exists", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits);

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a neon cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { b64_json: string }[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0].b64_json).toBe("aGVsbG8=");

    // The CCA call MUST hit the registry host, not the config-level baseUrl.
    expect(registryHits).toHaveLength(1);
    expect(registryHits[0].url).toContain("daily-cloudcode-pa.googleapis.com");
    expect(registryHits[0].url).toContain("generateContent");
    const body = registryHits[0].body as { model?: string; request?: { generationConfig?: { responseModalities?: string[] } } };
    expect(body.model).toBe("gemini-3.1-flash-image");
    expect(body.request?.generationConfig?.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(registryHits[0].headers.get("authorization")).toBe("Bearer cca-access-token");
    // The CCA image request must use the shared Antigravity User-Agent (not a
    // bespoke "opencodex-images/1.0"), so the request fingerprint matches the
    // OAuth credential.
    expect(registryHits[0].headers.get("user-agent")).toBe(ANTIGRAVITY_REQUEST_UA);

    // The attacker host (config baseUrl) must NOT receive any request.
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA image fallback preserves upstream 429 status", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, { status: 429, payload: { error: { message: "Rate limited" } } });

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(429);
    // The registry host was hit, not the attacker host.
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA fallback does not serve image edits", async () => {
  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/edits", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "edit this", model: "gpt-image-2" }),
    });
    // Edits should NOT hit the CCA fallback — it's text-to-image only.
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("image generation");
  } finally {
    await server.stop(true);
  }
});

test("CCA image fallback never sends Authorization to a tampered config baseUrl (sink-host regression)", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const attackerHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, attackerHits);

  // ccaConfig already sets baseUrl to https://attacker.example.com — if the pin
  // were ever removed, this host would receive the OAuth bearer token.
  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(200);

    // The registry host received the request with the OAuth bearer token.
    expect(registryHits).toHaveLength(1);
    expect(registryHits[0].url).toContain("daily-cloudcode-pa.googleapis.com");
    expect(registryHits[0].headers.get("authorization")).toBe("Bearer cca-access-token");

    // The attacker host received ZERO requests — no Authorization header leak.
    const authLeak = attackerHits.filter(r => r.headers.get("authorization"));
    expect(attackerHits).toHaveLength(0);
    expect(authLeak).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA image fallback rejects an empty prompt with 400 before any OAuth work", async () => {
  saveConfig(ccaConfig());
  // Deliberately do NOT save a google-antigravity credential: if the prompt
  // check did not fire first, getValidAccessToken would throw, and the request
  // would fall through to the misleading "no provider configured" 400 — not the
  // "prompt is required" message asserted below.

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("prompt is required");
  } finally {
    await server.stop(true);
  }
});

test("CCA image fallback rejects a whitespace-only prompt with 400", async () => {
  saveConfig(ccaConfig());

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "   ", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("prompt is required");
  } finally {
    await server.stop(true);
  }
});

test("CCA fallback serves images when OpenAI forward auth fails but Google Antigravity is logged in", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits);

  // OpenAI forward provider in pool mode, but pool-a has NO stored credential →
  // forward auth resolution throws CodexAuthContextError. Without the CCA
  // fallback the user gets a 401 even though they have a valid Google login.
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: { ...canonicalOpenAiProvider, codexAccountMode: "pool" },
      "google-antigravity": {
        adapter: "google",
        baseUrl: "https://attacker.example.com",
        googleMode: "cloud-code-assist",
      } as OcxConfig["providers"][string],
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    activeCodexAccountId: "pool-a",
  } as OcxConfig);
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    // OpenAI forward auth failed, but CCA picked up the slack.
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { b64_json: string }[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0].b64_json).toBe("aGVsbG8=");

    // CCA was called on the registry host, not the attacker host.
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA OAuth refresh failure returns 502, not a misleading 400 'none configured'", async () => {
  saveConfig(ccaConfig());
  // Deliberately do NOT save a google-antigravity credential. The provider IS
  // configured, but getValidAccessToken will throw OAuthLoginRequiredError.
  // This must surface as a 502 upstream error, NOT the permanent 400
  // "none configured" message that implies the user forgot to add a provider.

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(502);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("OAuth token refresh failed");
  } finally {
    await server.stop(true);
  }
});

test("CCA fetch network failure returns 502 without leaking the timeout timer", async () => {
  // Mock: CCA fetch always fails with a network error. The bug was that the
  // fetch catch returned 502 without calling linkedSignal.cleanup(), leaving
  // the timeout timer alive. With a short timeout this would keep the process
  // alive. The fix wraps everything in try/finally so cleanup always runs.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "daily-cloudcode-pa.googleapis.com") {
      throw new TypeError("fetch failed: connection refused");
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  saveConfig({ ...ccaConfig(), images: { timeoutMs: 10_000 } } as OcxConfig);
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(502);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("CCA image generation failed");
  } finally {
    await server.stop(true);
  }
}, 5_000);

test("CCA body-read timeout returns 504 when upstream stalls after sending headers", async () => {
  // Mock: CCA returns 200 OK headers immediately but the body stream never
  // produces data. The linked signal's timeout aborts reader.read(), which
  // must be caught and mapped to 504 — previously the rejection escaped
  // tryCcaImageGeneration entirely.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "daily-cloudcode-pa.googleapis.com") {
      const fetchSignal = init?.signal;
      const stalledBody = new ReadableStream<Uint8Array>({
        start(controller) {
          // Never produce data — stall until the fetch signal aborts, then
          // error the stream so reader.read() rejects with the abort reason.
          if (fetchSignal) {
            if (fetchSignal.aborted) {
              controller.error(fetchSignal.reason);
            } else {
              fetchSignal.addEventListener("abort", () => controller.error(fetchSignal.reason), { once: true });
            }
          }
        },
      });
      return new Response(stalledBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  saveConfig({ ...ccaConfig(), images: { timeoutMs: 100 } } as OcxConfig);
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(504);
    const json = await response.json() as { error: { message: string } };
    // Either the body-read timeout message or the general timeout message.
    expect(json.error.message).toMatch(/body read|timed out/i);
  } finally {
    await server.stop(true);
  }
}, 5_000);

test("CCA image fallback preserves upstream 400 (not collapsed to 502)", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, { status: 400, payload: { error: { message: "Invalid prompt content" } } });

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    // 400 must be forwarded, not collapsed to 502.
    expect(response.status).toBe(400);
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});
