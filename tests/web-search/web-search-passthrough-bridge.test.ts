/**
 * #3761: the Codex App always declares the hosted web_search tool, and the KEY-auth Responses
 * passthrough relayed that declaration as though the destination executed it. Ollama Cloud GLM
 * does not, so it answered with a plain function_call named web_search that nothing ran, and the
 * undeclared-tool guard ended the turn.
 *
 * These pin the opt-in bridge: OFF reproduces the reported abort, ON removes the call from the
 * client stream and continues the conversation upstream, and an unrelated undeclared tool still
 * fails closed through the bridged stream.
 */
import { describe, expect, test } from "bun:test";
import {
  appendBridgeSearchTurn,
  createPassthroughWebSearchBridgeStream,
  planPassthroughWebSearchBridge,
  resolveOllamaWebSearchEndpoint,
  WEB_SEARCH_BRIDGE_ERROR_CODE,
  WEB_SEARCH_BRIDGE_MIXED_TOOLS_ERROR_CODE,
  type PassthroughWebSearchBridgePlan,
} from "../../src/web-search/passthrough-bridge";
import { mapOllamaSearchResponse } from "../../src/web-search/ollama-executor";
import { UNDECLARED_TOOL_CALL_ERROR_CODE } from "../../src/server/responses-undeclared-tool-guard";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig, ProviderWebSearchBridgeConfig } from "../../src/types";

/** One SSE event block without its blank-line delimiter. */
function frame(type: string, payload: Record<string, unknown>): string {
  return "event: " + type + "\ndata: " + JSON.stringify({ type, ...payload });
}

function sseBody(...blocks: string[]): string {
  return blocks.concat("data: [DONE]").join("\n\n") + "\n\n";
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

/** Every parsed data payload the client received, in order. */
function clientEvents(body: string): Record<string, unknown>[] {
  return body
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(payload => payload.length > 0 && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
}

function providerFixture(
  bridge?: ProviderWebSearchBridgeConfig,
  overrides: Partial<OcxProviderConfig> = {},
): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://ollama.com/v1",
    authMode: "key",
    apiKey: "fixture-key",
    ...(bridge ? { webSearchBridge: bridge } : {}),
    ...overrides,
  } as OcxProviderConfig;
}

function parsedFixture(overrides: Record<string, unknown> = {}): OcxParsedRequest {
  return {
    modelId: "glm-4.7",
    options: {},
    stream: true,
    _webSearch: { type: "web_search" },
    ...overrides,
  } as unknown as OcxParsedRequest;
}

const armed: ProviderWebSearchBridgeConfig = { enabled: true, backend: "ollama" };

