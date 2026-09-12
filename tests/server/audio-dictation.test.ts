import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import * as routing from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { createDictationFrameValidator } from "../../src/server/audio-dictation";
import { abortAndReleaseAllTurns, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const KEY = "ocx_data_audio_stream_fixture";
const OTHER_KEY = "ocx_data_audio_other_fixture";
const fetchOriginal = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let home: string;
let codex: IsolatedCodexHome;
let fixture: ReturnType<typeof createFixture> | undefined;
const clients = new Set<WebSocket>();

const startEvent = { type: "session.start", config: {
  input_audio_format: "pcm16", sample_rate_hz: 48000, num_channels: 1,
  max_buffer_size_bytes: 4194304, max_utterance_duration_ms: 30000, session_ttl_ms: 300000,
  provider_mode: "streaming_sse", transcript_delivery_mode: "segment",
  vad: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
} };

function createFixture() {
  const creates: Headers[] = [];
  const handshakes: Array<{ url: string; headers: Headers; protocols?: string[] }> = [];
  const frames: string[] = [];
  const upstreamClosed = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocol = req.headers.get("sec-websocket-protocol")?.includes("chatgpt-dictation") ? "chatgpt-dictation" : undefined;
        if (server.upgrade(req, { data: {}, ...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {}) })) return;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const message = String(raw);
        frames.push(message);
        let event: { type?: string };
        try { event = JSON.parse(message); } catch { ws.send(message); return; }
        if (event.type === "session.start") ws.send(JSON.stringify({ type: "session.started", sequence_no: 1, session: { session_id: "fixture", status: "active", config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" } } }));
        else if (event.type === "audio.append") ws.send(JSON.stringify({ type: "transcript.final", sequence_no: 2, utterance_id: "u1", revision: 1, text: "fixture transcript" }));
        else if (event.type === "session.close") {
          ws.send(JSON.stringify({ type: "session.updated", sequence_no: 3, session: { session_id: "fixture", status: "closed", config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" } } }));
          ws.close(1000);
        } else ws.send(message);
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (["chatgpt.com", "api.openai.com"].includes(new URL(req.url).hostname)) {
      if (new URL(req.url).pathname.endsWith("/realtime/calls") || new URL(req.url).pathname === "/v1/live") {
        creates.push(new Headers(req.headers));
        return new Response("v=0\r\n", { status: 201, headers: { "content-type": "application/sdp", location: `https://api.openai.com/v1/live/rtc_upstream_${creates.length}` } });
      }
      return Response.json({});
    }
    return fetchOriginal(input, init);
  }) as typeof fetch;
  const server = startServer(0, {
    liveSidebandWebSocketFactory(url, headers, protocols) {
      handshakes.push({ url, headers: new Headers(headers), protocols });
      const local = new URL("/socket", upstream.url); local.protocol = "ws:";
      const socket = new WebSocket(local, { headers, protocols } as unknown as string[]);
      socket.addEventListener("close", () => upstreamClosed.resolve(), { once: true });
      return socket;
    },
  });
  return { server, upstream, creates, handshakes, frames, upstreamClosed: upstreamClosed.promise };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-stream-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  codex = installIsolatedCodexHome("ocx-stream-codex-");
  resetLifecycleDrainStateForTests(); clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap();
  const config: OcxConfig = {
    port: 0, hostname: "127.0.0.1", defaultProvider: "openai", openaiProviderTierVersion: 2, accountPoolStrategy: "round-robin",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
    codexAccounts: [
      { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-a" },
      { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "acct-b" },
    ],
    apiKeys: [
      { id: "one", name: "one", key: KEY, createdAt: "2026-09-12T00:00:00Z" },
      { id: "two", name: "two", key: OTHER_KEY, createdAt: "2026-09-12T00:00:00Z" },
    ],
  };
  for (const [id, account] of [["pool-a", "acct-a"], ["pool-b", "acct-b"]] as const) {
    saveCodexAccountCredential(id, { accessToken: fakeChatGptJwt({ chatgpt_account_id: account }), refreshToken: "fixture-refresh", expiresAt: Date.now() + 3600000, chatgptAccountId: account });
  }
  saveConfig(config);
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

function socket(path: string, browser = false): WebSocket {
  const url = new URL(path, fixture!.server.url); url.protocol = "ws:";
  const ws = browser
    ? new WebSocket(url, ["opencodex-audio", `opencodex-key.${Buffer.from(KEY).toString("base64url")}`])
    : new WebSocket(url, { headers: { authorization: `Bearer ${KEY}` } } as unknown as string[]);
  clients.add(ws);
  return ws;
}

function receive(ws: WebSocket, send: unknown, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Fixture socket timed out")); }, 10000);
    ws.addEventListener("message", event => {
      const text = String(event.data);
      if (text.includes(expected)) { clearTimeout(timer); resolve(text); }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Fixture socket failed")); }, { once: true });
    const transmit = () => ws.send(typeof send === "string" ? send : JSON.stringify(send));
    if (ws.readyState === WebSocket.OPEN) transmit(); else ws.addEventListener("open", transmit, { once: true });
  });
}

async function createCall(): Promise<string> {
  const response = await fetchOriginal(new URL("/v1/live", fixture!.server.url), {
    method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ sdp: "v=0\r\n" }),
  });
  expect(response.status).toBe(201);
  await response.text();
  return response.headers.get("location")!;
}

describe("dictation protocol validation", () => {
  test("PCM frames require a valid start, canonical base64 and an open session", () => {
    const validate = createDictationFrameValidator();
    expect(validate(JSON.stringify({ type: "audio.append", audio: "AAA=" }))).toBe(false);
    expect(validate(JSON.stringify(startEvent))).toBe(true);
    expect(validate(JSON.stringify(startEvent))).toBe(false);
    expect(validate(JSON.stringify({ type: "audio.append", audio: "AA==" }))).toBe(false);
    expect(validate(JSON.stringify({ type: "audio.append", audio: "AAA=" }))).toBe(true);
    expect(validate(JSON.stringify({ type: "session.close" }))).toBe(true);
    expect(validate(JSON.stringify({ type: "audio.append", audio: "AAA=" }))).toBe(false);
  });
  test("bad formats and oversized configurations do not start sessions", () => {
    for (const change of [{ num_channels: 2 }, { sample_rate_hz: 0 }, { session_ttl_ms: 300001 }, { max_buffer_size_bytes: 4194305 }]) {
      expect(createDictationFrameValidator()(JSON.stringify({ ...startEvent, config: { ...startEvent.config, ...change } }))).toBe(false);
    }
  });
});

describe("external audio sockets", () => {
  test("browser key carrier relays the actual dictation protocol without exposing upstream credentials", async () => {
    fixture = createFixture();
    const ws = socket("/v1/audio/transcriptions/stream", true);
    await receive(ws, startEvent, "session.started");
    expect(ws.protocol).toBe("opencodex-audio");
    const transcript = await receive(ws, { type: "audio.append", audio: "AAA=" }, "transcript.final");
    expect(JSON.parse(transcript).text).toBe("fixture transcript");
    await receive(ws, { type: "session.close" }, "session.updated");
    expect(fixture.handshakes[0]!.url).toBe("wss://chatgpt.com/backend-api/dictation/stream");
    expect(fixture.handshakes[0]!.protocols?.[0]).toBe("chatgpt-dictation");
    expect(fixture.handshakes[0]!.protocols?.[1]).toStartWith("openai-bearer.");
    expect(fixture.handshakes[0]!.protocols?.join(",")).not.toContain(KEY);
  });
  test("standalone live defaults model and negotiation only for external clients", async () => {
    fixture = createFixture();
    const ws = socket("/v1/live");
    expect(await receive(ws, "fixture-echo", "fixture-echo")).toBe("fixture-echo");
    expect(fixture.handshakes[0]!.url).toBe("wss://api.openai.com/v1/live?model=gpt-live-1-codex");
    expect(fixture.handshakes[0]!.headers.get("openai-alpha")).toBe("quicksilver=v2");
  });
  test("successful external sockets record one supported success outcome", async () => {
    fixture = createFixture();
    const outcomes = spyOn(routing, "recordCodexUpstreamOutcome");
    try {
      const ws = socket("/v1/live");
      await receive(ws, "healthy", "healthy");
      ws.close();
      await fixture.upstreamClosed;
      expect(outcomes.mock.calls.map(call => call[2])).toEqual([200]);
    } finally { outcomes.mockRestore(); }
  });
  test("shutdown cancellation reaches the authenticated upstream socket", async () => {
    fixture = createFixture();
    const ws = socket("/v1/live");
    await receive(ws, "before-shutdown", "before-shutdown");
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Shutdown left the client open")), 10000);
      ws.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    abortAndReleaseAllTurns();
    await Promise.all([closed, fixture.upstreamClosed]);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  }, { timeout: 15000 });
  test("a returned call alias keeps the creating account after pool rotation", async () => {
    fixture = createFixture();
    const location = await createCall();
    expect(location).toStartWith("/v1/live/rtc_ocx_");
    await createCall();
    expect(fixture.creates[1]!.get("chatgpt-account-id")).not.toBe(fixture.creates[0]!.get("chatgpt-account-id"));
    const ws = socket(location);
    await receive(ws, "bound-echo", "bound-echo");
    expect(fixture.handshakes[0]!.url).toBe("wss://api.openai.com/v1/live/rtc_upstream_1");
    expect(fixture.handshakes[0]!.headers.get("chatgpt-account-id")).toBe(fixture.creates[0]!.get("chatgpt-account-id"));
  });
  test("wrong key and unkeyed callers cannot join an external alias", async () => {
    fixture = createFixture();
    const location = await createCall();
    for (const [key, expected] of [[OTHER_KEY, 404], ["", 401]] as const) {
      const response = await fetchOriginal(new URL(location, fixture.server.url), { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==", "sec-websocket-version": "13", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
      expect(response.status).toBe(expected);
      await response.text();
    }
    expect(fixture.handshakes).toHaveLength(0);
  });
  test("missing reserved aliases never become legacy native joins", async () => {
    fixture = createFixture();
    const response = await fetchOriginal(new URL("/v1/live/rtc_ocx_expired", fixture.server.url), { headers: { upgrade: "websocket" } });
    expect(response.status).toBe(401);
    expect(fixture.handshakes).toHaveLength(0);
  });
});
