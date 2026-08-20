import { afterEach, describe, expect, jest, test } from "bun:test";
import { providerFetch } from "../src/server/responses/fetch-helpers";
import { handleResponses } from "../src/server/responses";
import { isEagerRelaySseResponse } from "../src/server/relay";
import { isWin32EagerRewrite } from "../src/lib/bun-stream-caps";
import {
  bunSupportsBoundedCodexWsRelay,
  codexWsUpstreamFetch as rawCodexWsUpstreamFetch,
  currentBunRuntimeIdentity,
  isCodexWsUpstreamResponse,
  MAX_CODEX_WS_FRAME_BYTES,
  MAX_CODEX_WS_QUEUE_BYTES,
  shouldUseCodexWsUpstream as rawShouldUseCodexWsUpstream,
} from "../src/server/responses/ws-upstream";
import type { OcxProviderConfig } from "../src/types";
import type { OcxConfig } from "../src/types";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const BOUNDED_WS_RUNTIME = "1.4.0";

// #864 keeps win32 rewrite traffic out of the tee()+JS-pull chain, so
// `isWin32EagerRewrite(platform, needsClientRewrite)` sends it through the eager
// single-reader relay instead. Since the annotations backfill became an
// unconditional block rewrite (5a75e57f, `createResponsesFieldBackfillBlockRewrite()`),
// `needsClientRewrite` is true for every Responses stream — so on win32 the eager
// relay marker is set no matter which upstream transport was chosen. Cases below
// that are about *not* taking the WebSocket path assert that directly through
// `FakeWebSocket.instances`; they hold the marker to this rule rather than to a
// constant that only held before the backfill landed.
const EAGER_RELAY_FORCED_BY_PLATFORM = isWin32EagerRewrite(process.platform, true);

function shouldUseCodexWsUpstream(url: string, init?: RequestInit): boolean {
  return rawShouldUseCodexWsUpstream(url, init, BOUNDED_WS_RUNTIME);
}

function codexWsUpstreamFetch(
  url: string,
  init: RequestInit,
  fallback: typeof fetch,
): Promise<Response> {
  return rawCodexWsUpstreamFetch(url, init, fallback, BOUNDED_WS_RUNTIME);
}

function streamingInit(body: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, ...body }),
  };
}