describe("planPassthroughWebSearchBridge arming", () => {
  test("arms for an enabled ollama-backed key provider on the canonical origin", () => {
    const plan = planPassthroughWebSearchBridge(parsedFixture(), providerFixture(armed), {
      isPassthrough: true,
      stream: true,
    });
    expect(plan).toEqual({
      backend: "ollama",
      endpoint: "https://ollama.com/api/web_search",
      maxSearches: 3,
      timeoutMs: 60_000,
    });
  });

  test("stays disarmed without the opt-in", () => {
    const off: (ProviderWebSearchBridgeConfig | undefined)[] = [
      undefined,
      { backend: "ollama" },
      { enabled: false, backend: "ollama" },
    ];
    for (const bridge of off) {
      expect(planPassthroughWebSearchBridge(parsedFixture(), providerFixture(bridge), {
        isPassthrough: true,
        stream: true,
      })).toBeUndefined();
    }
  });

  test("never arms for forwarded ChatGPT auth or a stored OAuth credential", () => {
    for (const authMode of ["forward", "oauth"] as const) {
      expect(planPassthroughWebSearchBridge(
        parsedFixture(),
        providerFixture(armed, { authMode }),
        { isPassthrough: true, stream: true },
      )).toBeUndefined();
    }
  });

  test("stays disarmed off the passthrough, without hosted web_search, and for non-streaming turns", () => {
    const provider = providerFixture(armed);
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, { isPassthrough: false, stream: true }))
      .toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture({ _webSearch: undefined }), provider, {
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, { isPassthrough: true, stream: false }))
      .toBeUndefined();
  });

  test("a tool_choice that excludes search excludes the bridge", () => {
    expect(planPassthroughWebSearchBridge(
      parsedFixture({ options: { toolChoice: { type: "function", name: "exec" } } }),
      providerFixture(armed),
      { isPassthrough: true, stream: true },
    )).toBeUndefined();
  });

  test("backends without a shipped executor stay inert rather than falling back", () => {
    for (const backend of ["openai", "anthropic", "xai", "gemini", "exa"] as const) {
      expect(planPassthroughWebSearchBridge(
        parsedFixture(),
        providerFixture({ enabled: true, backend }),
        { isPassthrough: true, stream: true },
      )).toBeUndefined();
    }
  });

  test("the ollama backend refuses a non-canonical origin unless the operator names the endpoint", () => {
    const renamed = providerFixture(armed, { baseUrl: "https://gateway.example/v1" });
    expect(resolveOllamaWebSearchEndpoint(renamed)).toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture(), renamed, { isPassthrough: true, stream: true }))
      .toBeUndefined();

    const operatorSet = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "https://search.internal/api/web_search" },
      { baseUrl: "https://gateway.example/v1" },
    );
    const plan = planPassthroughWebSearchBridge(parsedFixture(), operatorSet, {
      isPassthrough: true,
      stream: true,
    });
    expect(plan?.endpoint).toBe("https://search.internal/api/web_search");
  });

  test("out-of-range bounds fall back to the documented defaults", () => {
    const plan = planPassthroughWebSearchBridge(
      parsedFixture(),
      providerFixture({ enabled: true, backend: "ollama", maxSearches: 99, timeoutMs: 1 }),
      { isPassthrough: true, stream: true },
    );
    expect(plan?.maxSearches).toBe(3);
    expect(plan?.timeoutMs).toBe(60_000);
  });
});

const plan: PassthroughWebSearchBridgePlan = {
  backend: "ollama",
  endpoint: "https://ollama.com/api/web_search",
  maxSearches: 3,
  timeoutMs: 60_000,
};

const searchCall = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "web_search",
  arguments: "{\"query\":\"opencodex release\"}",
};

const preamble = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  content: [{ type: "output_text", text: "Let me look that up." }],
};

const answer = {
  type: "message",
  id: "msg_2",
  role: "assistant",
  content: [{ type: "output_text", text: "The current release is 2.50.0." }],
};

/** A leg that asks for one search, preceded by a normal assistant message. */
function searchLeg(): string {
  return sseBody(
    frame("response.created", { response: { id: "resp_1", status: "in_progress" } }),
    frame("response.output_item.added", { output_index: 0, item: { ...preamble, content: [] } }),
    frame("response.output_item.done", { output_index: 0, item: preamble }),
    frame("response.output_item.added", { output_index: 1, item: { ...searchCall, arguments: "" } }),
    frame("response.function_call_arguments.done", {
      output_index: 1,
      item_id: "fc_1",
      arguments: searchCall.arguments,
    }),
    frame("response.output_item.done", { output_index: 1, item: searchCall }),
    frame("response.completed", {
      response: { id: "resp_1", status: "completed", output: [preamble, searchCall] },
    }),
  );
}

function answerLeg(): string {
  return sseBody(
    frame("response.created", { response: { id: "resp_2", status: "in_progress" } }),
    frame("response.output_item.added", { output_index: 0, item: { ...answer, content: [] } }),
    frame("response.output_item.done", { output_index: 0, item: answer }),
    frame("response.completed", {
      response: { id: "resp_2", status: "completed", output: [answer] },
    }),
  );
}

const initialBody = JSON.stringify({
  model: "glm-4.7",
  stream: true,
  input: [{ role: "user", content: [{ type: "input_text", text: "what is the latest release?" }] }],
  tools: [{ type: "web_search" }],
});

