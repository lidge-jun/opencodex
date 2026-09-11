import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  classifyCodexWsFailure,
  closedBeforeTerminalMessage,
  codexWsFailureDetail,
  type CodexWsFailureStage,
} from "../../src/server/responses/codex-ws-wire";
import {
  codexWsUpstreamFetch,
  CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS,
} from "../../src/server/responses/ws-upstream";

/**
 * #4191: a long Codex thread died only through the proxy, and every variant of
 * that death arrived as the same one-line message. The reporter could not tell
 * an unanswered socket from one that had already started replying, so the only
 * usable evidence in the whole report was an A/B toggle. These cases hold the
 * transport to naming the stage it failed at.
 */

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const BOUNDED_WS_RUNTIME = "1.4.0";

type Listener = (event: unknown) => void;

/** Minimal scriptable stand-in for Bun's WebSocket, mirroring `ws-upstream.test.ts`. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  url: string;
  sent: string[] = [];
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

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}
}

const RealWebSocket = globalThis.WebSocket;

function installFake(script: (ws: FakeWebSocket) => void) {
  FakeWebSocket.script = script;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

function streamingInit(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-5.5", stream: true }),
  };
}

function noFallback(): Promise<Response> {
  throw new Error("fallback must not run after open");
}

function stage(overrides: Partial<CodexWsFailureStage> = {}): CodexWsFailureStage {
  return {
    requestBytes: 812,
    sent: true,
    upstreamFrames: 0,
    controlFrames: 0,
    relayedEvents: 0,
    firstFrameMs: null,
    elapsedMs: 90_003,
    ...overrides,
  };
}

async function failureMessage(script: (ws: FakeWebSocket) => void): Promise<string> {
  installFake(script);
  const response = await codexWsUpstreamFetch(
    CODEX_URL,
    streamingInit(),
    noFallback as unknown as typeof fetch,
    BOUNDED_WS_RUNTIME,
  );
  try {
    await response.text();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the relayed body to fail");
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
});

afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
});

describe("codex WS failure classification", () => {
  test("separates the four stages a dead exchange can be in", () => {
    expect(classifyCodexWsFailure(stage({ sent: false, elapsedMs: null }))).toBe("before-send");
    expect(classifyCodexWsFailure(stage())).toBe("no-upstream-frame");
    // Quota control frames prove the upstream answered; they are not a response.
    expect(classifyCodexWsFailure(stage({ upstreamFrames: 3, controlFrames: 3 }))).toBe("no-response-event");
    expect(classifyCodexWsFailure(stage({ upstreamFrames: 9, controlFrames: 2, relayedEvents: 7 })))
      .toBe("after-response-started");
  });

  test("a frame that never left outranks the counters behind it", () => {
    // The send is what makes a turn possibly live upstream, so it is read first.
    expect(classifyCodexWsFailure(stage({ sent: false, upstreamFrames: 4, relayedEvents: 2 })))
      .toBe("before-send");
  });

  test("renders every field, with n/a for the durations that do not exist yet", () => {
    expect(codexWsFailureDetail(stage({ upstreamFrames: 2, controlFrames: 2, firstFrameMs: 41 }))).toBe(
      " [cause=no-response-event request=812B sent=yes frames=2 control=2 relayed=0"
      + " first-frame=41ms elapsed=90003ms]",
    );
    expect(codexWsFailureDetail(stage({ sent: false, elapsedMs: null }))).toBe(
      " [cause=before-send request=812B sent=no frames=0 control=0 relayed=0"
      + " first-frame=n/a elapsed=n/a]",
    );
  });
});

describe("closedBeforeTerminalMessage", () => {
  test("keeps the close code contiguous and appends the stage last", () => {
    const message = closedBeforeTerminalMessage({ code: 1006, reason: "Connection ended" }, stage());
    // The close tail is read as one substring by existing callers and tests.
    expect(message).toContain("closed before a Responses terminal event (close 1006 Connection ended)");
    expect(message.endsWith(codexWsFailureDetail(stage()))).toBe(true);
  });

  test("leaves the oversized-frame guidance intact ahead of the stage", () => {
    const message = closedBeforeTerminalMessage({ code: 1009, reason: "Message Too Big" }, stage());
    expect(message).toMatch(/rejected the request frame as too large \(close 1009 Message Too Big\)/);
    expect(message).toContain("must use the HTTP SSE transport [cause=");
  });

  test("omits the stage entirely when none is supplied", () => {
    expect(closedBeforeTerminalMessage({ code: 1006 }))
      .toBe("codex websocket closed before a Responses terminal event (close 1006)");
    expect(closedBeforeTerminalMessage(null))
      .toBe("codex websocket closed before a Responses terminal event");
  });
});

describe("codexWsUpstreamFetch failure reporting", () => {
  test("names an unanswered socket, and measures the frame it actually sent", async () => {
    const message = await failureMessage(ws => {
      ws.emit("open", {});
      ws.emit("close", { code: 1006, reason: "Connection ended" });
    });
    const sentBytes = Buffer.byteLength(FakeWebSocket.instances[0]!.sent[0]!, "utf8");
    expect(message).toContain("closed before a Responses terminal event (close 1006 Connection ended)");
    expect(message).toContain(`[cause=no-upstream-frame request=${sentBytes}B sent=yes frames=0`);
    expect(message).toContain("control=0 relayed=0 first-frame=n/a");
  });

  test("distinguishes a socket that answered with quota but never started a response", async () => {
    const message = await failureMessage(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({
        type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } },
      }) });
      ws.emit("close", { code: 1006 });
    });
    expect(message).toContain("cause=no-response-event");
    expect(message).toContain("frames=1 control=1 relayed=0");
    expect(message).toMatch(/first-frame=\d+ms/);
  });

  test("distinguishes a drop that landed after the response was already flowing", async () => {
    const message = await failureMessage(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      ws.emit("message", { data: JSON.stringify({
        type: "response.output_text.delta", delta: "hi", item_id: "m1", output_index: 0, content_index: 0,
      }) });
      ws.emit("close", { code: 1006 });
    });
    expect(message).toContain("cause=after-response-started");
    expect(message).toContain("frames=2 control=0 relayed=2");
  });

  test("the prelude timeout says which stage ran out of budget", async () => {
    jest.useFakeTimers();
    const opened = Promise.withResolvers<void>();
    try {
      installFake(ws => { ws.emit("open", {}); opened.resolve(); });
      const pending = codexWsUpstreamFetch(
        CODEX_URL,
        streamingInit(),
        noFallback as unknown as typeof fetch,
        BOUNDED_WS_RUNTIME,
      );
      await opened.promise;
      jest.advanceTimersByTime(CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS);
      const response = await pending;
      await expect(response.text()).rejects.toThrow(
        /prelude timed out \[cause=no-upstream-frame request=\d+B sent=yes frames=0 control=0 relayed=0/,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

