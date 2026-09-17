/**
 * #4587: the bridge shows the CALLER a hosted web_search_call cell for a search it ran
 * proxy-side. The caller replays that cell on the next turn, so the destination — which never
 * produced a web_search_call — saw an unknown item type carrying a query and no result, and
 * usually just searched again.
 *
 * These pin the repair and, just as importantly, its refusals: a miss must leave the replayed
 * item alone rather than re-running the search or inventing a result.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createPassthroughWebSearchBridgeStream,
  type PassthroughWebSearchBridgePlan,
} from "../../src/web-search/passthrough-bridge";
import { restoreBridgedWebSearchCalls } from "../../src/adapters/openai-responses/tool-output-recovery";
import {
  bridgeSearchReplayScope,
  clearBridgeSearchReplayCacheForTests,
  rememberBridgeSearchReplay,
} from "../../src/responses/bridge-search-replay-cache";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import type { OcxProviderConfig } from "../../src/types";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const GATEWAY_BASE_URL = "https://gateway.internal/v1";
const OTHER_BASE_URL = "https://other-gateway.internal/v1";

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

function clientEvents(body: string): Record<string, unknown>[] {
  return body
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(payload => payload.length > 0 && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
}

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

const clientCall = {
  type: "function_call",
  id: "fc_2",
  call_id: "call_2",
  name: "exec",
  arguments: "{\"cmd\":\"ls\"}",
};

/** The reported shape: one bridged search and one client-executed call on the same leg. */
const mixedLeg = sseBody(
  frame("response.output_item.added", { output_index: 0, item: { ...searchCall, arguments: "" } }),
  frame("response.output_item.done", { output_index: 0, item: searchCall }),
  frame("response.output_item.added", { output_index: 1, item: { ...clientCall, arguments: "" } }),
  frame("response.output_item.done", { output_index: 1, item: clientCall }),
  frame("response.completed", {
    response: { id: "resp_1", status: "completed", output: [searchCall, clientCall] },
  }),
);

const initialBody = JSON.stringify({
  model: "glm-4.7",
  stream: true,
  input: [{ role: "user", content: [{ type: "input_text", text: "what is the latest release?" }] }],
  tools: [{ type: "web_search" }],
});

/**
 * Run one mixed leg through the real bridge stream and return the hosted cell id the client
 * would store. Reading the id off the emitted stream, rather than asserting a literal, is what
 * proves the memo is keyed on the same id the caller actually replays.
 */
async function runBridgedMixedLeg(baseUrl: string, result = "opencodex 2.50.0 shipped"): Promise<string> {
  const stream = createPassthroughWebSearchBridgeStream({
    plan,
    firstLeg: streamFromText(mixedLeg),
    requestBody: initialBody,
    send: async () => {
      throw new Error("a mixed leg must not send a continuation");
    },
    execute: async () => ({ text: result, sources: [{ url: "https://example.test/rel", title: "Releases" }] }),
    destinationScope: bridgeSearchReplayScope(baseUrl),
  });
  const body = await new Response(stream).text();
  const added = clientEvents(body).find(event =>
    event.type === "response.output_item.added"
    && (event.item as { type?: string } | undefined)?.type === "web_search_call");
  const cellId = (added?.item as { id?: string } | undefined)?.id;
  expect(typeof cellId).toBe("string");
  return cellId as string;
}

/** The next turn as the caller sends it: the hosted cell, then the client's own tool result. */
function nextTurnBody(cellId: string): Record<string, unknown> {
  return {
    model: "glm-4.7",
    input: [
      { role: "user", content: [{ type: "input_text", text: "what is the latest release?" }] },
      {
        type: "web_search_call",
        id: cellId,
        status: "completed",
        action: { type: "search", query: "opencodex release", queries: ["opencodex release"] },
      },
      { type: "function_call", id: "fc_2", call_id: "call_2", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "call_2", output: "ok" },
    ],
  };
}

afterEach(() => {
  clearBridgeSearchReplayCacheForTests();
});

