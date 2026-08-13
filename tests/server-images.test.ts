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
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { selectImagesProvider } from "../src/providers/openai-sidecar";
import { startServer } from "../src/server";
import { handleImages, IMAGES_RESPONSE_MAX_BYTES, readImageResponseBytes } from "../src/server/images";
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

test("image response byte reader enforces the stream cap when Content-Length is understated", async () => {
  const chunks = [
    new Uint8Array(5),
    new Uint8Array([0x01]),
    new Uint8Array([0x7f]),
    new Uint8Array([0x7e]),
  ];
  let canceled = false;
  let tailPulled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (!chunk) return controller.close();
      if (chunk.byteLength === 1 && chunk[0] === 0x7e) tailPulled = true;
      controller.enqueue(chunk);
    },
    cancel() { canceled = true; },
  }), { headers: { "content-length": "1" } });

  const observed = await readImageResponseBytes(response, { maxBytes: 5 });
  expect(observed.oversized).toBe(true);
  expect(observed.bytes.byteLength).toBe(0);
  expect(canceled).toBe(true);
  // One queued chunk may be prefetched; cancellation must stop later draining.
  expect(tailPulled).toBe(false);
});

test("POST /v1/images/generations relays to the ChatGPT forward provider with forwarded auth", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  const config = forwardConfig();
  config.providers.openai!.baseUrl = "https://chatgpt.com/backend-api/codex///";
  saveConfig(config);

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

test("relays arbitrary upstream image bytes with status and content-type unchanged", async () => {
  const payload = new Uint8Array([0x00, 0xff, 0x80, 0x7f]);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname === "chatgpt.com") {
      return new Response(payload, {
        status: 418,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig(forwardConfig());

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
    expect(response.status).toBe(418);
    expect(response.headers.get("content-type")).toContain("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  } finally {
    await server.stop(true);
  }
});

test("relays a bodyless upstream image status without synthesizing a body", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname === "chatgpt.com") {
      return new Response(null, {
        status: 204,
        headers: { "content-length": String(IMAGES_RESPONSE_MAX_BYTES + 1) },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig(forwardConfig());

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
    expect(response.status).toBe(204);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("records an oversized forward response status before returning the size error", async () => {
  let upstreamCanceled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname === "chatgpt.com") {
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { upstreamCanceled = true; },
      }), {
        status: 429,
        headers: {
          "content-length": String(IMAGES_RESPONSE_MAX_BYTES + 1),
          "content-type": "application/json",
          "retry-after": "60",
        },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    ...forwardConfig(),
    providers: { openai: { ...canonicalOpenAiProvider, codexAccountMode: "pool" } },
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
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { message: string } }).error.message)
      .toContain("response too large");
    expect(upstreamCanceled).toBe(true);
    expect(getCodexUpstreamHealth("pool-a")).toMatchObject({ lastFailureStatus: 429 });
  } finally {
    await server.stop(true);
  }
});

test("an image body that stalls after headers retains the 504 deadline", async () => {
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
  saveConfig({ ...forwardConfig(), images: { timeoutMs: 50 } } as OcxConfig);

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
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("timed out");
    expect(upstreamCanceled).toBe(true);
  } finally {
    await server.stop(true);
  }
}, 5_000);

test("a client abort during image body reading maps to 499 and cancels upstream", async () => {
  let markReaderAttached: (() => void) | undefined;
  const readerAttached = new Promise<void>(resolve => { markReaderAttached = resolve; });
  let pulls = 0;
  let upstreamCanceled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(requestUrl).hostname === "chatgpt.com") {
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 1) {
            // Fill the initial queue. The second pull only happens after the
            // handler's reader consumes this chunk, proving reader attachment.
            controller.enqueue(new Uint8Array([0x01]));
            return;
          }
          markReaderAttached?.();
        },
        cancel() { upstreamCanceled = true; },
      }), { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const parent = new AbortController();
  const request = new Request("http://127.0.0.1/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
      "chatgpt-account-id": "acct-123",
    },
    body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    signal: parent.signal,
  });
  const reading = handleImages(request, forwardConfig(), "generations", { model: "", provider: "" });
  await readerAttached;
  parent.abort(new Error("client stopped"));

  const response = await reading;
  expect(response.status).toBe(499);
  expect(upstreamCanceled).toBe(true);
});

test("a client abort before the image reader attaches cancels the untouched upstream body", async () => {
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

  const request = new Request("http://127.0.0.1/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
      "chatgpt-account-id": "acct-123",
    },
    body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    signal: parent.signal,
  });
  const response = await handleImages(request, forwardConfig(), "generations", { model: "", provider: "" });
  expect(response.status).toBe(499);
  expect(upstreamCanceled).toBe(true);
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
    // proxy, but must never be forwarded as ChatGPT credentials. OpenAI forward is skipped; a
    // configured keyed provider may still serve the request with its own apiKey.
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-secret" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-platform-key");
    expect([...captured[0].headers.values()].some(v => v.includes("local-secret"))).toBe(false);
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

