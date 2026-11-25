import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IncrementalPlan } from "../../src/server/responses/codex-ws-incremental";
import { readCodexWsAdvertisedMessageLimit } from "../../src/server/responses/codex-ws-metadata";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import type { NativeResponseControl } from "../../src/server/responses/native-response-control";
import { NativeSteeringError } from "../../src/server/responses/native-steering";
import { NativeInjectionChannel } from "../../src/server/responses/native-injection";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { CODEX_RESPONSES_HTTP_URL, prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";

const usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 };
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxyEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of proxyKeys) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
});

function request() {
  const init: RequestInit = {
    method: "POST", signal: AbortSignal.timeout(3000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model", stream: true, input: [] }),
  };
  return { init, prepared: prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, init)! };
}

type MetadataPlan = { before?: Record<string, string>; after?: Record<string, string> };
type EventPayload = { type: string; response?: { usage?: typeof usage }; headers?: Record<string, string> };

/** Real Bun upgrade and production exchange, with no credentials or provider traffic. */
async function withLoopback(
  headers: Record<string, string>,
  plan: (index: number) => MetadataPlan,
  run: (fixture: {
    next(hold?: boolean): Promise<{ response: Response; events: EventPayload[]; body: string }>;
    connections(): number;
    creates: Record<string, unknown>[];
    quotas: Headers[];
  }) => Promise<void>,
) {
  let connections = 0;
  let fallbacks = 0;
  const creates: Record<string, unknown>[] = [];
  const quotas: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { headers: new Headers(headers) })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open() { connections++; },
      message(ws, message) {
        creates.push(JSON.parse(String(message)));
        const { before, after } = plan(creates.length - 1);
        const id = `response-${creates.length}`;
        const send = (event: unknown) => ws.send(JSON.stringify(event));
        if (before) send({ type: "codex.response.metadata", headers: before });
        send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
        if (after) send({ type: "codex.response.metadata", headers: after });
        send({ type: "response.done", response: { id, status: "completed", output: [], usage } });
      },
    },
  });
  const session = new CodexWsSession(`ws://127.0.0.1:${server.port}`, request().prepared.headers, true);
  try {
    await run({
      connections: () => connections, creates, quotas,
      async next(hold = false) {
        expect(session.reserve()).toBe(true);
        const { init, prepared } = request();
        const response = await codexWsExchange({
          session, url: CODEX_RESPONSES_HTTP_URL, init, prepared, bunVersion: Bun.version,
          onQuota: value => quotas.push(value),
          ...(hold ? { preOutputRefusalHold: { maxMs: 1000, until: Date.now() + 1000 } } : {}),
          sseFallback: (async () => { fallbacks++; throw new Error("unexpected HTTP fallback"); }) as typeof fetch,
        });
        const body = await response.text();
        const events: EventPayload[] = body.split("\n").filter(line => line.startsWith("data: "))
          .map(line => JSON.parse(line.slice(6)));
        expect(response.status).toBe(200);
        expect(events.find(event => event.type === "response.completed")?.response?.usage).toEqual(usage);
        return { response, events, body };
      },
    });
    expect(fallbacks).toBe(0);
    expect(creates.every(frame => frame.type === "response.create")).toBe(true);
  } finally {
    session.dispose();
    await server.stop(true);
  }
}

test("upgrade-only reasoning inclusion survives both first and reused exchanges", async () => {
  await withLoopback({ "x-reasoning-included": "true" }, () => ({}), async fixture => {
    for (let index = 0; index < 2; index++) {
      const { response, events } = await fixture.next();
      expect(response.headers.get("x-reasoning-included")).toBe("true");
      expect(events.some(event => event.type === "codex.response.metadata")).toBe(false);
    }
    expect(fixture.connections()).toBe(1);
    expect(fixture.creates).toHaveLength(2);
  });
});

