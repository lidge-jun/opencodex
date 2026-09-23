import { afterEach, describe, expect, test } from "bun:test";
import { cancelBodyOnAbort } from "../../src/lib/abort";
import { handleLive, readBodyCapped } from "../../src/server/live";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let releaseSpendHome: (() => void) | undefined;
afterEach(() => {
  // Release the lease before later teardown can replace the preload sandbox home.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
});

function bodyWithCancelSpy(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { /* never resolves; only cancel settles it */ },
    cancel() { cancelled = true; },
  });
  return { body, cancelled: () => cancelled };
}

describe("readBodyCapped settles the stream when a read throws", () => {
  test("a rejected read propagates and leaves no live reader lock", async () => {
    // Note on what this can and cannot assert: a source whose own `pull()` rejects is errored
    // by the stream machinery itself, which by spec does NOT invoke the source's `cancel()`.
    // So the observable contract here is that the failure propagates to the caller (whose
    // existing classification turns it into 499/504/502) and that the stream is left settled
    // rather than pending. The cancel path added alongside this covers the case where the
    // source is still live — an abort delivered while a read is outstanding.
    let cancelled = false;
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      pull() { return Promise.reject(new Error("upstream reset")); },
      cancel() { cancelled = true; },
    });

    await expect(readBodyCapped(failing, 1024, total => `too large (${total})`)).rejects.toThrow("upstream reset");
    // The stream errored itself, so `cancel()` is not expected to have run.
    expect(cancelled).toBe(false);
    // The lock is released even though the cancel rejected with the stored error: holding it
    // would leave the stream permanently locked for any later consumer. A second reader is
    // therefore obtainable, and it observes the original failure rather than hanging.
    expect(failing.locked).toBe(false);
    await expect(failing.getReader().read()).rejects.toThrow("upstream reset");
  });

  test("cancelBodyOnAbort cannot settle a body once a reader holds the lock", async () => {
    // The reason readBodyCapped needed its own cancel path. `cancelBodyOnAbort` calls
    // `body.cancel()`, which throws on a locked stream, so once `getReader()` has run the
    // guard alone can no longer settle the body — only the code holding the reader can.
    // This is why the guard is attached BEFORE the read (covering the pre-attach window) and
    // the reader cancels on failure (covering the window after it).
    let cancelled = false;
    const pending = new ReadableStream<Uint8Array>({
      pull() { return new Promise<never>(() => {}); },
      cancel() { cancelled = true; },
    });

    const reader = pending.getReader();
    const ac = new AbortController();
    cancelBodyOnAbort(pending, ac.signal);
    ac.abort(new DOMException("client closed request", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelled).toBe(false);

    // The reader itself can still settle it, which is what the new failure path does.
    await reader.cancel(new Error("client closed request"));
    expect(cancelled).toBe(true);
  });

  test("an aborted live relay reaches fetch before settling its locked upstream body", async () => {
    const originalFetch = globalThis.fetch;
    const requestAbort = new AbortController();
    const events: string[] = [];
    let rejectRead!: (reason: unknown) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });

    const reader = {
      read(): Promise<ReadableStreamReadResult<Uint8Array>> {
        events.push("reader.read");
        markReadStarted();
        return new Promise((_resolve, reject) => { rejectRead = reject; });
      },
      cancel(): Promise<void> {
        events.push("reader.cancel");
        return Promise.resolve();
      },
      releaseLock(): void {
        events.push("reader.releaseLock");
      },
    } as ReadableStreamDefaultReader<Uint8Array>;
    const body = {
      getReader(): ReadableStreamDefaultReader<Uint8Array> {
        events.push("body.getReader");
        return reader;
      },
      cancel(): Promise<void> {
        events.push("body.cancel");
        return Promise.reject(new TypeError("body is locked"));
      },
    } as ReadableStream<Uint8Array>;

    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("live relay omitted its upstream abort signal");
      signal.addEventListener("abort", () => {
        events.push("fetch.abort");
        rejectRead(signal.reason);
      }, { once: true });
      return {
        status: 201,
        headers: new Headers({ "content-type": "application/sdp" }),
        body,
      } as Response;
    }) as typeof fetch;

    const config = {
      defaultProvider: "openai-apikey",
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-live",
        },
      },
    } as OcxConfig;

    try {
      const pending = handleLive(new Request("http://localhost/v1/live", {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: "offer",
        signal: requestAbort.signal,
      }), config, { model: "", provider: "" });
      await readStarted;
      requestAbort.abort(new DOMException("client closed request", "AbortError"));

      expect((await pending).status).toBe(499);
      // Fetch observes the client abort first; the pre-reader guard then attempts body-level
      // settlement, and the reader owns the locked-stream fallback before releasing its lock.
      expect(events).toEqual([
        "body.getReader",
        "reader.read",
        "fetch.abort",
        "body.cancel",
        "reader.cancel",
        "reader.releaseLock",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    { label: "passthrough", adapter: "openai-responses", model: "fixture/model", combos: undefined },
    { label: "translated adapter", adapter: "openai-chat", model: "fixture/model", combos: undefined },
    {
      label: "combo",
      adapter: "openai-responses",
      model: "combo/fallback",
      combos: { fallback: { strategy: "failover" as const, targets: [{ provider: "fixture", model: "model" }] } },
    },
  ] as const)("$label Responses failure consumes each original body exactly once", async ({ adapter, model, combos }) => {
    const originalFetch = globalThis.fetch;
    const bodyReads: number[] = [];
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: "upstream failed" } })));
          controller.close();
        },
      });
      const response = new Response(body, {
        status: 503,
        headers: { "content-type": "application/json" },
      });
      const index = bodyReads.push(0) - 1;
      Object.defineProperty(response, "body", {
        configurable: true,
        get() {
          bodyReads[index] += 1;
          return body;
        },
      });
      return response;
    }) as typeof fetch;

    const config = {
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter,
          baseUrl: "https://fixture.example.test/v1",
          apiKey: "sk-test",
        },
      },
      ...(combos ? { combos } : {}),
    } as OcxConfig;

    try {
      // Direct dispatch needs the writer lease that prevents spend-ledger ownership failures.
      releaseSpendHome = acquireOwnedSpendHome();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "hello", stream: false }),
      }), config, { model: "", provider: "" });
      await response.text();
      expect(bodyReads.length).toBeGreaterThan(0);
      expect(bodyReads.every(reads => reads === 1)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("terminal continuation failure consumes its original body exactly once", async () => {
    const originalFetch = globalThis.fetch;
    const continuationBodyReads: number[] = [];
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) {
        return new Response([
          'data: {"choices":[{"delta":{"content":"我接下来会修改相关文件。"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: "continuation failed" } })));
          controller.close();
        },
      });
      const response = new Response(body, {
        status: 503,
        headers: { "content-type": "application/json" },
      });
      const index = continuationBodyReads.push(0) - 1;
      Object.defineProperty(response, "body", {
        configurable: true,
        get() {
          continuationBodyReads[index] += 1;
          return body;
        },
      });
      return response;
    }) as typeof fetch;

    const config = {
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "https://fixture.example.test/v1",
          apiKey: "sk-test",
          terminalContinuationGuard: true,
        },
      },
    } as OcxConfig;

    try {
      releaseSpendHome = acquireOwnedSpendHome();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/model",
          input: "请检查这个问题并修复代码",
          stream: true,
          tools: [{
            type: "function",
            name: "exec_command",
            description: "run a command",
            parameters: { type: "object" },
          }],
        }),
      }), config, { model: "", provider: "" });
      await response.text();

      expect(response.status).toBe(200);
      expect(continuationBodyReads.length).toBeGreaterThan(0);
      expect(continuationBodyReads.every(reads => reads === 1)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a normal read still returns the buffered payload", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });

    const payload = await readBodyCapped(body, 1024, total => `too large (${total})`);
    expect(payload).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(payload as ArrayBuffer)).toBe("hello");
  });

  test("the byte cap still short-circuits with a 502 rather than throwing", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });

    const payload = await readBodyCapped(body, 8, total => `too large (${total})`);
    expect(payload).toBeInstanceOf(Response);
    expect((payload as Response).status).toBe(502);
  });
});