describe("the bridged client stream", () => {
  test("replaces the web_search function_call with a hosted cell and continues upstream", async () => {
    const sent: string[] = [];
    const executed: string[][] = [];
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(streamFromText(answerLeg()), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      execute: async (queries) => {
        executed.push(queries);
        return { text: "opencodex 2.50.0 shipped", sources: [{ url: "https://example.test/rel", title: "Releases" }] };
      },
    });

    const body = await new Response(stream).text();
    const events = clientEvents(body);

    // The call Codex cannot execute never reaches it; the hosted cell does.
    expect(body).not.toContain("\"name\":\"web_search\"");
    expect(body).not.toContain("\"type\":\"function_call\"");
    const added = events.find(event =>
      event.type === "response.output_item.added"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    const done = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    expect(added).toBeDefined();
    expect(done).toBeDefined();
    const addedItem = added!.item as Record<string, unknown>;
    const doneItem = done!.item as Record<string, unknown>;
    expect(addedItem.status).toBe("in_progress");
    expect(String(addedItem.id)).toStartWith("ws_");
    expect(doneItem.id).toBe(addedItem.id);
    expect(doneItem.status).toBe("completed");
    expect(doneItem.action).toEqual({
      type: "search",
      query: "opencodex release",
      queries: ["opencodex release"],
    });
    expect(doneItem.sources).toEqual([{ url: "https://example.test/rel", title: "Releases" }]);
    expect(executed).toEqual([["opencodex release"]]);

    // The second upstream body carries the executed call and its result.
    expect(sent).toHaveLength(1);
    const continuation = JSON.parse(sent[0]!) as { input: Record<string, unknown>[]; stream: boolean };
    expect(continuation.stream).toBe(true);
    const call = continuation.input.find(item => item.type === "function_call");
    const output = continuation.input.find(item => item.type === "function_call_output");
    expect(call).toMatchObject({ call_id: "call_1", name: "web_search", arguments: searchCall.arguments });
    expect(output).toMatchObject({ call_id: "call_1", output: "opencodex 2.50.0 shipped" });

    // Both legs land in one monotonic client numbering, and the terminal snapshot matches it.
    const indexes = events
      .filter(event => event.type === "response.output_item.added")
      .map(event => event.output_index);
    expect(indexes).toEqual([0, 1, 2]);
    const completed = events.filter(event => event.type === "response.completed");
    expect(completed).toHaveLength(1);
    const finalOutput = (completed[0]!.response as { output: Record<string, unknown>[] }).output;
    expect(finalOutput.map(item => item.type)).toEqual(["message", "web_search_call", "message"]);
    const sequences = events.map(event => event.sequence_number as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  test("a turn with no search is relayed untouched and never re-sends", async () => {
    let sends = 0;
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(answerLeg()),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(null, { status: 500 });
      },
      execute: async () => {
        throw new Error("must not execute a search for a turn that did not ask for one");
      },
    });

    const body = await new Response(stream).text();
    expect(sends).toBe(0);
    expect(body).not.toContain("web_search_call");
    expect(body).toContain("response.completed");
    expect(body).toContain("The current release is 2.50.0.");
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("a search mixed with another client tool call fails closed instead of dropping it", async () => {
    let sends = 0;
    const clientCall = {
      type: "function_call",
      id: "fc_2",
      call_id: "call_2",
      name: "exec",
      arguments: "{}",
    };
    const mixedLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: searchCall }),
      frame("response.output_item.added", { output_index: 1, item: { ...clientCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 1, item: clientCall }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [searchCall, clientCall] },
      }),
    );

    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(mixedLeg),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(null, { status: 500 });
      },
      execute: async () => ({ text: "unused", sources: [] }),
    });

    const body = await new Response(stream).text();
    expect(sends).toBe(0);
    // The client tool call is withheld and dropped: releasing it under a failed turn would let
    // Codex start running exec for a turn that never completes.
    expect(body).not.toContain("\"name\":\"exec\"");
    const failed = clientEvents(body).find(event => event.type === "response.failed");
    expect(failed).toBeDefined();
    const error = (failed!.response as { error: Record<string, unknown> }).error;
    expect(error.code).toBe(WEB_SEARCH_BRIDGE_MIXED_TOOLS_ERROR_CODE);
    expect(String(error.message)).toContain("another client tool");
    // The opened hosted cell is closed as failed rather than left spinning.
    const cell = clientEvents(body).find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    expect((cell!.item as Record<string, unknown>).status).toBe("failed");
  });

  test("a search that is not the last item keeps its streamed position", async () => {
    // The model searches first and keeps talking; the hosted cell must open where the call stood.
    const leg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: searchCall }),
      frame("response.output_item.added", { output_index: 1, item: { ...preamble, content: [] } }),
      frame("response.output_item.done", { output_index: 1, item: preamble }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [searchCall, preamble] },
      }),
    );
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(leg),
      requestBody: initialBody,
      send: async () => new Response(streamFromText(answerLeg()), {
        headers: { "content-type": "text/event-stream" },
      }),
      execute: async () => ({ text: "a result", sources: [] }),
    });

    const events = clientEvents(await new Response(stream).text());
    const added = events.filter(event => event.type === "response.output_item.added");
    expect(added.map(event => (event.item as Record<string, unknown>).type))
      .toEqual(["web_search_call", "message", "message"]);
    expect(added.map(event => event.output_index)).toEqual([0, 1, 2]);

    // The terminal snapshot keeps the same order the client saw, not the order of completion.
    const completed = events.find(event => event.type === "response.completed");
    const output = (completed!.response as { output: Record<string, unknown>[] }).output;
    expect(output.map(item => item.type)).toEqual(["web_search_call", "message", "message"]);
  });

  test("a continuation body over the outbound ceiling is refused instead of sent", async () => {
    let sends = 0;
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(null, { status: 500 });
      },
      execute: async () => ({ text: "a result", sources: [] }),
      checkOutboundBody: () => "outbound body is too large",
    });

    const body = await new Response(stream).text();
    expect(sends).toBe(0);
    const failed = clientEvents(body).find(event => event.type === "response.failed");
    const error = (failed!.response as { error: Record<string, unknown> }).error;
    expect(error.code).toBe(WEB_SEARCH_BRIDGE_ERROR_CODE);
    expect(String(error.message)).toContain("outbound body is too large");
  });

  test("a cancelled client stream bills no further search and sends no continuation", async () => {
    let sends = 0;
    let executes = 0;
    const controller = new AbortController();
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(streamFromText(answerLeg()), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      execute: async () => {
        executes += 1;
        return { text: "a result", sources: [] };
      },
      signal: controller.signal,
    });

    controller.abort();
    await new Response(stream).text();
    expect(executes).toBe(0);
    expect(sends).toBe(0);
  });


  test("the search budget is bounded and the turn terminates rather than looping", async () => {
    const executed: string[][] = [];
    let sends = 0;
    const stream = createPassthroughWebSearchBridgeStream({
      plan: { ...plan, maxSearches: 1 },
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(streamFromText(searchLeg()), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      execute: async (queries) => {
        executed.push(queries);
        return { text: "one result", sources: [] };
      },
    });

    const body = await new Response(stream).text();
    // One executed search, one refusal cell, then a bounded terminal failure.
    expect(executed).toHaveLength(1);
    expect(sends).toBe(2);
    const failed = clientEvents(body).find(event => event.type === "response.failed");
    expect((failed!.response as { error: Record<string, unknown> }).error.code)
      .toBe(WEB_SEARCH_BRIDGE_ERROR_CODE);
  });

  test("an executor failure is reported as the tool result, not as a dead turn", async () => {
    const sent: string[] = [];
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(streamFromText(answerLeg()), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      execute: async () => ({ text: "", sources: [], error: "ollama web-search HTTP 401" }),
    });

    const body = await new Response(stream).text();
    const done = clientEvents(body).find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    expect((done!.item as Record<string, unknown>).status).toBe("failed");
    const continuation = JSON.parse(sent[0]!) as { input: Record<string, unknown>[] };
    const output = continuation.input.find(item => item.type === "function_call_output");
    expect(String(output!.output)).toContain("Web search failed: ollama web-search HTTP 401");
    expect(body).toContain("The current release is 2.50.0.");
  });
});

