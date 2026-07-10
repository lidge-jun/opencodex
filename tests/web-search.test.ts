import { afterEach, describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { planWebSearch, webSearchStallTimeoutSec } from "../src/web-search";
import { runWithWebSearch } from "../src/web-search/loop";
import { headersForCodexAuthContext } from "../src/codex/auth-context";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../src/types";
import type { AdapterFetchContext, ProviderAdapter } from "../src/adapters/base";
import type { OcxMessage, OcxParsedRequest } from "../src/types";

const routedProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "routed-key",
};

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {
      routed: routedProvider,
      chatgpt: forwardProvider,
    },
    ...overrides,
  };
}

function parsedWithWebSearch() {
  return parseRequest({
    model: "routed/model",
    input: "Search for current docs",
    stream: true,
    tools: [
      { type: "web_search", search_context_size: "medium" },
      { type: "function", name: "read_file", description: "Read file", parameters: {} },
    ],
  });
}

describe("web-search sidecar planning", () => {
  test("parseRequest stashes hosted web_search while keeping normal tools", () => {
    const parsed = parsedWithWebSearch();

    expect(parsed._webSearch).toEqual({ type: "web_search", search_context_size: "medium" });
    expect(parsed.context.tools?.map(t => t.name)).toEqual(["read_file"]);
  });

  test("planWebSearch activates only for routed requests with forward auth and incoming authorization", () => {
    const parsed = parsedWithWebSearch();
    const plan = planWebSearch(
      config(),
      parsed,
      false,
      new Headers({ authorization: "Bearer chatgpt" }),
      routedProvider,
      "model",
    );

    expect(plan).toBeDefined();
    expect(plan?.forwardProvider).toBe(forwardProvider);
    expect(plan?.hostedTool).toEqual(parsed._webSearch);
    expect(plan?.settings.model).toBe("gpt-5.6-luna");
  });

  test("planWebSearch activates for pool-selected headers even when raw inbound auth would be main", () => {
    const parsed = parsedWithWebSearch();
    const selectedHeaders = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main-token", "chatgpt-account-id": "main_acc" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );
    const plan = planWebSearch(
      config(),
      parsed,
      false,
      selectedHeaders,
      routedProvider,
      "model",
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );

    expect(plan).toBeDefined();
    expect(selectedHeaders.get("authorization")).toBe("Bearer pool-token");
    expect(selectedHeaders.get("chatgpt-account-id")).toBe("pool_acc");
  });

  test("planWebSearch suppresses sidecar predictably when prerequisites are absent", () => {
    const parsed = parsedWithWebSearch();

    expect(planWebSearch(config(), parsed, true, new Headers({ authorization: "Bearer x" }), routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config(), parsed, false, new Headers(), routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config({ providers: { routed: routedProvider } }), parsed, false, new Headers({ authorization: "Bearer x" }), routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config({ webSearchSidecar: { enabled: false } }), parsed, false, new Headers({ authorization: "Bearer x" }), routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config(), { ...parsed, _webSearch: undefined }, false, new Headers({ authorization: "Bearer x" }), routedProvider, "model")).toBeUndefined();
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

function hangUntilAbort(ctx?: AdapterFetchContext): Promise<Response> {
  const signal = ctx?.abortSignal;
  return new Promise((_resolve, reject) => {
    const rejectAborted = () => {
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error(reason ? String(reason) : "aborted"));
    };
    if (signal?.aborted) {
      rejectAborted();
      return;
    }
    signal?.addEventListener("abort", rejectAborted, { once: true });
  });
}

/** Adapter whose first streamed pass returns the events, and every later (forceAnswer) pass a text answer. */
function scriptedAdapter(firstPass: AdapterEvent[]): ProviderAdapter {
  let pass = 0;
  return {
    name: "mock",
    buildRequest: () => ({ url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
    async *parseStream() {
      const events: AdapterEvent[] = pass++ === 0
        ? firstPass
        : [{ type: "text_delta", text: "final answer" }, { type: "done" }];
      for (const event of events) yield event;
      if (!events.some(event => event.type === "done" || event.type === "error")) {
        yield { type: "done" };
      }
    },
    async parseResponse() {
      throw new Error("parseResponse must be unreachable");
    },
  };
}

describe("BUG-R86 routed web-search timeout semantics", () => {
  test("routed iterations use upstream streaming and never call parseResponse", async () => {
    const seenStream: boolean[] = [];
    let parseStreamCalls = 0;
    let parseResponseCalls = 0;
    const adapter: ProviderAdapter = {
      name: "stream-only",
      buildRequest(parsed) {
        seenStream.push(parsed.stream);
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        parseStreamCalls++;
        yield { type: "text_delta", text: "healthy" };
        yield { type: "done" };
      },
      async parseResponse() {
        parseResponseCalls++;
        throw new Error("parseResponse must be unreachable");
      },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    expect(seenStream).toEqual([true]);
    expect(parseStreamCalls).toBe(1);
    expect(parseResponseCalls).toBe(0);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
  });

  test("fast headers plus raw byte progress can outlive connectTimeoutMs", async () => {
    const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    let bodyCancelled = 0;
    const adapter: ProviderAdapter = {
      name: "slow-healthy-stream",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async (_request, ctx) => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of ["a", "b", "c", "d", "e"]) {
              await delay(12);
              if (ctx?.abortSignal?.aborted) {
                controller.error(ctx.abortSignal.reason);
                return;
              }
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
          cancel() { bodyCancelled++; },
        });
        return new Response(body, { status: 200 });
      },
      async *parseStream(response) {
        expect(await response.text()).toBe("abcde");
        yield { type: "text_delta", text: "healthy after slow generation" };
        yield { type: "done" };
      },
      async parseResponse(response) {
        await response.text();
        return [{ type: "text_delta", text: "legacy non-stream result" }, { type: "done" }];
      },
    };

    const started = performance.now();
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 25,
    });

    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(bodyCancelled).toBe(0);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
  }, 1_000);

  test("a buffered web_search followed by error never dispatches the hosted sidecar", async () => {
    let sidecarCalls = 0;
    globalThis.fetch = (async () => {
      sidecarCalls++;
      return new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"must not run"}\n\n'
          + 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;

    let streamPass = 0;
    let responsePass = 0;
    const badPass: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_bad", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "must not run" }) },
      { type: "tool_call_end" },
      { type: "error", message: "routed model failed" },
    ];
    const finalPass: AdapterEvent[] = [
      { type: "text_delta", text: "fallback answer" },
      { type: "done" },
    ];
    const adapter: ProviderAdapter = {
      name: "search-then-error",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        const events = streamPass++ === 0 ? badPass : finalPass;
        for (const event of events) yield event;
      },
      async parseResponse() {
        return responsePass++ === 0 ? badPass : finalPass;
      },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    expect(sidecarCalls).toBe(0);
    expect(frames.filter(frame => frame.event === "response.failed")).toHaveLength(1);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });
});

describe("web-search sidecar native web_search_call emission", () => {
  test("loop 429 triggers on429 rotation and succeeds with the rebuilt adapter", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ))) as typeof fetch;

    // First adapter always 429s via fetchResponse; the rotated adapter answers.
    const firstAdapter: ProviderAdapter = {
      name: "mock-429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "text_delta", text: "should not reach" }, { type: "done" }] as AdapterEvent[]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      name: "mock-rotated",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("{}", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "answer from rotated key" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };
    let rotations = 0;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      on429: retryAfter => {
        rotations++;
        expect(retryAfter).toBe("30");
        return rotatedAdapter;
      },
    });
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as { type: string; content?: { text?: string }[] }[];
    expect(output.find(o => o.type === "message")?.content?.[0]?.text).toBe("answer from rotated key");
    expect(rotations).toBe(1);
  });

  test("loop 429 with exhausted pool (on429 null) surfaces the provider error", async () => {
    const firstAdapter: ProviderAdapter = {
      name: "mock-429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("rate limited", { status: 429 }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      on429: () => null,
    });
    expect(response.status).toBe(429);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("429");
  });

  test("loop per-iteration timeout surfaces 504 instead of hanging", async () => {
    const hangingAdapter: ProviderAdapter = {
      name: "mock-hang",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: (_req, ctx) => hangUntilAbort(ctx),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: hangingAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 100,
    });
    expect(response.status).toBe(504);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("timeout");
  }, 1_000);

  test("loop reuses one iteration deadline signal across 429 rotation", async () => {
    let firstSignal: AbortSignal | undefined;
    const firstAdapter: ProviderAdapter = {
      name: "mock-429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async (_req, ctx) => {
        firstSignal = ctx?.abortSignal;
        return new Response("rate limited", { status: 429 });
      },
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      name: "mock-rotated-hang",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: (_req, ctx) => {
        expect(ctx?.abortSignal).toBe(firstSignal);
        return hangUntilAbort(ctx);
      },
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 100,
      on429: () => rotatedAdapter,
    });
    expect(response.status).toBe(504);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("timeout");
  }, 1_000);

  test("loop propagates parent abort into a hanging iteration", async () => {
    const parent = new AbortController();
    let resolveSignal!: (signal: AbortSignal) => void;
    const receivedSignal = new Promise<AbortSignal>(resolve => { resolveSignal = resolve; });
    const hangingAdapter: ProviderAdapter = {
      name: "mock-parent-abort",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: (_req, ctx) => {
        if (ctx?.abortSignal) resolveSignal(ctx.abortSignal);
        return hangUntilAbort(ctx);
      },
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };

    const pending = runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: hangingAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 30_000,
      abortSignal: parent.signal,
    });
    const iterationSignal = await receivedSignal;
    parent.abort(new DOMException("superseded", "AbortError"));

    const response = await pending;
    expect(iterationSignal.aborted).toBe(true);
    expect(response.status).toBe(499);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message).toBe("client closed request during web-search");
  }, 1_000);

  test("signed thinking before a web_search call survives into the replayed assistant turn", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const seenBodies: OcxMessage[][] = [];
    let pass = 0;
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: (p: OcxParsedRequest) => {
        seenBodies.push(p.context.messages);
        return { url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
      },
      async *parseStream() {
        pass++;
        if (pass === 1) {
          const events: AdapterEvent[] = [
            { type: "thinking_delta", thinking: "I should search" },
            { type: "thinking_signature", signature: "RealSig1234567890==" },
            { type: "tool_call_start", id: "call_t", name: "web_search" },
            { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
            { type: "tool_call_end" },
            { type: "done" },
          ];
          for (const event of events) yield event;
          return;
        }
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "look up docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 2,
    });
    await collectSse(response.body!);

    // The second iteration's request must replay the assistant turn as [thinking, toolCall].
    const replayMessages = seenBodies.at(-1)!;
    const assistant = replayMessages.find(m => m.role === "assistant"
      && Array.isArray(m.content) && (m.content as { type: string }[]).some(c => c.type === "toolCall"));
    expect(assistant).toBeDefined();
    const content = assistant!.content as { type: string; thinking?: string; signature?: string }[];
    expect(content[0].type).toBe("thinking");
    expect(content[0].thinking).toBe("I should search");
    expect(content[0].signature).toBe("RealSig1234567890==");
    expect(content[1].type).toBe("toolCall");
  });

  test("an executed search emits a web_search_call item ahead of the assistant message", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar /responses: return a minimal completed SSE with answer text
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_1", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["web_search_call", "message"]);
    expect(output[0]).toMatchObject({ type: "web_search_call", action: { type: "search", query: "current docs" } });
  });

  test("empty-query and limit placeholders do NOT emit a web_search_call item", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    // First pass: an empty-query web_search call (handled by the empty-query branch, never hits the sidecar).
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "go", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_empty", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.some(item => item.type === "web_search_call")).toBe(false);
    expect(output.map(item => item.type)).toEqual(["message"]);
  });
});

