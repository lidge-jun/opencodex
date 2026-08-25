import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterFetchContext, ProviderAdapter } from "../src/adapters/base";
import { parseRequest } from "../src/responses/parser";
import { responseWithDeferredRequestLog, type RequestLogEntry } from "../src/server";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { runWithWebSearch as runWithWebSearchProduction, type WebSearchLoopDeps } from "../src/web-search/loop";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { OcxRequestValidationError } from "../src/lib/errors";

function runWithWebSearch(
  deps: Omit<WebSearchLoopDeps, "incomingMeta"> & { incomingMeta?: WebSearchLoopDeps["incomingMeta"] },
): Promise<Response> {
  return runWithWebSearchProduction({
    ...deps,
    incomingMeta: deps.incomingMeta ?? {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

function parsed() {
  return parseRequest({
    model: "routed/model",
    input: "Search current docs",
    stream: true,
    tools: [{ type: "web_search" }],
  });
}

function deps(adapter: ProviderAdapter, overrides: Record<string, unknown> = {}) {
  return {
    parsed: parsed(),
    adapter,
    forwardProvider,
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers({ authorization: "Bearer forwarded" }),
    settings: { model: "gpt-5.6-luna", reasoning: "low" as const, timeoutMs: 1_000 },
    maxSearches: 1,
    ...overrides,
  };
}

function hangingFetch(ctx?: AdapterFetchContext): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = ctx?.abortSignal;
    const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) rejectAbort();
    else signal?.addEventListener("abort", rejectAbort, { once: true });
  });
}

function silentResponse(onCancel?: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    cancel() {
      onCancel?.();
    },
  }), { status: 200 });
}

function parseBodyThen(events: AdapterEvent[]): ProviderAdapter["parseStream"] {
  return async function* (response) {
    await response.text();
    for (const event of events) yield event;
  };
}

interface SseFrame {
  event?: string;
  data: Record<string, unknown>;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n")
    .map(block => block.trim())
    .filter(block => block.length > 0 && block !== "data: [DONE]")
    .map(block => {
      const lines = block.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const data = lines.find(line => line.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

function terminalFrames(frames: SseFrame[]): SseFrame[] {
  return frames.filter(frame => [
    "response.completed",
    "response.incomplete",
    "response.failed",
  ].includes(frame.event ?? ""));
}

function wrapForLog(response: Response, entries: RequestLogEntry[]): Response {
  return responseWithDeferredRequestLog(
    response,
    "ocx-web-search-timeout-contract",
    Date.now(),
    { model: "routed/model", provider: "routed" },
    entry => entries.push(entry),
  );
}

describe("web-search timeout runtime contracts", () => {
  test("an erroring non-2xx body preserves provider status without leaking its stream failure", async () => {
    let parserCalls = 0;
    let formatterCalls = 0;
    let sidecarCalls = 0;
    globalThis.fetch = (async () => {
      sidecarCalls++;
      throw new Error("sidecar must not run");
    }) as typeof fetch;

    let pullCount = 0;
    const errorBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode("partial provider-secret"));
        } else {
          controller.error(new Error("provider-secret"));
        }
      },
    }, { highWaterMark: 0 });
    const adapter: ProviderAdapter = {
      name: "erroring-error-body",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response(errorBody, { status: 418 }),
      formatErrorBody: () => {
        formatterCalls++;
        return "formatter must not run";
      },
      async *parseStream() {
        parserCalls++;
        yield { type: "done" };
      },
      async parseResponse() {
        parserCalls++;
        return [{ type: "done" }];
      },
    };

    const response = await runWithWebSearch(deps(adapter));
    expect(response.status).toBe(418);
    const body = await response.json();
    expect(body).toEqual({
      error: { message: "Provider error 418", type: "upstream_error", code: null },
    });
    expect(JSON.stringify(body)).not.toContain("provider-secret");
    expect(parserCalls).toBe(0);
    expect(formatterCalls).toBe(0);
    expect(sidecarCalls).toBe(0);
  });

