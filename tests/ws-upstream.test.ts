import { afterEach, describe, expect, jest, test } from "bun:test";
import { providerFetch } from "../src/server/responses/fetch-helpers";
import { codexWsUpstreamFetch, shouldUseCodexWsUpstream } from "../src/server/responses/ws-upstream";
import type { OcxProviderConfig } from "../src/types";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

function streamingInit(body: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, ...body }),
  };
}

describe("shouldUseCodexWsUpstream", () => {
  test("matches only streaming POSTs to the Codex backend", () => {
    expect(shouldUseCodexWsUpstream(CODEX_URL, streamingInit())).toBe(true);
    // Non-streaming turns keep HTTP: the WS path only speaks the event protocol.
    expect(shouldUseCodexWsUpstream(CODEX_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
    })).toBe(false);
    expect(shouldUseCodexWsUpstream(CODEX_URL, { method: "GET" })).toBe(false);
    expect(shouldUseCodexWsUpstream("https://api.openai.com/v1/responses", streamingInit())).toBe(false);
    // Body must be the adapter's serialized string, not a stream.
    expect(shouldUseCodexWsUpstream(CODEX_URL, { method: "POST", body: new Blob(["x"]) as unknown as string })).toBe(false);
  });

  test("requires a ROOT-level stream flag, not a serialized substring", () => {
    // Nested stream:true must not flip the transport.
    expect(shouldUseCodexWsUpstream(CODEX_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-luna", metadata: { stream: true } }),
    })).toBe(false);
    // Whitespace-formatted JSON still routes.
    expect(shouldUseCodexWsUpstream(CODEX_URL, {
      method: "POST",
      body: "{\n  \"model\": \"gpt-5.6-luna\",\n  \"stream\" : true\n}",
    })).toBe(true);
    // Non-boolean stream values stay on HTTP.
    expect(shouldUseCodexWsUpstream(CODEX_URL, {
      method: "POST",
      body: JSON.stringify({ stream: "true" }),
    })).toBe(false);
    // Malformed JSON stays on HTTP.
    expect(shouldUseCodexWsUpstream(CODEX_URL, { method: "POST", body: "{\"stream\":true" })).toBe(false);
  });
});

type Listener = (event: unknown) => void;