describe("cancelBodyOnAbort", () => {
  test("cancels the body when the signal aborts", async () => {
    const { body, cancelled } = bodyWithCancelSpy();
    const ac = new AbortController();
    cancelBodyOnAbort(body, ac.signal);
    expect(cancelled()).toBe(false);
    ac.abort(new DOMException("superseded", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled()).toBe(true);
  });

  test("cancels immediately when the signal is already aborted", async () => {
    const { body, cancelled } = bodyWithCancelSpy();
    const ac = new AbortController();
    ac.abort(new DOMException("already", "AbortError"));
    cancelBodyOnAbort(body, ac.signal);
    await Promise.resolve();
    expect(cancelled()).toBe(true);
  });

  test("detach() prevents cancellation on the normal path", async () => {
    const { body, cancelled } = bodyWithCancelSpy();
    const ac = new AbortController();
    const detach = cancelBodyOnAbort(body, ac.signal);
    detach();
    ac.abort(new DOMException("late", "AbortError"));
    await Promise.resolve();
    expect(cancelled()).toBe(false);
    await body.cancel().catch(() => {});
  });

  test("no-ops when body or signal is missing", () => {
    expect(() => cancelBodyOnAbort(null, new AbortController().signal)).not.toThrow();
    const { body } = bodyWithCancelSpy();
    expect(() => cancelBodyOnAbort(body, undefined)).not.toThrow();
    void body.cancel().catch(() => {});
  });
});
