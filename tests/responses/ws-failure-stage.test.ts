import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relaySseEagerBounded } from "../../src/server/relay-eager";
import { appendUsageEntry, type PersistedUsageEntry } from "../../src/usage/log";
import {
  classifyCodexWsFailure,
  closedBeforeTerminalMessage,
  codexWsFailureDetail,
  markCodexWsStage,
  projectCodexWsFailure,
  readCodexWsStage,
  type CodexWsFailureStage,
  type CodexWsStageRecord,
} from "../../src/server/responses/codex-ws-wire";
import { permitsResend, resendPermission } from "../../src/lib/request-failure-model";
import {
  codexWsUpstreamFetch,
  CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS,
} from "../../src/server/responses/ws-upstream";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";

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

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() { this.closed = true; }
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
    firstResponseMs: null,
    elapsedMs: 90_003,
    pings: 0,
    pongs: 0,
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
  return failureMessageOf(response);
}

/**
 * A failure before the first response event is an honest gateway status whose JSON body
 * carries the message; a failure after the response started is still an errored 200 body.
 * Both shapes carry the same stage detail, which is what these cases read.
 */
async function failureMessageOf(response: Response): Promise<string> {
  if (response.status >= 500) {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message !== "string") throw new Error("expected a gateway failure body");
    return body.error.message;
  }
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

  /**
   * The same four outcomes said in the shared stage-and-cause vocabulary, so a WebSocket failure
   * can be compared with an HTTP one instead of being the one surface with private words for it.
   * These rows are asserted individually because a projection is a mapping, and a mapping whose
   * rows are only checked for totality can be rewritten wholesale without any case objecting.
   */
  test("projects each outcome onto the shared stage and cause", () => {
    expect(projectCodexWsFailure(stage({ sent: false, elapsedMs: null })))
      .toEqual({ stage: "pre-header", cause: "transport-unsent" });
    expect(projectCodexWsFailure(stage()))
      .toEqual({ stage: "pre-header", cause: "transport-ambiguous" });
    expect(projectCodexWsFailure(stage({ upstreamFrames: 3, controlFrames: 3 })))
      .toEqual({ stage: "protocol-prelude", cause: "transport-ambiguous" });
    expect(projectCodexWsFailure(stage({ upstreamFrames: 9, controlFrames: 2, relayedEvents: 7 })))
      .toEqual({ stage: "semantic-output", cause: "transport-ambiguous" });
  });

  /**
   * The shared table has to reach the same verdict the transport already enforces on its own, or
   * one of the two is lying about this exchange. A create frame that never left is the only
   * outcome the origin provably did not see.
   */
  test("only an unsent create frame may be sent again", () => {
    const resendable = ([
      stage({ sent: false, elapsedMs: null }),
      stage(),
      stage({ upstreamFrames: 3, controlFrames: 3 }),
      stage({ upstreamFrames: 9, controlFrames: 2, relayedEvents: 7 }),
    ]).map(candidate => {
      const projected = projectCodexWsFailure(candidate);
      return permitsResend(resendPermission(projected.stage, projected.cause));
    });
    expect(resendable).toEqual([true, false, false, false]);
  });

  test("renders every field, with n/a for the durations that do not exist yet", () => {
    expect(codexWsFailureDetail(stage({ upstreamFrames: 2, controlFrames: 2, firstFrameMs: 41, firstResponseMs: 57 }))).toBe(
      " [cause=no-response-event request=812B sent=yes frames=2 control=2 relayed=0"
      + " first-frame=41ms first-response=57ms elapsed=90003ms pings=0 pongs=0]",
    );
    expect(codexWsFailureDetail(stage({ sent: false, elapsedMs: null }))).toBe(
      " [cause=before-send request=812B sent=no frames=0 control=0 relayed=0"
      + " first-frame=n/a first-response=n/a elapsed=n/a pings=0 pongs=0]",
    );
    // A peer that answered pings but never started a response is named as such.
    expect(codexWsFailureDetail(stage({ upstreamFrames: 0, pings: 6, pongs: 6 }))).toContain(" pings=6 pongs=6]");
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

  test("times the first response event, not only the first frame of any kind", async () => {
    // #4191: a socket that carried quota frames then a response is "upstream alive
    // and slow", and first-frame alone cannot separate it from a silent peer.
    const message = await failureMessage(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({
        type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } },
      }) });
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      ws.emit("close", { code: 1006 });
    });
    expect(message).toContain("cause=after-response-started");
    expect(message).toMatch(/first-frame=\d+ms first-response=\d+ms/);
  });

  test("a socket that carried only quota frames reports no response event", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({
        type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } },
      }) });
      ws.emit("close", { code: 1006 });
    });
    const response = await codexWsUpstreamFetch(
      CODEX_URL,
      streamingInit(),
      noFallback as unknown as typeof fetch,
      BOUNDED_WS_RUNTIME,
    );
    const record = JSON.parse(JSON.stringify(readCodexWsStage(response))) as Record<string, unknown>;
    expect(typeof record.firstFrameMs).toBe("number");
    expect(record.firstResponseMs).toBeNull();
    const message = await failureMessageOf(response);
    expect(message).toContain("cause=no-response-event");
    expect(message).toContain("first-response=n/a");
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
      expect(response.status).toBe(504);
      expect(await failureMessageOf(response)).toMatch(
        /prelude timed out \[cause=no-upstream-frame request=\d+B sent=yes frames=0 control=0 relayed=0/,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test("the prelude-timeout response carries the stage as a durable record", async () => {
    jest.useFakeTimers();
    const opened = Promise.withResolvers<void>();
    const noFallback = async () => {
      throw new Error("fallback must not run after open");
    };
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
      expect(response.status).toBe(504);
      const stage = readCodexWsStage(response);
      expect(stage).toBeDefined();
      expect(stage?.upstreamFrames).toBe(0);
      expect(stage?.firstFrameMs).toBeNull();
      expect(stage?.closeCode).toBeNull();
      expect(stage?.sent).toBe(true);
      expect(stage?.requestBytes).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("codex ws stage record marker (#4191)", () => {
  const stage: CodexWsStageRecord = {
    requestBytes: 1234,
    sent: true,
    upstreamFrames: 3,
    controlFrames: 1,
    relayedEvents: 2,
    firstFrameMs: 42,
    firstResponseMs: 57,
    elapsedMs: 900,
    pings: 1,
    pongs: 1,
    closeCode: 1006,
    reused: false,
    ocxVersion: "2.52.0",
    bunVersion: "1.4.0",
  };

  test("mark/read round trip on the resolved Response", () => {
    const response = new Response("ok");
    expect(readCodexWsStage(response)).toBeUndefined();
    markCodexWsStage(response, stage);
    expect(readCodexWsStage(response)).toEqual(stage);
  });

  test("updating one response preserves its adopted record and leaves another response unchanged", () => {
    const first = new Response("first");
    const second = new Response("second");
    markCodexWsStage(first, { ...stage });
    markCodexWsStage(second, { ...stage, reused: true });
    const firstAdopted = readCodexWsStage(first);
    const secondAdopted = readCodexWsStage(second);
    const finalStage = { ...stage, requestBytes: null, closeCode: null, upstreamFrames: 5, relayedEvents: 4 };

    markCodexWsStage(first, finalStage);

    expect(readCodexWsStage(first)).toBe(firstAdopted);
    expect(firstAdopted).toEqual(finalStage);
    expect(readCodexWsStage(second)).toBe(secondAdopted);
    expect(secondAdopted).not.toBe(firstAdopted);
    expect(secondAdopted).toEqual({ ...stage, reused: true });
  });

  test("a successful exchange finalizes the stage reference adopted before its terminal", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
    });
    const response = await codexWsUpstreamFetch(
      CODEX_URL,
      streamingInit(),
      noFallback as unknown as typeof fetch,
      BOUNDED_WS_RUNTIME,
    );
    // handleResponses keeps this reference when the Response resolves, before the body settles.
    const adopted = readCodexWsStage(response);
    const ws = FakeWebSocket.instances[0]!;
    ws.emit("message", { data: JSON.stringify({
      type: "response.output_text.delta", delta: "hi", item_id: "m1", output_index: 0, content_index: 0,
    }) });
    ws.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: "r1" } }) });
    await response.text();

    expect(response.status).toBe(200);
    expect(readCodexWsStage(response)).toBe(adopted);
    expect(adopted).toBeDefined();
    expect(adopted?.requestBytes).toBeNull();
    expect(adopted?.closeCode).toBeNull();
    expect(adopted?.sent).toBe(true);
    expect(adopted?.upstreamFrames).toBe(3);
    expect(adopted?.relayedEvents).toBe(3);
    expect(typeof adopted?.firstResponseMs).toBe("number");
  });

  test("a body failure finalizes the stage reference adopted before the socket closes", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
    });
    const response = await codexWsUpstreamFetch(
      CODEX_URL,
      streamingInit(),
      noFallback as unknown as typeof fetch,
      BOUNDED_WS_RUNTIME,
    );
    const adopted = readCodexWsStage(response);
    const committedBytes = adopted?.requestBytes;
    const committedCloseCode = adopted?.closeCode;
    const ws = FakeWebSocket.instances[0]!;
    const failure = failureMessageOf(response);
    ws.emit("message", { data: JSON.stringify({
      type: "response.output_text.delta", delta: "hi", item_id: "m1", output_index: 0, content_index: 0,
    }) });
    ws.emit("close", { code: 1006 });
    const message = await failure;

    expect(response.status).toBe(200);
    expect(committedBytes).toBeNull();
    expect(committedCloseCode).toBeNull();
    expect(message).toContain("closed before a Responses terminal event (close 1006)");
    expect(readCodexWsStage(response)).toBe(adopted);
    expect(adopted?.requestBytes).toBe(Buffer.byteLength(ws.sent[0]!, "utf8"));
    expect(adopted?.closeCode).toBe(1006);
    expect(adopted?.upstreamFrames).toBe(2);
    expect(adopted?.relayedEvents).toBe(2);
  });

  test("cancel-drain byte expiry persists the finalized WS stage in usage.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-ws-stage-cancel-"));
    const upstream = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    let relayStarted = false;
    try {
      installFake(ws => {
        ws.emit("open", {});
        ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      });
      const response = await codexWsUpstreamFetch(
        CODEX_URL,
        { ...streamingInit(), signal: upstream.signal },
        noFallback as unknown as typeof fetch,
        BOUNDED_WS_RUNTIME,
      );
      const adopted = readCodexWsStage(response);
      expect(adopted).toBeDefined();
      expect(adopted?.requestBytes).toBeNull();
      const entry: PersistedUsageEntry = {
        requestId: "req-ws-stage-cancel", timestamp: 1, provider: "openai", model: "gpt-5.5",
        status: 499, durationMs: 1000, usageStatus: "unreported",
        attempts: [{ ordinal: 1, provider: "openai", model: "gpt-5.5", adapter: "openai-responses",
          status: 499, durationMs: 1000, sendCount: 1, recoveryKinds: [], usageStatus: "unreported",
          codexWsStage: adopted }],
      };
      const synthetic = jest.fn();
      const onClientCancel = jest.fn(() => {
        // The real writer is synchronous: keep this test-only path override in the same turn.
        const previous = process.env.OPENCODEX_HOME;
        process.env.OPENCODEX_HOME = dir;
        try { appendUsageEntry(entry); }
        finally {
          if (previous === undefined) delete process.env.OPENCODEX_HOME;
          else process.env.OPENCODEX_HOME = previous;
        }
      });
      const reader = relaySseEagerBounded(response.body!, upstream, {
        inspectChunk: () => {}, finishInspection: () => {}, sawTerminal: () => false,
        onSynthetic: synthetic, onClientCancel, onDone: finish,
      }, { postCancelDrainBytes: 1 }).getReader();
      relayStarted = true;
      await reader.read();
      await reader.cancel();
      const ws = FakeWebSocket.instances[0]!;
      ws.emit("message", { data: JSON.stringify({
        type: "response.output_text.delta", delta: "hi", item_id: "m1", output_index: 0, content_index: 0,
      }) });
      await done;

      const rows = readFileSync(join(dir, "usage.jsonl"), "utf8").trim().split("\n");
      expect(rows).toHaveLength(1);
      const persisted = JSON.parse(rows[0]!) as PersistedUsageEntry;
      const logged = persisted.attempts?.[0]?.codexWsStage;
      expect(logged?.requestBytes).toBe(Buffer.byteLength(ws.sent[0]!, "utf8"));
      expect(logged?.upstreamFrames).toBe(2);
      expect(logged?.relayedEvents).toBe(2);
      expect(logged?.closeCode).toBeNull();
      expect(logged).toEqual(adopted);
      expect(onClientCancel).toHaveBeenCalledTimes(1);
      expect(synthetic).not.toHaveBeenCalled();
      expect(upstream.signal.aborted).toBe(true);
    } finally {
      upstream.abort();
      if (relayStarted) await done;
      rmSync(dir, { recursive: true });
    }
  });

  test("the serialized record is numeric/boolean/semver only", () => {
    const json = JSON.stringify(stage);
    expect(json).not.toContain("reason");
    expect(json).not.toMatch(/header|authorization|conversation|body/i);
    for (const [key, value] of Object.entries(stage)) {
      expect(["number", "boolean", "string", "object"]).toContain(typeof value);
      if (typeof value === "string") expect(value.length).toBeLessThan(64);
      expect(key).not.toContain("reason");
    }
  });
});