const CCA_TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

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
        content: { parts: [{ inlineData: { mimeType: "image/png", data: CCA_TINY_PNG } }] },
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
    expect(json.data[0].b64_json).toBe(CCA_TINY_PNG);

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
    expect(json.data[0].b64_json).toBe(CCA_TINY_PNG);

    // CCA was called on the registry host, not the attacker host.
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA OAuth no credential saved returns 401 (login required), not a misleading 502/400", async () => {
  saveConfig(ccaConfig());
  // Deliberately do NOT save a google-antigravity credential. The provider IS
  // configured, but getValidAccessToken will throw OAuthLoginRequiredError.
  // This must surface as a 401 "login required" — NOT 502 (which implies a
  // transient refresh/network failure) or the permanent 400 "none configured"
  // message that implies the user forgot to add a provider.

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(401);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("login required");
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
  // must be caught and mapped to 504. The abort surfaces as a generic
  // AbortError (not TimeoutError) — just like in production Bun — so the
  // signal-state check (linkedSignal.signal.aborted) is what maps it, not
  // err.name matching.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "daily-cloudcode-pa.googleapis.com") {
      const fetchSignal = init?.signal;
      const stalledBody = new ReadableStream<Uint8Array>({
        start(controller) {
          // Never produce data — stall until the fetch signal aborts, then
          // error the stream as AbortError (the typical rejection Bun's
          // stream layer produces on linked-signal abort, NOT TimeoutError).
          const abortError = new DOMException("The operation was aborted.", "AbortError");
          if (fetchSignal) {
            if (fetchSignal.aborted) {
              controller.error(abortError);
            } else {
              fetchSignal.addEventListener("abort", () => controller.error(abortError), { once: true });
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

test("CCA body-read client cancellation returns 499, not 504", async () => {
  // Regression for Wibias R4 finding 1: when the client aborts during the body-read
  // phase, both the parent signal and the linked signal are aborted (parent abort
  // propagates into the linked signal). The body-read catch must check the PARENT
  // signal first (499) before the linked signal (504), otherwise client cancellation
  // is misreported as an upstream timeout.
  //
  // We call handleImages directly (not via server fetch) because a client-side
  // fetch abort tears down the connection before the server response can be read.
  const { handleImages } = await import("../src/server/images");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "daily-cloudcode-pa.googleapis.com") {
      const fetchSignal = init?.signal;
      const stalledBody = new ReadableStream<Uint8Array>({
        start(controller) {
          const abortError = new DOMException("The operation was aborted.", "AbortError");
          if (fetchSignal) {
            if (fetchSignal.aborted) controller.error(abortError);
            else fetchSignal.addEventListener("abort", () => controller.error(abortError), { once: true });
          }
        },
      });
      return new Response(stalledBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  // Use a long timeout so the deadline does NOT fire — only the client abort triggers.
  const cfg = { ...ccaConfig(), images: { timeoutMs: 30_000 } } as OcxConfig;
  saveConfig(cfg);
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const ctrl = new AbortController();
  const req = new Request("http://localhost:0/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "a cat" }),
    signal: ctrl.signal,
  });
  const logCtx = { model: "", provider: "" } as never;

  // Start the handler — it enters the body-read loop and stalls on the mocked body.
  const responsePromise = handleImages(req, cfg, "generations", logCtx);
  // Abort the parent signal after the body read has started.
  setTimeout(() => ctrl.abort(), 100);
  const response = await responsePromise;
  expect(response.status).toBe(499);
  const json = await response.json() as { error: { message: string } };
  expect(json.error.message).toContain("canceled");
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

test("CCA image response with malformed inlineData.data (non-string) returns 502, not fake image data", async () => {
  // Regression for codex1-malformed-inlinedata: inlineData.data that is not a
  // non-empty string (e.g. a number, object, or empty string) used to pass the
  // truthiness check and was forwarded as a fake b64_json. Now it must be
  // silently skipped, and when no valid images remain the response is 502.
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        candidates: [{
          content: { parts: [
            { inlineData: { mimeType: "image/png", data: 12345 } },          // number
            { inlineData: { mimeType: "image/png", data: { foo: "bar" } } }, // object
            { inlineData: { mimeType: "image/png", data: "" } },             // empty string
            { inlineData: { mimeType: "image/png", data: null } },           // null
          ] },
        }],
      },
    },
  });

  saveConfig(ccaConfig());
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
    expect(json.error.message).toContain("no image data");
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA image response skips malformed inlineData.data but keeps valid string image", async () => {
  // When some parts have non-string data and at least one has a valid non-empty
  // string, the valid image is extracted and the malformed ones are skipped.
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        candidates: [{
          content: { parts: [
            { inlineData: { mimeType: "image/png", data: 42 } },
            { inlineData: { mimeType: "image/png", data: CCA_TINY_PNG } },
            { inlineData: { mimeType: "image/png", data: "" } },
          ] },
        }],
      },
    },
  });

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
    const json = await response.json() as { data: { b64_json: string }[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0].b64_json).toBe(CCA_TINY_PNG);
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA image response with non-array parts returns 502 (envelope validation)", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  // A truthy but non-array parts object would throw inside for...of before the
  // Array.isArray guard was added. It must be caught and surfaced as 502.
  ccaFetchMock(registryHits, otherHits, {
    payload: { response: { candidates: [{ content: { parts: "not-an-array" } }] } },
  });

  saveConfig(ccaConfig());
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
    expect(json.error.message).toContain("no valid parts array");
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

// ── OAuth preflight cancellation (finding2-oauth-signal) ──
// getValidAccessToken chains through 4 layers of non-cancellable OAuth functions.
// The fix wraps it in abortableRace against linkedSignal so client cancellation
// and deadline expiry are surfaced promptly instead of hanging on the refresh.

/** Expired credential that forces getValidAccessToken to trigger a token refresh. */
const CCA_CREDENTIAL_EXPIRED = {
  access: "cca-expired-token",
  refresh: "cca-refresh-token",
  expires: Date.now() - 60_000,
  projectId: "cca-project-123",
} as const;

/**
 * Mock fetch so the Google OAuth token endpoint (oauth2.googleapis.com/token)
 * hangs indefinitely — simulating a hung OAuth refresh. The registry host and
 * all other hosts pass through to the real network stack (they should never be
 * reached during these tests).
 */
function hungOauthFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "oauth2.googleapis.com") {
      // Never resolve until the fetch signal aborts (just like production).
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) reject(new DOMException("The operation was aborted.", "AbortError"));
          else sig.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        }
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

