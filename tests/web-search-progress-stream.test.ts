import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  parseStreamWithProgress,
  RoutedModelInactivityError,
  WebSearchStreamProtocolError,
} from "../src/web-search/progress-stream";
import type { AdapterEvent } from "../src/types";

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
    const response = new Response(chunkStream([
      { after: 15, value: "a" },
      { after: 15, value: "b" },
      { after: 15, value: "c" },
      { after: 15, value: "d" },
    ]));
    const events = await collect(parseStreamWithProgress(response, drainThenDone, { inactivityTimeoutMs: 30 }));
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
    const parser: ParseStream = async function* () {
      yield { type: "text_delta", text: "a" };
      marks.push("requested-second");
      yield { type: "text_delta", text: "b" };
      marks.push("requested-done");
      yield { type: "done" };
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
      await sleep(20);
      returned = true;
    };
    const iterator = parseStreamWithProgress(new Response(chunkStream([])), parser, { inactivityTimeoutMs: 100 });
    const next = await iterator.next();
    expect(returned).toBe(true);
    expect(next.value).toEqual({ type: "done", usage: { inputTokens: 1, outputTokens: 2 } });
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