test.each(["before", "after", "absent"] as const)("%s metadata keeps the existing header commit boundary", async timing => {
  await withLoopback({}, () => timing === "absent" ? {} : { [timing]: { "x-reasoning-included": "true" } }, async fixture => {
    const { response, events } = await fixture.next();
    expect(response.headers.get("x-reasoning-included")).toBe(timing === "before" ? "true" : null);
    const metadata = events.filter(event => event.type === "codex.response.metadata");
    expect(metadata).toHaveLength(timing === "absent" ? 0 : 1);
    if (metadata.length) expect(metadata[0]?.headers?.["x-reasoning-included"]).toBe("true");
  });
});

test("per-response metadata overrides the upgrade default without contaminating socket reuse", async () => {
  await withLoopback({ "x-reasoning-included": "false" }, index => index === 0
    ? { before: { "x-reasoning-included": "true" } } : {}, async fixture => {
    const first = await fixture.next();
    const second = await fixture.next();
    expect(first.response.headers.get("x-reasoning-included")).toBe("true");
    expect(second.response.headers.get("x-reasoning-included")).toBe("false");
    expect(second.events.some(event => event.type === "codex.response.metadata")).toBe(false);
    expect(fixture.connections()).toBe(1);
  });
});

test("a refusal hold keeps the upgrade header frozen before late metadata", async () => {
  await withLoopback({ "x-reasoning-included": "true" }, () => ({ after: { "x-reasoning-included": "false" } }), async fixture => {
    const { response, events } = await fixture.next(true);
    expect(response.headers.get("x-reasoning-included")).toBe("true");
    expect(events.find(event => event.type === "codex.response.metadata")?.headers?.["x-reasoning-included"]).toBe("false");
  });
});

test("upgrade capture does not replay credentials, framing, or response-scoped headers", async () => {
  await withLoopback({
    "x-reasoning-included": "true", authorization: "fixture-secret", "set-cookie": "fixture-cookie=value",
    "x-request-id": "upgrade-request", "openai-model": "upgrade-model", "x-models-etag": "upgrade-catalog",
    "x-codex-turn-state": "upgrade-turn", "x-codex-primary-used-percent": "19", "x-codex-credits-balance": "7",
  }, () => ({}), async fixture => {
    const { response, body } = await fixture.next();
    expect(response.headers.get("x-reasoning-included")).toBe("true");
    for (const name of ["authorization", "set-cookie", "connection", "upgrade", "sec-websocket-accept", "content-length",
      "x-request-id", "openai-model", "x-models-etag", "x-codex-turn-state", "x-codex-primary-used-percent", "x-codex-credits-balance"]) {
      expect(response.headers.has(name)).toBe(false);
    }
    expect(body).not.toContain("fixture-secret");
    expect(body).not.toContain("fixture-cookie");
    expect(fixture.quotas).toHaveLength(0);
  });
});

test("an invalid 101 handshake cannot contaminate the HTTP fallback", async () => {
  const answered = new WeakSet<object>();
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      data(socket) {
        if (answered.has(socket)) return;
        answered.add(socket);
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
          + "Sec-WebSocket-Accept: invalid-fixture-accept\r\nx-reasoning-included: true\r\n\r\n");
      },
    },
  });
  const { init, prepared } = request();
  const session = new CodexWsSession(`ws://127.0.0.1:${listener.port}`, prepared.headers);
  let handshakes = 0;
  let fallbacks = 0;
  session.socket.addEventListener("handshake", () => { handshakes++; });
  const fallback = new Response("fallback-body", { headers: { "x-request-id": "http-fallback" } });
  try {
    expect(session.reserve()).toBe(true);
    const response = await codexWsExchange({
      session, url: CODEX_RESPONSES_HTTP_URL, init, prepared, bunVersion: Bun.version,
      sseFallback: (async () => { fallbacks++; return fallback; }) as typeof fetch,
    });
    expect(handshakes).toBe(1);
    expect(session.opened).toBe(false);
    expect(fallbacks).toBe(1);
    expect(response).toBe(fallback);
    expect(response.headers.has("x-reasoning-included")).toBe(false);
    expect(response.headers.get("x-request-id")).toBe("http-fallback");
    expect(await response.text()).toBe("fallback-body");
  } finally {
    session.dispose();
    listener.stop(true);
  }
});