test("CCA client abort during OAuth preflight returns 499, not a hung response", async () => {
  // Regression for finding2-oauth-signal: when the client disconnects while
  // getValidAccessToken is refreshing the token, the request must return 499
  // promptly, not hang waiting for the refresh HTTP call to complete.
  const { handleImages } = await import("../src/server/images");
  hungOauthFetchMock();

  // Long timeout so the deadline does NOT fire — only the client abort triggers.
  const cfg = { ...ccaConfig(), images: { timeoutMs: 30_000 } } as OcxConfig;
  saveConfig(cfg);
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL_EXPIRED });

  const ctrl = new AbortController();
  const req = new Request("http://localhost:0/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "a cat" }),
    signal: ctrl.signal,
  });
  const logCtx = { model: "", provider: "" } as never;

  // Start the handler — it enters getValidAccessToken which hangs on the token refresh.
  const responsePromise = handleImages(req, cfg, "generations", logCtx);
  // Abort the parent signal after the OAuth preflight has started.
  setTimeout(() => ctrl.abort(), 100);
  const response = await responsePromise;
  expect(response.status).toBe(499);
  const json = await response.json() as { error: { message: string } };
  expect(json.error.message).toContain("canceled");
}, 5_000);

test("CCA deadline expiry during OAuth preflight returns 504, not a hung response", async () => {
  // Regression for finding2-oauth-signal: when the deadline fires while
  // getValidAccessToken is refreshing the token, the request must return 504
  // promptly, not hang waiting for the refresh HTTP call to complete.
  const { handleImages } = await import("../src/server/images");
  hungOauthFetchMock();

  // Short timeout so the deadline fires during the hung OAuth refresh.
  const cfg = { ...ccaConfig(), images: { timeoutMs: 100 } } as OcxConfig;
  saveConfig(cfg);
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL_EXPIRED });

  const req = new Request("http://localhost:0/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "a cat" }),
  });
  const logCtx = { model: "", provider: "" } as never;

  const response = await handleImages(req, cfg, "generations", logCtx);
  expect(response.status).toBe(504);
  const json = await response.json() as { error: { message: string } };
  expect(json.error.message).toContain("timed out");
}, 5_000);

// ── codex4-cca-safety-blocks ──
// Safety blocks are permanent for the same prompt. Returning 502 (upstream_error)
// causes codex to retry up to 5 times, wasting paid quota on a prompt that will
// never succeed. These must return 400 (invalid_request_error, non-retryable).

