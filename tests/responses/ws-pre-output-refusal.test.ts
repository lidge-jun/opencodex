import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import {
  codexWsPreOutputRefusalHold,
  codexWsPreOutputRefusalStatus,
  codexWsSocketDeathStage,
  isCodexWsPreOutputRefusal,
  isCodexWsUpstreamResponse,
  readCodexWsStage,
  restoreCodexWsPreOutputRefusal,
} from "../../src/server/responses/codex-ws-wire";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { BOUNDED_WS_RUNTIME, streamingInit } from "../helpers/ws-upstream-fixtures";

/**
 * #6969: the Codex WebSocket used to commit a 200 at `response.created`, so an upstream that then
 * refused the turn with a structured 5xx and no output reached no retry layer at all. With the
 * opt-in hold, such a refusal settles as a replayable gateway status and can be restored to the
 * original stream; every other outcome must stay exactly what it was.
 */

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const HOLD_MS = 10_000;

type Listener = (event: unknown) => void;

/** Minimal scriptable stand-in for Bun's WebSocket, mirroring `ws-ambiguous-resend.test.ts`. */
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

  frame(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
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
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.WebSocket = RealWebSocket;
  codexWsPool.dispose();
});

function installFake(script: (ws: FakeWebSocket) => void) {
  FakeWebSocket.script = script;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

const noFallback = (async () => {
  throw new Error("fallback must not run after open");
}) as unknown as typeof fetch;

function exchange(
  script: (ws: FakeWebSocket) => void,
  holdMs = HOLD_MS,
  until = Number.MAX_SAFE_INTEGER,
): Promise<Response> {
  installFake(script);
  return codexWsUpstreamFetch(
    CODEX_URL, streamingInit(), noFallback, BOUNDED_WS_RUNTIME,
    undefined, undefined, undefined, undefined, undefined, { maxMs: holdMs, until },
  );
}

const CREATED = { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } };
const IN_PROGRESS = { type: "response.in_progress", response: { id: "resp_1", status: "in_progress", output: [] } };
const OVERLOADED = {
  type: "error",
  status: 503,
  error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." },
};
const SERVER_ERROR = {
  type: "error",
  status: 502,
  error: { type: "server_error", message: "An error occurred while processing your request." },
};
const FAILED_OVERLOADED = {
  type: "response.failed",
  response: { id: "resp_1", status: "failed", output: [], error: { code: "server_is_overloaded", message: "overloaded" } },
};
const OUTPUT_ITEM = {
  type: "response.output_item.added",
  response_id: "resp_1",
  output_index: 0,
  item: { id: "msg_1", type: "message", role: "assistant", content: [] },
};
const QUOTA = (percent: number) => ({
  type: "codex.rate_limits",
  rate_limits: { primary: { used_percent: percent, window_minutes: 10080 } },
});

function opened(...frames: unknown[]): (ws: FakeWebSocket) => void {
  return ws => {
    ws.emit("open", {});
    for (const frame of frames) ws.frame(frame);
  };
}

describe("an authoritative refusal before any output becomes a replayable gateway status (#6969)", () => {
  test("after an empty created/in_progress preamble", async () => {
    const projection = await exchange(opened(CREATED, IN_PROGRESS, OVERLOADED));
    expect(projection.status).toBe(503);
    expect(isNonReplayableResponse(projection)).toBe(false);
    expect(isCodexWsPreOutputRefusal(projection)).toBe(true);
    expect(await projection.clone().json()).toMatchObject({ error: { code: "server_is_overloaded" } });
    const stage = readCodexWsStage(projection);
    expect(stage).toMatchObject({ sent: true, relayedEvents: 3, terminalEvent: "error", terminalErrorStatus: 503 });

    const restored = restoreCodexWsPreOutputRefusal(projection);
    expect(restored.status).toBe(200);
    expect(restored.headers.get("content-type")).toContain("text/event-stream");
    expect(isCodexWsUpstreamResponse(restored)).toBe(true);
    // The same record object: the attempt that adopted it keeps one stage.
    expect(readCodexWsStage(restored)).toBe(stage);
    const body = await restored.text();
    const order = ["event: response.created", "event: response.in_progress", "event: error"].map(marker => body.indexOf(marker));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain("server_is_overloaded");
    // Single use.
    expect(restoreCodexWsPreOutputRefusal(projection)).toBe(projection);
  });

  test("as the first Responses event, with the wrapper's own 5xx", async () => {
    const projection = await exchange(opened(SERVER_ERROR));
    expect(projection.status).toBe(502);
    expect(isNonReplayableResponse(projection)).toBe(false);
    const body = await restoreCodexWsPreOutputRefusal(projection).text();
    expect(body.startsWith("event: error")).toBe(true);
  });

  test("as an empty response.failed carrying the overload class", async () => {
    const projection = await exchange(opened(CREATED, FAILED_OVERLOADED));
    expect(projection.status).toBe(503);
    expect(isCodexWsPreOutputRefusal(projection)).toBe(true);
  });

  test("restored headers keep the prelude frozen at the first Responses event", async () => {
    const projection = await exchange(opened(QUOTA(10), CREATED, QUOTA(20), OVERLOADED));
    expect(projection.status).toBe(503);
    const restored = restoreCodexWsPreOutputRefusal(projection);
    expect(restored.headers.get("x-codex-primary-used-percent")).toBe("10");
  });
});

