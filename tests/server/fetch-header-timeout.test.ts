import { afterEach, describe, expect, jest, test } from "bun:test";
import { fetchWithHeaderTimeout } from "../../src/server/responses";
import { isNonReplayableResponse, isReplayRefusalResponse } from "../../src/lib/upstream-retry";
import { fetchVertexWithRetry } from "../../src/adapters/google-http";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

test("physical headers end the production adapter deadline without reading the no-retry body", async () => {
  jest.useFakeTimers();
  const caller = new AbortController();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let physicalSignal!: AbortSignal;
  let headersArrived!: () => void;
  const headers = new Promise<void>(resolve => { headersArrived = resolve; });
  const physical = (async (_input, init) => {
    physicalSignal = init!.signal!;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    physicalSignal.addEventListener("abort", () => controller.error(physicalSignal.reason), { once: true });
    headersArrived();
    return new Response(body, { status: 429, headers: { "content-type": "application/json", "x-should-retry": "false" } });
  }) as typeof fetch;
  try {
    let settled = false;
    const pending = fetchVertexWithRetry({ url: "https://fixture.example/v1/responses", method: "POST", headers: {}, body: "{}" },
      { abortSignal: caller.signal, timeoutMs: 100, returnRawErrors: true, executor: physical });
    void pending.then(() => { settled = true; });
    await headers;
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(settled).toBe(true);
    jest.advanceTimersByTime(140);
    expect(physicalSignal.aborted).toBe(false);
    const raw = JSON.stringify({ error: { code: "upstream_response_refused", message: "Fixture refusal" } });
    controller.enqueue(new TextEncoder().encode(raw)); controller.close();
    const response = await pending;
    expect(isReplayRefusalResponse(response)).toBe(false);
    expect(await response.text()).toBe(raw);
  } finally { caller.abort(); jest.useRealTimers(); }
});

test("a dispatched POST's own header deadline refuses replay without claiming quota", async () => {
  jest.useFakeTimers();
  let received = 0;
  const bodyReceived = Promise.withResolvers<void>();
  const caller = new AbortController();
  let settle: ((response: Response) => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      expect(await request.text()).toBe('{"fixture":true}');
      received++;
      bodyReceived.resolve();
      return new Promise<Response>(resolve => { settle = resolve; });
    },
  });
  try {
    const pending = fetchWithHeaderTimeout(server.url.toString(), {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"fixture":true}',
    }, caller.signal, 300);
    await Promise.race([bodyReceived.promise, pending.then(() => { throw new Error("response preceded the fixture body receipt"); })]);
    jest.advanceTimersByTime(301);
    const response = await pending;
    expect(received).toBe(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(isNonReplayableResponse(response)).toBe(true);
    expect(isReplayRefusalResponse(response)).toBe(true);
    expect(await response.json()).toMatchObject({ error: {
      code: "upstream_reset_replay_refused", message: expect.stringContaining("may already have been processed"),
    } });
  } finally {
    caller.abort();
    settle?.(new Response(null, { status: 499 }));
    try { await server.stop(true); } finally { jest.useRealTimers(); }
  }
});

test("an unrelated POST TimeoutError is not our header deadline", async () => {
  const unrelated = new DOMException("Executor's independent deadline", "TimeoutError");
  await expect(fetchWithHeaderTimeout("http://127.0.0.1:1", { method: "POST" },
    new AbortController().signal, 300, false, (async () => { throw unrelated; }) as typeof fetch))
    .rejects.toBe(unrelated);
});

test("caller cancellation wins even when our POST header deadline already fired", async () => {
  const caller = new AbortController(), cancelled = new DOMException("Caller cancelled", "AbortError");
  const executor = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => {
      caller.abort(cancelled); reject(init!.signal!.reason);
    }, { once: true });
  })) as typeof fetch;
  await expect(fetchWithHeaderTimeout("http://127.0.0.1:1", { method: "POST" },
    caller.signal, 20, false, executor)).rejects.toBe(cancelled);
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startHeaderEchoServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return new Response(req.headers.get("accept-encoding") ?? "");
    },
  });
  servers.push(server);
  return server;
}

async function observedEncoding(headers: HeadersInit | undefined, streaming: boolean): Promise<string> {
  const server = startHeaderEchoServer();
  const response = await fetchWithHeaderTimeout(
    server.url.toString(),
    { headers },
    new AbortController().signal,
    1_000,
    streaming,
  );
  return response.text();
}

function delayedSseStream(delayMs = 80): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: first\n\n"));
      setTimeout(() => {
        controller.enqueue(encoder.encode("data: second\n\n"));
        controller.close();
      }, delayMs);
    },
  });
}

function startCompressionAwareSseServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const acceptsGzip = req.headers.get("accept-encoding")?.includes("gzip") === true;
      const body = acceptsGzip
        ? delayedSseStream().pipeThrough(new CompressionStream("gzip"))
        : delayedSseStream();
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          ...(acceptsGzip ? { "content-encoding": "gzip" } : {}),
        },
      });
    },
  });
  servers.push(server);
  return server;
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  return new TextDecoder().decode(chunk.value);
}

describe("fetchWithHeaderTimeout content-encoding policy", () => {
  test("streaming defaults to identity while non-streaming keeps Bun negotiation", async () => {
    expect(await observedEncoding(undefined, true)).toBe("identity");
    const nonStreaming = await observedEncoding(undefined, false);
    expect(nonStreaming).toContain("gzip");
    expect(nonStreaming).not.toBe("identity");
  });

  test("explicit caller encoding wins for every HeadersInit shape", async () => {
    expect(await observedEncoding({ "Accept-Encoding": "gzip" }, true)).toBe("gzip");
    expect(await observedEncoding([["aCcEpT-EnCoDiNg", "br"]], true)).toBe("br");
    expect(await observedEncoding(new Headers({ "ACCEPT-ENCODING": "deflate" }), true)).toBe("deflate");
  });

  test("identity keeps SSE frames incremental instead of waiting for a gzip block", async () => {
    const server = startCompressionAwareSseServer();

    const compressed = await fetchWithHeaderTimeout(
      server.url.toString(),
      {},
      new AbortController().signal,
      1_000,
      false,
    );
    const compressedReader = compressed.body!.getReader();
    expect(await readChunk(compressedReader)).toBe("data: first\n\ndata: second\n\n");

    const identity = await fetchWithHeaderTimeout(
      server.url.toString(),
      {},
      new AbortController().signal,
      1_000,
      true,
    );
    const identityReader = identity.body!.getReader();
    expect(await readChunk(identityReader)).toBe("data: first\n\n");
    expect(await readChunk(identityReader)).toBe("data: second\n\n");
  });
});