test("CCA finishReason SAFETY returns 400 (non-retryable), not 502", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        candidates: [{
          content: { parts: [] },
          finishReason: "SAFETY",
        }],
      },
    },
  });

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("safety filter");
    expect(json.error.message).toContain("SAFETY");
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA promptFeedback.blockReason returns 400 (non-retryable)", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        promptFeedback: { blockReason: "SAFETY" },
      },
    },
  });

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("safety filter");
    expect(json.error.message).toContain("promptFeedback");
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA finishReason BLOCKLIST returns 400 (non-retryable)", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        candidates: [{ finishReason: "BLOCKLIST" }],
      },
    },
  });

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("BLOCKLIST");
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA blocked candidate with empty content.parts returns 400, not 502", async () => {
  // When content is blocked, candidates may exist but content/parts is missing
  // or empty. The safety check must fire before the "no valid parts" 502 path.
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        candidates: [{
          finishReason: "PROHIBITED_CONTENT",
          // content is entirely absent — common when generation is blocked
        }],
      },
    },
  });

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("PROHIBITED_CONTENT");
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA finishReason STOP with valid image is not affected by safety block logic", async () => {
  // Regression: a normal STOP finishReason with a valid inline image must still
  // return 200 — the safety check must not false-positive on non-blocking reasons.
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: "image/png", data: CCA_TINY_PNG } }] },
          finishReason: "STOP",
        }],
      },
    },
  });

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
    const json = await response.json() as { data: { b64_json: string }[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0].b64_json).toBe(CCA_TINY_PNG);
    expect(registryHits).toHaveLength(1);
    expect(otherHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA-only request with proxy admission bearer succeeds and never sends it upstream", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "proxy-admission-secret";
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits);

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer proxy-admission-secret",
      },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(200);
    expect(registryHits).toHaveLength(1);
    expect([...registryHits[0].headers.values()].some(v => v.includes("proxy-admission-secret"))).toBe(false);
    expect(registryHits[0].headers.get("authorization")).toBe("Bearer cca-access-token");
  } finally {
    await server.stop(true);
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
  }
});

test("CCA logged-in without projectId returns project-discovery error, not provider-missing 400", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits);

  saveConfig(ccaConfig());
  const { projectId: _omit, ...noProject } = CCA_CREDENTIAL;
  await saveCredential("google-antigravity", { ...noProject });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toMatch(/Cloud Code Assist project/i);
    expect(json.error.message).not.toMatch(/none is configured/i);
    expect(registryHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA rejects n>1 before contacting Google", async () => {
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
      body: JSON.stringify({ prompt: "a cat", n: 2 }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toMatch(/n=1/i);
    expect(registryHits).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("CCA RECITATION finishReason returns non-retryable 400", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        candidates: [{ content: { parts: [] }, finishReason: "RECITATION" }],
      },
    },
  });

  saveConfig(ccaConfig());
  await saveCredential("google-antigravity", { ...CCA_CREDENTIAL });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "copyrighted stuff" }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toMatch(/RECITATION|safety/i);
  } finally {
    await server.stop(true);
  }
});

test("CCA rejects invalid base64 and non-image bytes instead of returning b64_json", async () => {
  const registryHits: CcaFetchRequest[] = [];
  const otherHits: CcaFetchRequest[] = [];
  ccaFetchMock(registryHits, otherHits, {
    payload: {
      response: {
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] },
        }],
      },
    },
  });

  saveConfig(ccaConfig());
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
    expect(json.error.message).toMatch(/base64|magic|validation/i);
  } finally {
    await server.stop(true);
  }
});

test("GET /v1/opencodex/artifacts/:id serves opaque artifacts with API auth", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "proxy-admission-secret";
  const { materializeInlineImage, createImageBudget, artifactHttpUrl } = await import("../src/images/artifacts");
  const filePath = await materializeInlineImage(CCA_TINY_PNG, createImageBudget());
  const urlPath = artifactHttpUrl(filePath);

  // Non-loopback bind makes data-plane auth mandatory (same as production remote binds).
  saveConfig({ ...ccaConfig(), hostname: "0.0.0.0" });
  const server = startServer(0);
  try {
    const denied = await fetch(`http://127.0.0.1:${server.port}${urlPath}`);
    expect(denied.status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${server.port}${urlPath}`, {
      headers: { authorization: "Bearer wrong-secret" },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${server.port}${urlPath}`, {
      headers: { authorization: "Bearer proxy-admission-secret" },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await ok.arrayBuffer());
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);

    const traversal = await fetch(`http://127.0.0.1:${server.port}/v1/opencodex/artifacts/../package.json`, {
      headers: { authorization: "Bearer proxy-admission-secret" },
    });
    expect(traversal.status).toBe(404);
  } finally {
    await server.stop(true);
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
  }
});
