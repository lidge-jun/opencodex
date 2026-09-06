import { afterEach, beforeEach, expect, test } from "bun:test";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { CodexWsPool, codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";

const URL = "https://chatgpt.com/backend-api/codex/responses";
const realWebSocket = globalThis.WebSocket;
const proxyEnvKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxyEnv: Record<string, string | undefined>;
let sequence = 0;

class Socket extends EventTarget {
  static all: Socket[] = [];
  static onSend: (socket: Socket, frame: Record<string, unknown>) => void = (socket) => socket.complete();
  readyState = 0;
  frames: Record<string, unknown>[] = [];
  constructor(readonly url: string, readonly options?: { proxy?: string }) {
    super();
    Socket.all.push(this);
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event("open")); } });
  }
  send(text: string) {
    const frame = JSON.parse(text);
    this.frames.push(frame);
    Socket.onSend(this, frame);
  }
  emit(payload: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
  complete() {
    const id = `response-${++sequence}`;
    queueMicrotask(() => {
      this.emit({ type: "response.created", response: { id } });
      this.emit({ type: "response.completed", response: { id, status: "completed", output: [] } });
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  ref() {}
  unref() {}
}

function init(input = "first", signal?: AbortSignal): RequestInit {
  return { method: "POST", signal, headers: {
    authorization: "Bearer fixture-token", "chatgpt-account-id": "fixture-account", "thread-id": "fixture-thread",
  }, body: JSON.stringify({ model: "fixture-model", stream: true, input,
    client_metadata: { thread_id: "fixture-thread", turn_id: "fixture-turn" } }) };
}

const fallback = (async () => { throw new Error("unexpected HTTP fallback"); }) as typeof fetch;
const request = (options = init(), guard?: (headers: Headers) => void) =>
  codexWsUpstreamFetch(URL, options, fallback, "1.4.0", undefined, guard);
const drain = async (options = init()) => (await request(options)).text();
function bodyWith(fields: Record<string, unknown>) {
  const options = init();
  options.body = JSON.stringify({ ...JSON.parse(options.body as string), ...fields });
  return options;
}
beforeEach(() => {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  savedProxyEnv = Object.fromEntries(proxyEnvKeys.map(key => [key, process.env[key]]));
  for (const key of proxyEnvKeys) delete process.env[key];
});

afterEach(() => {
  runOptionalShutdownHooks();
  for (const socket of Socket.all) socket.close();
  Socket.all = [];
  Socket.onSend = socket => socket.complete();
  sequence = 0;
  globalThis.WebSocket = realWebSocket;
  for (const key of proxyEnvKeys) delete process.env[key];
  for (const key of proxyEnvKeys) {
    if (savedProxyEnv[key] !== undefined) process.env[key] = savedProxyEnv[key];
  }
});

test("proxy changes and NO_PROXY retire the old route while unchanged routes reuse", async () => {
  for (const proxy of ["http://proxy-a.example:8080", "http://proxy-b.example:8080"]) {
    process.env.HTTPS_PROXY = proxy;
    await drain();
    await drain();
  }
  process.env.NO_PROXY = "chatgpt.com:443";
  await drain();
  await drain();
  expect(Socket.all.map(socket => socket.options?.proxy))
    .toEqual(["http://proxy-a.example:8080", "http://proxy-b.example:8080", undefined]);
  expect(Socket.all.map(socket => socket.frames.length)).toEqual([2, 2, 2]);
  expect(Socket.all.map(socket => socket.readyState)).toEqual([3, 3, 1]);
});

test("same account/thread/turn reuses one socket without trimming either HTTP input", async () => {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  await (await codexWsUpstreamFetch(URL, init("first full input"), fallback, "1.4.0")).text();
  await (await codexWsUpstreamFetch(URL, init("second full input"), fallback, "1.4.0")).text();
  expect(Socket.all).toHaveLength(1);
  expect(Socket.all[0]!.frames.map(frame => frame.input)).toEqual(["first full input", "second full input"]);
  expect(Socket.all[0]!.frames.every(frame => !Object.hasOwn(frame, "previous_response_id"))).toBe(true);
});

test.each(["authorization", "chatgpt-account-id", "originator", "x-client-request-id", "x-custom-policy"])(
  "changed selected %s cannot reuse an immutable handshake", async name => {
    await drain();
    const options = init();
    const headers = new Headers(options.headers);
    headers.set(name, name === "authorization" ? "Bearer rotated-token" : "different");
    await drain({ ...options, headers });
    expect(Socket.all).toHaveLength(2);
  });

test.each([
  { model: "another-model" }, { service_tier: "priority" },
  { client_metadata: { thread_id: "other-thread", turn_id: "fixture-turn" } },
  { client_metadata: { thread_id: "fixture-thread", turn_id: "other-turn" } },
])("model, tier or native scope changes redial: %j", async fields => {
  await drain();
  await drain(bodyWith(fields));
  expect(Socket.all).toHaveLength(2);
});

test.each([
  { client_metadata: {} }, { client_metadata: { session_id: "shared", turn_id: "turn" }, },
  { client_metadata: { thread_id: "fixture-thread", turn_id: "" } },
  { previous_response_id: "server-owned-id" }, { stream_id: "main" },
  { generate: false }, { background: true },
])("ineligible requests stay one-shot: %j", async fields => {
  const options = bodyWith(fields);
  // session-only fixture must not accidentally inherit the explicit header thread.
  if (Object.hasOwn((fields.client_metadata ?? {}) as object, "session_id")) {
    const headers = new Headers(options.headers); headers.delete("thread-id"); options.headers = headers;
  }
  await drain(options); await drain(options);
  expect(Socket.all).toHaveLength(2);
  expect(codexWsPool.snapshot()).toEqual({ size: 0, active: 0, timer: false });
});

test("mutable turn headers are projected per frame; explicit body values win", async () => {
  for (const state of ["state-a", "state-b"]) {
    const options = init(); const headers = new Headers(options.headers);
    headers.set("x-codex-turn-state", state);
    headers.set("x-codex-turn-metadata", JSON.stringify({ turn: state }));
    await drain({ ...options, headers });
  }
  expect(Socket.all).toHaveLength(1);
  expect(Socket.all[0]!.frames.map(frame => (frame.client_metadata as Record<string, string>)["x-codex-turn-state"]))
    .toEqual(["state-a", "state-b"]);
  expect((Socket.all[0]!.frames[1]!.client_metadata as Record<string, string>)["x-codex-turn-metadata"])
    .toBe('{"turn":"state-b"}');
  const options = bodyWith({ client_metadata: { "x-codex-turn-state": "body-state" } });
  const headers = new Headers(options.headers); headers.set("x-codex-turn-state", "header-state");
  const prepared = prepareCodexWsRequest(URL, { ...options, headers })!;
  expect(JSON.parse(prepared.frameText).client_metadata["x-codex-turn-state"]).toBe("body-state");
});

test("fresh warm dispatch guard refusal never sends or falls back", async () => {
  await drain();
  let checks = 0;
  await expect(request(init(), () => { if (++checks === 2) throw new Error("revoked"); })).rejects.toThrow("revoked");
  expect(checks).toBe(2);
  expect(Socket.all).toHaveLength(1);
  expect(Socket.all[0]!.frames).toHaveLength(1);
  expect(codexWsPool.snapshot().size).toBe(0);
});

test("busy identity gets an independent one-shot; old abort cannot kill successor", async () => {
  const old = new AbortController();
  await drain(init("A", old.signal));
  Socket.onSend = socket => queueMicrotask(() => socket.emit({ type: "response.created", response: { id: `active-${Socket.all.indexOf(socket)}` } }));
  const b = await request(init("B"));
  const c = await request(init("C"));
  expect(Socket.all).toHaveLength(2);
  expect(Socket.all[0]!.frames.map(frame => frame.input)).toEqual(["A", "B"]);
  old.abort();
  expect(Socket.all[0]!.readyState).toBe(1);
  for (const [index, socket] of Socket.all.entries()) socket.emit({ type: "response.completed", response: { id: `active-${index}`, status: "completed" } });
  await b.text(); await c.text();
  expect(Socket.all[0]!.readyState).toBe(1);
  expect(Socket.all[1]!.readyState).toBe(3);
});

test("overlapping A to changed-header B to A keeps retired busy sockets tracked until release", async () => {
  Socket.onSend = () => {};
  const changed = init("B");
  const headers = new Headers(changed.headers);
  headers.set("x-custom-policy", "B");
  const pending = [request(init("A")), request({ ...changed, headers }), request(init("A-again"))];
  await Promise.resolve();
  expect(Socket.all).toHaveLength(3);
  expect(codexWsPool.snapshot()).toEqual({ size: 2, active: 2, timer: false });
  expect(Socket.all.map(socket => socket.frames.map(frame => frame.input)))
    .toEqual([["A"], ["B"], ["A-again"]]);
  Socket.all[0]!.complete();
  await (await pending[0]!).text();
  expect(Socket.all[0]!.readyState).toBe(3);
  expect(codexWsPool.snapshot()).toEqual({ size: 1, active: 1, timer: false });
  Socket.all[1]!.complete(); Socket.all[2]!.complete();
  await Promise.all(pending.slice(1).map(async result => (await result).text()));
  expect(Socket.all.every(socket => socket.readyState === 3)).toBe(true);
  expect(codexWsPool.snapshot()).toEqual({ size: 0, active: 0, timer: false });
});

test.each(["abort", "error", "close", "shutdown", "stale-item", "stale-response", "named-lane"])(
  "warm %s fails its body without a resend", async reason => {
    await drain();
    Socket.onSend = socket => queueMicrotask(() => socket.emit({ type: "response.created", response: { id: "new-response" } }));
    const abort = new AbortController();
    const response = await request(init("B", abort.signal));
    const socket = Socket.all[0]!;
    if (reason === "abort") abort.abort();
    if (reason === "error") socket.dispatchEvent(new Event("error"));
    if (reason === "close") socket.close();
    if (reason === "shutdown") runOptionalShutdownHooks();
    if (reason === "stale-item") socket.emit({ type: "response.output_text.delta", item_id: "old-item", delta: "MUST NOT RELAY" });
    if (reason === "stale-response") socket.emit({ type: "response.completed", response: { id: "response-1", status: "completed" } });
    if (reason === "named-lane") socket.emit({ type: "response.output_text.delta", stream_id: "other", delta: "MUST NOT RELAY" });
    await expect(response.text()).rejects.toThrow();
    expect(Socket.all).toHaveLength(1);
    expect(socket.frames).toHaveLength(2);
    expect(codexWsPool.snapshot()).toEqual({ size: 0, active: 0, timer: false });
  });

test("idle unsolicited data retires the socket before another request", async () => {
  await drain();
  Socket.all[0]!.emit({ type: "response.created", response: { id: "unsolicited" } });
  await drain();
  expect(Socket.all).toHaveLength(2);
});

test("uncorrelatable legacy response remains usable but never retained", async () => {
  Socket.onSend = socket => queueMicrotask(() => socket.emit({ type: "response.completed", response: { status: "completed" } }));
  expect(await drain()).toContain("response.completed");
  expect(await drain()).toContain("response.completed");
  expect(Socket.all).toHaveLength(2);
  expect(codexWsPool.snapshot().timer).toBe(false);
});

test("bounded pool expires idle state, preserves active work, and drains on shutdown", async () => {
  let now = 0;
  const pool = new CodexWsPool({ now: () => now, idleMs: 30_000, maxAgeMs: 300_000, maxSessions: 2 });
  try {
    expect(pool.snapshot()).toEqual({ size: 0, active: 0, timer: false });
    const a = pool.acquire({ key: "a", scope: "a" }, "wss://fixture", {})!;
    await Promise.resolve(); a.release("a-response");
    now = 29_999; pool.sweep(); expect(a.closed).toBe(false);
    now = 30_000; pool.sweep(); expect(a.closed).toBe(true);
    const b = pool.acquire({ key: "b", scope: "b" }, "wss://fixture", {})!;
    await Promise.resolve();
    now = 330_000; pool.sweep(); expect(b.closed).toBe(false);
    b.release("b-response"); expect(b.closed).toBe(true);
    const c = pool.acquire({ key: "c", scope: "c" }, "wss://fixture", {})!;
    const d = pool.acquire({ key: "d", scope: "d" }, "wss://fixture", {})!;
    expect(pool.acquire({ key: "e", scope: "e" }, "wss://fixture", {})).toBeNull();
    await Promise.resolve(); c.release("c-response");
    const e = pool.acquire({ key: "e", scope: "e" }, "wss://fixture", {})!;
    expect(c.closed).toBe(true); expect(d.closed).toBe(false);
    pool.dispose(); expect(d.closed).toBe(true); expect(e.closed).toBe(true);
    expect(pool.snapshot()).toEqual({ size: 0, active: 0, timer: false });
  } finally { pool.dispose(); }
});

test("shutdown before open rejects as cancellation, not fallback", async () => {
  const response = request();
  runOptionalShutdownHooks();
  await expect(response).rejects.toMatchObject({ name: "AbortError" });
  expect(Socket.all[0]!.frames).toHaveLength(0);
});

test("quota prelude and callbacks belong to each warm exchange, not its predecessor", async () => {
  let turn = 0;
  Socket.onSend = socket => queueMicrotask(() => {
    const id = `quota-${++turn}`;
    socket.emit({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: turn, window_minutes: 300 } } });
    socket.emit({ type: "response.created", response: { id } });
    socket.emit({ type: "response.completed", response: { id, status: "completed" } });
  });
  const observed: string[][] = [[], []];
  for (let index = 0; index < 2; index++) {
    const response = await codexWsUpstreamFetch(URL, init(), fallback, "1.4.0", headers => {
      observed[index]!.push(headers.get("x-codex-primary-used-percent")!);
    });
    expect(response.headers.get("x-codex-primary-used-percent")).toBe(String(index + 1));
    await response.text();
  }
  expect(Socket.all).toHaveLength(1);
  expect(observed).toEqual([["1"], ["2"]]);
});

test("retirement bounds remembered response IDs and keeps all full requests intact", async () => {
  for (let index = 0; index < 33; index++) await drain(init(`full-${index}`));
  expect(Socket.all).toHaveLength(2);
  expect(Socket.all[0]!.frames).toHaveLength(32);
  expect(Socket.all[0]!.readyState).toBe(3);
  expect(Socket.all[1]!.frames[0]!.input).toBe("full-32");
});

test("a Lite mode change retires the old handshake", async () => {
  for (const lite of ["true", "false"]) {
    const options = init(); const headers = new Headers(options.headers);
    headers.set("x-openai-internal-codex-responses-lite", lite);
    await drain({ ...options, headers });
  }
  expect(Socket.all).toHaveLength(2);
  expect(Socket.all[0]!.readyState).toBe(3);
});
