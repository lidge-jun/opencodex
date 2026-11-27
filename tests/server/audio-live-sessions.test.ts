/**
 * Public GPT-Live sessions (`/v1/live/sessions`) for external audio keys on an OpenAI API-key
 * provider. Upstream HTTP and WebSocket peers are local fixtures; nothing reaches OpenAI.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { resetLifecycleDrainStateForTests, tryAdmitTurn } from "../../src/server/lifecycle";
import { resolveAudioClient } from "../../src/server/audio-client";
import { handleLiveSessionCreate } from "../../src/server/audio-live-sessions";
import { LIVE_RESPONSE_MAX_BYTES } from "../../src/server/live";
import { LiveCallBindings } from "../../src/server/live-call-bindings";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const KEY = "ocx_data_live_sessions_fixture";
const OTHER_KEY = "ocx_data_live_sessions_other";
const SCOPED_KEY = "ocx_data_live_sessions_scoped";
const UPSTREAM_KEY = "fixture-upstream-key";
const fetchOriginal = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let home: string;
let codex: IsolatedCodexHome;
let fixture: ReturnType<typeof createFixture> | undefined;
const clients = new Set<WebSocket>();

const offer = { session: { model: "gpt-live-1.1", instructions: "Be concise." }, transport: { type: "webrtc", sdp: "v=0\r\n" } };

function keyedConfig(): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "openai-apikey", openaiProviderTierVersion: 2,
    providers: { "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: UPSTREAM_KEY, authMode: "key" } },
    apiKeys: [
      { id: "one", name: "one", key: KEY, createdAt: "2026-11-26T00:00:00Z" },
      { id: "two", name: "two", key: OTHER_KEY, createdAt: "2026-11-26T00:00:00Z" },
      { id: "scoped", name: "scoped", key: SCOPED_KEY, createdAt: "2026-11-26T00:00:00Z", allowedModels: ["gpt-live-1.1"] },
    ],
  } as OcxConfig;
}

const sessionAnswer = () => Response.json({ session: { id: "live_fixture_1" }, transport: { type: "webrtc", sdp: "v=0 answer\r\n" } }, { status: 201 });

function createFixture(options: { answer?: (req: Request) => Response | Promise<Response> } = {}) {
  const creates: Request[] = [];
  const handshakes: Array<{ url: string; headers: Headers }> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: {} })) return;
      return new Response("not found", { status: 404 });
    },
    websocket: { message(ws, raw) { ws.send(String(raw)); } },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (["api.openai.com", "chatgpt.com"].includes(new URL(req.url).hostname)) {
      if (new URL(req.url).pathname === "/v1/live/sessions") {
        creates.push(req.clone());
        return (options.answer ?? sessionAnswer)(req);
      }
      // Frameless call-create on either upstream, so a call alias exists beside the session aliases.
      if (new URL(req.url).pathname === "/v1/live" || new URL(req.url).pathname.endsWith("/realtime/calls")) {
        return new Response("v=0\r\n", { status: 201, headers: { "content-type": "application/sdp", location: "https://api.openai.com/v1/live/rtc_frameless_fixture" } });
      }
      return Response.json({});
    }
    return fetchOriginal(input, init);
  }) as typeof fetch;
  const server = startServer(0, {
    liveSidebandWebSocketFactory(url, headers) {
      handshakes.push({ url, headers: new Headers(headers) });
      const local = new URL("/socket", upstream.url); local.protocol = "ws:";
      return new WebSocket(local, { headers } as unknown as string[]);
    },
  });
  return { server, upstream, creates, handshakes };
}

function create(body: unknown = offer, key = KEY, extra: Record<string, string> = {}): Promise<Response> {
  return fetchOriginal(new URL("/v1/live/sessions", fixture!.server.url), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body),
  });
}

function socket(path: string, key = KEY): WebSocket {
  const url = new URL(path, fixture!.server.url); url.protocol = "ws:";
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } } as unknown as string[]);
  clients.add(ws);
  return ws;
}

function echo(ws: WebSocket, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Fixture socket timed out")); }, 10000);
    ws.addEventListener("message", event => { clearTimeout(timer); resolve(String(event.data)); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Fixture socket failed")); }, { once: true });
    if (ws.readyState === WebSocket.OPEN) ws.send(message); else ws.addEventListener("open", () => ws.send(message), { once: true });
  });
}

async function upgradeStatus(path: string, key?: string): Promise<number> {
  const response = await fetchOriginal(new URL(path, fixture!.server.url), { headers: {
    upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==", "sec-websocket-version": "13",
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  } });
  await response.text();
  return response.status;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-live-sessions-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  codex = installIsolatedCodexHome("ocx-live-sessions-codex-");
  resetLifecycleDrainStateForTests(); clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap();
  saveConfig(keyedConfig());
});

afterEach(async () => {
  for (const ws of clients) ws.close();
  clients.clear();
  if (fixture) await Promise.all([fixture.server.stop(true), fixture.upstream.stop(true)]);
  fixture = undefined;
  globalThis.fetch = fetchOriginal;
  resetLifecycleDrainStateForTests(); clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap();
  codex.restore(); removeTreeWithRetry(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
});

describe("GPT-Live session creation", () => {
  test("relays the session to the API-key provider and answers with a key-bound alias", async () => {
    fixture = createFixture();
    const response = await create(offer, KEY, { "openai-safety-identifier": "hashed-user" });
    expect(response.status).toBe(201);
    const answer = await response.json() as { session: { id: string }; transport: unknown };
    expect(answer.session.id).toStartWith("rtc_ocx_");
    expect(answer.transport).toEqual({ type: "webrtc", sdp: "v=0 answer\r\n" });
    const upstream = fixture.creates[0]!;
    expect(upstream.url).toBe("https://api.openai.com/v1/live/sessions");
    expect(upstream.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(upstream.headers.get("openai-safety-identifier")).toBe("hashed-user");
    expect(upstream.headers.get("x-opencodex-api-key")).toBeNull();
    expect(await upstream.json()).toEqual(offer);
  });

  test("malformed requests, SIP and missing models are refused before any upstream call", async () => {
    fixture = createFixture();
    const bodies: unknown[] = [
      { transport: offer.transport },
      { session: { instructions: "x" }, transport: offer.transport },
      { session: offer.session, transport: { type: "sip", destination: "+14155550123" } },
      { session: offer.session, transport: { type: "webrtc", sdp: "" } },
      [],
    ];
    for (const body of bodies) expect((await create(body)).status).toBe(400);
    expect(fixture.creates).toHaveLength(0);
  });

  test("a ChatGPT account is never substituted for the API-key provider", async () => {
    saveConfig({
      port: 0, hostname: "127.0.0.1", defaultProvider: "openai", openaiProviderTierVersion: 2,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
      codexAccounts: [{ id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-a" }],
      apiKeys: [{ id: "one", name: "one", key: KEY, createdAt: "2026-11-26T00:00:00Z" }],
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", { accessToken: fakeChatGptJwt({ chatgpt_account_id: "acct-a" }), refreshToken: "fixture-refresh", expiresAt: Date.now() + 3600000, chatgptAccountId: "acct-a" });
    fixture = createFixture();
    const response = await create();
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("API-key provider");
    expect(await upgradeStatus("/v1/live/sessions", KEY)).toBe(400);
    expect(fixture.creates).toHaveLength(0);
    expect(fixture.handshakes).toHaveLength(0);
  });

  test("a model-scoped key is judged on the session model", async () => {
    fixture = createFixture();
    expect((await create({ ...offer, session: { ...offer.session, model: "gpt-live-1" } }, SCOPED_KEY)).status).toBe(403);
    expect((await create(offer, SCOPED_KEY)).status).toBe(201);
  });

  test("the native path without an audio key cannot create or open sessions", async () => {
    fixture = createFixture();
    const response = await fetchOriginal(new URL("/v1/live/sessions", fixture.server.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(offer),
    });
    expect(response.status).toBe(401);
    expect(await upgradeStatus("/v1/live/sessions")).toBe(401);
    expect(await upgradeStatus("/v1/live/sessions/rtc_ocx_missing/attach")).toBe(401);
    expect(fixture.creates).toHaveLength(0);
    expect(fixture.handshakes).toHaveLength(0);
  });
});

describe("GPT-Live session sockets", () => {
  test("a session socket opens on the API-key provider without a query", async () => {
    fixture = createFixture();
    expect(await echo(socket("/v1/live/sessions"), "start-echo")).toBe("start-echo");
    expect(fixture.handshakes[0]!.url).toBe("wss://api.openai.com/v1/live/sessions");
    expect(fixture.handshakes[0]!.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(fixture.handshakes[0]!.headers.get("openai-alpha")).toBeNull();
  });

  test("a model-scoped key cannot open a session socket that names its model in-band", async () => {
    fixture = createFixture();
    expect(await upgradeStatus("/v1/live/sessions", SCOPED_KEY)).toBe(403);
    expect(fixture.handshakes).toHaveLength(0);
  });

  test("only the creating key can attach to a session it created", async () => {
    fixture = createFixture();
    const created = await create();
    const alias = (await created.json() as { session: { id: string } }).session.id;
    expect(await upgradeStatus(`/v1/live/sessions/${alias}/attach`, OTHER_KEY)).toBe(404);
    expect(fixture.handshakes).toHaveLength(0);
    expect(await echo(socket(`/v1/live/sessions/${alias}/attach`), "attach-echo")).toBe("attach-echo");
    expect(fixture.handshakes[0]!.url).toBe("wss://api.openai.com/v1/live/sessions/live_fixture_1/attach");
  });
});


describe("GPT-Live session boundaries", () => {
  test("a ChatGPT call alias never opens the session attach route, nor a session alias the call route", async () => {
    saveConfig({
      ...keyedConfig(), defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" },
        ...keyedConfig().providers,
      },
      codexAccounts: [{ id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-a" }],
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", { accessToken: fakeChatGptJwt({ chatgpt_account_id: "acct-a" }), refreshToken: "fixture-refresh", expiresAt: Date.now() + 3600000, chatgptAccountId: "acct-a" });
    fixture = createFixture();
    const call = await fetchOriginal(new URL("/v1/live", fixture.server.url), {
      method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ sdp: "v=0\r\n" }),
    });
    expect(call.status).toBe(201);
    await call.text();
    const callAlias = call.headers.get("location")!.split("/").at(-1)!;
    expect(await upgradeStatus(`/v1/live/sessions/${callAlias}/attach`, KEY)).toBe(404);
    const created = await create();
    const sessionAlias = (await created.json() as { session: { id: string } }).session.id;
    expect(await upgradeStatus(`/v1/live/${sessionAlias}`, KEY)).toBe(404);
    expect(fixture.handshakes).toHaveLength(0);
  });

  test("session sockets reach the API-key provider even when a sideband override is configured", async () => {
    saveConfig({ ...keyedConfig(), experimentalRealtimeWsBaseUrl: "wss://sideband.example.test/v1" } as OcxConfig);
    fixture = createFixture();
    await echo(socket("/v1/live/sessions"), "start-echo");
    const alias = (await (await create()).json() as { session: { id: string } }).session.id;
    await echo(socket(`/v1/live/sessions/${alias}/attach`), "attach-echo");
    expect(fixture.handshakes.map(handshake => handshake.url)).toEqual([
      "wss://api.openai.com/v1/live/sessions",
      "wss://api.openai.com/v1/live/sessions/live_fixture_1/attach",
    ]);
  });

  test.each([
    ["an empty transport", () => Response.json({ session: { id: "live_fixture_1" }, transport: {} }, { status: 201 })],
    ["an empty SDP answer", () => Response.json({ session: { id: "live_fixture_1" }, transport: { type: "webrtc", sdp: " " } }, { status: 201 })],
    ["a SIP transport", () => Response.json({ session: { id: "live_fixture_1" }, transport: { type: "sip" } }, { status: 201 })],
    ["an invalid session id", () => Response.json({ session: { id: "live 1/../x" }, transport: { type: "webrtc", sdp: "v=0" } }, { status: 201 })],
    ["a non-JSON body", () => new Response("v=0", { status: 201 })],
    ["a redirect", () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example.test/v1/live/sessions" } })],
    ["an oversized answer", () => new Response("x".repeat(LIVE_RESPONSE_MAX_BYTES + 1), { status: 201 })],
  ] as const)("%s from upstream is a 502 and binds nothing", async (_label, answer) => {
    fixture = createFixture({ answer });
    const response = await create();
    expect(response.status).toBe(502);
    await response.text();
    expect(fixture.creates[0]!.redirect).toBe("manual");
  });

  test("a client cancel aborts the upstream request", async () => {
    const config = keyedConfig();
    saveConfig(config);
    const started = Promise.withResolvers<void>();
    let aborted = false;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started.resolve();
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }, { once: true });
    })) as typeof fetch;
    const controller = new AbortController();
    const req = new Request("http://localhost/v1/live/sessions", {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-opencodex-api-key": KEY }, body: JSON.stringify(offer),
    });
    const audio = resolveAudioClient(req, config, true);
    if (!audio || audio instanceof Response) throw new Error("audio key was not admitted");
    const lease = tryAdmitTurn();
    if (!lease) throw new Error("turn gate refused an idle lease");
    try {
      const pending = handleLiveSessionCreate(req, config, { model: "unknown", provider: "unknown" }, { client: audio, lease, bindings: new LiveCallBindings() });
      await started.promise;
      controller.abort();
      expect((await pending).status).toBe(499);
      expect(aborted).toBe(true);
    } finally { lease.release(); }
  });
});