describe("shouldUseCodexWsUpstream", () => {
  test("uses HTTP SSE on runtimes without a bounded response sink", async () => {
    expect(bunSupportsBoundedCodexWsRelay("1.3.14")).toBe(false);
    expect(bunSupportsBoundedCodexWsRelay("1.4.0-canary.1")).toBe(false);
    expect(bunSupportsBoundedCodexWsRelay("garbage")).toBe(false);
    expect(bunSupportsBoundedCodexWsRelay("1.4.0")).toBe(true);
    expect(bunSupportsBoundedCodexWsRelay("1.5.0")).toBe(true);
    expect(bunSupportsBoundedCodexWsRelay({
      version: "1.4.0",
      versionWithSha: "v1.4.0 (0123abcd)",
    })).toBe(true);
    expect(bunSupportsBoundedCodexWsRelay({
      version: "1.4.0",
      versionWithSha: "v1.4.0-canary.1 (0123abcd)",
    })).toBe(false);
    expect(bunSupportsBoundedCodexWsRelay({
      version: "1.4.0",
      versionWithSha: "v1.5.0 (0123abcd)",
    })).toBe(false);
    expect(bunSupportsBoundedCodexWsRelay({
      version: "1.4.0",
      versionWithSha: "malformed",
    })).toBe(false);
    expect(bunSupportsBoundedCodexWsRelay()).toBe(
      bunSupportsBoundedCodexWsRelay(currentBunRuntimeIdentity()),
    );
    if (Bun.version_with_sha.includes("-")) {
      expect(bunSupportsBoundedCodexWsRelay()).toBe(false);
    }
    expect(rawShouldUseCodexWsUpstream(CODEX_URL, streamingInit(), "1.3.14")).toBe(false);

    const sentinel = new Response("http-sse");
    const response = await rawCodexWsUpstreamFetch(
      CODEX_URL,
      streamingInit(),
      (async () => sentinel) as typeof fetch,
      "1.3.14",
    );
    expect(response).toBe(sentinel);
    expect(FakeWebSocket.instances).toHaveLength(0);

    const canarySentinel = new Response("canary-http-sse");
    const canaryResponse = await rawCodexWsUpstreamFetch(
      CODEX_URL,
      streamingInit(),
      (async () => canarySentinel) as typeof fetch,
      { version: "1.4.0", versionWithSha: "v1.4.0-canary.1 (0123abcd)" },
    );
    expect(canaryResponse).toBe(canarySentinel);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

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
const RealFetch = globalThis.fetch;

afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
  globalThis.fetch = RealFetch;
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
});

function installFake(script: (ws: FakeWebSocket) => void) {
  FakeWebSocket.script = script;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

describe("providerFetch routing", () => {
  test("a canary runtime identity cannot open the WS transport", async () => {
    const sentinel = new Response("base");
    let baseCalls = 0;
    const provider = {
      fetch: (async () => {
        baseCalls += 1;
        return sentinel;
      }) as typeof fetch,
    } as OcxProviderConfig;
    const wrapped = providerFetch(provider, {
      version: "1.4.0",
      versionWithSha: "v1.4.0-canary.1 (0123abcd)",
    });

    expect(await wrapped(CODEX_URL, streamingInit())).toBe(sentinel);
    expect(baseCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

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
    const wrapped = providerFetch(provider, BOUNDED_WS_RUNTIME);

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

describe("handleResponses Codex WS relay selection", () => {
  function forwardConfig(): OcxConfig {
    return {
      port: 0,
      defaultProvider: "openai",
      streamMode: "legacy-tee",
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

  function request(): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "hello", stream: true }),
    });
  }

  test("a successful WS upgrade bypasses the configured legacy tee path", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", {
        data: JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [] } }),
      });
    });

    const response = await handleResponses(request(), forwardConfig(), { model: "", provider: "" }, {
      codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    });

    expect(response.status).toBe(200);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(isEagerRelaySseResponse(response)).toBe(true);
    const text = await response.text();
    expect(text).toContain("response.completed");
    expect(text).toContain("data: [DONE]");
  });

  test("an HTTP fallback remains on the configured legacy tee path", async () => {
    installFake(ws => ws.close());
    globalThis.fetch = (async () => new Response(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "r-http", status: "completed", output: [] },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

    const response = await handleResponses(request(), forwardConfig(), { model: "", provider: "" }, {
      codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(isEagerRelaySseResponse(response)).toBe(EAGER_RELAY_FORCED_BY_PLATFORM);
    expect(await response.text()).toContain("response.completed");
  });

  test("a WS queue overflow fails closed through the bounded eager relay", async () => {
    const delta = "x".repeat(Math.floor(MAX_CODEX_WS_QUEUE_BYTES / 3));
    installFake(ws => {
      ws.emit("open", {});
      for (let index = 0; index < 4; index += 1) {
        ws.emit("message", {
          data: JSON.stringify({ type: "response.output_text.delta", delta, index }),
        });
      }
    });

    const logCtx = { model: "", provider: "" };
    const response = await handleResponses(request(), forwardConfig(), logCtx, {
      codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    });

    expect(isEagerRelaySseResponse(response)).toBe(true);
    const text = await response.text();
    expect(text).toContain("event: response.failed");
    expect(text).toContain("data: [DONE]");
    expect(logCtx.activeAttempt?.streamAborted).toBe(true);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  test.skipIf(bunSupportsBoundedCodexWsRelay())(
    "an older runtime stays on HTTP SSE without opening a WebSocket",
    async () => {
      globalThis.fetch = (async () => new Response(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: { id: "r-old", status: "completed", output: [] },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch;

      const response = await handleResponses(request(), forwardConfig(), { model: "", provider: "" });

      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(isEagerRelaySseResponse(response)).toBe(EAGER_RELAY_FORCED_BY_PLATFORM);
      expect(await response.text()).toContain("response.completed");
    },
  );

  // The two cases above assert the marker against `EAGER_RELAY_FORCED_BY_PLATFORM`,
  // which is only the right expectation while `needsClientRewrite` is genuinely
  // `true`. Rather than assert that through the rewrite factory — which would stay
  // green if `handleResponses` stopped registering it — this drives a real Responses
  // stream through the handler and reads the rewrite's own effect off the client
  // bytes. `createResponsesFieldBackfillBlockRewrite()` is the unconditional entry in
  // `blockRewrites`, so observing its transformation is what proves
  // `clientBlockRewrite !== undefined`, hence `needsClientRewrite === true`.
  test("the registered rewrite chain transforms the client stream, so needsClientRewrite is true", async () => {
    const upstreamEvent = {
      type: "response.completed",
      response: {
        id: "r-backfill",
        status: "completed",
        // Deliberately spec-non-compliant: `annotations` is required on
        // `output_text` and this upstream omits it. Only the backfill rewrite
        // puts it back.
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        }],
      },
    };
    globalThis.fetch = (async () => new Response(
      `event: response.completed\ndata: ${JSON.stringify(upstreamEvent)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

    const response = await handleResponses(request(), forwardConfig(), { model: "", provider: "" });
    const text = await response.text();

    const payload = text
      .split("\n")
      .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice("data: ".length)))
      .find(event => event.type === "response.completed");

    expect(payload).toBeDefined();
    // Absent on the wire, present to the client: the chain ran.
    expect(payload.response.output[0].content[0]).toHaveProperty("annotations");
    expect(payload.response.output[0].content[0].annotations).toEqual([]);

    // And with the chain proven non-empty, the marker is exactly the win32 rule.
    expect(isEagerRelaySseResponse(response)).toBe(EAGER_RELAY_FORCED_BY_PLATFORM);
  });
});

describe("isWin32EagerRewrite", () => {
  test("marks rewrite traffic on win32 only", () => {
    // #864 is a win32-only Bun sink defect, so the rule must not widen to other
    // platforms, and must not fire when there is nothing to rewrite.
    expect(isWin32EagerRewrite("win32", true)).toBe(true);
    expect(isWin32EagerRewrite("win32", false)).toBe(false);
    expect(isWin32EagerRewrite("darwin", true)).toBe(false);
    expect(isWin32EagerRewrite("linux", true)).toBe(false);

    expect(EAGER_RELAY_FORCED_BY_PLATFORM).toBe(process.platform === "win32");
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
    expect(isCodexWsUpstreamResponse(response)).toBe(true);
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

  test("relays an upstream error frame and closes the stream", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", {
        data: JSON.stringify({ type: "error", error: { message: "upstream refused the turn" } }),
      });
    });
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), (() => {
      throw new Error("fallback must not run after open");
    }) as unknown as typeof fetch);

    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).toContain("upstream refused the turn");
    expect(FakeWebSocket.instances[0].closed).toBe(true);
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
    expect(isCodexWsUpstreamResponse(response)).toBe(false);
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
      expect(isCodexWsUpstreamResponse(response)).toBe(false);
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
    expect(isCodexWsUpstreamResponse(response)).toBe(false);
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

  test("rejects an oversized upstream frame before parsing or enqueueing it", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: "x".repeat(MAX_CODEX_WS_FRAME_BYTES + 1) });
    });
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), (() => {
      throw new Error("fallback must not run after open");
    }) as unknown as typeof fetch);

    await expect(response.text()).rejects.toThrow("frame exceeds the response size limit");
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  test("rejects a raw frame whose SSE envelope would exceed the shared frame limit", async () => {
    const type = "response." + "x".repeat(64);
    const base = JSON.stringify({ type, padding: "" });
    const text = JSON.stringify({ type, padding: "x".repeat(MAX_CODEX_WS_FRAME_BYTES - base.length) });
    expect(new TextEncoder().encode(text).byteLength).toBe(MAX_CODEX_WS_FRAME_BYTES);
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: text });
    });
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), (() => {
      throw new Error("fallback must not run after open");
    }) as unknown as typeof fetch);

    await expect(response.text()).rejects.toThrow("frame exceeds the response size limit");
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  test("disconnects an upstream that fills the bounded response queue", async () => {
    const delta = "x".repeat(Math.floor(MAX_CODEX_WS_QUEUE_BYTES / 3));
    installFake(ws => {
      ws.emit("open", {});
      for (let index = 0; index < 4; index += 1) {
        ws.emit("message", {
          data: JSON.stringify({ type: "response.output_text.delta", delta, index }),
        });
      }
    });
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), (() => {
      throw new Error("fallback must not run after open");
    }) as unknown as typeof fetch);

    await expect(response.text()).rejects.toThrow("buffered queue limit");
    expect(FakeWebSocket.instances[0].closed).toBe(true);
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

  test("aborting after open preserves the caller's abort reason", async () => {
    installFake(ws => ws.emit("open", {}));
    const controller = new AbortController();
    const response = await codexWsUpstreamFetch(
      CODEX_URL,
      { ...streamingInit(), signal: controller.signal },
      (() => { throw new Error("fallback must not run"); }) as unknown as typeof fetch,
    );

    controller.abort(new Error("turn cancelled"));

    await expect(response.text()).rejects.toThrow("turn cancelled");
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });
});
