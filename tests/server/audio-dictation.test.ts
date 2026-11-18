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
import { createDictationFrameValidator, DICTATION_SESSION_MAX_MS, DICTATION_FINALIZATION_MAX_MS } from "../../src/server/audio-dictation";
import { attachLiveSidebandUpstream, beginAudioFinalization } from "../../src/server/index/live-sideband";
import type { WsData } from "../../src/server/ws-bridge";
import { abortAndReleaseAllTurns, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { LiveCallBindings } from "../../src/server/live-call-bindings";
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
// Matches ScribeTray src/openai_streaming.rs::start_message (UUIDs fixed for repeatability).
const scribeStart = {
  type: "session.start", dictation_session_id: "78d201cb-1b49-40e1-a5b5-e06a8f8489a1",
  attempt_id: "8b3c2e4f-d501-4a66-b123-456789abcdef", config: {
    input_audio_format: "pcm16", sample_rate_hz: 16000, num_channels: 1,
    max_buffer_size_bytes: 4194304, max_utterance_duration_ms: 30000, session_ttl_ms: 300000,
    provider_mode: "streaming_sse", transcript_delivery_mode: "final_only", session_asset_mode: "none",
    vad: { type: "server_vad" },
  }, client_capabilities: ["server_stop_requested"],
};

function createFixture(options: { failDictation?: boolean; finalOnClose?: boolean; answer?: "invalid" | "ok200" } = {}) {
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
        if (options.failDictation && event.type === "session.start") {
          ws.send(JSON.stringify({ type: "session.error", sequence_no: 1, fatal: true, error: { code: "fixture_error", message: "fixture rejection", retryable: false } }));
          ws.close(1000);
          return;
        }
        if (event.type === "session.start") ws.send(JSON.stringify({ type: "session.started", sequence_no: 1, session: { session_id: "fixture", status: "active", config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" } } }));
        else if (event.type === "audio.append") ws.send(JSON.stringify({ type: options.finalOnClose ? "speech.started" : "transcript.final", sequence_no: 2, utterance_id: "u1", revision: 1, text: "fixture transcript" }));
        else if (event.type === "session.close") {
          if (options.finalOnClose) ws.send(JSON.stringify({ type: "transcript.final", utterance_id: "u1", revision: 1, text: "the last synthetic words" }));
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
        if (options.answer === "invalid") return new Response("", { status: 200 });
        if (options.answer === "ok200") return new Response("v=0\r\n", { status: 200, headers: { "content-type": "application/sdp", location: `https://api.openai.com/v1/live/rtc_upstream_${creates.length}` } });
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
  test("exact ScribeTray start with and without language preserves flush/close sequencing", () => {
    for (const language of [undefined, "it", "en-US"]) {
      const validate = createDictationFrameValidator();
      const accepts = (value: unknown) => validate(JSON.stringify(value));
      expect(accepts({ type: "audio.flush" })).toBe(false);
      expect(accepts({ type: "session.close" })).toBe(false);
      expect(accepts({ ...scribeStart, config: { ...scribeStart.config, ...(language ? { language } : {}) } })).toBe(true);
      expect(accepts({ type: "audio.append", audio: "AAA=" })).toBe(true);
      expect(accepts({ type: "audio.flush" })).toBe(true);
      // Flush is nonterminal: more audio is legal until close.
      expect(accepts({ type: "audio.append", audio: "AgA=" })).toBe(true);
      expect(accepts({ type: "audio.flush" })).toBe(true);
      expect(accepts({ type: "session.close" })).toBe(true);
      for (const type of ["audio.append", "audio.flush", "session.close", "session.start"]) expect(accepts({ type, audio: "AAA=" })).toBe(false);
    }
  });
  test("optional VAD settings remain validated when present", () => {
    for (const vad of [
      { threshold: -0.1 }, { threshold: 1.1 }, { threshold: "0.5" }, { threshold: null },
      { prefix_padding_ms: -1 }, { prefix_padding_ms: 1001 }, { prefix_padding_ms: 0.5 },
      { silence_duration_ms: -1 }, { silence_duration_ms: 5001 }, { silence_duration_ms: "500" },
      { type: "client_vad" }, { unexpected: true },
    ]) expect(createDictationFrameValidator()(JSON.stringify({ ...scribeStart, config: { ...scribeStart.config, vad: { type: "server_vad", ...vad } } }))).toBe(false);
    for (const vad of [{ threshold: 0 }, { threshold: 1, prefix_padding_ms: 1000, silence_duration_ms: 5000 }]) {
      expect(createDictationFrameValidator()(JSON.stringify({ ...scribeStart, config: { ...scribeStart.config, vad: { type: "server_vad", ...vad } } }))).toBe(true);
    }
  });
  test("compatibility additions do not admit arbitrary fields or unbounded data", () => {
    for (const change of [
      { dictation_session_id: "x".repeat(129) }, { attempt_id: null }, { attempt_id: "" },
      { dictation_session_id: "bad\nvalue" }, { client_capabilities: "server_stop_requested" },
      { client_capabilities: ["unknown"] }, { client_capabilities: ["server_stop_requested", "server_stop_requested"] },
      { arbitrary: true },
    ]) expect(createDictationFrameValidator()(JSON.stringify({ ...scribeStart, ...change }))).toBe(false);
    for (const change of [{ language: "" }, { language: "x".repeat(65) }, { language: 3 }, { session_asset_mode: "all" }, { arbitrary: true }, { provider_mode: ["streaming_sse"] }, { transcript_delivery_mode: ["final_only"] }]) {
      expect(createDictationFrameValidator()(JSON.stringify({ ...scribeStart, config: { ...scribeStart.config, ...change } }))).toBe(false);
    }
    const validate = createDictationFrameValidator();
    expect(validate(Buffer.from(JSON.stringify(scribeStart)))).toBe(false);
    expect(validate("{" )).toBe(false);
    expect(validate(JSON.stringify(scribeStart))).toBe(true);
    for (const event of [
      { type: "audio.append", audio: "A".repeat(65536) }, { type: "audio.append", audio: "not base64!" },
      { type: "audio.append", audio: "AA==" }, { type: "audio.append", audio: "" },
      { type: "audio.flush", extra: true }, { type: "session.close", extra: true },
    ]) expect(validate(JSON.stringify(event))).toBe(false);
  });
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
    for (const change of [{ num_channels: 2 }, { sample_rate_hz: 0 }, { session_ttl_ms: 600001 }, { max_buffer_size_bytes: 4194305 }]) {
      expect(createDictationFrameValidator()(JSON.stringify({ ...startEvent, config: { ...startEvent.config, ...change } }))).toBe(false);
    }
  });
  test("ten-minute application ceiling accepts the old TTL and rejects larger TTLs", () => {
    expect(DICTATION_SESSION_MAX_MS).toBe(600_000);
    for (const ttl of [300_000, 600_000]) {
      expect(createDictationFrameValidator()(JSON.stringify({ ...startEvent, config: { ...startEvent.config, session_ttl_ms: ttl } }))).toBe(true);
    }
  });
  test("relay recording and finalization clocks are bounded and cleaned on expiry or cancel", () => {
    for (const mode of ["recording", "finalizing", "cancel", "complete", "other-transport", "connect-timeout"] as const) {
      let now = 0;
      let id = 0;
      const timers = new Map<number, { at: number; run: () => void }>();
      const set = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
        timers.set(++id, { at: now + ms, run }); return id;
      }) as typeof setTimeout);
      const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((key: number) => { timers.delete(key); }) as typeof clearTimeout);
      const advance = (ms: number) => {
        now += ms;
        for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.run(); }
      };
      const upstream = new EventTarget() as EventTarget & { readyState: number; close: () => void };
      upstream.readyState = WebSocket.OPEN;
      upstream.close = () => { upstream.readyState = WebSocket.CLOSED; upstream.dispatchEvent(new CloseEvent("close", { code: 1000 })); };
      let releases = 0;
      const outcomes: unknown[] = [];
      const data: WsData = {
        liveUpstream: upstream as unknown as WebSocket,
        liveUpstreamHandoff: { failure: () => undefined, take: () => ({ ok: true, frames: [] }) },
        liveMaxSessionMs: DICTATION_SESSION_MAX_MS, liveFinalizationMs: DICTATION_FINALIZATION_MAX_MS,
        liveFinish: outcome => { outcomes.push(outcome); },
        liveTurnAdmissionLease: { release: () => { releases++; } } as never,
      };
      const ws = { data, readyState: WebSocket.OPEN, close() {} };
      if (mode === "other-transport") data.liveFinalizationMs = undefined;
      if (mode === "connect-timeout") {
        data.liveUpstream = undefined;
        data.liveUpstreamUrl = "ws://fixture.invalid";
        upstream.readyState = WebSocket.CONNECTING;
      }
      try {
        attachLiveSidebandUpstream(ws as never, () => upstream as unknown as WebSocket);
        if (mode === "connect-timeout") {
          expect(data.liveConnectTimer).toBeDefined();
          advance(9_999);
          expect(releases).toBe(0);
          advance(1);
          expect(releases).toBe(1);
          expect(outcomes).toEqual(["timeout"]);
          expect(timers.size).toBe(0);
          expect(data.liveConnectTimer).toBeUndefined();
          expect(data.liveSessionTimer).toBeUndefined();
          continue;
        }
        expect(data.liveConnectTimer).toBeUndefined();
        advance(599_999);
        expect(releases).toBe(0);
        if (mode === "recording") advance(1);
        else {
          beginAudioFinalization(ws as never, '{"type":"session.close"}');
          if (mode === "other-transport") {
            expect(data.liveFinalizing).toBeUndefined();
            advance(1);
          } else {
            advance(1);
            expect(releases).toBe(0);
            if (mode === "cancel") data.cancel!();
            else if (mode === "complete") upstream.close();
            else {
              advance(59_998);
              expect(releases).toBe(0);
              advance(1);
            }
          }
        }
        expect(releases).toBe(1);
        expect(outcomes).toEqual([undefined]);
        expect(timers.size).toBe(0);
        expect(data.liveSessionTimer).toBeUndefined();
        expect(data.liveAbortListener).toBeUndefined();
      } finally { set.mockRestore(); clear.mockRestore(); }
    }
  });
});