/** Minimal scriptable stand-in for Bun's WebSocket. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  url: string;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => FakeWebSocket.script(this));
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
}

const RealWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
});

function installFake(script: (ws: FakeWebSocket) => void) {
  FakeWebSocket.script = script;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

describe("providerFetch routing", () => {
  test("routes eligible Codex streaming turns to WS and everything else to the base fetch", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.completed", response: {} }) });
    });
    const baseCalls: string[] = [];
    const sentinel = new Response("base");
    const provider = {
      fetch: (async (input: unknown) => {
        baseCalls.push(String(input));
        return sentinel.clone();
      }) as unknown as typeof fetch,
    } as unknown as OcxProviderConfig;
    const wrapped = providerFetch(provider);

    // Eligible: WS adapter serves it, base fetch untouched.
    const wsResponse = await wrapped(CODEX_URL, streamingInit());
    expect(wsResponse.headers.get("content-type")).toContain("text/event-stream");
    expect(baseCalls).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Non-streaming body: base fetch.
    await wrapped(CODEX_URL, { method: "POST", body: JSON.stringify({ model: "m" }) });
    // Different host: base fetch.
    await wrapped("https://api.openai.com/v1/responses", streamingInit());
    // Request-object input: base fetch (WS path only handles string URLs).
    await wrapped(new Request(CODEX_URL, streamingInit() as RequestInit));
    expect(baseCalls).toHaveLength(3);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("codexWsUpstreamFetch", () => {
  test("relays event frames as an SSE response and sends one response.create frame", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "codex.rate_limits", limits: {} }) });
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      ws.emit("message", { data: JSON.stringify({ type: "response.output_text.delta", delta: "hi" }) });
      ws.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: "r1" } }) });
    });
    const fallback = () => { throw new Error("fallback must not run"); };
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback as unknown as typeof fetch);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    // WS-only frames are dropped so clients see the exact SSE surface they always got.
    expect(text).not.toContain("codex.rate_limits");
    expect(text).toContain("event: response.created");
    expect(text).toContain('data: {"type":"response.output_text.delta","delta":"hi"}');
    expect(text).toContain("event: response.completed");

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]) as Record<string, unknown>;
    expect(frame.type).toBe("response.create");
    // The HTTP-only stream flag must not reach the WS create frame.
    expect("stream" in frame).toBe(false);
    expect(ws.closed).toBe(true);
  });

  test("a request body with a top-level type field cannot override the frame discriminator", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.completed", response: {} }) });
    });
    await codexWsUpstreamFetch(CODEX_URL, streamingInit({ type: "evil.frame" }), (() => {
      throw new Error("fallback must not run");
    }) as unknown as typeof fetch);
    const frame = JSON.parse(FakeWebSocket.instances[0].sent[0]) as Record<string, unknown>;
    expect(frame.type).toBe("response.create");
  });

  test("falls back to the HTTP fetch when the upgrade is rejected before open", async () => {
    installFake(ws => ws.close());
    const sentinel = new Response("sse-fallback", { status: 429 });
    let fallbackCalls = 0;
    const fallback = (async () => {
      fallbackCalls += 1;
      return sentinel;
    }) as unknown as typeof fetch;
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback);
    // The real HTTP status must reach the existing refresh/rotation handlers.
    expect(response).toBe(sentinel);
    expect(fallbackCalls).toBe(1);
  });

  test("falls back to the HTTP fetch when the upgrade deadline elapses without open or close", async () => {
    jest.useFakeTimers();
    try {
      installFake(() => { /* handshake never settles */ });
      const sentinel = new Response("sse-timeout-fallback", { status: 200 });
      let fallbackCalls = 0;
      const fallback = (async () => {
        fallbackCalls += 1;
        return sentinel;
      }) as unknown as typeof fetch;

      const responsePromise = codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback);
      expect(FakeWebSocket.instances).toHaveLength(1);
      jest.advanceTimersByTime(10_000);
      const response = await responsePromise;

      expect(response).toBe(sentinel);
      expect(fallbackCalls).toBe(1);
      expect(FakeWebSocket.instances[0].closed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("falls back to the HTTP fetch when the frame send throws", async () => {
    installFake(ws => {
      ws.send = () => { throw new Error("socket write failed"); };
      ws.emit("open", {});
    });
    const sentinel = new Response("sse-after-send-failure", { status: 200 });
    let fallbackCalls = 0;
    const fallback = (async () => {
      fallbackCalls += 1;
      return sentinel;
    }) as unknown as typeof fetch;
    // The frame never left the client, so no upstream turn started and the SSE
    // resend is safe; a synthetic 200 with an errored body would bypass the
    // pre-stream HTTP error/refresh/failover machinery.
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback);
    expect(response).toBe(sentinel);
    expect(fallbackCalls).toBe(1);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  test("errors the stream when the socket drops before a Responses terminal event", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      ws.close();
    });
    const fallback = () => { throw new Error("fallback must not run after open"); };
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback as unknown as typeof fetch);
    // A clean EOF here would let a terminal-less stream reach clients:
    // relaySseWithFailedTail() only synthesizes response.failed when the body
    // read throws. The read must therefore reject, like a reset TCP socket.
    await expect(response.text()).rejects.toThrow("closed before a Responses terminal event");
  });

  test("a mid-stream drop surfaces as a synthesized failed terminal through the passthrough relay", async () => {
    const { relaySseWithFailedTail } = await import("../src/server/relay");
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      ws.emit("message", { data: JSON.stringify({ type: "response.output_text.delta", delta: "partial" }) });
      // Drop on a later tick: controller.error() discards chunks still queued,
      // so a synchronous close would erase frames a real client had already
      // received over the wire.
      setTimeout(() => ws.close(), 10);
    });
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), (() => {
      throw new Error("fallback must not run after open");
    }) as unknown as typeof fetch);
    const relayed = relaySseWithFailedTail(response.body!, new AbortController());
    const text = await new Response(relayed).text();
    expect(text).toContain("event: response.created");
    // The relay converts the erroring read into a failed terminal + [DONE], so
    // no client ever sees a terminal-less stream.
    expect(text).toContain("event: response.failed");
    expect(text).toContain("data: [DONE]");
  });

  test("preserves caller headers on the handshake without fabricating an originator", async () => {
    const seen: Record<string, string>[] = [];
    FakeWebSocket.script = ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.completed", response: {} }) });
    };
    class HeaderCapturingWebSocket extends FakeWebSocket {
      constructor(url: string, options?: { headers?: Record<string, string> }) {
        super(url);
        seen.push(options?.headers ?? {});
      }
    }
    globalThis.WebSocket = HeaderCapturingWebSocket as unknown as typeof WebSocket;
    const fallback = (() => { throw new Error("fallback must not run"); }) as unknown as typeof fetch;

    await codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback);
    // Without a caller originator none is invented: pool/forward traffic must
    // not impersonate Codex CLI (metadata-integrity contract).
    expect(seen[0].originator).toBeUndefined();
    expect(seen[0]["openai-beta"]).toContain("responses_websockets");
    expect(seen[0].authorization).toBe("Bearer test");
    // HTTP body-framing headers do not belong on a WS handshake.
    expect(seen[0]["content-type"]).toBeUndefined();

    // A genuine caller originator is forwarded verbatim.
    await codexWsUpstreamFetch(CODEX_URL, {
      ...streamingInit(),
      headers: { ...streamingInit().headers as Record<string, string>, originator: "codex_cli_rs" },
    }, fallback);
    expect(seen[1].originator).toBe("codex_cli_rs");
  });

  test("aborting before open rejects like an aborted fetch", async () => {
    installFake(() => { /* never opens */ });
    const controller = new AbortController();
    const promise = codexWsUpstreamFetch(CODEX_URL, { ...streamingInit(), signal: controller.signal }, (() => {
      throw new Error("fallback must not run");
    }) as unknown as typeof fetch);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });
});