describe("bridge helpers", () => {
  test("appendBridgeSearchTurn refuses a body whose input is not an array", () => {
    expect(appendBridgeSearchTurn("not json", [])).toBeUndefined();
    expect(appendBridgeSearchTurn(JSON.stringify({ input: "prompt" }), [])).toBeUndefined();
  });

  test("mapOllamaSearchResponse digests results and rejects a shapeless body", () => {
    expect(mapOllamaSearchResponse({ nope: true }).error).toBeDefined();
    expect(mapOllamaSearchResponse({ results: [] }).error).toBeDefined();
    const mapped = mapOllamaSearchResponse({
      results: [{ title: "Releases", url: "https://example.test/rel", content: "2.50.0 is out" }],
    });
    expect(mapped.error).toBeUndefined();
    expect(mapped.sources).toEqual([{ url: "https://example.test/rel", title: "Releases" }]);
    expect(mapped.text).toContain("2.50.0 is out");
  });
});

describe("the reported turn, end to end through handleResponses", () => {
  function config(bridge?: ProviderWebSearchBridgeConfig): OcxConfig {
    return {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://ollama.com/v1",
          authMode: "key",
          apiKey: "fixture-key",
          ...(bridge ? { webSearchBridge: bridge } : {}),
        },
      },
    } as unknown as OcxConfig;
  }

  // Codex's own shape: the hosted web_search declaration plus ordinary client function tools.
  const clientRequest = JSON.stringify({
    model: "fixture/glm-4.7",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "what is the latest release?" }] }],
    tools: [
      { type: "web_search" },
      { type: "function", name: "wait", parameters: { type: "object" } },
    ],
  });

  async function post(
    ocxConfig: OcxConfig,
    legs: string[],
  ): Promise<{ body: string; outbound: string[]; searches: number }> {
    const savedFetch = globalThis.fetch;
    const outbound: string[] = [];
    let searches = 0;
    let leg = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("/api/web_search")) {
        searches += 1;
        return new Response(JSON.stringify({
          results: [{ title: "Releases", url: "https://example.test/rel", content: "opencodex 2.50.0" }],
        }), { headers: { "content-type": "application/json" } });
      }
      outbound.push(String(init?.body ?? ""));
      const text = legs[Math.min(leg, legs.length - 1)]!;
      leg += 1;
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: clientRequest,
      }), ocxConfig, { model: "", provider: "" });
      return { body: await response.text(), outbound, searches };
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  test("without the opt-in the reported abort still happens", async () => {
    const result = await post(config(), [searchLeg()]);
    expect(result.searches).toBe(0);
    expect(result.outbound).toHaveLength(1);
    expect(result.body).toContain("response.failed");
    expect(result.body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(result.body).not.toContain("web_search_call");
  });

  test("with the opt-in the client sees a hosted search cell and the answer", async () => {
    const result = await post(config(armed), [searchLeg(), answerLeg()]);

    expect(result.searches).toBe(1);
    expect(result.body).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(result.body).toContain("\"type\":\"web_search_call\"");
    expect(result.body).not.toContain("\"name\":\"web_search\"");
    expect(result.body).toContain("The current release is 2.50.0.");

    // The search result reached the SECOND upstream body as a native tool result.
    expect(result.outbound).toHaveLength(2);
    const continuation = JSON.parse(result.outbound[1]!) as { input: Record<string, unknown>[] };
    const output = continuation.input.find(item => item.type === "function_call_output");
    expect(output).toBeDefined();
    expect(String(output!.output)).toContain("opencodex 2.50.0");
    expect(continuation.input.some(item =>
      item.type === "function_call" && item.name === "web_search")).toBe(true);
  });

  test("an unrelated undeclared tool still fails closed through the bridged stream", async () => {
    const strayCall = {
      type: "function_call",
      id: "fc_9",
      call_id: "call_9",
      name: "frobnicate",
      arguments: "{}",
    };
    const strayLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...strayCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: strayCall }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [strayCall] },
      }),
    );

    const result = await post(config(armed), [strayLeg]);
    expect(result.searches).toBe(0);
    expect(result.body).toContain("response.failed");
    expect(result.body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(result.body).toContain("frobnicate");
  });
});