describe("external audio sockets", () => {
  test("native platform bearer keeps HTTP creation and WebSocket relay on its configured tier", async () => {
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "openai-apikey", openaiProviderTierVersion: 2,
      providers: { "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-fixture-native", authMode: "key" } },
      apiKeys: [{ id: "one", name: "one", key: KEY, createdAt: "2026-09-12T00:00:00Z" }],
    });
    fixture = createFixture();
    const form = new FormData(); form.set("sdp", "v=0\r\n");
    const response = await fetchOriginal(new URL("/v1/live", fixture.server.url), {
      method: "POST", body: form, headers: { authorization: "Bearer sk-fixture-native" },
    });
    expect(response.status).toBe(201);
    await response.text();
    expect(response.headers.get("location")).toBe("https://api.openai.com/v1/live/rtc_upstream_1");
    const url = new URL("/v1/realtime?model=gpt-realtime-1.5", fixture.server.url); url.protocol = "ws:";
    const ws = new WebSocket(url, { headers: { authorization: "Bearer sk-fixture-native" } } as unknown as string[]);
    clients.add(ws);
    await receive(ws, "native-echo", "native-echo");
    expect(fixture.handshakes[0]!.headers.get("authorization")).toBe("Bearer sk-fixture-native");
  });
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
  test("ScribeTray frames reach upstream unchanged and ordered, with finals after close", async () => {
    fixture = createFixture({ finalOnClose: true });
    const ws = socket("/v1/audio/transcriptions/stream", true);
    const start = { ...scribeStart, config: { ...scribeStart.config, language: "it" } };
    await receive(ws, start, "session.started");
    const append = { type: "audio.append", audio: "AAA=" };
    await receive(ws, append, "speech.started");
    const flush = { type: "audio.flush" };
    const close = { type: "session.close" };
    const finals: string[] = [];
    ws.addEventListener("message", event => {
      const value = JSON.parse(String(event.data));
      if (value.type === "transcript.final") finals.push(value.text);
    });
    const closed = receive(ws, flush, "session.updated");
    ws.send(JSON.stringify(close));
    await closed;
    expect(finals).toEqual(["the last synthetic words"]);
    expect(fixture.frames).toEqual([start, append, flush, close].map(value => JSON.stringify(value)));
  });
  test("standalone live defaults model and negotiation only for external clients", async () => {
    fixture = createFixture();
    const ws = socket("/v1/live");
    expect(await receive(ws, "fixture-echo", "fixture-echo")).toBe("fixture-echo");
    expect(fixture.handshakes[0]!.url).toBe("wss://api.openai.com/v1/live?model=gpt-live-1-codex");
    expect(fixture.handshakes[0]!.headers.get("openai-alpha")).toBe("quicksilver=v2");
  });
  test("connectivity-only completion does not claim inference recovery", async () => {
    fixture = createFixture();
    const outcomes = spyOn(routing, "recordCodexUpstreamOutcome");
    try {
      const ws = socket("/v1/live");
      await receive(ws, "healthy", "healthy");
      ws.close();
      await fixture.upstreamClosed;
      expect(outcomes.mock.calls).toEqual([]);
    } finally { outcomes.mockRestore(); }
  });
  test("protocol failure followed by a normal close never records success", async () => {
    fixture = createFixture({ failDictation: true });
    const before = routing.getCodexUpstreamHealth("pool-a");
    const outcomes = spyOn(routing, "recordCodexUpstreamOutcome");
    try {
      const ws = socket("/v1/audio/transcriptions/stream", true);
      await receive(ws, startEvent, "session.error");
      await fixture.upstreamClosed;
      expect(outcomes.mock.calls).toEqual([]);
      expect(routing.getCodexUpstreamHealth("pool-a")).toEqual(before);
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
  test("invalid live answer books the upstream 200 while the client gets 502", async () => {
    fixture = createFixture({ answer: "invalid" });
    const outcomes = spyOn(routing, "recordCodexUpstreamOutcome");
    try {
      const response = await fetchOriginal(new URL("/v1/live", fixture.server.url), {
        method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ sdp: "v=0\r\n" }),
      });
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("invalid call answer");
      const accountId = fixture.creates[0]!.get("chatgpt-account-id") === "acct-b" ? "pool-b" : "pool-a";
      expect(outcomes.mock.calls.filter(call => call[1] === accountId).map(call => call[2])).toEqual([200]);
    } finally { outcomes.mockRestore(); }
  });
  test("alias registration failure books the upstream 200 while the client gets 503", async () => {
    fixture = createFixture({ answer: "ok200" });
    const outcomes = spyOn(routing, "recordCodexUpstreamOutcome");
    const create = spyOn(LiveCallBindings.prototype, "create").mockReturnValue(null);
    try {
      const response = await fetchOriginal(new URL("/v1/live", fixture.server.url), {
        method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ sdp: "v=0\r\n" }),
      });
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain("Live call could not be registered");
      expect(body).not.toContain("Live call capacity reached");
      const accountId = fixture.creates[0]!.get("chatgpt-account-id") === "acct-b" ? "pool-b" : "pool-a";
      expect(outcomes.mock.calls.filter(call => call[1] === accountId).map(call => call[2])).toEqual([200]);
    } finally { outcomes.mockRestore(); create.mockRestore(); }
  });
  test("missing reserved aliases never become legacy native joins", async () => {
    fixture = createFixture();
    const response = await fetchOriginal(new URL("/v1/live/rtc_ocx_expired", fixture.server.url), { headers: { upgrade: "websocket" } });
    expect(response.status).toBe(401);
    expect(fixture.handshakes).toHaveLength(0);
  });
});
