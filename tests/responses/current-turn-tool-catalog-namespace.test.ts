import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { clearResponseStateForTests, expandPreviousResponseInput, flushResponseState } from "../../src/responses/state";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import * as adapterResolver from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses";
import { namespacedToolName, type AdapterEvent, type OcxConfig, type OcxParsedRequest } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

type Rec = Record<string, unknown>;
type Lane = "adapter" | "runTurn";
type Reply = { response: Rec; items: Rec[] };
const userInput = { role: "user", content: [{ type: "input_text", text: "fixture request" }] };
const readTool = { type: "function", name: "Read", parameters: { type: "object", properties: {} } };
const additional = (namespace: string | undefined) => ({
  type: "additional_tools", role: "developer",
  tools: namespace ? [{ type: "namespace", name: namespace, tools: [readTool] }] : [readTool],
});

let home: ReturnType<typeof createTempHome>;
let releaseHome: (() => void) | undefined;
let adapterSpy: ReturnType<typeof spyOn<typeof adapterResolver, "resolveAdapter">> | undefined;
let nextCall: string | undefined;
let dispatched: Array<{ replayPrefix: number; tools: string[] }>;

beforeEach(() => {
  home = createTempHome("ocx-current-tool-namespace-");
  releaseHome = acquireOwnedSpendHome();
  clearResponseStateForTests();
  clearKeyCooldowns();
  nextCall = undefined;
  dispatched = [];
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

function setup(lane: Lane): OcxConfig {
  const adapterName = `current-namespace-${lane}`;
  const record = (parsed: OcxParsedRequest) => dispatched.push({
    replayPrefix: parsed._replayPrefixLen ?? 0,
    tools: (parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)),
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
      // Exercise the real handler and continuation store without a physical network send.
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
      authMode: "key", apiKey: "fixture-key", models: ["model"], liveModels: false,
    } },
  };
}

async function post(config: OcxConfig, stream: boolean, body: Rec): Promise<Reply> {
  const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", stream, ...body }),
  }), config, { model: "", provider: "" });
  const text = await response.text();
  expect(response.status).toBe(200);
  if (!stream) return { response: JSON.parse(text) as Rec, items: [] };
  const frames = text.split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    return data && data !== "[DONE]" ? [JSON.parse(data) as Rec] : [];
  });
  const terminal = frames.filter(frame => frame.type === "response.completed" || frame.type === "response.failed");
  expect(terminal).toHaveLength(1);
  return {
    response: terminal[0]!.response as Rec,
    items: frames.filter(frame => frame.type === "response.output_item.added" || frame.type === "response.output_item.done")
      .map(frame => frame.item as Rec),
  };
}

function assertCurrentIdentity(reply: Reply, namespace: string | undefined, allowRefusal: boolean): void {
  const calls = (reply.response.output as Rec[]).filter(item => item.type === "function_call");
  const streamedCalls = reply.items.filter(item => item.type === "function_call");
  if (allowRefusal && reply.response.status === "failed") {
    expect(calls).toHaveLength(0);
    expect(streamedCalls).toHaveLength(0);
    expect((reply.response.error as Rec).message).toContain("undeclared client tool");
    const continuation = { previous_response_id: reply.response.id, input: [userInput] };
    expect(expandPreviousResponseInput(continuation)).toBe(continuation);
    return;
  }
  expect(reply.response.status).toBe("completed");
  expect(reply.response.error).toBeUndefined();
  expect(calls).toHaveLength(1);
  for (const call of [...calls, ...streamedCalls]) {
    expect(call.name).toBe("Read");
    expect(call.namespace).toBe(namespace);
  }
}

for (const lane of ["adapter", "runTurn"] as const) for (const stream of [false, true]) {
  for (const currentNamespace of ["remote", undefined]) {
    const previousNamespace = currentNamespace ? undefined : "remote";
    test(`${lane}, ${stream ? "SSE" : "JSON"}: prior ${previousNamespace ?? "bare"}/Read cannot own current ${currentNamespace ?? "bare"}/Read echo`, async () => {
      const config = setup(lane);
      const prior = await post(config, stream, { input: [additional(previousNamespace), userInput] });
      expect(prior.response.status).toBe("completed");
      const body = { previous_response_id: prior.response.id, input: [additional(currentNamespace), userInput] };
      nextCall = "Read";
      const echo = await post(config, stream, body);
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]!.replayPrefix).toBeGreaterThan(0);
      expect(dispatched[1]!.tools).toEqual(expect.arrayContaining(["Read", "remote__Read"]));
      // An ambiguous bare echo may be refused, but must never execute under the older identity.
      assertCurrentIdentity(echo, currentNamespace, true);
      // The current canonical spelling remains executable; denying every call is not a fix.
      nextCall = namespacedToolName(currentNamespace, "Read");
      const canonical = await post(config, stream, body);
      expect(dispatched).toHaveLength(3);
      expect(dispatched[2]!.replayPrefix).toBeGreaterThan(0);
      assertCurrentIdentity(canonical, currentNamespace, false);
    });
  }
}
