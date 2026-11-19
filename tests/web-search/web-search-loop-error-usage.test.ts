import { afterEach, expect, jest, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import { fetchVertexWithRetry } from "../../src/adapters/google-http";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import { runWithWebSearch } from "../../src/web-search/loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { PROVIDER_INPUT_TOO_LARGE_MESSAGE } from "../../src/server/responses/context-overflow";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// A pass that ends in an adapter error was billed; the request log must meter it, and the turn
// must still fail with the same error.
test("an errored iteration's usage reaches the request log beside the search pass", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  const passes: AdapterEvent[][] = [
    [
      { type: "tool_call_start", id: "ws1", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 1000, outputTokens: 50 } },
    ],
    [{ type: "text_delta", text: "partial" }, { type: "error", message: "provider blew up", usage: { inputTokens: 1400, outputTokens: 30 } }],
  ];
  const adapter: ProviderAdapter = {
    name: "errored-iteration",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async (_req, ctx) => {
      ctx?.onPhysicalSend?.({ ordinal: 1 });
      return new Response("wire");
    },
    async *parseStream() { yield* passes.shift()!; },
  };
  const parsed: OcxParsedRequest = {
    modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] },
  };
  const reported: unknown[] = [];
  const response = await runWithWebSearch({
    parsed, adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    onUsage: usage => reported.push(usage),
  });
  const text = await response.text();
  expect(text).toContain("response.failed");
  expect(text).toContain("Provider stream error: provider blew up");
  expect(reported).toEqual([expect.objectContaining({ inputTokens: 2400, outputTokens: 80 })]);
});

// #7316: once the turn is streaming, a later iteration's provider overflow must still end as the
// main path's terminal context_length_exceeded rather than a generic upstream failure.
for (const [label, second] of [
  ["an HTTP 413", { response: () => new Response("Request body exceeds the 8 MiB limit", { status: 413 }), events: [], message: PROVIDER_INPUT_TOO_LARGE_MESSAGE }],
  ["an adapter-classified overflow", {
    response: () => new Response("wire"),
    events: [{ type: "error", status: 400, code: "context_length_exceeded", message: "adapter overflow" }],
    message: "adapter overflow",
  }],
] as const) {
  test(`a later iteration's ${label} ends as a terminal context_length_exceeded`, async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
    const passes: AdapterEvent[][] = [[
      { type: "tool_call_start", id: "ws1", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
      { type: "tool_call_end" },
      { type: "done" },
    ], [...second.events]];
    let sends = 0;
    const adapter: ProviderAdapter = {
      name: "overflowing-iteration",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async (_req, ctx) => {
        ctx?.onPhysicalSend?.({ ordinal: 1 });
        return (sends++ === 0 ? new Response("wire") : second.response());
      },
      async *parseStream() { yield* passes.shift()!; },
    };
    const parsed: OcxParsedRequest = {
      modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] },
    };
    const response = await runWithWebSearch({
      parsed, adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
      settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("response.failed");
    expect(text).toContain('"code":"context_length_exceeded"');
    expect(text).toContain(second.message);
    expect(sends).toBe(2);
  });
}

// A worded verdict keeps its status and provider wording in-stream: combo stream preflight reads
// exactly those to decide whether a larger-context target may still serve the turn.
function wordedFailureRun(respond: () => Response, sameTargetRetries = false) {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  const passes: AdapterEvent[][] = [[
    { type: "tool_call_start", id: "ws1", name: "web_search" },
    { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
    { type: "tool_call_end" },
    { type: "done" },
  ]];
  const state = { sends: 0 };
  const adapter: ProviderAdapter = {
    name: "worded-overflow",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async (_req, ctx) => {
      ctx?.onPhysicalSend?.({ ordinal: 1 });
      return (state.sends++ === 0 ? new Response("wire") : respond());
    },
    formatErrorBody: (_status, _headers, body) => body,
    async *parseStream() { yield* passes.shift()!; },
  };
  const response = runWithWebSearch({
    parsed: { modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] } },
    adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    ...(sameTargetRetries ? { retryOn429Policy: {
      enabled: true, attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false,
    } } : {}),
  });
  return { state, text: response.then(r => r.text()) };
}

test.each([400, 413])("a later iteration's worded %i overflow keeps its evidence beside context_length_exceeded", async status => {
  const run = wordedFailureRun(() => new Response("This model's maximum context length is 8192 tokens", { status }));
  const text = await run.text;
  expect(text).toContain('"code":"context_length_exceeded"');
  expect(text).toContain("maximum context length is 8192 tokens");
  expect(run.state.sends).toBe(2);
});

// The provider may already have run a non-replayable turn; an overflow would invite a compacted resend.
test.each(["Request body exceeds the 8 MiB limit", "This model's maximum context length is 8192 tokens"])("a later iteration's non-replayable 413 keeps its own failure (%s)", async body => {
  const run = wordedFailureRun(() => {
    const response = new Response(body, { status: 413 });
    markResponseNonReplayable(response);
    return response;
  });
  const text = await run.text;
  expect(text).toContain("response.failed");
  expect(text).not.toContain("context_length_exceeded");
});

