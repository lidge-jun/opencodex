import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import * as adapterResolver from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses";
import {
  clearResponseStateForTests,
  expandPreviousResponseInput,
  flushResponseState,
} from "../../src/responses/state";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import type { AdapterEvent, OcxConfig, OcxParsedRequest } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

type Rec = Record<string, unknown>;
type Lane = "adapter" | "runTurn";
type Wire = "chat" | "anthropic";
const REFUSAL_CODE = "undeclared_tool_call";
const userInput = { role: "user", content: [{ type: "input_text", text: "fixture request" }] };
const tool = (name: string) => ({ type: "function", name, parameters: { type: "object", properties: {} } });
const additional = (names: string[]) => ({ type: "additional_tools", role: "developer", tools: names.map(tool) });

let home: ReturnType<typeof createTempHome>;
let releaseHome: (() => void) | undefined;
let adapterSpy: ReturnType<typeof spyOn<typeof adapterResolver, "resolveAdapter">> | undefined;
let nextCall: string | undefined;
let dispatched: Array<{ replayPrefix: number; tools: string[] }>;

beforeEach(() => {
  home = createTempHome("ocx-empty-tool-history-");
  releaseHome = acquireOwnedSpendHome();
  clearResponseStateForTests();
  clearKeyCooldowns();
  dispatched = [];
  nextCall = undefined;
});

afterEach(async () => {
  adapterSpy?.mockRestore();
  adapterSpy = undefined;
  releaseHome?.();
  releaseHome = undefined;
  closeRequestHistoryIndex();
  await flushResponseState();
  clearResponseStateForTests();
  clearKeyCooldowns();
  resetProviderRequestPacingForTest();
  home.remove();
});

function replyEvents(): AdapterEvent[] {
  return [
    ...(nextCall ? [
      { type: "tool_call_start" as const, id: "call_fixture", name: nextCall },
      { type: "tool_call_delta" as const, arguments: "{}" },
      { type: "tool_call_end" as const },
    ] : [{ type: "text_delta" as const, text: "fixture answer" }]),
    { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
  ];
}

function setup(lane: Lane, authMode: "key" | "forward" = "key"): OcxConfig {
  const adapterName = `empty-history-${lane}`;
  const record = (parsed: OcxParsedRequest) => dispatched.push({
    replayPrefix: parsed._replayPrefixLen ?? 0,
    tools: (parsed.context.tools ?? []).map(item => item.name),
  });
  const originalResolve = adapterResolver.resolveAdapter;
  adapterSpy = spyOn(adapterResolver, "resolveAdapter").mockImplementation((provider, cache) => {
    if (provider.adapter !== adapterName) return originalResolve(provider, cache);
    return {
      name: adapterName,
      buildRequest(parsed) {
        record(parsed);
        return { url: provider.baseUrl, method: "POST", headers: {}, body: "{}" };
      },
      // Keep the real request pipeline, but never perform a physical network send.
      async fetchResponse() { return Response.json({ fixture: true }); },
      async *parseStream() { yield* replyEvents(); },
      async parseResponse() { return replyEvents(); },
      ...(lane === "runTurn" ? {
        async runTurn(parsed: OcxParsedRequest, _incoming: unknown, emit: (event: AdapterEvent) => void) {
          record(parsed);
          for (const event of replyEvents()) emit(event);
        },
      } : {}),
    } satisfies ProviderAdapter;
  });
  return {
    port: 0, defaultProvider: "fixture",
    providers: { fixture: {
      adapter: adapterName, baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true,
      authMode, apiKey: "fixture-key", models: ["model"], liveModels: false,
    } },
  };
}

async function post(config: OcxConfig, inboundWire: Wire, stream: boolean, body: Rec, emptyAtIngress = false, directFallback = false) {
  const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", stream, input: [userInput], ...body }),
  }), config, { model: "", provider: "" }, {
    inboundWire, clientDeclaredEmptyToolCatalog: emptyAtIngress,
    ...(directFallback ? { clientEncoder: { protocol: inboundWire === "chat" ? "chat" as const : "messages" as const,
      stream, model: "fixture/model" } } : {}),
  });
  const text = await response.text();
  expect(response.status).toBe(200);
  if (!stream) return JSON.parse(text) as Rec;
  const frames = text.split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    return data && data !== "[DONE]" ? [JSON.parse(data) as Rec] : [];
  });
  const terminal = frames.filter(frame => frame.type === "response.completed" || frame.type === "response.failed");
  expect(terminal).toHaveLength(1);
  if (terminal[0]!.type === "response.failed") {
    expect(frames.some(frame => frame.type === "response.output_item.added"
      && (frame.item as Rec | undefined)?.type === "function_call")).toBe(false);
  }
  return terminal[0]!.response as Rec;
}

