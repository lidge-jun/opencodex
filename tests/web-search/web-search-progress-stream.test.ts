import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import {
  parseStreamWithProgress,
  RoutedModelInactivityError,
  WebSearchStreamProtocolError,
} from "../../src/web-search/progress-stream";
import {
  createPassthroughWebSearchBridgeStream,
  MAX_HELD_CALL_EVENTS,
  WEB_SEARCH_BRIDGE_ERROR_CODE,
} from "../../src/web-search/passthrough-bridge";
import type { AdapterEvent } from "../../src/types";

type ParseStream = ProviderAdapter["parseStream"];

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(1);
}

async function collect(stream: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const result: AdapterEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

function chunkStream(chunks: Array<{ after?: number; value: string }>): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks[index++];
      if (!chunk) {
        controller.close();
        return;
      }
      if (chunk.after) await sleep(chunk.after);
      controller.enqueue(bytes(chunk.value));
    },
  }, { highWaterMark: 0 });
}

const drainThenDone: ParseStream = async function* (response) {
  const reader = response.body!.getReader();
  while (!(await reader.read()).done) { /* drain */ }
  yield { type: "done" };
};

describe("web-search streamed-body progress collector", () => {
  test("an already-aborted parent does not arm a lingering inactivity timer", async () => {
    const parent = new AbortController();
    const reason = new DOMException("already gone", "AbortError");
    parent.abort(reason);
    let parseCalls = 0;
    const adapter = async function* (_response: Response): AsyncGenerator<AdapterEvent> {
      parseCalls++;
      yield { type: "done" };
    };

    const iterator = parseStreamWithProgress(new Response(chunkStream([{ value: "unused" }])), adapter, {
      signal: parent.signal,
      inactivityTimeoutMs: 10,
      postTerminalDrainTimeoutMs: 10_000,
    });
    try {
      await iterator.next();
      expect.unreachable("collector should reject");
    } catch (error) {
      expect(error).toBe(reason);
    }
    await sleep(20);
    expect(parseCalls).toBe(0);
  });

  test("an already-aborted parent reason wins over a synchronous original-reader cancel throw", async () => {
    const parent = new AbortController();
    const reason = { kind: "already-aborted" };
    parent.abort(reason);
    const response = new Response(new ReadableStream<Uint8Array>({ pull() {} }, { highWaterMark: 0 }));
    const reader = response.body!.getReader();
    reader.cancel = (() => { throw new Error("synchronous cancel failure"); }) as typeof reader.cancel;
    response.body!.getReader = (() => reader) as typeof response.body.getReader;

    const error = await collect(parseStreamWithProgress(response, drainThenDone, {
      signal: parent.signal,
      inactivityTimeoutMs: 1_000,
    })).then(() => undefined, failure => failure);
    expect(error).toBe(reason);
  });

  test("raw response bytes keep a generation alive beyond its initial total elapsed time", async () => {
    // Drive each byte through an explicit gate so suite-load jitter on Windows CI cannot
    // invent a false stall between sleeps (10ms-vs-120ms flaked on run 30185030821).
    // Gaps stay a fixed fraction of the inactivity window; total wall time still exceeds it.
    const inactivityTimeoutMs = 1_000;
    const gapMs = 80; // 12.5× under the window — tolerates multi-100ms scheduler stalls
    const target = 16; // ~1.2s total >> 1s
    let resolveGate!: () => void;
    let gate = new Promise<void>(resolve => { resolveGate = resolve; });
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= target) {
          controller.close();
          return;
        }
        await gate;
        gate = new Promise<void>(resolve => { resolveGate = resolve; });
        controller.enqueue(bytes(String.fromCharCode(97 + (sent++ % 26))));
      },
    }, { highWaterMark: 0 });

    const pending = collect(parseStreamWithProgress(new Response(body), drainThenDone, { inactivityTimeoutMs }));
    const started = Date.now();
    resolveGate(); // first byte immediately — inactivity is already armed at collector start
    for (let i = 1; i < target; i++) {
      await sleep(gapMs);
      resolveGate();
    }
    const events = await pending;
    expect(Date.now() - started).toBeGreaterThan(inactivityTimeoutMs);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.some(event => event.type === "heartbeat")).toBe(true);
  });

  test("continuous raw-byte silence raises the exact typed inactivity error", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ pull() { /* never resolves */ } }, { highWaterMark: 0 }));
    const error = await collect(parseStreamWithProgress(response, drainThenDone, { inactivityTimeoutMs: 20 }))
      .then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(RoutedModelInactivityError);
    expect(error.message).toBe(
      "Routed model generation timeout after 20ms without response bytes during web-search",
    );
  });

  test("parent abort rejects with the exact reason object", async () => {
    const controller = new AbortController();
    const reason = { kind: "client-left" };
    const response = new Response(new ReadableStream<Uint8Array>({ pull() {} }, { highWaterMark: 0 }));
    const pending = collect(parseStreamWithProgress(response, drainThenDone, {
      inactivityTimeoutMs: 1_000,
      signal: controller.signal,
    }));
    controller.abort(reason);
    expect(await pending.then(() => undefined, error => error)).toBe(reason);
  });

  test("the tapped HWM-zero body does not read the original before adapter demand", async () => {
    let pulls = 0;
    let allowRead!: () => void;
    const gate = new Promise<void>(resolve => { allowRead = resolve; });
    const original = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(bytes("x"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const parser: ParseStream = async function* (response) {
      await gate;
      await response.body!.getReader().read();
      yield { type: "done" };
    };
    const iterator = parseStreamWithProgress(new Response(original), parser, { inactivityTimeoutMs: 200 });
    const pending = iterator.next();
    await sleep(10);
    expect(pulls).toBe(0);
    allowRead();
    expect((await pending).value).toEqual({ type: "heartbeat" });
    await iterator.return(undefined);
  });

  test("semantic delivery is ordered and acknowledged one event at a time", async () => {
    const marks: string[] = [];
    const parser = async function* () {
      yield { type: "text_delta", text: "a" } as AdapterEvent;
      marks.push("requested-second");
      yield { type: "text_delta", text: "b" } as AdapterEvent;
      marks.push("requested-done");
      yield { type: "done" } as AdapterEvent;
    };
    const iterator = parseStreamWithProgress(new Response(chunkStream([])), parser, { inactivityTimeoutMs: 200 });
    expect(await iterator.next()).toEqual({ done: false, value: { type: "text_delta", text: "a" } });
    expect(marks).toEqual(["requested-second"]);
    expect(await iterator.next()).toEqual({ done: false, value: { type: "text_delta", text: "b" } });
    expect(marks).toEqual(["requested-second", "requested-done"]);
    expect(await iterator.next()).toEqual({ done: false, value: { type: "done" } });
    expect(marks).toEqual(["requested-second", "requested-done"]);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  test("raw progress coalesces and never displaces a semantic event", async () => {
    const parser: ParseStream = async function* (response) {
      const reader = response.body!.getReader();
      await reader.read();
      await reader.read();
      await reader.read();
      yield { type: "text_delta", text: "semantic" };
      yield { type: "done" };
    };
    const iterator = parseStreamWithProgress(
      new Response(chunkStream([{ value: "1" }, { value: "2" }, { value: "3" }])),
      parser,
      { inactivityTimeoutMs: 200 },
    );
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "heartbeat" });
    await sleep(10); // parser consumes the remaining chunks while foreground is paused
    const events: AdapterEvent[] = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event);
    expect(events.filter(event => event.type === "heartbeat")).toEqual([{ type: "heartbeat" }]);
    expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "semantic" }]);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  test("holds a valid done until the adapter iterator returns", async () => {
    let returned = false;
    const parser: ParseStream = async function* () {
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 2 } };
      await sleep(30);
      returned = true;
    };
    const iterator = parseStreamWithProgress(new Response(chunkStream([])), parser, {
      inactivityTimeoutMs: 10,
      postTerminalDrainTimeoutMs: 100,
    });
    const next = await iterator.next();
    expect(returned).toBe(true);
    expect(next.value).toEqual({ type: "done", usage: { inputTokens: 1, outputTokens: 2 } });
  });

  test("holds and forwards an explicit incomplete terminal", async () => {
    let returned = false;
    const parser: ParseStream = async function* () {
      yield { type: "incomplete", reason: "empty_kiro_fallback", retryable: true, endTurn: false };
      returned = true;
    };
    const iterator = parseStreamWithProgress(new Response(chunkStream([])), parser, { inactivityTimeoutMs: 100 });
    const next = await iterator.next();
    expect(returned).toBe(true);
    expect(next.value).toEqual({ type: "incomplete", reason: "empty_kiro_fallback", retryable: true, endTurn: false });
    expect((await iterator.next()).done).toBe(true);
  });

  test.each([
    ["missing terminal", async function* () { yield { type: "text_delta", text: "x" } as AdapterEvent; }],
    ["duplicate terminal", async function* () { yield { type: "done" } as AdapterEvent; yield { type: "done" } as AdapterEvent; }],
    ["post-terminal event", async function* () { yield { type: "done" } as AdapterEvent; yield { type: "text_delta", text: "late" } as AdapterEvent; }],
    ["post-terminal throw", async function* () { yield { type: "done" } as AdapterEvent; throw new Error("late throw"); }],
  ])("rejects %s", async (_name, parser) => {
    const error = await collect(parseStreamWithProgress(
      new Response(chunkStream([])),
      parser as ParseStream,
      { inactivityTimeoutMs: 200 },
    )).then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WebSearchStreamProtocolError);
  });

  test("an adapter error event rejects immediately and is never yielded", async () => {
    let finalized = false;
    const parser: ParseStream = async function* () {
      try {
        yield { type: "error", message: "provider exploded" };
        await sleep(100);
        yield { type: "done" };
      } finally {
        finalized = true;
      }
    };
    await expect(collect(parseStreamWithProgress(new Response(chunkStream([])), parser, {
      inactivityTimeoutMs: 200,
    }))).rejects.toThrow("provider exploded");
    await waitFor(() => finalized);
    expect(finalized).toBe(true);
  });

  test("protocol failure best-effort closes the adapter iterator", async () => {
    let finalized = false;
    const parser: ParseStream = async function* () {
      try {
        yield { type: "done" };
        yield { type: "text_delta", text: "late" };
      } finally {
        finalized = true;
      }
    };
    const error = await collect(parseStreamWithProgress(new Response(chunkStream([])), parser, {
      inactivityTimeoutMs: 200,
    })).then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(WebSearchStreamProtocolError);
    await waitFor(() => finalized);
    expect(finalized).toBe(true);
  });

  test("done followed by an iterator that never returns hits the separate drain guard", async () => {
    let finalized = false;
    const parser: ParseStream = async function* (response) {
      try {
        yield { type: "done" };
        await response.body!.getReader().read();
      } finally {
        finalized = true;
      }
    };
    const error = await collect(parseStreamWithProgress(new Response(
      new ReadableStream<Uint8Array>({ pull() {} }, { highWaterMark: 0 }),
    ), parser, {
      inactivityTimeoutMs: 200,
      postTerminalDrainTimeoutMs: 20,
    })).then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(WebSearchStreamProtocolError);
    expect(error.message).toContain("did not return within 20ms after done");
    await waitFor(() => finalized);
    expect(finalized).toBe(true);
  });

  test("parent abort during provisional drain clears its guard and closes the adapter", async () => {
    const drainMs = 777;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimerCleared = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(handler, delay, ...args);
      if (delay === drainMs) drainTimer = timer;
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
      if (timer !== undefined && timer === drainTimer) drainTimerCleared = true;
      return originalClearTimeout(timer);
    }) as typeof clearTimeout;
    globalThis.addEventListener?.("unhandledrejection", onUnhandled);

    let finalized = false;
    let enteredDrain!: () => void;
    const draining = new Promise<void>(resolve => { enteredDrain = resolve; });
    const controller = new AbortController();
    const reason = { kind: "abort-during-provisional-done" };
    const parser: ParseStream = async function* (response) {
      try {
        yield { type: "done" };
        enteredDrain();
        await response.body!.getReader().read();
      } finally {
        finalized = true;
      }
    };
    try {
      const pending = collect(parseStreamWithProgress(new Response(
        new ReadableStream<Uint8Array>({ pull() {} }, { highWaterMark: 0 }),
      ), parser, {
        inactivityTimeoutMs: 2_000,
        postTerminalDrainTimeoutMs: drainMs,
        signal: controller.signal,
      }));
      await draining;
      expect(drainTimer).toBeDefined();
      controller.abort(reason);
      expect(await pending.then(() => undefined, error => error)).toBe(reason);
      await waitFor(() => finalized && drainTimerCleared);
      expect(finalized).toBe(true);
      expect(drainTimerCleared).toBe(true);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.removeEventListener?.("unhandledrejection", onUnhandled);
      if (drainTimer !== undefined) originalClearTimeout(drainTimer);
    }
  });

  test("consumer return cancels the original reader and does not hang", async () => {
    let cancellation: unknown;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(bytes("x")); },
      cancel(reason) { cancellation = reason; },
    }, { highWaterMark: 0 }));
    const parser: ParseStream = async function* (tapped) {
      await tapped.body!.getReader().read();
      yield { type: "text_delta", text: "x" };
      await new Promise<void>(() => {});
    };
    const iterator = parseStreamWithProgress(response, parser, { inactivityTimeoutMs: 200 });
    await iterator.next(); // heartbeat
    await iterator.next(); // semantic event
    await iterator.return(undefined);
    await sleep(0);
    expect(cancellation).toBeInstanceOf(Error);
  });

  test("consumer return is not rejected by a synchronous original-reader cancel throw", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(bytes("x")); },
    }, { highWaterMark: 0 }));
    const reader = response.body!.getReader();
    reader.cancel = (() => { throw new Error("synchronous cancel failure"); }) as typeof reader.cancel;
    response.body!.getReader = (() => reader) as typeof response.body.getReader;
    const parser: ParseStream = async function* (tapped) {
      await tapped.body!.getReader().read();
      yield { type: "text_delta", text: "x" };
      await new Promise<void>(() => {});
    };
    const iterator = parseStreamWithProgress(response, parser, { inactivityTimeoutMs: 200 });
    await iterator.next(); // heartbeat
    await iterator.next(); // semantic event
    expect(await iterator.return(undefined)).toEqual({ done: true, value: undefined });
  });

  test("caught parser failures produce no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    globalThis.addEventListener?.("unhandledrejection", listener);
    try {
      const parser: ParseStream = async function* () { throw new Error("caught pump failure"); };
      const error = await collect(parseStreamWithProgress(new Response(chunkStream([])), parser, {
        inactivityTimeoutMs: 100,
      })).then(() => undefined, reason => reason);
      expect(error).toBeInstanceOf(WebSearchStreamProtocolError);
      await sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.removeEventListener?.("unhandledrejection", listener);
    }
  });
});