describe("everything else keeps today's settle", () => {
  async function committed(response: Response): Promise<string> {
    expect(response.status).toBe(200);
    expect(isCodexWsPreOutputRefusal(response)).toBe(false);
    return response.text();
  }

  test("without the opt-in the refusal is relayed in a committed 200", async () => {
    const body = await committed(await exchange(opened(CREATED, IN_PROGRESS, OVERLOADED), 0));
    expect(body).toContain("server_is_overloaded");
  });

  test("once output started the refusal stays in the body", async () => {
    const body = await committed(await exchange(opened(CREATED, OUTPUT_ITEM, OVERLOADED)));
    expect(body).toContain("response.output_item.added");
    expect(body).toContain("server_is_overloaded");
  });

  test("a created snapshot that already carries output commits", async () => {
    const resumed = { type: "response.created", response: { id: "resp_1", output: [{ id: "msg_0", type: "message" }] } };
    expect(await committed(await exchange(opened(resumed, OVERLOADED)))).toContain("server_is_overloaded");
  });

  test.each([
    ["a 429 wrapper", { type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "slow down" } }],
    ["a 5xx that names quota", { type: "error", status: 503, error: { code: "usage_limit_reached", message: "limit" } }],
    ["a 5xx whose message is quota", { type: "error", status: 502, error: { message: "You exceeded your current quota" } }],
    ["a 5xx with a rate_limit_* code", { type: "error", status: 503, error: { code: "rate_limit_requests", message: "Please try again later" } }],
    ["a 5xx with a rate_limit_* type", { type: "error", status: 503, error: { type: "rate_limit_tokens", message: "Please try again later" } }],
    ["a foreign stream id", { ...OVERLOADED, stream_id: "other" }],
    ["doubled wrapper aliases", { ...OVERLOADED, status_code: 503 }],
    ["an unrecognized code without a wrapper status", { type: "error", error: { code: "mystery", message: "x" } }],
  ])("after the preamble, %s is relayed in the body", async (_name, frame) => {
    await committed(await exchange(opened(CREATED, frame)));
  });

  test.each([
    ["first", [] as unknown[]],
    ["after the held preamble", [CREATED]],
  ])("a refusal whose metadata cannot be projected is delivered in the body when it arrives %s", async (_name, before) => {
    const oversized = { ...OVERLOADED, headers: { "x-request-id": "a".repeat(5_000) } };
    expect(await committed(await exchange(opened(...before, oversized)))).toContain("server_is_overloaded");
  });

  test("a queue overflow while holding fails the committed body, as it did before the hold", async () => {
    const padded = (index: number) => ({
      type: "response.in_progress",
      response: { id: "resp_1", status: "in_progress", output: [], metadata: { pad: `${index}${"x".repeat(1_500_000)}` } },
    });
    const response = await exchange(opened(CREATED, ...Array.from({ length: 7 }, (_, index) => padded(index))));
    expect(response.status).toBe(200);
    expect(isCodexWsPreOutputRefusal(response)).toBe(false);
    await expect(response.text()).rejects.toThrow("buffered queue limit");
  });

  test("lifecycle frames do not extend the hold deadline", async () => {
    jest.useFakeTimers();
    let socket: FakeWebSocket | undefined;
    let settled: Response | undefined;
    const pending = exchange(ws => {
      socket = ws;
      ws.emit("open", {});
      ws.frame(CREATED);
    });
    void pending.then(response => { settled = response; });
    for (let i = 0; i < 5 && !socket; i += 1) await Promise.resolve();
    jest.advanceTimersByTime(HOLD_MS - 4_000);
    socket!.frame(IN_PROGRESS);
    jest.advanceTimersByTime(4_000);
    for (let i = 0; i < 5 && !settled; i += 1) await Promise.resolve();
    expect(settled?.status).toBe(200);
  });

  test("a first-frame 4xx keeps the existing refused-create projection", async () => {
    const response = await exchange(opened({ type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "slow" } }));
    expect(response.status).toBe(429);
    expect(isCodexWsPreOutputRefusal(response)).toBe(false);
  });

  test("a terminal naming another response than the held one commits", async () => {
    const foreign = { ...FAILED_OVERLOADED, response_id: "resp_other" };
    await committed(await exchange(opened(CREATED, foreign)));
  });

  test("a socket death after the held preamble is still a failed body, not a socket-death settle", async () => {
    const response = await exchange(ws => {
      ws.emit("open", {});
      ws.frame(CREATED);
      ws.emit("close", { code: 1006 });
    });
    expect(response.status).toBe(200);
    expect(codexWsSocketDeathStage(response)).toBeUndefined();
    await expect(response.text()).rejects.toThrow("closed before a Responses terminal event");
  });

  test("a socket death before any Responses event keeps the non-replayable 502", async () => {
    const response = await exchange(ws => {
      ws.emit("open", {});
      ws.emit("close", { code: 1006 });
    });
    expect(response.status).toBe(502);
    expect(isNonReplayableResponse(response)).toBe(true);
  });

  test("the hold is bounded: the preamble commits when it expires and the turn continues", async () => {
    jest.useFakeTimers();
    let socket: FakeWebSocket | undefined;
    const pending = exchange(ws => {
      socket = ws;
      ws.emit("open", {});
      ws.frame(CREATED);
    });
    for (let i = 0; i < 5 && !socket; i += 1) await Promise.resolve();
    jest.advanceTimersByTime(HOLD_MS);
    const response = await pending;
    expect(response.status).toBe(200);
    socket!.frame({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } });
    const body = await response.text();
    expect(body.indexOf("event: response.created")).toBeLessThan(body.indexOf("event: response.completed"));
  });

  test("a native-control exchange never holds", async () => {
    installFake(opened(CREATED, OVERLOADED));
    const init = streamingInit();
    const prepared = prepareCodexWsRequest(CODEX_URL, init)!;
    const session = new CodexWsSession("wss://chatgpt.com/backend-api/codex/responses", prepared.headers, true);
    const nativeControl = {
      kind: "steering" as const,
      relayActive: false,
      attached: false,
      ended: false,
      attach() { return () => {}; },
      observe() { return false; },
      steer() {},
      continue() { return false; },
    };
    try {
      expect(session.reserve()).toBe(true);
      const response = await codexWsExchange({
        session, url: CODEX_URL, init, prepared, nativeControl, sseFallback: noFallback, preOutputRefusalHold: { maxMs: HOLD_MS, until: Number.MAX_SAFE_INTEGER },
      });
      expect(response.status).toBe(200);
      expect(isCodexWsPreOutputRefusal(response)).toBe(false);
    } finally { session.dispose(); }
  });
});