/*
 * Upstream advertised WebSocket message ceiling (openai/codex ed7ca22bb6,
 * codex-rs/codex-api/src/endpoint/responses_websocket.rs:371-375 and :908-912 @5505daf388).
 *
 * Codex reads `x-codex-websocket-max-message-bytes` from the 101 response and sends a request
 * strictly larger than that over HTTP before uploading anything. The OpenCodex upstream dial does
 * the same: an oversized frame never leaves, and the turn takes the SSE path exactly once. Native
 * control has no SSE equivalent and is refused instead.
 */
const HEADER = "x-codex-websocket-max-message-bytes";
function sizedRequest(input: unknown[] = []) {
  const init: RequestInit = {
    method: "POST", signal: AbortSignal.timeout(3000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model", stream: true, input }),
  };
  return { init, prepared: prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, init)! };
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const handshake = (headers: [string, string][]) => ({ statusCode: 101, rawHeaders: headers.flat() });

describe("advertisement parsing", () => {
  test("one unsigned decimal is the limit, zero included", () => {
    expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, "1048576"]]))).toBe(1048576);
    expect(readCodexWsAdvertisedMessageLimit(handshake([["X-Codex-WebSocket-Max-Message-Bytes", " 64 "]]))).toBe(64);
    expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, "0"]]))).toBe(0);
  });

  test("Rust usize syntax: a plus sign and leading zeros are valid", () => {
    expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, "+7"]]))).toBe(7);
    expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, "000064"]]))).toBe(64);
    expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, "00000000000000000000"]]))).toBe(0);
    expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, "0000000000000000000000064"]]))).toBe(64);
    // Larger than any frame this process can build: it limits nothing.
    expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, "99999999999999999999"]]))).toBeUndefined();
  });

  test("anything else is no advertisement", () => {
    for (const value of ["", "abc", "-5", "1e3", "+", "++7", "1.5", "0x10"]) {
      expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, value]]))).toBeUndefined();
    }
    expect(readCodexWsAdvertisedMessageLimit(handshake([[HEADER, "10"], [HEADER, "20"]]))).toBeUndefined();
    expect(readCodexWsAdvertisedMessageLimit(handshake([["x-other", "10"]]))).toBeUndefined();
    expect(readCodexWsAdvertisedMessageLimit({ statusCode: 200, rawHeaders: [HEADER, "10"] })).toBeUndefined();
  });
});

type Reply = "complete" | "cache-miss" | "created" | "call";

/** Real Bun upgrade that advertises a ceiling; no credentials and no provider traffic. */
async function withAdvertisingServer(
  advertised: string | undefined,
  reply: (index: number) => Reply,
  run: (fixture: { session: CodexWsSession; frames: string[]; received: (count: number) => Promise<void> }) => Promise<void>,
) {
  const frames: string[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const received = (count: number) => frames.length >= count ? Promise.resolve()
    : new Promise<void>(resolve => { waiters.push({ count, resolve }); });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { headers: advertised === undefined ? {} : { [HEADER]: advertised } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, message) {
        frames.push(String(message));
        for (const waiter of waiters.splice(0)) {
          if (frames.length >= waiter.count) waiter.resolve(); else waiters.push(waiter);
        }
        const send = (event: unknown) => ws.send(JSON.stringify(event));
        if (reply(frames.length - 1) === "cache-miss") {
          send({ type: "error", error: { type: "invalid_request_error", code: "previous_response_not_found", message: "miss" } });
          return;
        }
        const id = `response-${frames.length}`;
        if (reply(frames.length - 1) === "call") {
          if (frames.length === 1) {
            send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
            for (const [index, call] of ["c", "d"].entries()) {
              const item = { id: `item-${call}`, type: "function_call", call_id: call, name: "fixture", arguments: "{}" };
              send({ type: "response.output_item.added", output_index: index, item });
              send({ type: "response.output_item.done", output_index: index, item });
            }
          }
          return;
        }
        if (reply(frames.length - 1) === "created") {
          if (frames.length === 1) send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
          return;
        }
        send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
        send({ type: "response.completed", response: { id, status: "completed", output: [], usage } });
      },
    },
  });
  const session = new CodexWsSession(`ws://127.0.0.1:${server.port}`, sizedRequest().prepared.headers, true);
  try {
    await run({ session, frames, received });
  } finally {
    session.dispose();
    await server.stop(true);
  }
}

