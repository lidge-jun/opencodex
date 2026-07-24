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
});
