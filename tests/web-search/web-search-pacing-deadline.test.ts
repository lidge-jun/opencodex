import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import { sleepWithAbort } from "../../src/lib/upstream-retry";
import {
  providerRequestPacingStatus,
  RequestPacingQueueOverloadError,
  resetProviderRequestPacingForTest,
  waitForProviderRequestSlot,
} from "../../src/providers/request-pacing";
import { parseRequest } from "../../src/responses/parser";
import { providerFetch, type ProviderFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";
import { runWithWebSearch, type WebSearchLoopDeps } from "../../src/web-search/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Every deadline, pacing interval and backoff here runs on Bun's fake clock, which also drives
// Date.now() and performance.now(). Virtual time moves only in settle(), one millisecond per step
// after the pending work has drained, so a loaded runner that stalls the event loop cannot spend
// a header budget and each case can assert the exact virtual time its contract implies (#6988).
const HEADER_MS = 60;
const QUEUE_MS = 180;
// Far below every margin the cases distinguish (40ms of rotation budget, a 60ms header budget).
const DRAIN_SLACK_MS = 20;
const NAME = "search-pacing-test";
const MODEL = "model";
const provider: OcxProviderConfig = {
  adapter: "openai-chat", baseUrl: "https://routed.test/v1",
  requestPacing: { enabled: true, maxConcurrentRequests: 1 },
};

// Each case's turn signal is aborted in cleanup, and streams a case opened are torn down, so a case that
// fails mid-flight cannot leave a queued send, a pending deadline or an open stream running into the next
// file in the same Bun process. Real timers come back even if that teardown throws.
let turn = new AbortController();
let teardown: Array<() => unknown> = [];
beforeEach(() => {
  turn = new AbortController();
  teardown = [];
  jest.useFakeTimers();
});
afterEach(async () => {
  try {
    turn.abort(new DOMException("test finished", "AbortError"));
    for (const step of teardown.splice(0)) await step();
    await drain();
    resetProviderRequestPacingForTest();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

/** Let promise chains and stream reads finish without moving the virtual clock. */
async function drain(turns = 8) {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** Advance virtual time until `pending` settles; return its value and the virtual ms it took. */
async function settle<T>(pending: Promise<T>, limitMs = 10_000): Promise<{ value: T; atMs: number }> {
  const start = performance.now();
  let done = false;
  const observed = pending.finally(() => { done = true; });
  observed.catch(() => {});
  await drain();
  while (!done) {
    if (performance.now() - start >= limitMs) throw new Error(`still pending after ${limitMs} virtual ms`);
    jest.advanceTimersByTime(1);
    await drain();
  }
  return { value: await observed, atMs: performance.now() - start };
}

function adapter(adapterSend = false): ProviderAdapter {
  return {
    name: "pacing-deadline",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    ...(adapterSend ? {
      fetchResponse: (request, ctx) => createAdapterPhysicalSend(ctx)({
        url: request.url,
        dispatch: executor => executor(request.url, { method: request.method, signal: ctx?.abortSignal }),
      }),
    } satisfies Pick<ProviderAdapter, "fetchResponse"> : {}),
    async *parseStream(response) {
      await response.text();
      yield { type: "text_delta", text: "answer" };
      yield { type: "done" };
    },
  };
}

function fetcher(send: (init?: RequestInit) => Promise<Response>, configured = provider): ProviderFetch {
  const physical = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => send(init),
    { preconnect() {} }) as typeof fetch;
  return providerFetch({ ...configured, fetch: physical } as OcxProviderConfig & { fetch: typeof fetch },
    undefined, { providerName: NAME, modelId: MODEL });
}

function run(executor: ProviderFetch, overrides: Partial<WebSearchLoopDeps> = {}) {
  return runWithWebSearch({
    parsed: parseRequest({ model: `routed/${MODEL}`, input: "hello", stream: true, tools: [{ type: "web_search" }] }),
    adapter: adapter(),
    incomingMeta: { headers: new Headers(), providerFetch: executor, translatorBudget: createTestTranslatorBudget() },
    forwardProvider: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" },
    hostedTool: { type: "web_search" }, selectedForwardHeaders: new Headers(),
    settings: { model: "search", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
    connectTimeoutMs: HEADER_MS, abortSignal: turn.signal,
    ...overrides,
  });
}

/** Resolves to the virtual ms at which the final headers arrived. */
async function expectSuccess(pending: Promise<Response>): Promise<number> {
  const { value: response, atMs } = await settle(pending);
  expect(response.status).toBe(200);
  const { value: body } = await settle(response.text());
  expect(body).toContain("response.completed");
  expect(body).not.toContain("response.failed");
  return atMs;
}

/** Resolves to the virtual ms at which the 504 was returned. */
async function expectTimeout(pending: Promise<Response>, timeoutMs = HEADER_MS): Promise<number> {
  const { value: response, atMs } = await settle(pending);
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ error: {
    message: `Provider response-header timeout after ${timeoutMs}ms during web-search`,
    type: "upstream_error", code: null,
  } });
  return atMs;
}

/** A deadline or slot fires at `expectedMs`; observation may trail it by bounded slack while continuations drain. */
function expectAt(atMs: number, expectedMs: number) {
  expect(atMs).toBeGreaterThanOrEqual(expectedMs);
  expect(atMs).toBeLessThan(expectedMs + DRAIN_SLACK_MS);
}

async function waitUntilQueued(configured = provider) {
  for (let i = 0; i < 1000; i++) {
    if (providerRequestPacingStatus(NAME, configured).queued > 0) return;
    await drain(1);
  }
  throw new Error("send never entered pacing queue");
}

describe("web-search pacing and response-header deadline", () => {
  test.each([0, -1])("disabled header budget %s survives pacing admission and retains cancellation", async connectTimeoutMs => {
    let sends = 0;
    const executor = fetcher(async () => { sends++; return new Response("ok"); });
    await expectSuccess(run(executor, { connectTimeoutMs }));
    expect(sends).toBe(1);
    const held = await waitForProviderRequestSlot(NAME, provider, MODEL);
    const caller = new AbortController();
    const pending = run(executor, { connectTimeoutMs, abortSignal: caller.signal });
    await waitUntilQueued();
    caller.abort(new DOMException("client left", "AbortError"));
    expect((await settle(pending)).value.status).toBe(499);
    expect(sends).toBe(1);
    held.release();
  });

  for (const adapterSend of [false, true]) {
    test(`${adapterSend ? "adapter fetchResponse" : "ordinary fetch"} excludes a queue wait longer than its header deadline`, async () => {
      const held = await waitForProviderRequestSlot(NAME, provider, MODEL);
      let sends = 0;
      const executor = fetcher(async () => { sends++; return new Response("ok"); });
      setTimeout(() => held.release(), QUEUE_MS);
      expectAt(await expectSuccess(run(executor, { adapter: adapter(adapterSend) })), QUEUE_MS);
      expect(sends).toBe(1);
      expect(providerRequestPacingStatus(NAME, provider)).toMatchObject({ queued: 0, inFlight: 0 });
    });

    test(`${adapterSend ? "adapter fetchResponse" : "ordinary fetch"} still times out genuine header stalls and releases its lease`, async () => {
      const executor = fetcher(async init => {
        await sleepWithAbort(10_000, init?.signal ?? undefined);
        return new Response("unreachable");
      });
      expectAt(await expectTimeout(run(executor, { adapter: adapter(adapterSend) })), HEADER_MS);
      expect(providerRequestPacingStatus(NAME, provider)).toMatchObject({ queued: 0, inFlight: 0 });
    });
  }

  test("a pacing-queue overload passes through instead of becoming 502 Provider unreachable", async () => {
    const overload = new RequestPacingQueueOverloadError(NAME, "queue_full", 2);
    const pending = run(fetcher(() => Promise.reject(new Error("must not send"))), {
      adapter: { ...adapter(), fetchResponse: () => Promise.reject(overload) },
    }).then(response => response.status, (error: unknown) => error);
    expect((await settle(pending)).value).toBe(overload);
  });

  test("client cancellation removes a queued send and leaves the next slot available", async () => {
    const held = await waitForProviderRequestSlot(NAME, provider, MODEL);
    const caller = new AbortController();
    let sends = 0;
    const executor = fetcher(async () => { sends++; return new Response("ok"); });
    const pending = run(executor, { abortSignal: caller.signal });
    await waitUntilQueued();
    caller.abort(new DOMException("client left", "AbortError"));
    const { value: response } = await settle(pending);
    expect(response.status).toBe(499);
    expect(sends).toBe(0);
    expect(providerRequestPacingStatus(NAME, provider)).toMatchObject({ queued: 0, inFlight: 1 });
    held.release();
    await expectSuccess(run(executor));
    expect(sends).toBe(1);
    expect(providerRequestPacingStatus(NAME, provider).inFlight).toBe(0);
  });

  for (const recovery of ["same-target", "rotation", "reset"] as const) {
    test(`${recovery} replay excludes its own pacing wait`, async () => {
      const intervalMs = recovery === "reset" ? QUEUE_MS * 5 : QUEUE_MS;
      const configured = { ...provider, requestPacing: { ...provider.requestPacing, minIntervalMs: intervalMs } };
      let sends = 0;
      const executor = fetcher(async () => {
        if (++sends === 1) {
          if (recovery === "reset") throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
          return new Response("limited", { status: 429 });
        }
        return new Response("ok");
      }, configured);
      // The replay waits out the whole pacing interval, several header budgets long, and still succeeds the
      // moment its slot opens. Reset recovery retains its existing 120-180ms backoff inside the budget.
      expectAt(await expectSuccess(run(executor, {
        connectTimeoutMs: recovery === "reset" ? HEADER_MS * 5 : HEADER_MS,
        ...(recovery === "same-target" ? { retryOn429Policy: {
          enabled: true, attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false,
        } } : {}),
        ...(recovery === "rotation" ? { on429: () => ({ adapter: adapter(true), recoveryKind: "key-429" }) } : {}),
      })), intervalMs);
      expect(sends).toBe(2);
      expect(providerRequestPacingStatus(NAME, configured)).toMatchObject({ queued: 0, inFlight: 0 });
    });
  }

  test("an adapter that calls its executor directly also excludes pacing", async () => {
    const held = await waitForProviderRequestSlot(NAME, provider, MODEL);
    const direct = adapter();
    direct.fetchResponse = (request, ctx) => ctx!.executor!(request.url, { signal: ctx?.abortSignal });
    setTimeout(() => held.release(), QUEUE_MS);
    expectAt(await expectSuccess(run(fetcher(async () => new Response("ok")), { adapter: direct })), QUEUE_MS);
    expect(providerRequestPacingStatus(NAME, provider)).toMatchObject({ queued: 0, inFlight: 0 });
  });

  test("adapter-owned retries retain pacing seams on every physical send", async () => {
    const configured = { ...provider, requestPacing: { ...provider.requestPacing, minIntervalMs: QUEUE_MS } };
    let sends = 0;
    const executor = fetcher(async () => ++sends === 1
      ? new Response("limited", { status: 429 }) : new Response("ok"), configured);
    const retrying = adapter();
    retrying.fetchResponse = async (request, ctx) => {
      const send = createAdapterPhysicalSend(ctx);
      const dispatch = (physical: typeof fetch) => physical(request.url, { signal: ctx?.abortSignal });
      const first = await send({ url: request.url, dispatch });
      expect(first.status).toBe(429);
      await first.body?.cancel();
      return send({ url: request.url, recovery: "rate-limit-429", dispatch });
    };
    expectAt(await expectSuccess(run(executor, { adapter: retrying })), QUEUE_MS);
    expect(sends).toBe(2);
    expect(providerRequestPacingStatus(NAME, configured)).toMatchObject({ queued: 0, inFlight: 0 });
  });

  test("final headers keep the pacing lease until the streamed body finishes", async () => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
    const { value: response } = await settle(run(fetcher(async () => new Response(upstream))));
    teardown.push(
      () => response.body?.cancel().catch(() => {}),
      () => { try { bodyController.error(new Error("test finished")); } catch { /* already closed */ } },
    );
    expect(response.status).toBe(200);
    expect(providerRequestPacingStatus(NAME, provider).inFlight).toBe(1);
    bodyController.enqueue(new TextEncoder().encode("ok"));
    bodyController.close();
    expect((await settle(response.text())).value).toContain("response.completed");
    expect(providerRequestPacingStatus(NAME, provider).inFlight).toBe(0);
  });

  test("rotation retains cumulative network time instead of renewing the header budget", async () => {
    const configured = { ...provider, requestPacing: { ...provider.requestPacing, minIntervalMs: QUEUE_MS } };
    let sends = 0;
    let started = 0;
    const executor = fetcher(async init => {
      started++;
      await sleepWithAbort(70, init?.signal ?? undefined);
      return ++sends === 1 ? new Response("limited", { status: 429 }) : new Response("ok");
    }, configured);
    // The first send spends 70 of 110ms; the pacing wait until 180ms is excluded; the rotated send gets only
    // the remaining 40ms. A renewed budget would let it answer at 250ms, and a counted pacing wait would
    // expire at 110ms before it started.
    expectAt(await expectTimeout(run(executor, { connectTimeoutMs: 110,
      on429: () => ({ adapter: adapter(), recoveryKind: "key-429" }),
    }), 110), QUEUE_MS + 40);
    expect(sends).toBe(1);
    expect(started).toBe(2);
    expect(providerRequestPacingStatus(NAME, configured)).toMatchObject({ queued: 0, inFlight: 0 });
  });
});