type Counters = { fallbacks: number; dispatches: number; physical: number };

async function exchange(session: CodexWsSession, input: unknown[], counters: Counters, extra: {
  incrementalPlan?: IncrementalPlan; nativeControl?: NativeResponseControl;
} = {}) {
  expect(session.busy || session.reserve()).toBe(true);
  const { init, prepared } = sizedRequest(input);
  const fallback = new Response("fallback-body", { headers: { "content-type": "text/event-stream" } });
  const response = await codexWsExchange({
    session, url: CODEX_RESPONSES_HTTP_URL, init, bunVersion: Bun.version,
    prepared: extra.incrementalPlan ? { ...prepared, frameText: extra.incrementalPlan.frameText } : prepared,
    ...extra,
    beforeDispatch: () => { counters.dispatches++; },
    onPhysicalDispatch: () => { counters.physical++; },
    beforeContinuation: async () => {},
    sseFallback: (async () => { counters.fallbacks++; return fallback; }) as typeof fetch,
  });
  return { response, fallback, frameText: prepared.frameText };
}

const fresh = (): Counters => ({ fallbacks: 0, dispatches: 0, physical: 0 });

describe("fresh and retained connections", () => {
  test("a frame above the advertised limit never leaves and falls back once", async () => {
    await withAdvertisingServer("64", () => "complete", async ({ session, frames }) => {
      const counters = fresh();
      const { response, fallback } = await exchange(session, [{ role: "user", content: "x".repeat(200) }], counters);
      expect(response).toBe(fallback);
      expect(await response.text()).toBe("fallback-body");
      expect(frames).toHaveLength(0);
      expect(counters).toEqual({ fallbacks: 1, dispatches: 0, physical: 0 });
    });
  });

  test("the comparison is strict and counts UTF-8 bytes, not code units", async () => {
    const input = [{ role: "user", content: "한글 boundary" }];
    const frameText = sizedRequest(input).prepared.frameText;
    expect(bytes(frameText)).toBeGreaterThan(frameText.length);
    await withAdvertisingServer(String(bytes(frameText)), () => "complete", async ({ session, frames }) => {
      const counters = fresh();
      const { response } = await exchange(session, input, counters);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("response.completed");
      expect(frames).toEqual([frameText]);
      expect(counters).toEqual({ fallbacks: 0, dispatches: 1, physical: 1 });
    });
    await withAdvertisingServer(String(bytes(frameText) - 1), () => "complete", async ({ session, frames }) => {
      const counters = fresh();
      await exchange(session, input, counters);
      expect(frames).toHaveLength(0);
      expect(counters.fallbacks).toBe(1);
    });
  });

  test("an advertised zero refuses every frame; an invalid advertisement is ignored", async () => {
    await withAdvertisingServer("0", () => "complete", async ({ session, frames }) => {
      const counters = fresh();
      await exchange(session, [], counters);
      expect(frames).toHaveLength(0);
      expect(counters.fallbacks).toBe(1);
    });
    for (const value of ["abc", "-5", "1e3"]) {
      await withAdvertisingServer(value, () => "complete", async ({ session, frames }) => {
        const counters = fresh();
        const { response } = await exchange(session, [{ role: "user", content: "x".repeat(200) }], counters);
        expect(await response.text()).toContain("response.completed");
        expect(frames).toHaveLength(1);
        expect(counters.fallbacks).toBe(0);
      });
    }
  });

  test("a retained connection keeps applying the limit its handshake advertised", async () => {
    const small = [{ role: "user", content: "hi" }];
    const limit = bytes(sizedRequest(small).prepared.frameText) + 16;
    await withAdvertisingServer(String(limit), () => "complete", async ({ session, frames }) => {
      const counters = fresh();
      const first = await exchange(session, small, counters);
      expect(await first.response.text()).toContain("response.completed");
      expect(frames).toHaveLength(1);
      expect(session.closed).toBe(false);
      const second = await exchange(session, [{ role: "user", content: "x".repeat(limit) }], counters);
      expect(second.response).toBe(second.fallback);
      expect(frames).toHaveLength(1);
      expect(counters).toEqual({ fallbacks: 1, dispatches: 1, physical: 1 });
    });
  });
});