/** Adapter that records the messages handed to it on each pass (forced-answer nudge assertion). */
function capturingAdapter(firstPass: AdapterEvent[]): { adapter: ProviderAdapter; messagesPerPass: OcxMessage[][] } {
  const messagesPerPass: OcxMessage[][] = [];
  let pass = 0;
  const adapter: ProviderAdapter = {
    name: "mock",
    buildRequest: (parsed: OcxParsedRequest) => {
      messagesPerPass.push(parsed.context.messages);
      return { url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
    },
    async *parseStream() {
      const events: AdapterEvent[] = pass++ === 0
        ? firstPass
        : [{ type: "text_delta", text: "final answer" }, { type: "done" }];
      for (const event of events) yield event;
      if (!events.some(event => event.type === "done" || event.type === "error")) {
        yield { type: "done" };
      }
    },
    async parseResponse() { throw new Error("parseResponse must be unreachable"); },
  };
  return { adapter, messagesPerPass };
}

/** Drain an SSE body so iterations that run live inside the stream actually execute. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("web-search forced-answer nudge", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("forced pass appends exactly one developer nudge after a real search, without mutating shared messages", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const { adapter, messagesPerPass } = capturingAdapter([
      { type: "tool_call_start", id: "call_1", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
      { type: "tool_call_end" },
    ]);
    const parsed = parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] });
    const baselineUserMessages = parsed.context.messages.length;

    const response = await runWithWebSearch({
      parsed,
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    // Iteration 2 (the forced-answer pass) runs live inside the SSE body — drain it so it executes.
    await drain(response.body!);

    // Pass 1 (search) has no nudge; pass 2 (forced answer) ends with exactly one developer nudge.
    expect(messagesPerPass.length).toBe(2);
    expect(messagesPerPass[0].some(m => m.role === "developer")).toBe(false);
    const forced = messagesPerPass[1];
    const developerMsgs = forced.filter(m => m.role === "developer");
    expect(developerMsgs.length).toBe(1);
    expect(forced[forced.length - 1].role).toBe("developer");
    // The nudge is iteration-local: the shared/persisted message list is never grown by it.
    expect(parsed.context.messages.length).toBe(baselineUserMessages);
    expect(parsed.context.messages.some(m => m.role === "developer")).toBe(false);
  });

  test("a run with only an empty-query placeholder gets NO forced-answer nudge", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const { adapter, messagesPerPass } = capturingAdapter([
      { type: "tool_call_start", id: "call_empty", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "" }) },
      { type: "tool_call_end" },
    ]);
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "go", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    await drain(response.body!);

    // Every pass is nudge-free because no real sidecar search ran (executedSearches stayed empty).
    for (const msgs of messagesPerPass) {
      expect(msgs.some(m => m.role === "developer")).toBe(false);
    }
  });
});

describe("web-search live spinner ordering", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("the in_progress added frame is emitted BEFORE the sidecar search resolves", async () => {
    // Gate the sidecar response so the search stays pending until we choose to release it.
    let releaseSidecar: () => void = () => {};
    const sidecarGate = new Promise<void>(resolve => { releaseSidecar = resolve; });
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar: resolve only after the gate opens.
      return sidecarGate.then(() => new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_1", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    // Read frames incrementally. The added(in_progress) web_search_call must arrive while the
    // sidecar promise is still gated; only after we see it do we release the sidecar.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawInProgress = false;
    let releasedAt = -1;
    const order: string[] = [];
    for (let reads = 0; reads < 200; reads++) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").find(l => l.startsWith("data: "))?.slice(6);
        if (!data) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(data); } catch { continue; }
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "web_search_call") {
          order.push(`${parsed.type}:${item.status}`);
          if (parsed.type === "response.output_item.added" && item.status === "in_progress") {
            sawInProgress = true;
            releasedAt = order.length;
            releaseSidecar(); // open the gate ONLY after the spinner frame is observed
          }
        }
      }
    }

    expect(sawInProgress).toBe(true);
    // The added(in_progress) frame came first, and we released the sidecar only after seeing it —
    // proving the spinner is live, not flashed back-to-back with done.
    expect(order[0]).toBe("response.output_item.added:in_progress");
    expect(order).toContain("response.output_item.done:completed");
    expect(releasedAt).toBe(1);
  });
});

describe("web-search batched queries", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("a single call with queries[] runs each query and emits ONE cell carrying all queries", async () => {
    const sidecarQueries: string[] = [];
    globalThis.fetch = ((input, init) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar: capture the query the proxy asked for, return a minimal answer.
      try {
        const body = JSON.parse(String(init?.body ?? "{}"));
        // Sidecar query lives at input[0].content[0].text (see src/web-search/executor.ts).
        const text = body?.input?.[0]?.content?.[0]?.text;
        if (typeof text === "string") sidecarQueries.push(text);
      } catch { /* ignore */ }
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ans"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "compare", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_b", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ queries: ["rust async", "tokio runtime"] }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 3,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    // Exactly ONE web_search_call cell, ahead of the message, carrying both queries (native plural).
    const cells = output.filter(item => item.type === "web_search_call");
    expect(cells.length).toBe(1);
    expect(cells[0]).toMatchObject({ action: { type: "search", queries: ["rust async", "tokio runtime"] } });
    // Both queries actually hit the sidecar.
    expect(sidecarQueries.some(q => q.includes("rust async"))).toBe(true);
    expect(sidecarQueries.some(q => q.includes("tokio runtime"))).toBe(true);
  });
});