  test("a synchronous non-2xx body reader failure is also status-only", async () => {
    let formatterCalls = 0;
    const errorBody = new ReadableStream<Uint8Array>();
    Object.defineProperty(errorBody, "getReader", {
      value: () => { throw new Error("synchronous-provider-secret"); },
    });
    const adapter: ProviderAdapter = {
      name: "throwing-error-body-reader",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response(errorBody, { status: 418 }),
      formatErrorBody: () => {
        formatterCalls++;
        return "formatter must not run";
      },
      async *parseStream() { throw new Error("parser must not run"); },
      async parseResponse() { throw new Error("parser must not run"); },
    };

    const response = await runWithWebSearch(deps(adapter));
    expect(response.status).toBe(418);
    const body = await response.json();
    expect(body).toEqual({
      error: { message: "Provider error 418", type: "upstream_error", code: null },
    });
    expect(JSON.stringify(body)).not.toContain("synchronous-provider-secret");
    expect(formatterCalls).toBe(0);
  });

  test("initial response-header timeout is an exact 504 JSON failure before parsing or sidecar work", async () => {
    const connectTimeoutMs = 30;
    let parserCalls = 0;
    let sidecarCalls = 0;
    globalThis.fetch = (async () => {
      sidecarCalls++;
      throw new Error("sidecar must not run");
    }) as typeof fetch;
    const adapter: ProviderAdapter = {
      name: "header-hang",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: (_request, ctx) => hangingFetch(ctx),
      async *parseStream() {
        parserCalls++;
        yield { type: "done" };
      },
      async parseResponse() {
        parserCalls++;
        return [{ type: "done" }];
      },
    };

    const response = await runWithWebSearch(deps(adapter, { connectTimeoutMs }));
    expect(response.status).toBe(504);
    expect(parserCalls).toBe(0);
    expect(sidecarCalls).toBe(0);

    const entries: RequestLogEntry[] = [];
    const logged = wrapForLog(response, entries);
    const message = `Provider response-header timeout after ${connectTimeoutMs}ms during web-search`;
    expect(await logged.json()).toEqual({
      error: { message, type: "upstream_error", code: null },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 504,
      errorCode: "upstream_server_error",
      closeReason: "non_stream",
      upstreamError: message,
    });
    expect(entries[0].terminalStatus).toBeUndefined();
  }, 1_000);