describe("stateful paths", () => {
  test("a fitting delta whose full recovery exceeds the limit falls back once without a second frame", async () => {
    const full = sizedRequest([{ role: "user", content: "x".repeat(400) }]).prepared.frameText;
    const delta = sizedRequest([{ role: "user", content: "d" }]).prepared.frameText;
    const limit = bytes(delta) + 32;
    expect(bytes(full)).toBeGreaterThan(limit);
    await withAdvertisingServer(String(limit), index => index === 0 ? "cache-miss" : "complete", async ({ session, frames }) => {
      const counters = fresh();
      const plan: IncrementalPlan = {
        session, caller: "fixture-caller", frameText: delta, fullFrameText: full, fullBytes: bytes(full),
        sentBytes: bytes(delta), delta: true, envelope: "fixture-envelope", items: [], retainable: false,
      };
      const { response, fallback } = await exchange(session, [{ role: "user", content: "x".repeat(400) }], counters, { incrementalPlan: plan });
      expect(response).toBe(fallback);
      expect(frames).toEqual([delta]);
      expect(counters.fallbacks).toBe(1);
      expect(counters.physical).toBe(1);
    });
  });

  test("an oversized native control frame is a typed refusal the channel can roll back", async () => {
    const opening = [{ role: "user", content: "hi" }];
    const limit = bytes(sizedRequest(opening).prepared.frameText) + 64;
    await withAdvertisingServer(String(limit), () => "created", async ({ session, frames, received }) => {
      let send: ((frame: Record<string, unknown>) => void) | undefined;
      const nativeControl = {
        kind: "injection",
        attach: (sender: (frame: Record<string, unknown>) => void) => { send = sender; return () => {}; },
        observe: () => false,
      } as unknown as NativeResponseControl;
      const { response } = await exchange(session, opening, fresh(), { nativeControl });
      expect(response.status).toBe(200);
      expect(frames).toHaveLength(1);
      const oversized = { type: "response.inject", response_id: "response-1", input: [{ type: "function_call_output", call_id: "c", output: "x".repeat(limit) }] };
      expect(() => send!(oversized)).toThrow(NativeSteeringError);
      expect(frames).toHaveLength(1);
      // The corrected frame still goes out on the same channel.
      send!({ type: "response.inject", response_id: "response-1", input: [{ type: "function_call_output", call_id: "c", output: "ok" }] });
      await received(2);
      expect(frames).toHaveLength(2);
      expect(JSON.parse(frames[1]!).input[0].output).toBe("ok");
    });
  });

  test("a real injection channel rolls an oversized result back and accepts the corrected one", async () => {
    const opening = [{ role: "user", content: "hi" }];
    const limit = bytes(sizedRequest(opening).prepared.frameText) + 256;
    await withAdvertisingServer(String(limit), () => "call", async ({ session, frames, received }) => {
      const channel = new NativeInjectionChannel({ type: "response.create", model: "fixture-model", multi_agent: { enabled: true } });
      const { response } = await exchange(session, opening, fresh(), { nativeControl: channel });
      expect(response.status).toBe(200);
      const body = response.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      // The call must be advertised on this response before a result for it can be injected.
      while ((seen.match(/response\.output_item\.done/g) ?? []).length < 2) {
        const chunk = await body.read();
        if (chunk.done) throw new Error("stream ended before the call was advertised");
        seen += decoder.decode(chunk.value, { stream: true });
      }
      expect(() => channel.inject({ type: "response.inject", response_id: "response-1",
        input: [{ type: "function_call_output", call_id: "c", output: "x".repeat(limit) }] })).toThrow(NativeSteeringError);
      expect(frames).toHaveLength(1);
      expect(channel.ended).toBe(false);
      channel.inject({ type: "response.inject", response_id: "response-1", input: [{ type: "function_call_output", call_id: "c", output: "ok" }] });
      await received(2);
      expect(JSON.parse(frames[1]!).input[0].output).toBe("ok");
      await body.cancel();
    });
  });

  test("an oversized injection queued behind an unacknowledged one is refused without failing the channel", async () => {
    const opening = [{ role: "user", content: "hi" }];
    const limit = bytes(sizedRequest(opening).prepared.frameText) + 256;
    await withAdvertisingServer(String(limit), () => "call", async ({ session, frames, received }) => {
      const channel = new NativeInjectionChannel({ type: "response.create", model: "fixture-model", multi_agent: { enabled: true } });
      const { response } = await exchange(session, opening, fresh(), { nativeControl: channel });
      const body = response.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      while ((seen.match(/response\.output_item\.done/g) ?? []).length < 2) {
        const chunk = await body.read();
        if (chunk.done) throw new Error("stream ended before both calls were advertised");
        seen += decoder.decode(chunk.value, { stream: true });
      }
      channel.inject({ type: "response.inject", response_id: "response-1", input: [{ type: "function_call_output", call_id: "c", output: "first" }] });
      await received(2);
      // The first result is still unacknowledged, so the second would queue. The refusal is synchronous.
      expect(() => channel.inject({ type: "response.inject", response_id: "response-1",
        input: [{ type: "function_call_output", call_id: "d", output: "x".repeat(limit) }] })).toThrow(NativeSteeringError);
      expect(channel.ended).toBe(false);
      expect(frames).toHaveLength(2);
      await body.cancel();
    });
  });

  test("native control above the limit is refused rather than degraded to plain SSE", async () => {
    await withAdvertisingServer("64", () => "complete", async ({ session, frames }) => {
      const counters = fresh();
      let attached = 0;
      const nativeControl = {
        kind: "steering",
        attach: () => { attached++; return () => {}; },
        observe: () => false,
      } as unknown as NativeResponseControl;
      await expect(exchange(session, [{ role: "user", content: "x".repeat(200) }], counters, { nativeControl }))
        .rejects.toThrow("advertised message limit");
      expect(attached).toBe(0);
      expect(frames).toHaveLength(0);
      expect(counters).toEqual({ fallbacks: 0, dispatches: 0, physical: 0 });
    });
  });
});