function assertRefusedAndUncached(response: Rec): void {
  expect(response.status).toBe("failed");
  expect(response.error).toMatchObject({ code: REFUSAL_CODE });
  expect((response.output as Rec[]).some(item => item.type === "function_call")).toBe(false);
  expect(typeof response.id).toBe("string");
  const continuation = { previous_response_id: response.id, input: [userInput] };
  expect(expandPreviousResponseInput(continuation)).toBe(continuation);
}

function assertAllowed(response: Rec, name: string): void {
  expect(response.status).toBe("completed");
  expect(response.error).toBeUndefined();
  expect(response.output).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "function_call", name, status: "completed" }),
  ]));
  const continuation = { previous_response_id: response.id, input: [userInput] };
  expect(expandPreviousResponseInput(continuation)).not.toBe(continuation);
}

describe("explicit empty catalog current-turn and continuation boundaries", () => {
  for (const lane of ["adapter", "runTurn"] as const) for (const wire of ["chat", "anthropic"] as const) {
    for (const stream of [false, true]) {
      const label = `${lane}, ${wire}, ${stream ? "SSE" : "JSON"}`;

      for (const emptyAtIngress of [false, true]) {
        test(`${label}: ${emptyAtIngress ? "ingress-only empty flag" : "current tools:[]"} blocks a historical tool without caching refusal`, async () => {
          const config = setup(lane);
          const prior = await post(config, wire, stream, { input: [additional(["Write"]), userInput] });
          expect(prior.status).toBe("completed");
          nextCall = "Write";
          // Translation may drop tools:[] entirely; its ingress-owned fact must survive replay.
          const response = await post(config, wire, stream, {
            previous_response_id: prior.id, ...(emptyAtIngress ? {} : { tools: [] }),
          }, emptyAtIngress);
          expect(dispatched).toHaveLength(2);
          expect(dispatched[1]!.replayPrefix).toBeGreaterThan(0);
          expect(dispatched[1]!.tools).toContain("Write");
          assertRefusedAndUncached(response);
        });
      }

      test(`${label}: historical additional_tools:[] does not restrict a current partial catalog`, async () => {
        const config = setup(lane);
        const prior = await post(config, wire, stream, { input: [additional([]), userInput] });
        expect(prior.status).toBe("completed");
        nextCall = "Write";
        const response = await post(config, wire, stream, { previous_response_id: prior.id, tools: [tool("Read")] });
        expect(dispatched).toHaveLength(2);
        expect(dispatched[1]!.replayPrefix).toBeGreaterThan(0);
        expect(dispatched[1]!.tools).toContain("Read");
        assertAllowed(response, "Write");
      });

      test(`${label}: current declaration controls output normalization after historical default.Read`, async () => {
        const config = setup(lane);
        const prior = await post(config, wire, stream, { input: [additional(["default.Read"]), userInput] });
        expect(prior.status).toBe("completed");
        nextCall = "default.Read";
        const response = await post(config, wire, stream, {
          previous_response_id: prior.id, tools: [], input: [additional(["Read"]), userInput],
        });
        expect(dispatched).toHaveLength(2);
        expect(dispatched[1]!.replayPrefix).toBeGreaterThan(0);
        expect(dispatched[1]!.tools).toEqual(expect.arrayContaining(["default.Read", "Read"]));
        assertAllowed(response, "Read");
        expect((response.output as Rec[]).some(item => item.name === "default.Read")).toBe(false);
      });

      test(`${label}: current custom exec controls helper normalization after historical apply_patch`, async () => {
        const config = setup(lane);
        const prior = await post(config, wire, stream, { input: [additional(["apply_patch"]), userInput] });
        nextCall = "apply_patch";
        const response = await post(config, wire, stream, {
          previous_response_id: prior.id, tools: [], input: [
            { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] },
            userInput,
          ],
        });
        expect(dispatched[1]!.replayPrefix).toBeGreaterThan(0);
        expect(response.status).toBe("completed");
        expect(response.output).toEqual(expect.arrayContaining([expect.objectContaining({
          type: "custom_tool_call", name: "exec", status: "completed",
          input: 'const result = await tools.apply_patch("{}");\ntext(result);',
        })]));
      });

      for (const name of ["Read", "Write"]) {
        test(`${label}: tools:[] plus current additional Read ${name === "Read" ? "allows Read" : "refuses Write"}`, async () => {
          const config = setup(lane);
          nextCall = name;
          const response = await post(config, wire, stream, { tools: [], input: [additional(["Read"]), userInput] });
          expect(dispatched).toHaveLength(1);
          expect(dispatched[0]!.tools).toContain("Read");
          if (name === "Read") assertAllowed(response, name);
          else assertRefusedAndUncached(response);
        });
      }

      for (const custom of [false, true]) {
        test(`${label}: empty catalog plus current ${custom ? "custom apply_patch" : "MCP namespace"} remains callable`, async () => {
          const config = setup(lane);
          nextCall = custom ? "apply_patch" : "mcp__fixture__lookup";
          const response = await post(config, wire, stream, { tools: [], input: [
            { type: "additional_tools", role: "developer", tools: custom
              ? [{ type: "custom", name: "apply_patch", format: { type: "text" } }]
              : [{ type: "namespace", name: "mcp__fixture", tools: [tool("lookup")] }] },
            userInput,
          ] });
          expect(response.status).toBe("completed");
          expect(response.error).toBeUndefined();
          expect(response.output).toEqual(expect.arrayContaining([expect.objectContaining(custom
            ? { type: "custom_tool_call", name: "apply_patch", input: "{}" }
            : { type: "function_call", name: "lookup", namespace: "mcp__fixture", arguments: "{}" })]));
        });
      }

      test(`${label}: forward authentication keeps its empty-catalog exemption`, async () => {
        const config = setup(lane, "forward");
        nextCall = "Write";
        const response = await post(config, wire, stream, { tools: [] }, true);
        expect(dispatched).toHaveLength(1);
        assertAllowed(response, "Write");
      });
    }
  }
});

