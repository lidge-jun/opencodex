import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import { sleepWithAbort } from "../../src/lib/upstream-retry";
import {
  providerRequestPacingStatus,
  resetProviderRequestPacingForTest,
  waitForProviderRequestSlot,
} from "../../src/providers/request-pacing";
import { parseRequest } from "../../src/responses/parser";
import { providerFetch, type ProviderFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";
import { runWithWebSearch, type WebSearchLoopDeps } from "../../src/web-search/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const HEADER_MS = 60;
const QUEUE_MS = 180;
const NAME = "search-pacing-test";
const MODEL = "model";
const provider: OcxProviderConfig = {
  adapter: "openai-chat", baseUrl: "https://routed.test/v1",
  requestPacing: { enabled: true, maxConcurrentRequests: 1 },
};

afterEach(() => resetProviderRequestPacingForTest());

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
    connectTimeoutMs: HEADER_MS,
    ...overrides,
  });
}

async function expectSuccess(pending: Promise<Response>) {
  const response = await pending;
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("response.completed");
  expect(body).not.toContain("response.failed");
}

async function expectTimeout(pending: Promise<Response>, timeoutMs = HEADER_MS) {
  const response = await pending;
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ error: {
    message: `Provider response-header timeout after ${timeoutMs}ms during web-search`,
    type: "upstream_error", code: null,
  } });
}

async function waitUntilQueued(configured = provider) {
  for (let i = 0; i < 1000; i++) {
    if (providerRequestPacingStatus(NAME, configured).queued > 0) return;
    await Bun.sleep(1);
  }
  throw new Error("send never entered pacing queue");
}

describe("web-search pacing and response-header deadline", () => {
  for (const adapterSend of [false, true]) {
    test(`${adapterSend ? "adapter fetchResponse" : "ordinary fetch"} excludes a queue wait longer than its header deadline`, async () => {
      const held = await waitForProviderRequestSlot(NAME, provider, MODEL);
      let sends = 0;
      const executor = fetcher(async () => { sends++; return new Response("ok"); });
      const pending = run(executor, { adapter: adapter(adapterSend) });
      const release = setTimeout(() => held.release(), QUEUE_MS);
      try {
        await expectSuccess(pending);
        expect(sends).toBe(1);
        expect(providerRequestPacingStatus(NAME, provider)).toMatchObject({ queued: 0, inFlight: 0 });
      } finally { clearTimeout(release); held.release(); }
    });

    test(`${adapterSend ? "adapter fetchResponse" : "ordinary fetch"} still times out genuine header stalls and releases its lease`, async () => {
      const executor = fetcher(async init => {
        await sleepWithAbort(10_000, init?.signal ?? undefined);
        return new Response("unreachable");
      });
      await expectTimeout(run(executor, { adapter: adapter(adapterSend) }));
      expect(providerRequestPacingStatus(NAME, provider)).toMatchObject({ queued: 0, inFlight: 0 });
    });
  }

  test("client cancellation removes a queued send and leaves the next slot available", async () => {
    const held = await waitForProviderRequestSlot(NAME, provider, MODEL);
    const caller = new AbortController();
    let sends = 0;
    const executor = fetcher(async () => { sends++; return new Response("ok"); });
    const pending = run(executor, { abortSignal: caller.signal });
    await waitUntilQueued();
    caller.abort(new DOMException("client left", "AbortError"));
    const response = await pending;
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
      const configured = { ...provider, requestPacing: { ...provider.requestPacing,
        minIntervalMs: recovery === "reset" ? QUEUE_MS * 5 : QUEUE_MS } };
      let sends = 0;
      const executor = fetcher(async () => {
        if (++sends === 1) {
          if (recovery === "reset") throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
          return new Response("limited", { status: 429 });
        }
        return new Response("ok");
      }, configured);
      await expectSuccess(run(executor, {
        // Reset recovery retains its existing 120-180ms backoff inside the budget.
        connectTimeoutMs: recovery === "reset" ? HEADER_MS * 5 : HEADER_MS,
        ...(recovery === "same-target" ? { retryOn429Policy: {
          enabled: true, attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false,
        } } : {}),
        ...(recovery === "rotation" ? { on429: () => ({ adapter: adapter(true), recoveryKind: "key-429" }) } : {}),
      }));
      expect(sends).toBe(2);
      expect(providerRequestPacingStatus(NAME, configured)).toMatchObject({ queued: 0, inFlight: 0 });
    });
  }

  test("an adapter that calls its executor directly also excludes pacing", async () => {
    const held = await waitForProviderRequestSlot(NAME, provider, MODEL);
    const direct = adapter();
    direct.fetchResponse = (request, ctx) => ctx!.executor!(request.url, { signal: ctx?.abortSignal });
    const pending = run(fetcher(async () => new Response("ok")), { adapter: direct });
    const release = setTimeout(() => held.release(), QUEUE_MS);
    try { await expectSuccess(pending); }
    finally { clearTimeout(release); held.release(); }
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
    await expectSuccess(run(executor, { adapter: retrying }));
    expect(sends).toBe(2);
    expect(providerRequestPacingStatus(NAME, configured)).toMatchObject({ queued: 0, inFlight: 0 });
  });

  test("final headers keep the pacing lease until the streamed body finishes", async () => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
    const response = await run(fetcher(async () => new Response(upstream)));
    expect(response.status).toBe(200);
    expect(providerRequestPacingStatus(NAME, provider).inFlight).toBe(1);
    bodyController.enqueue(new TextEncoder().encode("ok"));
    bodyController.close();
    expect(await response.text()).toContain("response.completed");
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
    await expectTimeout(run(executor, { connectTimeoutMs: 110,
      on429: () => ({ adapter: adapter(), recoveryKind: "key-429" }),
    }), 110);
    expect(sends).toBe(1);
    expect(started).toBe(2);
    expect(providerRequestPacingStatus(NAME, configured)).toMatchObject({ queued: 0, inFlight: 0 });
  });
});