  test("silent routed body returns HTTP 200 first, then emits one exact failed terminal and logs 504", async () => {
    const stallMs = 80;
    let sourceCancels = 0;
    let sidecarCalls = 0;
    globalThis.fetch = (async () => {
      sidecarCalls++;
      throw new Error("sidecar must not run");
    }) as typeof fetch;
    const adapter: ProviderAdapter = {
      name: "silent-body",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => silentResponse(() => { sourceCancels++; }),
      parseStream: parseBodyThen([{ type: "done" }]),
      async parseResponse() { return [{ type: "done" }]; },
    };

    const pending = runWithWebSearch(deps(adapter, { routedModelStallTimeoutMs: stallMs }));
    const first = await Promise.race([
      pending.then(response => ({ response })),
      new Promise<{ timedOut: true }>(resolve => setTimeout(() => resolve({ timedOut: true }), 25)),
    ]);
    expect("response" in first).toBe(true);
    if (!("response" in first)) throw new Error("runWithWebSearch waited for the routed body");
    expect(first.response.status).toBe(200);

    const entries: RequestLogEntry[] = [];
    const frames = await collectSse(wrapForLog(first.response, entries).body!);
    const message = `Routed model generation timeout after ${stallMs}ms without response bytes during web-search`;
    expect(terminalFrames(frames).map(frame => frame.event)).toEqual(["response.failed"]);
    const failedResponse = terminalFrames(frames)[0]!.data.response as Record<string, unknown>;
    expect(failedResponse.error).toEqual({ message, type: "server_error", code: "upstream_server_error" });
    expect(failedResponse.last_error).toEqual({ message, type: "server_error", code: "upstream_server_error" });
    expect(sourceCancels).toBe(1);
    expect(sidecarCalls).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 504,
      errorCode: "upstream_server_error",
      terminalStatus: "failed",
      closeReason: "terminal",
      upstreamError: message,
    });
  }, 1_000);

  test("one valid search completes once before the second routed body stalls with an exact failure", async () => {
    const stallMs = 45;
    let sidecarCalls = 0;
    globalThis.fetch = (async () => {
      sidecarCalls++;
      return new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs result"}\n\n'
          + 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    let pass = 0;
    let secondSourceCancels = 0;
    const adapter: ProviderAdapter = {
      name: "search-then-stall",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => ++pass === 1
        ? new Response("first-pass", { status: 200 })
        : silentResponse(() => { secondSourceCancels++; }),
      async *parseStream(response) {
        await response.text();
        if (pass === 1) {
          yield { type: "tool_call_start", id: "search_1", name: "web_search" };
          yield { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) };
          yield { type: "tool_call_end" };
        }
        yield { type: "done" };
      },
      async parseResponse() { return [{ type: "done" }]; },
    };

    const entries: RequestLogEntry[] = [];
    const response = await runWithWebSearch(deps(adapter, { routedModelStallTimeoutMs: stallMs }));
    const frames = await collectSse(wrapForLog(response, entries).body!);
    const message = `Routed model generation timeout after ${stallMs}ms without response bytes during web-search`;
    expect(sidecarCalls).toBe(1);
    expect(secondSourceCancels).toBe(1);
    expect(frames.filter(frame => frame.event === "response.output_item.added"
      && (frame.data.item as { type?: string } | undefined)?.type === "web_search_call")).toHaveLength(1);
    expect(frames.filter(frame => frame.event === "response.output_item.done"
      && (frame.data.item as { type?: string } | undefined)?.type === "web_search_call")).toHaveLength(1);
    expect(terminalFrames(frames).map(frame => frame.event)).toEqual(["response.failed"]);
    const failedResponse = terminalFrames(frames)[0]!.data.response as Record<string, unknown>;
    expect(failedResponse.error).toEqual({ message, type: "server_error", code: "upstream_server_error" });
    expect(entries[0]).toMatchObject({
      status: 504,
      terminalStatus: "failed",
      closeReason: "terminal",
      upstreamError: message,
    });
  }, 1_000);

  test("reader cancellation after headers cancels the routed source and logs a client close without a terminal", async () => {
    let sourceCancels = 0;
    const adapter: ProviderAdapter = {
      name: "client-cancel",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => silentResponse(() => { sourceCancels++; }),
      parseStream: parseBodyThen([{ type: "done" }]),
      async parseResponse() { return [{ type: "done" }]; },
    };

    const entries: RequestLogEntry[] = [];
    const response = await runWithWebSearch(deps(adapter, { routedModelStallTimeoutMs: 500 }));
    const reader = wrapForLog(response, entries).body!.getReader();
    await reader.cancel("client left");
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(sourceCancels).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 499,
      errorCode: "client_closed_request",
      closeReason: "client_cancel",
    });
    expect(entries[0].terminalStatus).toBeUndefined();
  }, 1_000);

  test("a never-settling 429 body cancel cannot block rotation under the cumulative header deadline", async () => {
    const connectTimeoutMs = 45;
    let firstSignal: AbortSignal | undefined;
    let cancelCalls = 0;
    let rotations = 0;
    const firstAdapter: ProviderAdapter = {
      name: "rate-limited-never-cancelled",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async (_request, ctx) => {
        firstSignal = ctx?.abortSignal;
        return new Response(new ReadableStream<Uint8Array>({
          cancel() {
            cancelCalls++;
            return new Promise<void>(() => {});
          },
        }), { status: 429 });
      },
      async *parseStream() { yield { type: "done" }; },
      async parseResponse() { return [{ type: "done" }]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      name: "rotated-header-hang",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: (_request, ctx) => {
        expect(ctx?.abortSignal).toBe(firstSignal);
        return hangingFetch(ctx);
      },
      async *parseStream() { yield { type: "done" }; },
      async parseResponse() { return [{ type: "done" }]; },
    };

    const started = performance.now();
    const response = await runWithWebSearch(deps(firstAdapter, {
      connectTimeoutMs,
      on429: () => {
        rotations++;
        return rotatedAdapter;
      },
    }));

    expect(performance.now() - started).toBeLessThan(500);
    expect(cancelCalls).toBe(1);
    expect(rotations).toBe(1);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: {
        message: `Provider response-header timeout after ${connectTimeoutMs}ms during web-search`,
        type: "upstream_error",
        code: null,
      },
    });
  }, 1_000);

  test("validates a rotated adapter before the second web-search build", async () => {
    let builds = 0;
    let fetches = 0;
    const firstAdapter: ProviderAdapter = {
      name: "first",
      buildRequest: () => {
        builds += 1;
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => {
        fetches += 1;
        return new Response("rate limited", { status: 429 });
      },
      async *parseStream() { yield { type: "done" }; },
      async parseResponse() { return [{ type: "done" }]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      ...firstAdapter,
      name: "rotated",
      buildRequest: () => {
        builds += 1;
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => {
        fetches += 1;
        return new Response("unexpected rotated fetch", { status: 200 });
      },
    };
    const response = await runWithWebSearch(deps(firstAdapter, {
      on429: () => rotatedAdapter,
      validateAdapter: (_parsed, adapter) => {
        if (adapter === rotatedAdapter) throw new OcxRequestValidationError("provider options route changed");
      },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "provider options route changed", type: "invalid_request_error", code: "invalid_request_error" },
    });
    expect(builds).toBe(1);
    expect(fetches).toBe(1);
  });

  test("preserves an upstream HTTP 400 as upstream_error", async () => {
    const adapter: ProviderAdapter = {
      name: "upstream-400",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("provider rejected request", { status: 400 }),
      async *parseStream() { yield { type: "done" }; },
      async parseResponse() { return [{ type: "done" }]; },
    };
    const response = await runWithWebSearch(deps(adapter, { maxSearches: 0 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "Provider error 400",
        type: "upstream_error",
        code: null,
      },
    });
  });

  test("a streamed web-search rotation failure is a typed 400 terminal", async () => {
    let builds = 0;
    let rotatedBuilds = 0;
    let fetches = 0;
    let parses = 0;
    const firstAdapter: ProviderAdapter = {
      name: "first",
      buildRequest: () => {
        builds += 1;
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => {
        fetches += 1;
        return new Response(fetches === 1 ? "ok" : "rate limited", { status: fetches === 1 ? 200 : 429 });
      },
      async *parseStream() {
        parses += 1;
        const events: AdapterEvent[] = parses === 1
          ? [
              { type: "tool_call_start", id: "search_1", name: "web_search" },
              { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
              { type: "tool_call_end" },
              { type: "done" },
            ]
          : [{ type: "done" }];
        for (const event of events) yield event;
      },
      async parseResponse() { return [{ type: "done" }]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      ...firstAdapter,
      name: "rotated",
      buildRequest: () => {
        rotatedBuilds += 1;
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => {
        fetches += 1;
        return new Response("unexpected rotated fetch", { status: 200 });
      },
    };
    const response = await runWithWebSearch(deps(firstAdapter, {
      backend: "xai",
      on429: () => rotatedAdapter,
      validateAdapter: (_parsed, adapter) => {
        if (adapter === rotatedAdapter) throw new OcxRequestValidationError("provider options route changed");
      },
    }));
    const sse = await response.text();
    expect(response.status).toBe(200);
    expect(builds).toBe(2);
    expect(rotatedBuilds).toBe(0);
    expect(fetches).toBe(2);
    expect(sse).toContain("event: response.failed");
    expect(sse).toContain('"type":"invalid_request_error"');
    expect(sse).not.toContain('"code":"upstream_server_error"');
    expect(sse).not.toContain("event: response.completed");
  });

  test("a streamed upstream HTTP 400 remains upstream_error", async () => {
    let fetches = 0;
    let parses = 0;
    const adapter: ProviderAdapter = {
      name: "upstream-400-stream",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => {
        fetches += 1;
        return new Response(fetches === 1 ? "ok" : "provider rejected request", { status: fetches === 1 ? 200 : 400 });
      },
      async *parseStream() {
        parses += 1;
        if (parses === 1) {
          yield { type: "tool_call_start", id: "search_1", name: "web_search" };
          yield { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) };
          yield { type: "tool_call_end" };
        }
        yield { type: "done" };
      },
      async parseResponse() { return [{ type: "done" }]; },
    };
    const response = await runWithWebSearch(deps(adapter, { backend: "xai" }));
    const sse = await response.text();
    expect(response.status).toBe(200);
    expect(sse).toContain("event: response.failed");
    expect(sse).toContain('"type":"upstream_error"');
    expect(sse).not.toContain('"type":"invalid_request_error"');
  });
});
