import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../src/types";

const actualResolver = await import("../src/server/adapter-resolve");
let adapterFactory: ((provider: OcxProviderConfig) => ProviderAdapter) | undefined;

mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    return adapterFactory?.(provider) ?? actualResolver.resolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../src/server/responses");

afterEach(() => {
  adapterFactory = undefined;
});

function config(adapter: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter,
        baseUrl: "https://fixture.test/v1",
        authMode: "key",
        apiKey: "fixture-key",
      },
    },
  } as OcxConfig;
}

function post(adapter: string, stream: boolean, abortSignal?: AbortSignal): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", input: "hello", stream }),
  }), config(adapter), { model: "", provider: "" }, { abortSignal });
}

describe("Responses abort guards", () => {
  test("runTurn backlog overflow aborts the adapter signal", async () => {
    let adapterSignal: AbortSignal | undefined;
    let abortedAfterOverflow = false;
    adapterFactory = provider => ({
      name: "test-run-turn",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream(): AsyncGenerator<AdapterEvent> {
        yield { type: "error", message: "runTurn adapter does not use parseStream" };
      },
      async runTurn(_parsed, incoming, emit) {
        adapterSignal = incoming.abortSignal;
        for (let i = 0; i <= 1_024; i++) emit({ type: "text_delta", text: String(i) });
        abortedAfterOverflow = incoming.abortSignal?.aborted === true;
      },
    });

    const response = await post("test-run-turn", false);
    const body = await response.text();

    expect(adapterSignal?.aborted).toBe(true);
    expect(abortedAfterOverflow).toBe(true);
    expect(body).toContain("consumer backlog exceeded — turn aborted");
  });

  test("abort after fetch resolution cancels the body before a late reader attaches", async () => {
    const clientAbort = new AbortController();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    let bodyCancelled = false;
    let readerAttached = false;

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      adapterFactory = provider => ({
        name: "test-fetch",
        buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
        async fetchResponse() {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              bodyCancelled = true;
              return Promise.reject(new Error("fault-injected cancel rejection"));
            },
          }), { status: 200, headers: { "content-type": "text/event-stream" } });
        },
        async *parseStream(response): AsyncGenerator<AdapterEvent> {
          clientAbort.abort(new DOMException("client disconnected", "AbortError"));
          await Promise.resolve();
          readerAttached = true;
          const reader = response.body!.getReader();
          try {
            await reader.read();
          } finally {
            reader.releaseLock();
          }
        },
      });

      const response = await post("test-fetch", true, clientAbort.signal);
      await response.text();
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(readerAttached).toBe(true);
      expect(bodyCancelled).toBe(true);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  test("terminal-guard continuation body is cancelled on a late client abort (#394 review)", async () => {
    // The terminal guard opens a SECOND upstream response (the continuation). Its body must be
    // bound to the abort signal exactly like the initial response, or the fetch-to-reader race
    // (#390/366e3053) reopens on the continuation path. First turn: an anthropic end_turn with no
    // tool call (triggers exactly one continuation). Continuation: a body whose reader attaches
    // only after the client has aborted; cancelBodyOnAbort must cancel it.
    const clientAbort = new AbortController();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    let continuationBodyCancelled = false;
    let fetches = 0;

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      adapterFactory = provider => ({
        name: "anthropic",
        buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
        async fetchResponse() {
          fetches += 1;
          if (fetches === 1) {
            // First turn: a complete anthropic-style stream that ends without a tool call.
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(
                  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
                  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
                  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我接下来会修改相关文件。"}}\n\n' +
                  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
                  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
                  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                ));
                controller.close();
              },
            }), { status: 200, headers: { "content-type": "text/event-stream" } });
          }
          // Continuation turn: reader attaches only after the client aborts.
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array([1])); },
            cancel() { continuationBodyCancelled = true; },
          }), { status: 200, headers: { "content-type": "text/event-stream" } });
        },
        async *parseStream(response): AsyncGenerator<AdapterEvent> {
          if (fetches >= 2) {
            // We are now parsing the continuation stream — abort before attaching the reader.
            clientAbort.abort(new DOMException("client disconnected", "AbortError"));
            await Promise.resolve();
            const reader = response.body!.getReader();
            try { await reader.read(); } finally { reader.releaseLock(); }
            return;
          }
          // First turn: emit an end_turn with no tool call so the guard opens a continuation.
          yield { type: "text_delta", text: "我接下来会修改相关文件。" };
          yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } };
        },
      });

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/model",
          input: "请检查这个问题并修复代码",
          stream: true,
          tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
        }),
      }), config("anthropic"), { model: "", provider: "" }, { abortSignal: clientAbort.signal });
      await response.text().catch(() => {});
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(fetches).toBe(2);
      expect(continuationBodyCancelled).toBe(true);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