describe("explicit empty catalog output normalization through direct client encoders", () => {
  for (const wire of ["chat", "anthropic"] as const) {
    test(`${wire}: direct encoder option retains current custom exec helper compilation via the Responses bridge`, async () => {
      const config = setup("adapter");
      const prior = await post(config, wire, false, { input: [additional(["apply_patch"]), userInput] });
      nextCall = "apply_patch";
      const response = await post(config, wire, true, {
        previous_response_id: prior.id, tools: [], input: [
          { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] },
          userInput,
        ],
      }, false, true);
      expect(dispatched[1]!.replayPrefix).toBeGreaterThan(0);
      expect(response.status).toBe("completed");
      expect(response.output).toEqual(expect.arrayContaining([expect.objectContaining({
        type: "custom_tool_call", name: "exec", status: "completed",
        input: 'const result = await tools.apply_patch("{}");\ntext(result);',
      })]));
    });
  }
  for (const wire of ["chat", "anthropic"] as const) for (const stream of [false, true]) {
    test(`${wire}, ${stream ? "SSE" : "JSON"}: direct output uses current Read after historical default.Read`, async () => {
      const config = setup("adapter");
      const prior = await post(config, wire, false, { input: [additional(["default.Read"]), userInput] });
      nextCall = "default.Read";
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          model: "fixture/model", stream: true, previous_response_id: prior.id,
          tools: [], input: [additional(["Read"]), userInput],
        }),
      }), config, { model: "", provider: "" }, {
        inboundWire: wire, clientEncoder: { protocol: wire === "chat" ? "chat" : "messages", stream, model: "fixture/model" },
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(dispatched[1]!.replayPrefix).toBeGreaterThan(0);
      expect(text).toContain('"name":"Read"');
      expect(text).not.toContain("default.Read");
      // Verify the direct client wire instead of accepting an unnoticed Responses fallback.
      expect(text).toContain(wire === "chat" ? '"choices"' : stream ? '"content_block_start"' : '"type":"message"');
    });
  }
});

describe("explicit empty catalog through the hosted web-search loop", () => {
  for (const wire of ["chat", "anthropic"] as const) for (const streamRoutedModelOutput of [false, true]) {
    for (const emptyAtIngress of [false, true]) for (const name of ["Write", undefined]) {
      const label = `${wire}, routed output ${streamRoutedModelOutput ? "live" : "buffered"}, ${emptyAtIngress ? "ingress flag" : "current additional_tools:[]"}`;
      test(`${label}: ${name ? "refuses ordinary client tool" : "allows text completion"} after hosted search planning`, async () => {
        const config = setup("adapter");
        config.webSearchSidecar = { backend: "exa", exaApiKey: "fixture-search-key", streamRoutedModelOutput };
        nextCall = name;
        // The model fixture never requests web_search. Any accidental physical send must fail locally.
        const networkSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
          throw new Error("The hosted search output fixture must not perform a network request");
        });
        try {
          const response = await post(config, wire, true, {
            tools: [{ type: "web_search" }],
            input: [...(emptyAtIngress ? [] : [additional([])]), userInput],
          }, emptyAtIngress);
          expect(networkSpy).not.toHaveBeenCalled();
          expect(dispatched).toHaveLength(1);
          // Prove the request entered the sidecar loop instead of ordinary adapter delivery.
          expect(dispatched[0]!.tools).toContain("web_search");
          if (name) assertRefusedAndUncached(response);
          else {
            expect(response.status).toBe("completed");
            expect(response.error).toBeUndefined();
            expect(JSON.stringify(response.output)).toContain("fixture answer");
          }
        } finally {
          networkSpy.mockRestore();
        }
      });
    }
  }
});