describe("web-search passthrough withheld-event stream lifecycle", () => {
  type Payload = Record<string, unknown>;
  type Event = {
    type: string;
    sequence_number: number;
    output_index?: number;
    item?: { type: string; id: string; status?: string; arguments?: string };
    delta?: string;
    response?: { error?: { code: string; message: string }; output?: unknown[] };
  };

  function* legEvents(
    deltas: number,
    delta = "x",
    searches = 0,
    itemIdOnly = false,
    terminal = "response.completed",
  ): Generator<Payload> {
    for (let index = 0; index < searches; index++) {
      yield {
        type: "response.output_item.added", output_index: index,
        item: {
          type: "function_call", id: "search-" + index, call_id: "search-call-" + index,
          name: "web_search", arguments: '{"query":"test"}',
        },
      };
    }
    const item = { type: "function_call", id: "client-tool", call_id: "client-call", name: "exec", arguments: "" };
    yield { type: "response.output_item.added", output_index: 7, item };
    const identity = itemIdOnly ? { item_id: item.id } : { output_index: 7 };
    for (let index = 0; index < deltas; index++) {
      yield { type: "response.function_call_arguments.delta", ...identity, delta };
    }
    const argumentsText = delta.repeat(deltas);
    yield { type: "response.function_call_arguments.done", ...identity, arguments: argumentsText };
    yield { type: "response.output_item.done", output_index: 7, item: { ...item, arguments: argumentsText } };
    yield { type: terminal, response: { output: [{ ...item, arguments: argumentsText }] } };
  }

  async function runLeg(events: Iterable<Payload>) {
    const iterator = events[Symbol.iterator]();
    const probe = { reads: 0, cancelled: false, executions: 0, sends: 0 };
    // One frame per pull: a cumulative-limit test must not trip the unrelated single-SSE bound.
    const firstLeg = new ReadableStream<Uint8Array>({
      pull(controller) {
        probe.reads++;
        const next = iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(bytes("data: " + JSON.stringify(next.value) + "\n\n"));
      },
      cancel() {
        probe.cancelled = true;
        iterator.return?.();
      },
    }, { highWaterMark: 0 });
    const body = createPassthroughWebSearchBridgeStream({
      plan: { backend: "ollama", endpoint: "https://example.com/search", maxSearches: 3, timeoutMs: 1_000 },
      firstLeg,
      requestBody: '{"input":[],"stream":true}',
      execute: async () => {
        probe.executions++;
        return { text: "result", sources: [] };
      },
      send: async () => {
        probe.sends++;
        throw new Error("a mixed or failed test leg must not continue");
      },
    });
    const wire = await new Response(body).text();
    const output: Event[] = wire.split("\n")
      .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6)) as Event);
    return { wire, output, probe };
  }

  function expectFailedClosed(result: Awaited<ReturnType<typeof runLeg>>): void {
    const failures = result.output.filter(event => event.type === "response.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.response?.error?.code).toBe(WEB_SEARCH_BRIDGE_ERROR_CODE);
    expect(result.wire.includes('"name":"exec"')).toBe(false);
    expect(result.output.some(event => event.type.startsWith("response.function_call_arguments."))).toBe(false);
    expect(result.probe.executions).toBe(0);
    expect(result.probe.sends).toBe(0);
    expect(result.wire.split("data: [DONE]").length - 1).toBe(1);
    expect(result.wire.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(result.output.map(event => event.sequence_number)).toEqual(result.output.map((_, index) => index));
  }

  /** Overflow is the bridge's own admission bound, so it must not be blamed on the upstream. */
  function expectBridgeOwnedOverflow(result: Awaited<ReturnType<typeof runLeg>>): void {
    const message = result.output.at(-1)?.response?.error?.message ?? "";
    expect(message).toContain("web-search bridge withheld more client tool events");
    expect(message).not.toContain("upstream read failed");
  }

  test.each([false, true])("bounds tiny delta events matched by item id only: %s", async itemIdOnly => {
    // Minimal delta frames are far below the derived 128-code-unit average, so the event
    // count is what stops this leg, not the character budget.
    const result = await runLeg(legEvents(MAX_HELD_CALL_EVENTS, "x", 0, itemIdOnly));
    expectFailedClosed(result);
    expectBridgeOwnedOverflow(result);
    expect(result.probe.reads).toBe(MAX_HELD_CALL_EVENTS + 1);
    expect(result.probe.cancelled).toBe(true);
  });

  test("bounds repeated client-call added events as well as deltas", async () => {
    function* additions(): Generator<Payload> {
      for (let index = 0; index < MAX_HELD_CALL_EVENTS; index++) {
        yield {
          type: "response.output_item.added", output_index: index,
          item: { type: "function_call", id: "tool-" + index, call_id: "call-" + index, name: "exec", arguments: "" },
        };
      }
    }
    const result = await runLeg(additions());
    expectFailedClosed(result);
    // An added frame serializes well above the 128-code-unit average the event cap is derived
    // from, so the character budget binds first here. Both bounds still fail the leg cleanly.
    expect(result.probe.reads).toBeLessThan(MAX_HELD_CALL_EVENTS);
    expect(result.probe.reads).toBeGreaterThan(1);
    expect(result.probe.cancelled).toBe(true);
  });

  test("bounds cumulative payload characters while individual frames and event count remain small", async () => {
    const result = await runLeg(legEvents(140, "x".repeat(64 * 1024), 0, true));
    expectFailedClosed(result);
    expectBridgeOwnedOverflow(result);
    expect(result.probe.reads).toBeLessThan(140);
    expect(result.probe.cancelled).toBe(true);
  });

  test("closes every opened search before failing a withheld-event budget overflow", async () => {
    const result = await runLeg(legEvents(140, "x".repeat(64 * 1024), 2));
    expectFailedClosed(result);
    const opened = result.output.filter(event => event.type === "response.output_item.added");
    const closed = result.output.filter(event => event.type === "response.output_item.done");
    expect(opened).toHaveLength(2);
    expect(closed).toHaveLength(2);
    expect(closed.map(event => [event.item?.id, event.output_index])).toEqual(
      opened.map(event => [event.item?.id, event.output_index]),
    );
    expect(closed.map(event => event.item?.status)).toEqual(["failed", "failed"]);
    expect(result.output.slice(-3).map(event => event.type)).toEqual([
      "response.output_item.done", "response.output_item.done", "response.failed",
    ]);
    expect(result.probe.cancelled).toBe(true);
  });

  test("also closes opened searches when reading the upstream leg throws", async () => {
    function* broken(): Generator<Payload> {
      yield* Array.from(legEvents(0, "", 2)).slice(0, 3);
      throw new Error("synthetic read failure");
    }
    const result = await runLeg(broken());
    expectFailedClosed(result);
    const closed = result.output.filter(event => event.type === "response.output_item.done");
    expect(closed.map(event => event.item?.status)).toEqual(["failed", "failed"]);
    expect(result.output.at(-1)?.response?.error?.message).toContain("synthetic read failure");
  });

  test("releases exactly the held-event limit without loss and preserves remapped order", async () => {
    // added + deltas + arguments.done + item.done = exactly MAX_HELD_CALL_EVENTS withheld events.
    const deltasAtLimit = MAX_HELD_CALL_EVENTS - 3;
    const result = await runLeg(legEvents(deltasAtLimit, "x", 1));
    expect(result.output.some(event => event.type === "response.failed")).toBe(false);
    const deltas = result.output.filter(event => event.type === "response.function_call_arguments.delta");
    expect(deltas).toHaveLength(deltasAtLimit);
    expect(deltas.map(event => event.delta).join("")).toBe("x".repeat(deltasAtLimit));
    expect(deltas.every(event => event.output_index === 1)).toBe(true);
    const toolDone = result.output.find(event => event.type === "response.output_item.done" && event.item?.type === "function_call");
    expect(toolDone?.item?.arguments).toBe("x".repeat(deltasAtLimit));
    expect(result.output.at(-1)?.type).toBe("response.completed");
    expect(result.output.at(-1)?.response?.output).toHaveLength(2);
    expect(result.probe.executions).toBe(1);
    expect(result.probe.sends).toBe(0);
    expect(result.output.map(event => event.sequence_number)).toEqual(result.output.map((_, index) => index));
  });

  test.each(["response.failed", "response.incomplete"])("preserves mixed-leg terminal handling for %s", async terminal => {
    const result = await runLeg(legEvents(2, "x", 1, false, terminal));
    expect(result.output.at(-1)?.type).toBe(terminal);
    expect(result.probe.executions).toBe(0);
    expect(result.probe.sends).toBe(0);
    expect(result.wire.includes('"name":"exec"')).toBe(terminal === "response.incomplete");
    expect(result.output.find(event => event.item?.type === "web_search_call" && event.type === "response.output_item.done")?.item?.status).toBe("failed");
  });
});
