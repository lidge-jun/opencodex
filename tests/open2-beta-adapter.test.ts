import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  createOpen2BetaAdapter,
  mapOpen2Event,
  open2HasUnsupportedProxy,
  open2Messages,
  open2ReasoningEffort,
  requestOpen2Session,
  resetOpen2SessionCache,
} from "../src/adapters/open2-beta";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = {
  adapter: "open2-beta",
  baseUrl: "https://open2-beta.upstage.ai",
  reasoningEfforts: ["medium", "high", "max"],
  reasoningEffortMap: {
    none: "none",
    minimal: "medium",
    low: "medium",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "max",
  },
};

class FakeOpen2Socket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  terminated = false;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }

  emitFrame(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

function parsedRequest(): OcxParsedRequest {
  return {
    modelId: "solar-open2",
    stream: true,
    context: {
      systemPrompt: ["Be concise."],
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: "ok", isError: false, timestamp: 3 },
      ],
    },
    options: {},
  };
}

function sessionResponse(cookie: string, status = 200): Response {
  return new Response(JSON.stringify({ token: "csrf-token" }), {
    status,
    headers: cookie ? { "content-type": "application/json", "set-cookie": `solar_session=${cookie}; HttpOnly; Secure` } : undefined,
  });
}

async function runScriptedTurn(options: {
  script?: (socket: FakeOpen2Socket) => void;
  provider?: OcxProviderConfig;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  idleTimeoutMs?: number;
  hasOutboundProxy?: boolean;
  onFetch?: (init: RequestInit | undefined) => void;
} = {}): Promise<{ events: AdapterEvent[]; sockets: FakeOpen2Socket[] }> {
  resetOpen2SessionCache();
  const sockets: FakeOpen2Socket[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    options.onFetch?.(init);
    return sessionResponse("anonymous-session");
  }) as typeof fetch;
  const adapter = createOpen2BetaAdapter(options.provider ?? provider, {
    fetch: fetchImpl,
    createSocket: (_url, _protocol, _socketOptions) => {
      const socket = new FakeOpen2Socket();
      sockets.push(socket);
      if (options.script) queueMicrotask(() => options.script!(socket));
      return socket;
    },
    readyTimeoutMs: options.readyTimeoutMs ?? 30,
    idleTimeoutMs: options.idleTimeoutMs ?? 30,
    hasOutboundProxy: () => options.hasOutboundProxy ?? false,
  });
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(parsedRequest(), { headers: new Headers(), abortSignal: options.signal }, event => events.push(event));
  return { events, sockets };
}