describe("#2567 the upstream fetch disables Bun's per-request idle timeout", () => {
  /**
   * Bun's default socket idle timeout kills a long-quiet upstream turn even though the
   * application-level deadline (AbortSignal) has not fired. Passing `timeout: 0` disables the
   * per-request idle timer; the signal remains the only deadline that can end the request.
   *
   * These pin the propagation on all three call sites, because the value is easy to drop in a
   * refactor and its absence is invisible until a slow provider stalls in production.
   */
  function recordingFetch(): { calls: RequestInit[]; fetch: typeof globalThis.fetch } {
    const calls: RequestInit[] = [];
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  }

  test("providerFetch passes timeout: 0 to the underlying fetch", async () => {
    const { providerFetch } = await import("../../src/server/responses/fetch-helpers");
    const { calls, fetch } = recordingFetch();
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://upstream.example.test/v1",
      fetch,
    } as unknown as Parameters<typeof providerFetch>[0];

    await providerFetch(provider)("https://upstream.example.test/v1/chat/completions", { method: "POST" });

    expect(calls.length).toBe(1);
    expect((calls[0] as { timeout?: number }).timeout).toBe(0);
  });

  test("fetchWithHeaderTimeout passes timeout: 0 while keeping its abort signal", async () => {
    const server = startHeaderEchoServer();
    const seen: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return originalFetch(input as string, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      await fetchWithHeaderTimeout(
        server.url.toString(),
        {},
        new AbortController().signal,
        1_000,
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seen.length).toBeGreaterThan(0);
    const init = seen[0] as { timeout?: number; signal?: AbortSignal };
    expect(init.timeout).toBe(0);
    // The application deadline must survive: disabling the idle timer is not the same as
    // removing the deadline.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("fetchWithHeaderDeadline passes timeout: 0 to its injected fetch", async () => {
    const { fetchWithHeaderDeadline } = await import("../../src/server/claude-messages");
    const { calls, fetch } = recordingFetch();

    const result = await fetchWithHeaderDeadline(
      "https://upstream.example.test/v1/messages",
      { method: "POST" },
      1_000,
      undefined,
      undefined,
      fetch,
    );

    expect(result.kind).toBe("response");
    expect(calls.length).toBe(1);
    const init = calls[0] as { timeout?: number; signal?: AbortSignal };
    expect(init.timeout).toBe(0);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("replacement key admission excludes the response-header deadline", () => {
  async function replacementFixture(physicalFetch: typeof fetch) {
    const { providerFetch } = await import("../../src/server/responses/fetch-helpers");
    const { waitForProviderRequestSlot, resetProviderRequestPacingForTest } = await import("../../src/providers/request-pacing");
    resetProviderRequestPacingForTest();
    const provider = { adapter: "openai-chat", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-A",
      apiKeyPool: [{ id: "a", key: "fixture-A", addedAt: 1 }, { id: "b", key: "fixture-B", addedAt: 2 }],
      requestPacing: { enabled: true, keys: { maxConcurrentRequests: 1 } } } as import("../../src/types").OcxProviderConfig;
    const replacement = { ...provider, apiKey: "fixture-B" };
    const held = await waitForProviderRequestSlot("header-replacement", replacement);
    let notify!: () => void;
    const queued = new Promise<void>(resolve => { notify = resolve; });
    const executor = providerFetch({ ...provider, fetch: physicalFetch } as typeof provider, undefined, { providerName: "header-replacement",
      dispatchOverride: async (input, init, execute, reacquire) => {
        notify();
        await reacquire!(replacement);
        return execute(input, init);
      } });
    return { executor, held, queued, resetProviderRequestPacingForTest };
  }

  test("a blocked replacement may wait beyond the header timeout and then send", async () => {
    let sends = 0;
    const fixture = await replacementFixture((async () => { sends++; return new Response("ok"); }) as typeof fetch);
    const pending = fetchWithHeaderTimeout("https://fixture.test/v1/chat/completions", {}, new AbortController().signal, 25, false, fixture.executor);
    void pending.catch(() => {});
    try {
      await fixture.queued;
      await Bun.sleep(80);
      expect(sends).toBe(0);
      fixture.held.release();
      expect(await (await pending).text()).toBe("ok");
      expect(sends).toBe(1);
    } finally { fixture.held.release(); fixture.resetProviderRequestPacingForTest(); }
  });

  test("the fresh header deadline still aborts a stalled physical send", async () => {
    let sends = 0;
    const fixture = await replacementFixture((async (_input, init) => {
      sends++;
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }) as typeof fetch);
    const pending = fetchWithHeaderTimeout("https://fixture.test/v1/chat/completions", {}, new AbortController().signal, 25, false, fixture.executor);
    void pending.catch(() => {});
    try {
      await fixture.queued;
      await Bun.sleep(80);
      fixture.held.release();
      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      expect(sends).toBe(1);
    } finally { fixture.held.release(); fixture.resetProviderRequestPacingForTest(); }
  });

  test("client abort remains active while replacement admission waits", async () => {
    let sends = 0;
    const fixture = await replacementFixture((async () => { sends++; return new Response("ok"); }) as typeof fetch);
    const controller = new AbortController();
    const pending = fetchWithHeaderTimeout("https://fixture.test/v1/chat/completions", {}, controller.signal, 25, false, fixture.executor);
    void pending.catch(() => {});
    try {
      await fixture.queued;
      controller.abort(new DOMException("client cancelled", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(sends).toBe(0);
    } finally { fixture.held.release(); fixture.resetProviderRequestPacingForTest(); }
  });
});

for (const policy of [
  { enabled: true, keySelection: "round-robin", minIntervalMs: 1 },
  { enabled: true, keys: { minIntervalMs: 1 } },
] as const) test(`key pacing keeps WebSocket requests on the guarded HTTP path: ${JSON.stringify(policy)}`, async () => {
  const { providerFetch } = await import("../../src/server/responses/fetch-helpers");
  const { resetProviderRequestPacingForTest } = await import("../../src/providers/request-pacing");
  const { BOUNDED_WS_RUNTIME } = await import("../helpers/ws-upstream-fixtures");
  const previousSocket = globalThis.WebSocket;
  let sockets = 0; let overrides = 0; const sentKeys: (string | null)[] = [];
  globalThis.WebSocket = class { constructor() { sockets++; throw new Error("unexpected WebSocket dispatch"); } } as unknown as typeof WebSocket;
  const physical = (async (_input, init) => {
    sentKeys.push(new Headers(init?.headers).get("authorization"));
    return new Response("fixture reply");
  }) as typeof fetch;
  const provider = { adapter: "openai-responses", authMode: "key", baseUrl: "https://api.openai.com/v1",
    upstreamWebsocket: true, apiKey: "fixture-A", requestPacing: policy, fetch: physical,
  } as import("../../src/types").OcxProviderConfig;
  try {
    const executor = providerFetch(provider, BOUNDED_WS_RUNTIME, { providerName: "ws-key-pacing",
      dispatchOverride: async (input, init, execute, reacquire) => {
        overrides++;
        await reacquire!({ ...provider, apiKey: "fixture-B" });
        return execute(input, { ...init, headers: { authorization: "Bearer fixture-B" } });
      },
    });
    const response = await executor("https://api.openai.com/v1/responses", { method: "POST",
      headers: { authorization: "Bearer fixture-A", "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", stream: true, input: [] }),
    });
    expect(await response.text()).toBe("fixture reply");
    expect(overrides).toBe(1);
    expect(sockets).toBe(0);
    expect(sentKeys).toEqual(["Bearer fixture-B"]);
  } finally { globalThis.WebSocket = previousSocket; resetProviderRequestPacingForTest(); }
});