describe("refusal identity and hold bound", () => {
  test("only structured transient 5xx evidence counts", () => {
    expect(codexWsPreOutputRefusalStatus(OVERLOADED)).toBe(503);
    expect(codexWsPreOutputRefusalStatus({ type: "error", error: { code: "server_is_overloaded" } })).toBe(503);
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 500, error: { message: "boom" } })).toBe(500);
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 400, error: { message: "bad" } })).toBeUndefined();
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: "503" })).toBeUndefined();
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 503, error: { code: "rate_limit_requests" } })).toBeUndefined();
    expect(codexWsPreOutputRefusalStatus({ ...FAILED_OVERLOADED, response: { ...FAILED_OVERLOADED.response, output: [{}] } }))
      .toBeUndefined();
  });

  test("the hold never exceeds 10 s, and every hold ends by half the header deadline from the send", () => {
    expect(codexWsPreOutputRefusalHold(200_000, 1_000)).toEqual({ maxMs: 10_000, until: 101_000 });
    expect(codexWsPreOutputRefusalHold(8_000, 1_000)).toEqual({ maxMs: 4_000, until: 5_000 });
  });

  test("a lifecycle frame after the hold's end commits at once", async () => {
    const response = await exchange(opened(CREATED, OVERLOADED), HOLD_MS, Date.now() - 1);
    // Nothing was held, so the refusal after it is relayed in the committed body as before.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("server_is_overloaded");
  });

  test("the hold ends at its absolute end even when the maximum is longer", async () => {
    const started = Date.now();
    const response = await exchange(ws => {
      ws.emit("open", {});
      ws.frame(CREATED);
    }, HOLD_MS, Date.now() + 50);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(HOLD_MS);
    void response.body?.cancel();
  });
});