describe("open2-beta adapter", () => {
  test("converts Codex history to Open2 user/assistant messages", () => {
    expect(open2Messages(parsedRequest())).toEqual([
      { role: "user", content: "[System]\nBe concise.\n\nhello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "[Tool result: shell]\nok" },
    ]);
  });

  test("maps text, thinking, usage, and completion events", () => {
    expect(mapOpen2Event({ type: "delta", content: "hello" })).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(mapOpen2Event({ type: "thinking_delta", content: "hmm" })).toEqual([{ type: "thinking_delta", thinking: "hmm" }]);
    expect(mapOpen2Event({
      type: "complete",
      data: {
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, cached_input_tokens: 3 },
        stop_reason: "complete",
      },
    })).toEqual([{
      type: "done",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 3 },
      stopReason: "complete",
      endTurn: true,
    }]);
  });

  test("normalizes Codex reasoning levels to the four Open2 beta choices", () => {
    const parsed = parsedRequest();
    expect(open2ReasoningEffort(parsed, provider)).toBe("medium");
    for (const [input, output] of [
      ["none", "none"],
      ["minimal", "medium"],
      ["low", "medium"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "high"],
      ["max", "max"],
    ] as const) {
      parsed.options.reasoning = input;
      expect(open2ReasoningEffort(parsed, provider)).toBe(output);
    }
  });

  test("rotates cached anonymous sessions and falls back to a fresh session", async () => {
    resetOpen2SessionCache();
    const seenCookies: Array<string | null> = [];
    let call = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenCookies.push(new Headers(init?.headers).get("cookie"));
      call += 1;
      if (call === 1) return sessionResponse("session-one");
      if (call === 2) return sessionResponse("", 401);
      return sessionResponse("session-two");
    }) as typeof fetch;

    expect(await requestOpen2Session(provider.baseUrl, undefined, fetchImpl)).toBe("session-one");
    expect(await requestOpen2Session(provider.baseUrl, undefined, fetchImpl)).toBe("session-two");
    expect(seenCookies).toEqual([null, "solar_session=session-one", null]);
  });

  test("never copies a configured API key into the anonymous HTTP or WebSocket session", async () => {
    let requestCookie: string | null = null;
    let socketCookie = "";
    const configured = { ...provider, apiKey: "upstage-api-secret" };
    resetOpen2SessionCache();
    const adapter = createOpen2BetaAdapter(configured, {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestCookie = new Headers(init?.headers).get("cookie");
        return sessionResponse("anonymous-only");
      }) as typeof fetch,
      createSocket: (_url, _protocol, socketOptions) => {
        socketCookie = socketOptions.headers.Cookie;
        const socket = new FakeOpen2Socket();
        queueMicrotask(() => {
          socket.emitFrame({ type: "ready", protocol: "solar-chat.v1" });
          socket.emitFrame({ type: "event", seq: 1, event: { type: "complete" } });
        });
        return socket;
      },
      hasOutboundProxy: () => false,
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsedRequest(), { headers: new Headers() }, event => events.push(event));

    expect(requestCookie).toBeNull();
    expect(socketCookie).toBe("solar_session=anonymous-only");
    expect(socketCookie).not.toContain("upstage-api-secret");
    expect(events.at(-1)?.type).toBe("done");
  });

  test("accumulates repeated standalone usage snapshots without double-counting", async () => {
    const { events } = await runScriptedTurn({
      script: socket => {
        socket.emitFrame({ type: "ready", protocol: "solar-chat.v1" });
        const usage = { type: "usage", input_tokens: 10, output_tokens: 4, total_tokens: 14, cached_input_tokens: 3, reasoning_tokens: 2 };
        socket.emitFrame({ type: "event", seq: 1, event: usage });
        socket.emitFrame({ type: "event", seq: 2, event: usage });
        socket.emitFrame({
          type: "event",
          seq: 3,
          event: { type: "complete", data: { usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } },
        });
      },
    });

    expect(events.at(-1)).toEqual({
      type: "done",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cachedInputTokens: 3,
        reasoningOutputTokens: 2,
      },
      stopReason: undefined,
      endTurn: true,
    });
  });

  test("rejects an incompatible ready protocol", async () => {
    const { events, sockets } = await runScriptedTurn({
      script: socket => socket.emitFrame({ type: "ready", protocol: "wrong" }),
    });
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("incompatible") });
    expect(sockets[0]?.terminated).toBe(true);
  });

  test("fails closed on a WebSocket sequence gap", async () => {
    const { events, sockets } = await runScriptedTurn({
      script: socket => {
        socket.emitFrame({ type: "ready", protocol: "solar-chat.v1" });
        socket.emitFrame({ type: "event", seq: 2, event: { type: "delta", content: "late" } });
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("sequence gap") });
    expect(sockets[0]?.terminated).toBe(true);
  });

  test("sends cancel and terminates when the caller aborts", async () => {
    const controller = new AbortController();
    const { events, sockets } = await runScriptedTurn({
      signal: controller.signal,
      script: socket => {
        socket.emitFrame({ type: "ready", protocol: "solar-chat.v1" });
        controller.abort();
      },
    });
    expect(sockets[0]?.sent.map(message => JSON.parse(message).type)).toContain("cancel");
    expect(sockets[0]?.terminated).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("aborted") });
  });

  test("times out before ready and after an idle ready handshake", async () => {
    const beforeReady = await runScriptedTurn({ readyTimeoutMs: 5, idleTimeoutMs: 50 });
    expect(beforeReady.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("did not become ready"),
      retryable: true,
    });
    expect(beforeReady.sockets[0]?.terminated).toBe(true);

    const afterReady = await runScriptedTurn({
      readyTimeoutMs: 50,
      idleTimeoutMs: 5,
      script: socket => socket.emitFrame({ type: "ready", protocol: "solar-chat.v1" }),
    });
    expect(afterReady.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("went idle"),
      retryable: true,
    });
    expect(afterReady.sockets[0]?.terminated).toBe(true);
  });

  test("fails closed when an outbound proxy would be bypassed", async () => {
    const { events, sockets } = await runScriptedTurn({ hasOutboundProxy: true });
    expect(sockets).toHaveLength(0);
    expect(events).toEqual([{
      type: "error",
      message: expect.stringContaining("outbound proxy"),
    }]);
    expect(open2HasUnsupportedProxy(new URL("wss://open2-beta.upstage.ai/api/agent/chat/ws"), {
      HTTPS_PROXY: "http://proxy.invalid:8080",
    })).toBe(true);
    expect(open2HasUnsupportedProxy(new URL("wss://open2-beta.upstage.ai/api/agent/chat/ws"), {
      HTTPS_PROXY: "http://proxy.invalid:8080",
      NO_PROXY: ".upstage.ai",
    })).toBe(false);
  });
});
