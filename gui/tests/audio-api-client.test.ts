import { afterEach, expect, test } from "bun:test";
import { AUDIO_FILE_MAX_BYTES, AudioApiError, LIVE_SESSION_UPDATE, audioSocketProtocols, connectLiveAudio, transcribeAudio } from "../src/audio-api-client";
import { resetApiAuthFetchForTests } from "../src/api";
import { isAudioApiInfo, type AudioApiInfo } from "../src/pages/api-keys-utils";
import { audioSocketExample, audioUploadExample } from "../src/audio-api-examples";

const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const KEY = "ocx_data_audio_client_fixture";
const ENDPOINT = "https://gateway.example/v1/audio/transcriptions";
afterEach(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; resetApiAuthFetchForTests(); });

test("upload sends multipart with only the typed data key and no cookies or redirects", async () => {
  resetApiAuthFetchForTests();
  let init!: RequestInit;
  globalThis.fetch = (async (_url, options) => { init = options!; return Response.json({ text: "fixture transcript" }); }) as typeof fetch;
  const text = await transcribeAudio(ENDPOINT, "gpt-4o-transcribe", KEY, new File(["synthetic"], "fixture.wav"), new AbortController().signal);
  expect(text).toBe("fixture transcript");
  expect([...new Headers(init.headers)]).toEqual([["x-opencodex-api-key", KEY]]);
  expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error");
  const body = init.body as FormData;
  expect(body.get("model")).toBe("gpt-4o-transcribe");
  expect(body.get("response_format")).toBe("json");
  expect((body.get("file") as File).name).toBe("fixture.wav");
});

test("invalid files stop before fetch and upstream errors never expose their body", async () => {
  resetApiAuthFetchForTests();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("private upstream detail", { status: 401 }); }) as typeof fetch;
  const file = new File(["fixture"], "fixture.wav");
  for (const size of [0, AUDIO_FILE_MAX_BYTES + 1]) {
    Object.defineProperty(file, "size", { configurable: true, value: size });
    await expect(transcribeAudio(ENDPOINT, "gpt-4o-transcribe", KEY, file, new AbortController().signal)).rejects.toMatchObject({ code: "size" });
  }
  expect(calls).toBe(0);
  Object.defineProperty(file, "size", { configurable: true, value: 7 });
  await expect(transcribeAudio(ENDPOINT, "gpt-4o-transcribe", KEY, file, new AbortController().signal)).rejects.toEqual(new AudioApiError("auth"));
});

test("upload cancellation aborts fetch and a locked response body", async () => {
  resetApiAuthFetchForTests();
  let responseCancelled = false;
  let uploadSignal: AbortSignal | undefined;
  let bodyStarted!: () => void;
  const started = new Promise<void>(resolve => { bodyStarted = resolve; });
  globalThis.fetch = (async (_url, init) => {
    uploadSignal = init!.signal!;
    return new Response(new ReadableStream({ start() { bodyStarted(); }, cancel() { responseCancelled = true; } }));
  }) as typeof fetch;
  const controller = new AbortController();
  const pending = transcribeAudio(ENDPOINT, "gpt-4o-transcribe", KEY, new File(["x"], "x.wav"), controller.signal);
  await started;
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  expect(uploadSignal!.aborted).toBe(true);
  expect(responseCancelled).toBe(true);
});

test("audio metadata accepts the exact scheme/origin/path projection only", () => {
  const base = "https://[2001:db8::1]:8443/v1";
  const audio: AudioApiInfo = {
    transcriptionEndpoint: `${base}/audio/transcriptions`, realtimeCallsEndpoint: `${base}/realtime/calls`,
    liveEndpoint: "wss://[2001:db8::1]:8443/v1/live", dictationStreamEndpoint: "wss://[2001:db8::1]:8443/v1/audio/transcriptions/stream",
    transcriptionModel: "gpt-4o-transcribe", liveModel: "gpt-live-1-codex",
    transcriptionConfigured: true, dictationConfigured: true, liveConfigured: true,
  };
  expect(isAudioApiInfo(audio, base)).toBe(true);
  for (const endpoint of ["ws://[2001:db8::1]:8443/v1/live", `${audio.liveEndpoint}?key=value`, `${audio.liveEndpoint}#fragment`, "wss://user:pass@[2001:db8::1]:8443/v1/live", "wss://other.example/v1/live", "wss://[2001:db8::1]:8443/v1/responses"]) {
    expect(isAudioApiInfo({ ...audio, liveEndpoint: endpoint }, base)).toBe(false);
  }
  expect(isAudioApiInfo(undefined, base)).toBe(false);
  expect(isAudioApiInfo({ ...audio, liveConfigured: "true" }, base)).toBe(false);
  expect(isAudioApiInfo({ ...audio, apiKey: "sensitive-marker" }, base)).toBe(false);
});