describe("bridged web_search replay to the destination", () => {
  test("the next turn carries the destination's own call and the executed result", async () => {
    const cellId = await runBridgedMixedLeg(GATEWAY_BASE_URL);

    const restored = restoreBridgedWebSearchCalls(
      nextTurnBody(cellId),
      bridgeSearchReplayScope(GATEWAY_BASE_URL),
    ) as { input: Record<string, unknown>[] };

    // The item type the destination never produced is gone, replaced in place by the exchange
    // it actually had: its own call, immediately followed by the result the proxy executed.
    expect(restored.input.some(item => item.type === "web_search_call")).toBe(false);
    const call = restored.input[1];
    const output = restored.input[2];
    expect(call).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "web_search",
      arguments: "{\"query\":\"opencodex release\"}",
    });
    expect(output).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "opencodex 2.50.0 shipped",
    });
    // The client's own call and result are untouched and still adjacent.
    expect(restored.input[3]).toEqual({ type: "function_call", id: "fc_2", call_id: "call_2", name: "exec", arguments: "{}" });
    expect(restored.input[4]).toEqual({ type: "function_call_output", call_id: "call_2", output: "ok" });
  });

  test("an executor failure replays as the same tool result the destination would have seen", async () => {
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(mixedLeg),
      requestBody: initialBody,
      send: async () => {
        throw new Error("a mixed leg must not send a continuation");
      },
      execute: async () => ({ text: "", sources: [], error: "backend refused" }),
      destinationScope: bridgeSearchReplayScope(GATEWAY_BASE_URL),
    });
    const body = await new Response(stream).text();
    const added = clientEvents(body).find(event =>
      event.type === "response.output_item.added"
      && (event.item as { type?: string } | undefined)?.type === "web_search_call");
    const cellId = (added?.item as { id?: string }).id as string;

    const restored = restoreBridgedWebSearchCalls(
      nextTurnBody(cellId),
      bridgeSearchReplayScope(GATEWAY_BASE_URL),
    ) as { input: Record<string, unknown>[] };
    expect(restored.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "Web search failed: backend refused",
    });
  });

  test("a cell this proxy never executed is left exactly as the caller sent it", () => {
    const body = nextTurnBody("ws_never-recorded");
    const restored = restoreBridgedWebSearchCalls(body, bridgeSearchReplayScope(GATEWAY_BASE_URL));
    // Same reference: a miss allocates nothing and invents nothing.
    expect(restored).toBe(body);
  });

  test("a search recorded for one destination is not replayed into another", async () => {
    const cellId = await runBridgedMixedLeg(GATEWAY_BASE_URL);
    const body = nextTurnBody(cellId);
    expect(restoreBridgedWebSearchCalls(body, bridgeSearchReplayScope(OTHER_BASE_URL))).toBe(body);
  });

  test("an expired entry behaves exactly like a miss", async () => {
    let clockMs = 1_000;
    clearBridgeSearchReplayCacheForTests(() => clockMs);
    const cellId = await runBridgedMixedLeg(GATEWAY_BASE_URL);
    const body = nextTurnBody(cellId);
    // Still inside the TTL.
    expect(restoreBridgedWebSearchCalls(body, bridgeSearchReplayScope(GATEWAY_BASE_URL))).not.toBe(body);
    clockMs += 61 * 60 * 1000;
    expect(restoreBridgedWebSearchCalls(body, bridgeSearchReplayScope(GATEWAY_BASE_URL))).toBe(body);
  });

  test("a call id the body already carries is never duplicated", () => {
    const scope = bridgeSearchReplayScope(GATEWAY_BASE_URL);
    rememberBridgeSearchReplay(scope, "ws_dup", {
      callId: "call_2",
      name: "web_search",
      argumentsText: "{}",
      output: "result",
    });
    const body = nextTurnBody("ws_dup");
    expect(restoreBridgedWebSearchCalls(body, scope)).toBe(body);
  });

  test("an unbridged provider is never given a scope to restore from", () => {
    const scope = bridgeSearchReplayScope(GATEWAY_BASE_URL);
    rememberBridgeSearchReplay(scope, "ws_unbridged", {
      callId: "call_1",
      name: "web_search",
      argumentsText: "{}",
      output: "result",
    });
    const body = nextTurnBody("ws_unbridged");
    expect(restoreBridgedWebSearchCalls(body, undefined)).toBe(body);
  });
});

describe("the Responses passthrough adapter", () => {
  function providerFixture(bridged: boolean): OcxProviderConfig {
    return {
      adapter: "openai-responses",
      baseUrl: GATEWAY_BASE_URL,
      authMode: "key",
      apiKey: "fixture-key",
      ...(bridged ? { webSearchBridge: { enabled: true, backend: "ollama" } } : {}),
    } as OcxProviderConfig;
  }

  function outboundInput(provider: OcxProviderConfig, cellId: string): Record<string, unknown>[] {
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "glm-4.7",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: nextTurnBody(cellId),
    }, { headers: new Headers() });
    return (JSON.parse(request.body) as { input: Record<string, unknown>[] }).input;
  }

  test("restores the pair on the wire for a bridged provider", async () => {
    const cellId = await runBridgedMixedLeg(GATEWAY_BASE_URL);
    const input = outboundInput(providerFixture(true), cellId);
    expect(input.some(item => item.type === "web_search_call")).toBe(false);
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "web_search" });
    expect(input[2]).toMatchObject({ type: "function_call_output", call_id: "call_1", output: "opencodex 2.50.0 shipped" });
  });

  test("leaves the hosted cell alone when the provider has not opted in", async () => {
    const cellId = await runBridgedMixedLeg(GATEWAY_BASE_URL);
    const input = outboundInput(providerFixture(false), cellId);
    expect(input.some(item => item.type === "web_search_call" && item.id === cellId)).toBe(true);
    expect(input.some(item => item.call_id === "call_1")).toBe(false);
  });
});