type Listener = (event: unknown) => void;

/** Scriptable stand-in for Bun's WebSocket, used only to reach the public upstream entry. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  sent: string[] = [];
  closed = false;
  readyState = 0;
  listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => FakeWebSocket.script(this));
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string) { this.sent.push(data); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }
}

test("the public upstream entry checks dispatch once before dialing and sends nothing past the advertisement", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = ws => {
    ws.emit("handshake", { data: handshake([[HEADER, "64"]]) });
    ws.readyState = 1;
    ws.emit("open", {});
  };
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    let fallbacks = 0;
    let dispatches = 0;
    let physical = 0;
    const fallback = new Response("fallback-body");
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-5.5", stream: true, input: [{ role: "user", content: "x".repeat(200) }] }),
    };
    const response = await codexWsUpstreamFetch(CODEX_RESPONSES_HTTP_URL, init,
      (async () => { fallbacks++; return fallback; }) as typeof fetch,
      "1.4.0", undefined, () => { dispatches++; }, undefined, undefined, () => { physical++; });
    expect(response).toBe(fallback);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.sent).toHaveLength(0);
    expect({ fallbacks, dispatches, physical }).toEqual({ fallbacks: 1, dispatches: 1, physical: 0 });
  } finally {
    globalThis.WebSocket = realWebSocket;
  }
});

