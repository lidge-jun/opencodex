/**
 * /v1/live relay: Codex App / ChatGPT voice POSTs call-create against the injected base_url,
 * so the proxy must relay it to an OpenAI upstream instead of the /v1/* JSON-404 guard.
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
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, ".tmp-server-live-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;
const DIRECT_CHATGPT_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
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
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
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

test("POST /v1/live relays to an OpenAI API-key provider at /v1/realtime/calls", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeLiveUpstream(captured, 201, "/v1/realtime/calls/rtc_api");
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
    expect(response.headers.get("location")).toBe("/v1/realtime/calls/rtc_api");

    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/realtime/calls");
    expect(captured[0].url).toContain("intent=quicksilver");
    expect(captured[0].url).toContain("architecture=avas");
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-test-live");
    expect(captured[0].headers.get("content-type")).toContain("multipart/form-data");
    expect(captured[0].bodyText).toContain('name="sdp"');
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

test("sideband GET /v1/live/{callId} upgrades and relays bidirectionally to ChatGPT backend", async () => {
  const seenPaths: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        seenPaths.push(url.pathname);
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${typeof message === "string" ? message : message.toString()}`);
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
        parsed.hostname === "chatgpt.com" && parsed.pathname.startsWith("/backend-api/codex/")
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
      },
    } as unknown as string[]);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sideband timeout")), 5_000);
      client.addEventListener("open", () => {
        client.send("ping-sideband");
      });
      client.addEventListener("message", (event) => {
        try {
          expect(String(event.data)).toBe("echo:ping-sideband");
          expect(seenPaths).toContain("/backend-api/codex/rtc_sideband");
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
});

test("buildLiveSidebandUpstreamWsUrl maps Frameless and Realtime join shapes", async () => {
  const { buildLiveSidebandUpstreamWsUrl, forwardLiveUrl, keyedLiveUrl, parseLiveSidebandTarget } =
    await import("../src/server/live");

  expect(forwardLiveUrl("https://chatgpt.com/backend-api/codex", true)).toBe(
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
    buildLiveSidebandUpstreamWsUrl("https://chatgpt.com/backend-api/codex", true, {
      style: "frameless-path",
      callId: "rtc_1",
    }),
  ).toBe("wss://chatgpt.com/backend-api/codex/rtc_1");
  expect(
    buildLiveSidebandUpstreamWsUrl("https://api.openai.com/v1", false, {
      style: "frameless-path",
      callId: "rtc_1",
    }),
  ).toBe("wss://api.openai.com/v1/live/rtc_1");
  expect(
    buildLiveSidebandUpstreamWsUrl("https://api.openai.com/v1", false, {
      style: "realtime-query",
      callId: "rtc_2",
    }),
  ).toBe("wss://api.openai.com/v1/realtime?intent=quicksilver&call_id=rtc_2");
});
