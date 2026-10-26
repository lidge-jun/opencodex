import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { CODEX_WS_LIVENESS_PING_INTERVAL_MS, codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { BOUNDED_WS_RUNTIME, streamingInit } from "../helpers/ws-upstream-fixtures";

/**
 * Pinging used to stop at the commit, so a path that died after `response.created` left the stream
 * silent until codex-rs's 300 s idle timeout. A peer that ponged and then goes silent is now gone;
 * one that keeps answering, or never answered, keeps the stream as before.
 */

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const INTERVAL = CODEX_WS_LIVENESS_PING_INTERVAL_MS;

type Listener = (event: unknown) => void;

/** Minimal scriptable stand-in for Bun's WebSocket, mirroring `ws-pre-output-refusal.test.ts`. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  url: string;
  sent: string[] = [];
  pings = 0;
  answersPings = true;
  pingThrows = false;
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

  frame(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  ping() {
    if (this.pingThrows) throw new Error("WebSocket is not open");
    this.pings += 1;
    if (this.answersPings) this.emit("pong", {});
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() { this.closed = true; }
}

const RealWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.WebSocket = RealWebSocket;
  codexWsPool.dispose();
});

const noFallback = (async () => {
  throw new Error("fallback must not run after open");
}) as unknown as typeof fetch;

const RATE_LIMITS = { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } } };
const CREATED = { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } };
const IN_PROGRESS = { type: "response.in_progress", response: { id: "resp_1", status: "in_progress", output: [] } };
const SUMMARY_DELTA = { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "…" };
const COMPLETED = { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } };

const flush = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};

/**
 * Quota, an empty preamble, then nothing: the shape that hit the 300 s timeout. `holdMs` turns on
 * the Pool pre-output hold; `diesInPreamble` kills the path before that hold commits.
 */
async function committedExchange(answersPings: boolean, { holdMs = 0, diesInPreamble = false } = {}) {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeWebSocket.script = ws => {
    ws.answersPings = answersPings;
    ws.emit("open", {});
    ws.frame(RATE_LIMITS);
    ws.frame(CREATED);
    ws.frame(IN_PROGRESS);
    if (diesInPreamble) ws.answersPings = false;
  };
  const hold = holdMs > 0 ? { maxMs: holdMs, until: Number.MAX_SAFE_INTEGER } : undefined;
  const pending = codexWsUpstreamFetch(
    CODEX_URL, streamingInit(), noFallback, BOUNDED_WS_RUNTIME,
    undefined, undefined, undefined, undefined, undefined, hold,
  );
  if (hold) {
    await flush();
    jest.advanceTimersByTime(holdMs);
  }
  const response = await pending;
  expect(response.status).toBe(200);
  const ws = FakeWebSocket.instances[0]!;
  // A reader, not response.text(): its reads settle on microtasks, so fake timers can step them.
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let outcome: { text: string } | { error: string } | undefined;
  void (async () => {
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      outcome = { text };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
  })();
  /** One ping interval per step, so each chained timer is scheduled and fired. */
  const advance = async (intervals: number, each?: () => void) => {
    for (let step = 0; step < intervals; step++) {
      jest.advanceTimersByTime(INTERVAL);
      each?.();
      await flush();
    }
    await flush();
  };
  return { ws, advance, outcome: () => outcome };
}

describe("codex ws committed-stream liveness", () => {
  test("a socket that stops answering after the response started is settled long before the client's idle timeout", async () => {
    const { ws, advance, outcome } = await committedExchange(true);
    // The path dies without a close.
    ws.answersPings = false;
    await advance(1);
    // One unanswered ping is not a verdict.
    expect(outcome()).toBeUndefined();
    await advance(2);
    const settled = outcome();
    expect(settled).toBeDefined();
    if (!settled || !("error" in settled)) throw new Error(`expected a body failure, got ${JSON.stringify(settled)}`);
    expect(settled.error).toContain("stopped answering after the response started");
    expect(settled.error).toContain("cause=after-response-started");
    expect(settled.error).toMatch(/pongs=1\]/);
    expect(ws.closed).toBe(true);
    expect(ws.sent).toHaveLength(1);
  });

  test("a socket whose ping() starts throwing is still judged by its silence", async () => {
    const { ws, advance, outcome } = await committedExchange(true);
    ws.pingThrows = true;
    await advance(3);
    const settled = outcome();
    if (!settled || !("error" in settled)) throw new Error(`expected a body failure, got ${JSON.stringify(settled)}`);
    expect(settled.error).toContain("stopped answering after the response started");
  });

  test("a peer that keeps answering pings is never cut, however long the model stays silent", async () => {
    const { ws, advance, outcome } = await committedExchange(true);
    // 300 s without a message frame, every ping answered.
    await advance(20);
    expect(outcome()).toBeUndefined();
    ws.frame(COMPLETED);
    await advance(0);
    const settled = outcome();
    if (!settled || !("text" in settled)) throw new Error(`expected a completed body, got ${JSON.stringify(settled)}`);
    expect(settled.text).toContain("event: response.completed");
    // The pinger ends with the exchange.
    const pings = ws.pings;
    await advance(4);
    expect(ws.pings).toBe(pings);
    expect([...ws.listeners.values()].every(listeners => listeners.length === 0)).toBe(true);
  });

  test("frames are proof of life on their own: a streaming peer that stopped answering pings is not cut", async () => {
    const { ws, advance, outcome } = await committedExchange(true);
    ws.answersPings = false;
    await advance(10, () => ws.frame(SUMMARY_DELTA));
    expect(outcome()).toBeUndefined();
    ws.frame(COMPLETED);
    await advance(0);
    const settled = outcome();
    if (!settled || !("text" in settled)) throw new Error(`expected a completed body, got ${JSON.stringify(settled)}`);
    expect(settled.text).toContain("event: response.completed");
  });

  test("a peer that has never answered a ping keeps the committed stream exactly as before", async () => {
    const { ws, advance, outcome } = await committedExchange(false);
    await advance(20);
    // No pong ever came back, so silence proves nothing.
    expect(outcome()).toBeUndefined();
    expect(ws.closed).toBe(false);
    ws.frame(COMPLETED);
    await advance(0);
    const settled = outcome();
    if (!settled || !("text" in settled)) throw new Error(`expected a completed body, got ${JSON.stringify(settled)}`);
    expect(settled.text).toContain("event: response.completed");
  });

  test("a path that dies while the pre-output hold keeps the 200 back is still caught after the commit", async () => {
    // The path dies seconds after the send, before a 10 s hold commits.
    const { ws, advance, outcome } = await committedExchange(true, { holdMs: 10_000, diesInPreamble: true });
    await advance(1);
    expect(outcome()).toBeUndefined();
    await advance(1);
    const settled = outcome();
    if (!settled || !("error" in settled)) throw new Error(`expected a body failure, got ${JSON.stringify(settled)}`);
    expect(settled.error).toContain("stopped answering after the response started");
    expect(ws.closed).toBe(true);
  });
});