// The bridge's wording heuristics must not rename a provider's own rate verdict an overflow.
test("a later iteration's rate_limit_exceeded 400 keeps its rate verdict", async () => {
  const run = wordedFailureRun(() => Response.json({ error: { message: "too many tokens", code: "rate_limit_exceeded" } }, { status: 400 }));
  const text = await run.text;
  expect(text).toContain('"code":"rate_limit_exceeded"');
  expect(text).not.toContain("context_length_exceeded");
});

test.each([false, true])("web-search does not resend a terminal 429 (local marker %s)", async marked => {
  const run = wordedFailureRun(() => {
    const response = new Response("fixture quota", {
      status: 429, headers: marked ? {} : { "x-should-retry": "false" },
    });
    if (marked) markResponseNonReplayable(response);
    return response;
  }, true);
  expect(await run.text).toContain("response.failed");
  expect(run.state.sends).toBe(2);
});

test.each(["body-only", "directive", "event", "ordinary", "empty", "forced-empty"] as const)("replay veto: web-search stops before a %s retry and preserves its terminal verdict", async kind => {
  let sends = 0, rotations = 0;
  const blocked = kind !== "ordinary";
  const adapter: ProviderAdapter = {
    name: "openai-chat",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    async fetchResponse() {
      sends++;
      if (kind === "body-only") return Response.json({ error: { code: "upstream_reset_replay_refused" } }, { status: 429 });
      return new Response("wire", { headers: ["directive", "empty", "forced-empty"].includes(kind) ? { "x-should-retry": "false" } : {} });
    },
    async *parseStream() {
      if (kind.endsWith("empty")) { yield { type: "done" }; return; }
      yield { type: "error", status: 503, message: "fixture stream failure", ...(kind === "event" ? { retryable: false } : {}) };
    },
  };
  const response = await runWithWebSearch({
    parsed: { modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] } },
    adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: kind === "forced-empty" ? 0 : 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, emptyCompletionRetry: true,
    retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false },
    on429: async () => { rotations++; return rotations < 2 ? { adapter, recoveryKind: "key-429" } : null; },
  });
  const text = await response.text();
  expect(sends).toBe(1);
  expect(rotations).toBe(0);
  if (kind === "body-only") {
    expect(response.status).toBe(429);
    expect(JSON.parse(text).error.code).toBe("upstream_reset_replay_refused");
  } else {
    expect(text).toContain("response.failed");
    expect(text.includes('"retryable":false')).toBe(blocked);
  }
});

test.each(["byte-limit", "header-clock", "adapter-header-clock", "caller-cancel"] as const)("review: sidecar refusal probe web-search %s", async kind => {
  const timed = kind !== "byte-limit";
  if (timed) jest.useFakeTimers();
  const caller = new AbortController();
  const probeStarted = Promise.withResolvers<void>();
  const code = "upstream_response_refused";
  const payload = JSON.stringify({ padding: timed ? "" : "x".repeat(17_000), error: { code } });
  let sends = 0, rotations = 0, externalFetches = 0;
  let physicalSignal: AbortSignal | undefined;
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let detach = () => {};
  const releaseBody = () => {
    if (!source || closed) return;
    closed = true;
    source.enqueue(new TextEncoder().encode(payload));
    source.close();
  };
  globalThis.fetch = (async () => { externalFetches++; throw new Error("fixture forbids external fetch"); }) as typeof fetch;
  const adapter: ProviderAdapter = {
    name: "mock-refusal-probe",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    async fetchResponse(request, ctx) {
      const respond = (signal: AbortSignal) => {
        sends++;
        physicalSignal = signal;
        if (!timed) return new Response(payload, { status: 429, headers: { "content-type": "application/json" } });
        const body = new ReadableStream<Uint8Array>({
          start(controller) { source = controller; },
          pull() { probeStarted.resolve(); },
          cancel() { closed = true; },
        }, { highWaterMark: 0 });
        const onAbort = () => {
          if (!closed) { closed = true; source!.error(signal.reason); }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => signal.removeEventListener("abort", onAbort);
        return new Response(body, { status: 429, headers: { "content-type": "application/json" } });
      };
      return kind === "adapter-header-clock"
        ? fetchVertexWithRetry(request, { ...ctx, executor: (async (_input, init) => respond(init!.signal!)) as typeof fetch })
        : respond(ctx!.abortSignal!);
    },
    async *parseStream() { throw new Error("fixture must not parse an HTTP refusal"); },
  };
  const pending = runWithWebSearch({
    parsed: { modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] } },
    adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, abortSignal: caller.signal,
    connectTimeoutMs: timed ? 50 : 2000,
    ...(timed ? {} : { retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false } }),
    on429: async () => { rotations++; return null; },
  });
  try {
    if (timed) {
      await probeStarted.promise;
      if (kind === "caller-cancel") caller.abort(new Error("fixture caller cancelled"));
      else jest.advanceTimersByTime(60);
      releaseBody();
    }
    const response = await pending;
    const body = await response.json();
    expect({ sends, rotations, externalFetches }).toEqual({ sends: 1, rotations: 0, externalFetches: 0 });
    expect(response.status).toBe(kind === "caller-cancel" ? 499 : 429);
    if (kind === "caller-cancel") expect(body.error.code).not.toBe("upstream_reset_replay_refused");
    else {
      expect(physicalSignal!.aborted).toBe(false);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(body.error.code).toBe(code);
    }
  } finally {
    caller.abort(); releaseBody(); detach();
    await pending.catch(() => {});
    if (timed) jest.useRealTimers();
  }
});