describe("native-control attach conflict", () => {
  test("an already-owned channel fails the turn instead of falling back to HTTP", async () => {
    installFake(ws => { ws.emit("open", {}); });
    const init = streamingInit();
    const prepared = prepareCodexWsRequest(CODEX_URL, init)!;
    const session = new CodexWsSession("wss://chatgpt.com/backend-api/codex/responses", prepared.headers, true);
    let fallbacks = 0;
    const nativeControl = {
      kind: "injection" as const,
      relayActive: false,
      attached: true,
      ended: false,
      attach() { throw new Error("Native injection transport is already owned."); },
      observe() { return false; },
      steer() { throw new Error("unreachable"); },
      continue() { return false; },
    };
    const options = { session, url: CODEX_URL, init, prepared, nativeControl,
      sseFallback: (async () => { fallbacks++; throw new Error("attach conflict must not fall back"); }) as typeof fetch };
    try {
      expect(session.reserve()).toBe(true);
      const response = await codexWsExchange(options);
      const ws = FakeWebSocket.instances.at(-1)!;
      expect(fallbacks).toBe(0);
      expect(ws.sent).toHaveLength(0);
      expect(response.status).toBe(502);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain("already owned");
      expect(ws.closed).toBe(true);
      expect([...ws.listeners.values()].every(listeners => listeners.length === 0)).toBe(true);
    } finally { session.dispose(); }
  });
});
