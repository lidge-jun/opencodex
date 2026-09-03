/**
 * /v1/live relay: Codex App / ChatGPT voice POSTs call-create against the injected base_url,
 * so the proxy must relay it to an OpenAI upstream instead of the /v1/* JSON-404 guard.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import {
  createReadinessGate,
  runStartupReadinessSync,
  type ReadinessGate,
} from "../src/server/readiness";
import {
  enqueueLiveSidebandPendingFrame,
  exceedsLiveSidebandFrameByteLimit,
  exceedsLiveSidebandPendingByteLimit,
  MAX_WS_FRAME_BYTES,
  startServer,
} from "../src/server";
import { beginShutdownDrain, isDraining, resetLifecycleDrainStateForTests } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, ".tmp-server-live-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;
const DIRECT_CHATGPT_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-live-codex-");
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
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

interface CapturedRequest {
  path: string;
  url: string;
  headers: Headers;
  bodyText: string;
}

function fakeLiveUpstream(captured: CapturedRequest[], status = 201, location = "/v1/live/rtc_test") {
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const reqUrl = new URL(req.url);
      captured.push({
        path: reqUrl.pathname,
        url: `${reqUrl.pathname}${reqUrl.search}`,
        headers: req.headers,
        bodyText: await req.text(),
      });
      return new Response("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n", {
        status,
        headers: {
          "content-type": "application/sdp",
          location,
        },
      });
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
    if (url.hostname === "api.openai.com") {
      const target = new URL(`${url.pathname}${url.search}`, upstream.url);
      return originalFetch(target, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return upstream;
}

function forwardConfig(): OcxConfig {
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

function expectReadyProtocolMetadata(body: Record<string, unknown>, managementUrl: string): void {
  expect(body).toMatchObject({
    protocol: 1,
    minimumClientProtocol: 1,
    managementUrl,
  });
}

function multipartLiveBody(
  sdp = "v=0",
  session: Record<string, unknown> | null = { model: "gpt-live" },
): { body: Uint8Array; contentType: string } {
  const boundary = "codex-realtime-call-boundary";
  const parts = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="sdp"`,
    `Content-Type: application/sdp`,
    ``,
    sdp,
  ];
  if (session !== null) {
    parts.push(
      `--${boundary}`,
      `Content-Disposition: form-data; name="session"`,
      `Content-Type: application/json`,
      ``,
      JSON.stringify(session),
    );
  }
  parts.push(`--${boundary}--`, ``);
  return {
    body: new TextEncoder().encode(parts.join("\r\n")),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test("POST /v1/live rewrites ChatGPT multipart into backend realtime/calls JSON", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured);
  const config = forwardConfig();
  config.providers.openai!.baseUrl = "https://chatgpt.com/backend-api/codex///";
  saveConfig(config);

  const server = startServer(0);
  try {
    const { body, contentType } = multipartLiveBody("v=0-offer", { model: "gpt-live", instructions: "hi" });
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: {
        "content-type": contentType,
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/v1/live/rtc_test");
    expect(await response.text()).toContain("v=0");

    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/realtime/calls");
    expect(captured[0].url).toContain("intent=quicksilver");
    expect(captured[0].url).toContain("architecture=avas");
    expect(captured[0].headers.get("authorization")).toBe(`Bearer ${DIRECT_CHATGPT_TOKEN}`);
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(captured[0].headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(captured[0].bodyText)).toEqual({
      sdp: "v=0-offer",
      session: { model: "gpt-live", instructions: "hi" },
    });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("POST /v1/live relays to an OpenAI API-key provider at /v1/live without AVAS", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured, 201, "/v1/live/rtc_api");
  saveConfig({
    port: 0,
    defaultProvider: "openai-apikey",
    openaiProviderTierVersion: 2,
    providers: {
      "openai-apikey": {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-live",
      },
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const { body, contentType } = multipartLiveBody();
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/v1/live/rtc_api");

    expect(captured).toHaveLength(1);
    // Frameless API shape posts to {base}/live without the AVAS query
    // (openai/codex RealtimeCallClient, realtime_call.rs).
    expect(captured[0].path).toBe("/v1/live");
    expect(captured[0].url).not.toContain("intent=");
    expect(captured[0].url).not.toContain("architecture=");
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-test-live");
    expect(captured[0].headers.get("content-type")).toContain("multipart/form-data");
    expect(captured[0].bodyText).toContain('name="sdp"');
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("call-create forwards Frameless protocol headers and keeps auth pool-owned", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured);
  saveConfig(forwardConfig());

  const server = startServer(0);
  try {
    const { body, contentType } = multipartLiveBody("v=0-offer", { model: "gpt-live", instructions: "hi" });
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: {
        "content-type": contentType,
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
        "openai-alpha": "quicksilver=v2",
        "x-session-id": "rts_123",
        "session-id": "sess_abc",
        "thread-id": "thread_def",
        originator: "codex_app",
        "x-oai-attestation": "attest-blob",
        // Must NOT be forwarded: account-derived compliance header.
        "x-openai-fedramp": "true",
      },
      body,
    });
    expect(response.status).toBe(201);

    expect(captured).toHaveLength(1);
    const headers = captured[0].headers;
    expect(headers.get("openai-alpha")).toBe("quicksilver=v2");
    expect(headers.get("x-session-id")).toBe("rts_123");
    expect(headers.get("session-id")).toBe("sess_abc");
    expect(headers.get("thread-id")).toBe("thread_def");
    expect(headers.get("originator")).toBe("codex_app");
    expect(headers.get("x-oai-attestation")).toBe("attest-blob");
    expect(headers.get("x-openai-fedramp")).toBeNull();
    // Auth stays proxy-resolved, not blindly copied from the whitelist path.
    expect(headers.get("authorization")).toBe(`Bearer ${DIRECT_CHATGPT_TOKEN}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct-123");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("call-create without protocol headers does not invent them upstream", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured);
  saveConfig(forwardConfig());

  const server = startServer(0);
  try {
    const { body, contentType } = multipartLiveBody("v=0-offer", { model: "gpt-live", instructions: "hi" });
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: {
        "content-type": contentType,
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(captured).toHaveLength(1);
    const headers = captured[0].headers;
    expect(headers.get("openai-alpha")).toBeNull();
    expect(headers.get("x-session-id")).toBeNull();
    expect(headers.get("session-id")).toBeNull();
    expect(headers.get("thread-id")).toBeNull();
    expect(headers.get("originator")).toBeNull();
    expect(headers.get("x-oai-attestation")).toBeNull();
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("POST /v1/realtime/calls is accepted and relays like /v1/live", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured, 201, "/v1/realtime/calls/rtc_codex");
  saveConfig(forwardConfig());

  const server = startServer(0);
  try {
    const { body, contentType } = multipartLiveBody("v=0-codex");
    const response = await fetch(new URL("/v1/realtime/calls", server.url), {
      method: "POST",
      headers: {
        "content-type": contentType,
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/v1/realtime/calls/rtc_codex");
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/realtime/calls");
    expect(JSON.parse(captured[0].bodyText)).toEqual({
      sdp: "v=0-codex",
      session: { model: "gpt-live" },
    });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("ChatGPT multipart rewrite allows SDP-only offers without session", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured);
  saveConfig(forwardConfig());

  const server = startServer(0);
  try {
    const { body, contentType } = multipartLiveBody("v=0-sdp-only", null);
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: {
        "content-type": contentType,
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0].bodyText)).toEqual({ sdp: "v=0-sdp-only" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("OPTIONS preflight allows ChatGPT-Account-Id for voice clients", async () => {
  saveConfig(forwardConfig());
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:" + new URL(server.url).port,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,chatgpt-account-id",
      },
    });
    expect(response.status).toBe(204);
    const allowed = response.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowed.toLowerCase()).toContain("chatgpt-account-id");
    expect(allowed.toLowerCase()).toContain("openai-alpha");
    expect(allowed.toLowerCase()).toContain("x-session-id");
    expect(allowed.toLowerCase()).toContain("session-id");
    expect(allowed.toLowerCase()).toContain("thread-id");
    expect(allowed.toLowerCase()).toContain("originator");
    expect(allowed.toLowerCase()).toContain("x-oai-attestation");
  } finally {
    await server.stop(true);
  }
});

test("POST /v1/live without an OpenAI upstream returns 400", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "cursor",
    providers: {
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "cursor-token" },
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0" }),
    });
    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: { message?: string } };
    expect(payload.error?.message).toContain("OpenAI upstream");
  } finally {
    await server.stop(true);
  }
});

test("GET /v1/live still hits the unknown-endpoint JSON 404 guard", async () => {
  saveConfig(forwardConfig());
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "GET",
      headers: {
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
    });
    expect(response.status).toBe(404);
    const payload = await response.json() as { error?: { message?: string } };
    expect(payload.error?.message).toContain("Unknown endpoint");
  } finally {
    await server.stop(true);
  }
});

test("a routed pool account's token overrides the caller bearer on the live relay", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured);
  saveConfig({
    ...forwardConfig(),
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    activeCodexAccountId: "pool-a",
  } as OcxConfig);
  saveCodexAccountCredential("pool-a", {
    accessToken: fakeChatGptJwt({ chatgpt_account_id: "acct-pool-a", email: "pool@example.test" }),
    refreshToken: "pool-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: "acct-pool-a",
  });

  const server = startServer(0);
  try {
    const { body, contentType } = multipartLiveBody();
    const response = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: {
        "content-type": contentType,
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-pool-a");
    expect(captured[0].headers.get("authorization")).toContain("Bearer ");
    expect(captured[0].headers.get("authorization")).not.toBe(`Bearer ${DIRECT_CHATGPT_TOKEN}`);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("call-create and its sideband join bind to the same pool account (openai/codex #35830)", async () => {
  // Desktop v3 voice: POST /v1/live creates the WebRTC call under the proxy-selected Pool
  // account; the sideband join must reach OpenAI under that SAME account or the call is not
  // found (404). Both legs carry codex-rs build_session_headers (session-id + thread-id), so
  // the pool affinity key is identical — a round-robin pool with two accounts must not hand
  // the join to the other account.
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured);
  const seenUpgradeHeaders: Headers[] = [];
  const wsUpstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        seenUpgradeHeaders.push(req.headers);
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { message(ws, message) { ws.send(String(message)); } },
  });
  saveConfig({
    ...forwardConfig(),
    accountPoolStrategy: "round-robin",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [
      { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" },
    ],
  } as OcxConfig);
  for (const [id, acct] of [["pool-a", "acct-pool-a"], ["pool-b", "acct-pool-b"]] as const) {
    saveCodexAccountCredential(id, {
      accessToken: fakeChatGptJwt({ chatgpt_account_id: acct, email: `${id}@example.test` }),
      refreshToken: `${id}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: acct,
    });
  }
  const RealWebSocket = globalThis.WebSocket;
  const wsPort = wsUpstream.port;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const parsed = new URL(String(url));
      const target = parsed.hostname === "api.openai.com" && parsed.pathname.startsWith("/v1/live/")
        ? `ws://127.0.0.1:${wsPort}${parsed.pathname}${parsed.search}`
        : String(url);
      super(target, protocols as string[]);
    }
  } as typeof WebSocket;

  const server = startServer(0);
  try {
    const voiceHeaders = {
      authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
      "chatgpt-account-id": "acct-123",
      "session-id": "sess_voice_1",
      "thread-id": "thread_voice_1",
    };
    const { body, contentType } = multipartLiveBody();
    const created = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: { ...voiceHeaders, "content-type": contentType },
      body,
    });
    expect(created.status).toBe(201);
    expect(captured).toHaveLength(1);
    const createAccount = captured[0].headers.get("chatgpt-account-id");
    expect(["acct-pool-a", "acct-pool-b"]).toContain(createAccount);

    // Unrelated traffic on a different thread advances round-robin in between.
    const other = await fetch(new URL("/v1/live", server.url), {
      method: "POST",
      headers: { ...voiceHeaders, "session-id": "sess_other", "thread-id": "thread_other", "content-type": contentType },
      body,
    });
    expect(other.status).toBe(201);
    expect(captured[1].headers.get("chatgpt-account-id")).not.toBe(createAccount);

    const wsUrl = new URL("/v1/live/rtc_test", server.url);
    wsUrl.protocol = "ws:";
    const client = new RealWebSocket(wsUrl.toString(), { headers: voiceHeaders } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sideband timeout")), 15_000);
      client.addEventListener("open", () => client.send("hello"));
      client.addEventListener("message", () => { clearTimeout(timer); resolve(); });
      client.addEventListener("error", () => { clearTimeout(timer); reject(new Error("client websocket error")); });
    });
    client.close();
    expect(seenUpgradeHeaders).toHaveLength(1);
    expect(seenUpgradeHeaders[0].get("chatgpt-account-id")).toBe(createAccount);
    expect(seenUpgradeHeaders[0].get("authorization")).toBe(captured[0].headers.get("authorization"));
    expect(seenUpgradeHeaders[0].get("session-id")).toBe("sess_voice_1");
    expect(seenUpgradeHeaders[0].get("thread-id")).toBe("thread_voice_1");
  } finally {
    globalThis.WebSocket = RealWebSocket;
    await server.stop(true);
    await upstream.stop(true);
    await wsUpstream.stop(true);
  }
}, { timeout: 20_000 });

test("sideband GET /v1/live/{callId} relays the exact frame ceiling bidirectionally", async () => {
  const seenPaths: string[] = [];
  const seenUpgradeHeaders: Headers[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        seenPaths.push(url.pathname);
        seenUpgradeHeaders.push(req.headers);
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_WS_FRAME_BYTES,
      message(ws, message) {
        ws.send(typeof message === "string" ? `echo:${message}` : `bytes:${message.byteLength}`);
      },
    },
  });

  saveConfig(forwardConfig());

  // Redirect ChatGPT sideband WebSocket targets to the local mock (config stays canonical).
  const RealWebSocket = globalThis.WebSocket;
  const upstreamPort = upstream.port;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const parsed = new URL(String(url));
      const target =
        parsed.hostname === "api.openai.com" && parsed.pathname.startsWith("/v1/live/")
          ? `ws://127.0.0.1:${upstreamPort}${parsed.pathname}${parsed.search}`
          : String(url);
      super(target, protocols as string[]);
    }
  } as typeof WebSocket;

  const server = startServer(0);
  try {
    const wsUrl = new URL(`/v1/live/rtc_sideband`, server.url);
    wsUrl.protocol = "ws:";
    const client = new RealWebSocket(wsUrl.toString(), {
      headers: {
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
        "openai-alpha": "quicksilver=v2",
        "x-session-id": "rts_side",
      },
    } as unknown as string[]);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sideband timeout")), 15_000);
      let sawPing = false;
      client.addEventListener("open", () => {
        client.send("ping-sideband");
      });
      client.addEventListener("message", (event) => {
        try {
          if (!sawPing) {
            expect(String(event.data)).toBe("echo:ping-sideband");
            sawPing = true;
            client.send(Buffer.alloc(MAX_WS_FRAME_BYTES));
            return;
          }
          expect(String(event.data)).toBe(`bytes:${MAX_WS_FRAME_BYTES}`);
          expect(seenPaths).toContain("/v1/live/rtc_sideband");
          expect(seenUpgradeHeaders).toHaveLength(1);
          expect(seenUpgradeHeaders[0].get("openai-alpha")).toBe("quicksilver=v2");
          expect(seenUpgradeHeaders[0].get("x-session-id")).toBe("rts_side");
          expect(seenUpgradeHeaders[0].get("authorization")).toBe(`Bearer ${DIRECT_CHATGPT_TOKEN}`);
          clearTimeout(timer);
          resolve();
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
      client.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("client websocket error"));
      });
    });
    client.close();
  } finally {
    globalThis.WebSocket = RealWebSocket;
    await server.stop(true);
    await upstream.stop(true);
  }
}, { timeout: 20_000 });

test("standalone GET /v1/realtime?intent=quicksilver&model= upgrades and relays bidirectionally", async () => {
  const seen: { path: string; headers: Headers }[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        seen.push({ path: `${url.pathname}${url.search}`, headers: req.headers });
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        ws.send(typeof message === "string" ? `echo:${message}` : "bytes");
      },
    },
  });

  saveConfig(forwardConfig());

  // Redirect the canonical standalone upstream (api.openai.com/v1/realtime) to the mock.
  const RealWebSocket = globalThis.WebSocket;
  const upstreamPort = upstream.port;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const parsed = new URL(String(url));
      const target =
        parsed.hostname === "api.openai.com" && parsed.pathname === "/v1/realtime"
          ? `ws://127.0.0.1:${upstreamPort}${parsed.pathname}${parsed.search}`
          : String(url);
      super(target, protocols as string[]);
    }
  } as typeof WebSocket;

  const server = startServer(0);
  try {
    const wsUrl = new URL(`/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5&access_token=dropme`, server.url);
    wsUrl.protocol = "ws:";
    const client = new RealWebSocket(wsUrl.toString(), {
      headers: {
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
        "x-session-id": "rts_standalone",
      },
    } as unknown as string[]);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("standalone realtime timeout")), 15_000);
      client.addEventListener("open", () => {
        client.send("ping-standalone");
      });
      client.addEventListener("message", (event) => {
        try {
          expect(String(event.data)).toBe("echo:ping-standalone");
          expect(seen).toHaveLength(1);
          // Query preserved verbatim, credential-shaped param dropped.
          expect(seen[0].path).toBe("/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5");
          expect(seen[0].headers.get("authorization")).toBe(`Bearer ${DIRECT_CHATGPT_TOKEN}`);
          expect(seen[0].headers.get("x-session-id")).toBe("rts_standalone");
          clearTimeout(timer);
          resolve();
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
      client.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("client websocket error"));
      });
    });
    client.close();
  } finally {
    globalThis.WebSocket = RealWebSocket;
    await server.stop(true);
    await upstream.stop(true);
  }
}, { timeout: 20_000 });

test("standalone GET /v1/live?model= upgrades and relays bidirectionally", async () => {
  const seenPaths: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        seenPaths.push(`${url.pathname}${url.search}`);
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${String(message)}`);
      },
    },
  });

  saveConfig(forwardConfig());

  const RealWebSocket = globalThis.WebSocket;
  const upstreamPort = upstream.port;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const parsed = new URL(String(url));
      const target =
        parsed.hostname === "api.openai.com" && parsed.pathname === "/v1/live"
          ? `ws://127.0.0.1:${upstreamPort}${parsed.pathname}${parsed.search}`
          : String(url);
      super(target, protocols as string[]);
    }
  } as typeof WebSocket;

  const server = startServer(0);
  try {
    const wsUrl = new URL(`/v1/live?model=gpt-realtime-1.5`, server.url);
    wsUrl.protocol = "ws:";
    const client = new RealWebSocket(wsUrl.toString(), {
      headers: {
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
    } as unknown as string[]);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("standalone frameless timeout")), 15_000);
      client.addEventListener("open", () => {
        client.send("ping-frameless");
      });
      client.addEventListener("message", (event) => {
        try {
          expect(String(event.data)).toBe("echo:ping-frameless");
          expect(seenPaths).toEqual(["/v1/live?model=gpt-realtime-1.5"]);
          clearTimeout(timer);
          resolve();
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
      client.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("client websocket error"));
      });
    });
    client.close();
  } finally {
    globalThis.WebSocket = RealWebSocket;
    await server.stop(true);
    await upstream.stop(true);
  }
}, { timeout: 20_000 });

test("standalone realtime upgrade keeps the auth and origin guards", async () => {
  saveConfig(forwardConfig());
  process.env.OPENCODEX_API_AUTH_TOKEN = "required-secret";

  const server = startServer(0);
  try {
    const upgradeHeaders = {
      connection: "upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
    };
    // No credential at all → 401 before any upgrade.
    const unauthenticated = await fetch(new URL("/v1/realtime?model=m", server.url), {
      headers: upgradeHeaders,
    });
    expect(unauthenticated.status).toBe(401);
    // Non-local Origin → 403 even with a credential.
    const crossOrigin = await fetch(new URL("/v1/realtime?model=m", server.url), {
      headers: {
        ...upgradeHeaders,
        authorization: "Bearer required-secret",
        origin: "https://evil.example",
      },
    });
    expect(crossOrigin.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});

test("sideband byte predicates accept exact limits and reject one byte over", () => {
  expect(exceedsLiveSidebandFrameByteLimit(50 * 1024 * 1024)).toBe(false);
  expect(exceedsLiveSidebandFrameByteLimit(50 * 1024 * 1024 + 1)).toBe(true);
  expect(exceedsLiveSidebandPendingByteLimit(256 * 1024, 768 * 1024)).toBe(false);
  expect(exceedsLiveSidebandPendingByteLimit(256 * 1024, 768 * 1024 + 1)).toBe(true);
});

test("sideband queue enforces aggregate bytes and frame count without retaining rejected frames", () => {
  const byteBounded: { livePending: Array<string | Buffer>; livePendingBytes: number } = {
    livePending: [],
    livePendingBytes: 0,
  };
  const quarterMiB = Buffer.alloc(256 * 1024);
  for (let i = 0; i < 4; i += 1) {
    expect(enqueueLiveSidebandPendingFrame(byteBounded, quarterMiB)).toBe("queued");
  }
  expect(byteBounded.livePending).toHaveLength(4);
  expect(byteBounded.livePendingBytes).toBe(1024 * 1024);
  expect(enqueueLiveSidebandPendingFrame(byteBounded, Buffer.from([1]))).toBe("too-many-bytes");
  expect(byteBounded.livePending).toHaveLength(4);
  expect(byteBounded.livePendingBytes).toBe(1024 * 1024);

  const countBounded: { livePending: Array<string | Buffer>; livePendingBytes: number } = {
    livePending: [],
    livePendingBytes: 0,
  };
  for (let i = 0; i < 32; i += 1) {
    expect(enqueueLiveSidebandPendingFrame(countBounded, "x")).toBe("queued");
  }
  expect(enqueueLiveSidebandPendingFrame(countBounded, "x")).toBe("too-many-frames");
  expect(countBounded.livePending).toHaveLength(32);
  expect(countBounded.livePendingBytes).toBe(32);
});

test("buildLiveSidebandUpstreamWsUrl maps Frameless and Realtime join shapes", async () => {
  const { buildLiveSidebandUpstreamWsUrl, forwardLiveUrl, keyedLiveUrl, parseLiveSidebandTarget } =
    await import("../src/server/live");

  expect(forwardLiveUrl("https://chatgpt.com/backend-api/codex", true)).toBe(
    "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
  );
  expect(forwardLiveUrl("https://chatgpt.com/backend-api/codex///", true)).toBe(
    "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
  );
  expect(keyedLiveUrl("https://api.openai.com/v1")).toBe(
    "https://api.openai.com/v1/realtime/calls?intent=quicksilver&architecture=avas",
  );

  expect(parseLiveSidebandTarget("/v1/live/rtc_1", new URLSearchParams())).toEqual({
    style: "frameless-path",
    callId: "rtc_1",
  });
  expect(parseLiveSidebandTarget("/v1/realtime", new URLSearchParams("call_id=rtc_2"))).toEqual({
    style: "realtime-query",
    callId: "rtc_2",
  });

  expect(
    buildLiveSidebandUpstreamWsUrl({
      style: "frameless-path",
      callId: "rtc_1",
    }),
  ).toBe("wss://api.openai.com/v1/live/rtc_1");
  expect(
    buildLiveSidebandUpstreamWsUrl({
      style: "realtime-calls-path",
      callId: "rtc_1",
    }),
  ).toBe("wss://api.openai.com/v1/realtime/calls/rtc_1");
  expect(
    buildLiveSidebandUpstreamWsUrl({
      style: "realtime-query",
      callId: "rtc_2",
    }),
  ).toBe("wss://api.openai.com/v1/realtime?intent=quicksilver&call_id=rtc_2");
  expect(
    buildLiveSidebandUpstreamWsUrl({
      style: "frameless-path",
      callId: "rtc_1",
    }),
  ).toBe("wss://api.openai.com/v1/live/rtc_1");
  expect(
    buildLiveSidebandUpstreamWsUrl({
      style: "realtime-query",
      callId: "rtc_2",
    }),
  ).toBe("wss://api.openai.com/v1/realtime?intent=quicksilver&call_id=rtc_2");
});

test("parseLiveSidebandTarget recognizes standalone realtime sessions", async () => {
  const { parseLiveSidebandTarget } = await import("../src/server/live");

  // Desktop voice since codex 0.147.x: standalone WebSocket transport, no call_id.
  expect(
    parseLiveSidebandTarget(
      "/v1/realtime",
      new URLSearchParams("intent=quicksilver&model=gpt-realtime-1.5"),
      "intent=quicksilver&model=gpt-realtime-1.5",
    ),
  ).toEqual({ style: "realtime-standalone", query: "intent=quicksilver&model=gpt-realtime-1.5" });
  // RealtimeV2 standalone carries no intent.
  expect(
    parseLiveSidebandTarget("/v1/realtime", new URLSearchParams("model=gpt-realtime-1.5"), "model=gpt-realtime-1.5"),
  ).toEqual({ style: "realtime-standalone", query: "model=gpt-realtime-1.5" });
  expect(parseLiveSidebandTarget("/v1/realtime", new URLSearchParams(), "")).toEqual({
    style: "realtime-standalone",
    query: "",
  });
  // Trailing slash forms.
  expect(
    parseLiveSidebandTarget("/v1/realtime/", new URLSearchParams("model=m"), "model=m"),
  ).toEqual({ style: "realtime-standalone", query: "model=m" });
  expect(parseLiveSidebandTarget("/v1/live", new URLSearchParams("model=m"), "model=m")).toEqual({
    style: "frameless-standalone",
    query: "model=m",
  });
  expect(parseLiveSidebandTarget("/v1/live/", new URLSearchParams(), "")).toEqual({
    style: "frameless-standalone",
    query: "",
  });

  // A present-but-invalid call_id is a malformed join, never a standalone session.
  expect(parseLiveSidebandTarget("/v1/realtime", new URLSearchParams("call_id="), "call_id=")).toBeNull();
  expect(
    parseLiveSidebandTarget("/v1/realtime", new URLSearchParams("call_id=bad id!"), "call_id=bad%20id!"),
  ).toBeNull();
  // Bare /v1/realtime/calls is the call-create HTTP path, not a WS target.
  expect(parseLiveSidebandTarget("/v1/realtime/calls", new URLSearchParams(), "")).toBeNull();
  // A malformed percent escape in a keyed join must read as "no target" (JSON 404), never
  // let decodeURIComponent throw out of the router as a 500.
  expect(parseLiveSidebandTarget("/v1/live/%ZZ", new URLSearchParams(), "")).toBeNull();
  expect(parseLiveSidebandTarget("/v1/realtime/calls/%ZZ", new URLSearchParams(), "")).toBeNull();
  expect(parseLiveSidebandTarget("/v1/live/rtc%5Fok", new URLSearchParams(), "")).toEqual({
    style: "frameless-path",
    callId: "rtc_ok",
  });
  // Valid join shapes keep working.
  expect(
    parseLiveSidebandTarget("/v1/realtime", new URLSearchParams("call_id=rtc_2"), "call_id=rtc_2"),
  ).toEqual({ style: "realtime-query", callId: "rtc_2" });
});

test("standalone realtime query relay drops credential-shaped keys and keeps raw bytes", async () => {
  const { parseLiveSidebandTarget, sanitizeStandaloneRealtimeQuery } = await import("../src/server/live");

  // Noncanonical encodings and bare keys survive byte-for-byte.
  expect(sanitizeStandaloneRealtimeQuery("model=a%2fb&flag&x=%20~")).toBe("model=a%2fb&flag&x=%20~");
  // Credential-shaped params never reach the upstream (case-folded, raw + decoded).
  expect(sanitizeStandaloneRealtimeQuery("access_token=abc&model=m")).toBe("model=m");
  expect(sanitizeStandaloneRealtimeQuery("API_KEY=abc&model=m")).toBe("model=m");
  expect(sanitizeStandaloneRealtimeQuery("model=m&token=abc")).toBe("model=m");
  expect(sanitizeStandaloneRealtimeQuery("key=abc&auth=def&sig=ghi&model=m")).toBe("model=m");
  expect(sanitizeStandaloneRealtimeQuery("%61ccess_token=abc&model=m")).toBe("model=m");
  // Bare credential key is dropped too.
  expect(sanitizeStandaloneRealtimeQuery("api_key&model=m")).toBe("model=m");
  // Duplicates and protocol params pass through.
  expect(sanitizeStandaloneRealtimeQuery("model=a&model=b&intent=quicksilver")).toBe(
    "model=a&model=b&intent=quicksilver",
  );
  expect(sanitizeStandaloneRealtimeQuery("")).toBe("");

  // Parser applies the same policy.
  expect(
    parseLiveSidebandTarget(
      "/v1/realtime",
      new URLSearchParams("access_token=abc&intent=quicksilver&model=m"),
      "access_token=abc&intent=quicksilver&model=m",
    ),
  ).toEqual({ style: "realtime-standalone", query: "intent=quicksilver&model=m" });
});

test("buildLiveSidebandUpstreamWsUrl maps standalone realtime session shapes", async () => {
  const { buildLiveSidebandUpstreamWsUrl } = await import("../src/server/live");

  expect(
    buildLiveSidebandUpstreamWsUrl({
      style: "realtime-standalone",
      query: "intent=quicksilver&model=gpt-realtime-1.5",
    }),
  ).toBe("wss://api.openai.com/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5");
  expect(buildLiveSidebandUpstreamWsUrl({ style: "realtime-standalone", query: "" })).toBe(
    "wss://api.openai.com/v1/realtime",
  );
  expect(buildLiveSidebandUpstreamWsUrl({ style: "frameless-standalone", query: "model=m" })).toBe(
    "wss://api.openai.com/v1/live?model=m",
  );
  expect(buildLiveSidebandUpstreamWsUrl({ style: "frameless-standalone", query: "" })).toBe(
    "wss://api.openai.com/v1/live",
  );
  // Override honored for standalone too.
  expect(
    buildLiveSidebandUpstreamWsUrl(
      { style: "realtime-standalone", query: "model=m" },
      "https://realtime.example.test/v1",
    ),
  ).toBe("wss://realtime.example.test/v1/realtime?model=m");
  expect(
    buildLiveSidebandUpstreamWsUrl(
      { style: "frameless-standalone", query: "model=m" },
      "http://127.0.0.1:8080/v1",
    ),
  ).toBe("ws://127.0.0.1:8080/v1/live?model=m");
});

test("sideband URL policy: override precedence, normalization, and fail-closed bounds", async () => {
  const { buildLiveSidebandUpstreamWsUrl } = await import("../src/server/live");
  const frameless = { style: "frameless-path", callId: "rtc_1" } as const;
  const realtime = { style: "realtime-query", callId: "rtc 2" } as const;

  // Override wins for every target style.
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "https://realtime.example.test/v1")).toBe("wss://realtime.example.test/v1/live/rtc_1");
  expect(buildLiveSidebandUpstreamWsUrl(realtime, "https://realtime.example.test/v1")).toBe("wss://realtime.example.test/v1/realtime?intent=quicksilver&call_id=rtc%202");

  // Normalization: query/fragment dropped, exactly one /v1, path prefix preserved,
  // recognized endpoint forms stripped back to the root (upstream methods.rs:994).
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "https://example.test/api/v1/?foo=bar#frag")).toBe("wss://example.test/api/v1/live/rtc_1");
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "https://example.test/v1/realtime")).toBe("wss://example.test/v1/live/rtc_1");
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "https://example.test/v1/realtime/calls/abc")).toBe("wss://example.test/v1/live/rtc_1");
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "https://example.test/v1/live/abc")).toBe("wss://example.test/v1/live/rtc_1");
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "https://example.test/v10")).toBe("wss://example.test/v10/v1/live/rtc_1");

  // Scheme rewrite: https -> wss; loopback http -> ws (the dev case the knob exists for).
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "http://localhost:8080/v1")).toBe("ws://localhost:8080/v1/live/rtc_1");
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "http://127.0.0.1:8080")).toBe("ws://127.0.0.1:8080/v1/live/rtc_1");
  expect(buildLiveSidebandUpstreamWsUrl(frameless, "http://127.0.0.2:8080")).toBe("ws://127.0.0.2:8080/v1/live/rtc_1");

  // Fail-closed bounds: malformed, remote plaintext, userinfo, and non-http(s)
  // schemes all return the canonical root — a compromised or accidental override
  // must never redirect upstream bearer credentials or user audio.
  for (const bad of [
    "not a url",
    "http://realtime.example.test/v1",
    "ws://realtime.example.test/v1",
    "http://127.256.0.1/v1",
    "http://127.evil.example/v1",
    "http://127.0.0.1.evil.example/v1",
    "https://user:pass@realtime.example.test/v1",
    "ftp://realtime.example.test/v1",
    "   ",
  ]) {
    expect(buildLiveSidebandUpstreamWsUrl(frameless, bad)).toBe("wss://api.openai.com/v1/live/rtc_1");
  }
});

// Regression: Korean realtime transcripts must survive the sideband relay byte-identically.
// A relay that re-decodes frames at arbitrary byte boundaries turns e.g. "얘" into "��"
// (U+FFFD pairs); this test pins text, binary, and large-frame transparency.
test("sideband relay preserves multibyte UTF-8 frames byte-identically in both directions", async () => {
  const KOREAN_LINE = "가볍게 얘기핼봐요";
  const KOREAN_EVENT = JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    delta: KOREAN_LINE,
  });
  const largeKorean = KOREAN_LINE.repeat(20_000); // ~1.3MB — forces TCP segmentation
  const receivedByUpstream: Uint8Array[] = [];

  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.send(KOREAN_EVENT);
        ws.send(new TextEncoder().encode(KOREAN_LINE));
        ws.send(largeKorean);
      },
      message(_ws, message) {
        receivedByUpstream.push(
          typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message as ArrayBuffer),
        );
      },
    },
  });

  saveConfig(forwardConfig());

  const RealWebSocket = globalThis.WebSocket;
  const upstreamPort = upstream.port;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const parsed = new URL(String(url));
      const target =
        parsed.hostname === "api.openai.com" && parsed.pathname.startsWith("/v1/live/")
          ? `ws://127.0.0.1:${upstreamPort}${parsed.pathname}${parsed.search}`
          : String(url);
      super(target, protocols as string[]);
    }
  } as typeof WebSocket;

  const server = startServer(0);
  try {
    const wsUrl = new URL(`/v1/live/rtc_korean`, server.url);
    wsUrl.protocol = "ws:";
    const client = new RealWebSocket(wsUrl.toString(), {
      headers: {
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
    } as unknown as string[]);
    client.binaryType = "arraybuffer";

    const inbound: Array<{ kind: string; data: unknown }> = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sideband timeout")), 10_000);
      client.addEventListener("open", () => {
        client.send(KOREAN_EVENT);
        client.send(new TextEncoder().encode(KOREAN_LINE));
      });
      client.addEventListener("message", event => {
        inbound.push({ kind: typeof event.data, data: event.data });
        if (inbound.length >= 3) {
          clearTimeout(timer);
          resolve();
        }
      });
      client.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("client websocket error"));
      });
    });

    expect(inbound[0]!.kind).toBe("string");
    expect(inbound[0]!.data).toBe(KOREAN_EVENT);
    expect(String(inbound[0]!.data)).not.toContain("�");
    if (inbound[1]!.kind === "string") {
      expect(inbound[1]!.data).toBe(KOREAN_LINE);
    } else {
      expect(new TextDecoder().decode(new Uint8Array(inbound[1]!.data as ArrayBuffer))).toBe(KOREAN_LINE);
    }
    expect(inbound[2]!.kind).toBe("string");
    expect(inbound[2]!.data).toBe(largeKorean);
    expect(String(inbound[2]!.data)).not.toContain("�");

    const deadline = Date.now() + 5_000;
    while (receivedByUpstream.length < 2 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(receivedByUpstream).toHaveLength(2);
    expect(new TextDecoder().decode(receivedByUpstream[0]!)).toBe(KOREAN_EVENT);
    expect(new TextDecoder().decode(receivedByUpstream[1]!)).toBe(KOREAN_LINE);

    client.close();
  } finally {
    globalThis.WebSocket = RealWebSocket;
    await server.stop(true);
    await upstream.stop(true);
  }
});

// The env-gated frame forensic log (OCX_LIVE_FRAME_LOG) records per-frame metadata and
// U+FFFD presence without writing full payloads — the attribution tool for multibyte
// transcript corruption reports.
test("sideband frame log records direction, kind, and U+FFFD context without full payloads", async () => {
  const frameLogPath = join(TEST_DIR, "frames.jsonl");
  process.env.OCX_LIVE_FRAME_LOG = frameLogPath;
  const FFFD_TEXT = "가볍게 ��기핼봐요";

  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.send(FFFD_TEXT);
      },
      message(ws, message) {
        if (typeof message === "string") ws.send(`ack:${message.length}`);
      },
    },
  });

  saveConfig(forwardConfig());

  const RealWebSocket = globalThis.WebSocket;
  const upstreamPort = upstream.port;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const parsed = new URL(String(url));
      const target =
        parsed.hostname === "api.openai.com" && parsed.pathname.startsWith("/v1/live/")
          ? `ws://127.0.0.1:${upstreamPort}${parsed.pathname}${parsed.search}`
          : String(url);
      super(target, protocols as string[]);
    }
  } as typeof WebSocket;

  const server = startServer(0);
  try {
    const wsUrl = new URL(`/v1/live/rtc_framelog`, server.url);
    wsUrl.protocol = "ws:";
    const client = new RealWebSocket(wsUrl.toString(), {
      headers: {
        authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}`,
        "chatgpt-account-id": "acct-123",
      },
    } as unknown as string[]);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("frame-log timeout")), 10_000);
      let acks = 0;
      client.addEventListener("open", () => {
        client.send("clean-frame");
      });
      client.addEventListener("message", () => {
        acks += 1;
        if (acks >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      client.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("client websocket error"));
      });
    });

    const deadline = Date.now() + 2_000;
    while (!existsSync(frameLogPath) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    const lines = readFileSync(frameLogPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const u2cFffd = lines.find(l => l.dir === "u2c" && l.fffd === true);
    const c2uClean = lines.find(l => l.dir === "c2u" && l.kind === "text");
    expect(u2cFffd).toBeDefined();
    expect(u2cFffd.kind).toBe("text");
    expect(u2cFffd.bytes).toBeGreaterThan(0);
    expect(u2cFffd.context).toContain("�");
    expect(c2uClean).toBeDefined();
    expect(c2uClean.fffd).toBe(false);
    // Full payloads must never be logged — only short FFFD context excerpts.
    for (const line of lines) {
      expect(JSON.stringify(line)).not.toContain("clean-frame");
    }

    client.close();
  } finally {
    delete process.env.OCX_LIVE_FRAME_LOG;
    globalThis.WebSocket = RealWebSocket;
    await server.stop(true);
    await upstream.stop(true);
  }
});

// ── /readyz: per-server readiness gate ────────────────────────────────────────
// /healthz remains the immediate liveness signal (with only bounded capability
// metadata); /readyz is the stricter gate that reflects the post-startup Codex sync
// outcome. It is exact-GET
// and unauthenticated (like /healthz), returns a sanitized body, 503+Retry-After
// while pending/failed, and 200 only when ready. Each startServer gets its own
// PRIVATE gate via createReadinessGate(); starting/failing a second server in the
// same process can never reset or mutate the first server's gate.
describe("GET /readyz", () => {
  test("controlled startup sync drives the server gate to ready or failed", async () => {
    saveConfig(forwardConfig());
    const cases = [
      { outcome: { ok: true }, expectedStatus: "ready", expectedHttp: 200 },
      { outcome: { ok: true, warning: "catalog sync blocked" }, expectedStatus: "failed", expectedHttp: 503 },
    ] as const;

    for (const { outcome, expectedStatus, expectedHttp } of cases) {
      const gate = createReadinessGate();
      const server = startServer(0, { readinessGate: gate });
      try {
        const pending = await fetch(new URL("/readyz", server.url));
        expect(pending.status).toBe(503);
        const pendingBody = (await pending.json()) as Record<string, unknown>;
        expect(pendingBody.status).toBe("pending");
        expectReadyProtocolMetadata(pendingBody, new URL(server.url).origin);

        await runStartupReadinessSync(gate, async () => outcome);

        const settled = await fetch(new URL("/readyz", server.url));
        expect(settled.status).toBe(expectedHttp);
        const settledBody = (await settled.json()) as Record<string, unknown>;
        expect(settledBody.status).toBe(expectedStatus);
        expectReadyProtocolMetadata(settledBody, new URL(server.url).origin);
      } finally {
        await server.stop(true);
      }
    }
  });

  test("fresh gate is pending; /healthz 200 while /readyz 503 with Retry-After", async () => {
    saveConfig(forwardConfig());
    const gate = createReadinessGate();
    const server = startServer(0, { readinessGate: gate });
    try {
      const base = server.url;
      // Liveness is immediate and unchanged.
      const healthzRes = await fetch(new URL("/healthz", base));
      expect(healthzRes.status).toBe(200);
      const healthzBody = (await healthzRes.json()) as { status: string; service: string; pid: number };
      expect(healthzBody.status).toBe("ok");
      expect(healthzBody.service).toBe("opencodex");

      // Readiness is pending right after bind: 503 + Retry-After, sanitized body.
      const readyzRes = await fetch(new URL("/readyz", base));
      expect(readyzRes.status).toBe(503);
      expect(readyzRes.headers.get("retry-after")).toBe("1");
      const readyzBody = (await readyzRes.json()) as Record<string, unknown>;
      expect(readyzBody.service).toBe("opencodex");
      expect(readyzBody.status).toBe("pending");
      expect(typeof readyzBody.version).toBe("string");
      expect(typeof readyzBody.uptime).toBe("number");
      expect(typeof readyzBody.pid).toBe("number");
      expect(typeof readyzBody.port).toBe("number");
      expectReadyProtocolMetadata(readyzBody, new URL(base).origin);
      // Sanitization: the body must never carry sync diagnostics, paths, or warnings.
      expect(Object.keys(readyzBody).sort()).toEqual([
        "managementUrl", "minimumClientProtocol", "pid", "port", "protocol", "service", "status", "uptime", "version",
      ]);
      expect(JSON.stringify(readyzBody)).not.toContain("warning");
      expect(JSON.stringify(readyzBody)).not.toContain("path");
    } finally {
      await server.stop(true);
    }
  });

  test("hub readiness prefers the configured public management origin over the observed listener", async () => {
    saveConfig({
      ...forwardConfig(),
      runtimeRole: "hub",
      hub: { managementPublicOrigin: "https://hub.example.test" },
    });
    const server = startServer(0);
    try {
      const ready = await fetch(new URL("/readyz", server.url), {
        headers: {
          Host: "observed.example.test:8443",
          "X-Forwarded-Host": "attacker.example.test",
          "X-Forwarded-Proto": "http",
        },
      });
      const body = await ready.json() as Record<string, unknown>;
      expectReadyProtocolMetadata(body, "https://hub.example.test");

      const health = await fetch(new URL("/healthz", server.url));
      const healthBody = await health.json() as Record<string, unknown>;
      expect(healthBody.guiPairCapability).toBe("v1");
      expect(JSON.stringify(healthBody)).not.toContain("ocx_session_");
      expect(JSON.stringify(healthBody)).not.toContain("csrf");
    } finally {
      await server.stop(true);
    }
  });

  test("/readyz is 200 with status ready only after gate.markReady()", async () => {
    saveConfig(forwardConfig());
    const gate = createReadinessGate();
    const server = startServer(0, { readinessGate: gate });
    try {
      const base = server.url;
      expect(((await (await fetch(new URL("/readyz", base))).json()) as { status: string }).status).toBe("pending");
      gate.markReady();
      const res = await fetch(new URL("/readyz", base));
      expect(res.status).toBe(200);
      expect(res.headers.get("retry-after")).toBeNull();
      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe("ready");
      expect(body.service).toBe("opencodex");
    } finally {
      await server.stop(true);
    }
  });

  test("/readyz is 503 with Retry-After when the gate is failed", async () => {
    saveConfig(forwardConfig());
    const gate = createReadinessGate();
    gate.markFailed();
    const server = startServer(0, { readinessGate: gate });
    try {
      const res = await fetch(new URL("/readyz", server.url));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(((await res.json()) as { status: string }).status).toBe("failed");
    } finally {
      await server.stop(true);
    }
  });

  test("exact method/path: POST /readyz and GET /readyz/ are NOT matched", async () => {
    saveConfig(forwardConfig());
    const gate = createReadinessGate();
    const server = startServer(0, { readinessGate: gate });
    try {
      const base = server.url;
      // POST must not be accepted as readiness (falls through to the JSON 404 guard).
      const postRes = await fetch(new URL("/readyz", base), { method: "POST" });
      expect(postRes.status).toBe(404);
      // Trailing slash is a distinct path and must not match either.
      const slashRes = await fetch(new URL("/readyz/", base));
      expect(slashRes.status).toBe(404);
      // OPTIONS is a non-GET method and must not be accepted as a readiness
      // preflight (the generic OPTIONS branch would otherwise answer 204).
      const optionsRes = await fetch(new URL("/readyz", base), { method: "OPTIONS" });
      expect(optionsRes.status).toBe(404);
      expect(optionsRes.headers.get("content-type")).toContain("application/json");
      expect(((await optionsRes.json()) as { error?: { type?: string; message?: string } }).error).toMatchObject({
        type: "not_found",
        message: "Unknown endpoint: OPTIONS /readyz",
      });
      const optionsSlashRes = await fetch(new URL("/readyz/", base), { method: "OPTIONS" });
      expect(optionsSlashRes.status).toBe(404);
      expect(optionsSlashRes.headers.get("content-type")).toContain("application/json");
      expect(((await optionsSlashRes.json()) as { error?: { type?: string; message?: string } }).error).toMatchObject({
        type: "not_found",
        message: "Unknown endpoint: OPTIONS /readyz/",
      });
      // Encoded variants (e.g. /readyz%2F, which decodes to /readyz/) must NOT
      // bypass the exact-path rejection and reach the GUI fallback (which would
      // serve index.html with 200). GET, POST, and OPTIONS all answer the JSON 404.
      const encodedGetRes = await fetch(`${base}/readyz%2F`);
      expect(encodedGetRes.status).toBe(404);
      const encodedPostRes = await fetch(`${base}/readyz%2F`, { method: "POST" });
      expect(encodedPostRes.status).toBe(404);
      const encodedOptionsRes = await fetch(`${base}/readyz%2F`, { method: "OPTIONS" });
      expect(encodedOptionsRes.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test("/readyz answers without an admission token (unauthenticated, like /healthz)", async () => {
    saveConfig(forwardConfig());
    const gate = createReadinessGate();
    const server = startServer(0, { readinessGate: gate });
    try {
      // No Authorization header, no API auth token in env (beforeEach deletes it).
      const res = await fetch(new URL("/readyz", server.url), { headers: { Authorization: "" } });
      // Pending → 503, but it answered (did NOT demand auth → would be 401).
      expect([200, 503]).toContain(res.status);
      const body = (await res.json()) as { service?: string };
      expect(body.service).toBe("opencodex");
    } finally {
      await server.stop(true);
    }
  });

  test("ephemeral startServer(0): /readyz reports the actual bound port (not the requested 0)", async () => {
    saveConfig(forwardConfig());
    const gate = createReadinessGate();
    const server = startServer(0, { readinessGate: gate });
    try {
      const boundPort = new URL(server.url).port;
      // The bound port is a real ephemeral port, not the requested 0.
      expect(Number(boundPort)).toBeGreaterThan(0);
      const res = await fetch(new URL("/readyz", server.url));
      const body = (await res.json()) as { port: number };
      // /readyz must report the ACTUAL bound port so the strict probe passes.
      expect(body.port).toBe(Number(boundPort));
    } finally {
      await server.stop(true);
    }
  });
});

// ── /readyz per-server gate isolation ─────────────────────────────────────────
// Two simultaneous startServer invocations in the same process get INDEPENDENT
// gates. Marking one ready cannot flip the other; a second server whose bind
// fails cannot mutate the first server's gate; the first stays ready while the
// second is pending/failed.
describe("per-server readiness gate isolation", () => {
  test("two simultaneous servers keep independent gates (first ready while second pending)", async () => {
    saveConfig(forwardConfig());
    const gateA: ReadinessGate = createReadinessGate();
    const gateB: ReadinessGate = createReadinessGate();
    const serverA = startServer(0, { readinessGate: gateA });
    const serverB = startServer(0, { readinessGate: gateB });
    try {
      gateA.markReady();
      // gateB stays pending.

      const resA = await fetch(new URL("/readyz", serverA.url));
      expect(resA.status).toBe(200);
      expect(((await resA.json()) as { status: string }).status).toBe("ready");

      const resB = await fetch(new URL("/readyz", serverB.url));
      expect(resB.status).toBe(503);
      expect(((await resB.json()) as { status: string }).status).toBe("pending");
    } finally {
      await serverA.stop(true);
      await serverB.stop(true);
    }
  });

  test("marking one gate failed does not mutate the other gate", async () => {
    saveConfig(forwardConfig());
    const gateA: ReadinessGate = createReadinessGate();
    const gateB: ReadinessGate = createReadinessGate();
    const serverA = startServer(0, { readinessGate: gateA });
    const serverB = startServer(0, { readinessGate: gateB });
    try {
      gateA.markReady();
      gateB.markFailed();

      const resA = await fetch(new URL("/readyz", serverA.url));
      expect(resA.status).toBe(200);
      expect(((await resA.json()) as { status: string }).status).toBe("ready");

      const resB = await fetch(new URL("/readyz", serverB.url));
      expect(resB.status).toBe(503);
      expect(((await resB.json()) as { status: string }).status).toBe("failed");
    } finally {
      await serverA.stop(true);
      await serverB.stop(true);
    }
  });

  test("a server with no gate passed in still serves pending /readyz (fresh private gate)", async () => {
    saveConfig(forwardConfig());
    // No gate supplied → startServer creates a fresh pending private gate.
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/readyz", server.url));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { status: string }).status).toBe("pending");
    } finally {
      await server.stop(true);
    }
  });

  test("a bind failure on server A's actual occupied port cannot mutate A's gate (A stays ready, B stays pending)", async () => {
    saveConfig(forwardConfig());
    const gateA: ReadinessGate = createReadinessGate();
    const gateB: ReadinessGate = createReadinessGate();
    // Ephemeral start: A binds a real kernel-assigned port (NOT a fixed user port).
    const serverA = startServer(0, { readinessGate: gateA });
    try {
      gateA.markReady();
      const occupiedPort = Number(new URL(serverA.url).port);
      // The bound port is a real ephemeral port — the second startServer targets
      // the SAME actual port, which is already held by A.
      expect(occupiedPort).toBeGreaterThan(0);
      expect(Number.isInteger(occupiedPort)).toBe(true);

      // Binding the occupied port with a separate gate must throw (EADDRINUSE).
      // It must never silently share A's listener or reset A's gate.
      expect(() => startServer(occupiedPort, { readinessGate: gateB })).toThrow();

      // A is unaffected by the failed bind: still HTTP 200 / ready.
      const resA = await fetch(new URL("/readyz", serverA.url));
      expect(resA.status).toBe(200);
      expect(((await resA.json()) as { status: string }).status).toBe("ready");
      expect(gateA.getStatus()).toBe("ready");

      // B never got past Bun.serve, so its gate was never marked: it stays
      // pending (not failed, not ready) — exactly the isolation contract.
      expect(gateB.getStatus()).toBe("pending");

      // /healthz on A is unchanged too (liveness and readiness are independent).
      const healthzRes = await fetch(new URL("/healthz", serverA.url));
      expect(healthzRes.status).toBe(200);
    } finally {
      // Clean up ONLY A — B never bound, so there is no B server to stop.
      await serverA.stop(true);
    }
  });
});

describe("GET /readyz while draining", () => {
  afterEach(() => {
    resetLifecycleDrainStateForTests();
  });

  test("a ready gate reports pending (503) once the listener starts draining", async () => {
    saveConfig(forwardConfig());
    const gate = createReadinessGate();
    const server = startServer(0, { readinessGate: gate });
    try {
      gate.markReady();
      const base = server.url;

      // Before drain: ready → 200.
      const readyRes = await fetch(new URL("/readyz", base));
      expect(readyRes.status).toBe(200);
      expect(((await readyRes.json()) as { status: string }).status).toBe("ready");

      // Begin draining (as shutdown would). The one-shot gate is NOT mutated,
      // but /readyz must stop advertising ready while the listener drains.
      expect(isDraining()).toBe(false);
      expect(beginShutdownDrain()).toBe(true);
      expect(isDraining()).toBe(true);

      const drainRes = await fetch(new URL("/readyz", base));
      expect(drainRes.status).toBe(503);
      expect(drainRes.headers.get("retry-after")).toBe("1");
      const drainBody = (await drainRes.json()) as Record<string, unknown>;
      expect(drainBody.status).toBe("pending");
      expectReadyProtocolMetadata(drainBody, new URL(base).origin);

      // The gate itself is untouched — draining is a listener state, not a gate
      // transition, so the startup-sync ownership contract is preserved.
      expect(gate.getStatus()).toBe("ready");
    } finally {
      await server.stop(true);
      resetLifecycleDrainStateForTests();
    }
  });
});