class FakeSocket {
  static OPEN = 1;
  static latest: FakeSocket;
  readyState = 0;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.latest = this; }
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

function probe(options: { readyTimeoutMs?: number; maxSessionMs?: number } = {}) {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const states: string[] = [];
  const events: string[] = [];
  const dispose = connectLiveAudio({ endpoint: "wss://gateway.example/v1/live", model: "gpt-live-1-codex", key: KEY,
    onState: (state, code) => states.push(code ? `${state}:${code}` : state), onEvent: event => events.push(event), ...options });
  return { socket: FakeSocket.latest, states, events, dispose };
}

test("voice waits for a nonterminal native session ID, then closes without audio", () => {
  const { socket, states, events, dispose } = probe();
  try {
    expect(socket.url).not.toContain(KEY);
    expect(socket.protocols).toEqual(audioSocketProtocols(KEY));
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual(LIVE_SESSION_UPDATE);
    expect(states).toEqual(["connecting"]);
    socket.message({ type: "session.started", session: { session_id: "dictation-not-live" } });
    expect(states).toEqual(["connecting"]);
    socket.message({ type: "session.started", session: { id: "fixture" }, secret: "never display" });
    expect(states).toEqual(["connecting", "connected"]);
    expect(events).toEqual(["session.started", "session.started"]);
  } finally { dispose(); }
  expect(socket.closed).toBe(true);
  expect(socket.onmessage).toBeNull();
  expect(socket.sent.map(value => JSON.parse(value).type)).toEqual(["session.update", "session.close"]);
});

test("terminal acknowledgments and protocol errors stay failed after a normal close", () => {
  for (const event of [{ type: "session.updated", session: { id: "fixture", status: "closed" } }, { type: "protocol.error", error: "sensitive" }]) {
    const { socket, states, dispose } = probe();
    socket.open();
    const oldClose = socket.onclose;
    socket.message(event);
    oldClose?.({ code: 1000 });
    expect(states).toEqual(["connecting", "failed:protocol"]);
    expect(socket.closed).toBe(true);
    dispose();
  }
});

test("voice readiness and established-session timers release all handlers", async () => {
  const pending = probe({ readyTimeoutMs: 5 });
  pending.socket.open();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(pending.states).toEqual(["connecting", "failed:timeout"]);
  expect(pending.socket.onmessage).toBeNull();
  const ready = probe({ maxSessionMs: 5 });
  ready.socket.open(); ready.socket.message({ type: "session.started", session: { id: "fixture" } });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(ready.states).toEqual(["connecting", "connected", "disconnected"]);
  expect(ready.socket.closed).toBe(true);
});

test("failed session updates remain failures even after readiness", () => {
  for (const status of ["error", "failed"]) {
    const { socket, states, dispose } = probe();
    socket.open(); socket.message({ type: "session.started", session: { id: "fixture" } });
    const oldClose = socket.onclose;
    socket.message({ type: "session.updated", session: { id: "fixture", status } });
    oldClose?.({ code: 1000 });
    expect(states).toEqual(["connecting", "connected", "failed:protocol"]);
    expect(socket.closed).toBe(true);
    dispose();
  }
});

test("copied socket examples are executable protocol code with a localized key prompt", () => {
  const example = audioSocketExample("wss://gateway.example/v1/live", true, "gpt-live-1-codex", "데이터 키");
  let label = "";
  const run = new Function("WebSocket", "prompt", "btoa", "TextEncoder", example + "; return ws;");
  const socket = run(FakeSocket, (value: string) => { label = value; return KEY; }, btoa, TextEncoder) as FakeSocket;
  expect(label).toBe("데이터 키");
  expect(socket.protocols).toEqual(audioSocketProtocols(KEY));
  socket.open();
  expect(JSON.parse(socket.sent[0]!)).toEqual(LIVE_SESSION_UPDATE);
  expect(audioUploadExample(ENDPOINT, "gpt-4o-transcribe")).toContain("$OPENCODEX_API_KEY");
  expect(audioUploadExample(ENDPOINT, "gpt-4o-transcribe")).not.toContain("\n+");
});