describe("web-search sources -> url_citation annotations", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("a search's sources land as url_citation annotations on the assistant message", async () => {
    // Sidecar returns answer text plus a url_citation annotation in the completed output[].
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      const completed = {
        type: "response.completed",
        response: {
          output: [{
            type: "message", role: "assistant",
            content: [{
              type: "output_text", text: "Node 24 is LTS.",
              annotations: [{ type: "url_citation", url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases" }],
            }],
          }],
        },
      };
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Node 24 is LTS."}\n\n' +
          `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "node lts?", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_s", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "node lts" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([{
      type: "url_citation", url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases", start_index: 0, end_index: 0,
    }]);
  });

  test("real-world: empty annotations + body Sources block still produce url_citation annotations", async () => {
    // Mirrors the actual OpenAI hosted web_search wire shape captured in dumps: annotations:[] and a
    // trailing markdown Sources block in the answer text.
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      const answer = "Node 24.18.0 is the latest LTS.\n\nSources:\n" +
        "- Node.js Download page: https://nodejs.org/en/download/current\n" +
        "- Node.js release archive: https://nodejs.org/en/download/archive/current";
      const completed = {
        type: "response.completed",
        response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", annotations: [], text: answer }] }] },
      };
      return Promise.resolve(new Response(
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "node lts?", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_s2", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "node lts" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([
      { type: "url_citation", url: "https://nodejs.org/en/download/current", title: "Node.js Download page", start_index: 0, end_index: 0 },
      { type: "url_citation", url: "https://nodejs.org/en/download/archive/current", title: "Node.js release archive", start_index: 0, end_index: 0 },
    ]);
  });

  test("a turn with no search keeps empty annotations", async () => {
    globalThis.fetch = ((input) => {
      const u = String(input);
      if (u.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
    }) as typeof fetch;
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([{ type: "text_delta", text: "no search needed" }, { type: "done" }]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([]);
  });
});

describe("web-search batched sources -> url_citation annotations", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("a batched call dedupes duplicate sources across queries by URL", async () => {
    // Both queries' sidecar answers cite the SAME url; only one url_citation must survive.
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      const answer = "Shared finding.\n\nSources:\n" +
        "- Shared doc: https://shared.test/doc\n" +
        "- Unique: https://shared.test/uniqueA";
      const completed = {
        type: "response.completed",
        response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", annotations: [], text: answer }] }] },
      };
      return Promise.resolve(new Response(
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "compare", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_dup", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ queries: ["q one", "q two"] }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 3,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    // Both queries returned the same shared.test/doc, so it appears exactly once.
    expect(part.annotations).toEqual([
      { type: "url_citation", url: "https://shared.test/doc", title: "Shared doc", start_index: 0, end_index: 0 },
      { type: "url_citation", url: "https://shared.test/uniqueA", title: "Unique", start_index: 0, end_index: 0 },
    ]);
  });

  test("a partial failure still surfaces the successful query's sources", async () => {
    // First sidecar call fails (HTTP 500), second succeeds with a real Sources block. The batch is a
    // partial success, so the surviving query's citation must still reach the assistant message.
    let sidecarCall = 0;
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      sidecarCall++;
      if (sidecarCall === 1) return Promise.resolve(new Response("upstream boom", { status: 500 }));
      const answer = "Recovered.\n\nSources:\n- Good doc: https://ok.test/doc";
      const completed = {
        type: "response.completed",
        response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", annotations: [], text: answer }] }] },
      };
      return Promise.resolve(new Response(
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "compare", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_partial", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ queries: ["fails first", "works second"] }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 3,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    // The cell is still "completed" because one query succeeded.
    const cell = output.find(item => item.type === "web_search_call") as Record<string, unknown>;
    expect(cell.status).toBe("completed");
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([
      { type: "url_citation", url: "https://ok.test/doc", title: "Good doc", start_index: 0, end_index: 0 },
    ]);
  });
});

describe("web-search stall deadline", () => {
  test("planWebSearch computes the effective stall deadline covering bounded silent units", () => {
    const parsed = parsedWithWebSearch();
    const auth = new Headers({ authorization: "Bearer chatgpt" });
    // defaults: max(90, connect 200s, sidecar 200s) + 30 margin
    expect(planWebSearch(config(), parsed, false, auth, routedProvider, "model")?.stallTimeoutSec).toBe(230);
    // a larger user-configured stallTimeoutSec dominates
    expect(planWebSearch(config({ stallTimeoutSec: 600 }), parsed, false, auth, routedProvider, "model")?.stallTimeoutSec).toBe(630);
    // small unit budgets -> the bridge's 90s default dominates
    expect(planWebSearch(
      config({
        connectTimeoutMs: 30_000,
        webSearchSidecar: { timeoutMs: 30_000, routedModelStallTimeoutMs: 30_000 },
      }),
      parsed, false, auth, routedProvider, "model",
    )?.stallTimeoutSec).toBe(120);
  });

  test("webSearchStallTimeoutSec helper covers the largest bounded unit plus margin", () => {
    expect(webSearchStallTimeoutSec(undefined, undefined, 200_000)).toBe(230);
    expect(webSearchStallTimeoutSec(90, 200_000, 200_000)).toBe(230);
    expect(webSearchStallTimeoutSec(600, 200_000, 200_000)).toBe(630);
    expect(webSearchStallTimeoutSec(undefined, 30_000, 30_000)).toBe(120);
  });

  test("threaded stallTimeoutSec reaches the bridge: a hung sidecar trips upstream_stall_timeout", async () => {
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar /responses hangs until aborted (stall must fire first: sidecar budget is 600s)
      return new Promise<Response>((_, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_1", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 600_000 },
      maxSearches: 1,
      // Bridge clamps to >= 1s and checks on its 2s tick: the hung search dies on the first
      // silent tick (~4s), proving deps.stallTimeoutSec actually reaches bridgeToResponsesSSE.
      stallTimeoutSec: 1,
    });
    const frames = await collectSse(response.body!);
    const incomplete = frames.find(f => f.event === "response.incomplete");
    expect(incomplete).toBeDefined();
    const resp = incomplete!.data.response as { incomplete_details?: { reason?: string } };
    expect(resp.incomplete_details?.reason).toBe("upstream_stall_timeout");
  }, 15_000);
});
