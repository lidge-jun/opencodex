import { describe, expect, test } from "bun:test";
import { deliverPassthroughResponse } from "../../src/server/responses/passthrough-delivery";
import { guardBufferedComboRequiredTool } from "../../src/server/responses/combo-required-tool-contract";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const payload = {
  id: "resp_media_type", object: "response", status: "completed", model: "m1",
  output: [{ id: "msg_media_type", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "fixture answer", annotations: [] }] }],
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
};
const eventStream = `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\ndata: [DONE]\n\n`;

async function deliver(body: string, contentType?: string, plaintext = false): Promise<Response> {
  const request = new Request("http://127.0.0.1/v1/responses", { method: "POST" });
  const upstream = new AbortController();
  return deliverPassthroughResponse(
    { req: request, config: { providers: {} }, logCtx: { model: "", provider: "" },
      options: { admission: { kind: "loopback", source: "loopback" }, inboundWire: "responses" }
    } as Parameters<typeof deliverPassthroughResponse>[0],
    { authCtx: { kind: "none" } } as Parameters<typeof deliverPassthroughResponse>[1],
    { parsed: { stream: true, modelId: "m1", _rawBody: {} }, clientRequestedStream: false,
      translatorBudget: createTestTranslatorBudget(), route: {
        provider: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
        providerName: "fixture", modelId: "m1", staticPolicy: { model: {} },
      } } as Parameters<typeof deliverPassthroughResponse>[2],
    { requestBindings: new Map() } as Parameters<typeof deliverPassthroughResponse>[3],
    {} as Parameters<typeof deliverPassthroughResponse>[4],
    { plaintextV2AgentMessageToolNames: new Set(plaintext ? ["agent_message"] : []),
      plaintextV2AgentMessageAliasedToolNames: new Set(), routedMuseToolNameAliases: new Map(),
      routedNamespaceToolAliases: new Map(), commitReasoningReplayServingRoute() {}, recordTerminalOutcomes: false,
    } as Parameters<typeof deliverPassthroughResponse>[5],
    { upstreamResponse: new Response(new TextEncoder().encode(body), {
        headers: contentType === undefined ? {} : { "content-type": contentType },
      }), upstream, request, connectMs: 0, imageGenCallAliases: new Map(),
      selfNamedNamespaceScrubAuthorization: new Set(), authorizedBareNamespaceToolAliases: new Map(),
      routedCustomToolNames: new Set(), routedCustomToolRepairNames: new Set(), declaredWireToolNames: new Set(),
      routedToolSearchNames: new Set(), functionRepairSchemas: new Map(), declaredNamelessClientCallTypes: new Set(),
      providerExecutedCallTypes: new Set(), declaredBareWireToolNames: new Set(), recoverableBareCustomWireToolNames: new Set(),
      undeclaredToolGuardActive: true, rememberPassthroughResponse: false, rememberPassthroughResponseChecked() {},
      noteInspectedPayload() {}, normalizeFunctionCompletionJson: (value: string) => value, outboundRequestBody: "{}",
    } as Parameters<typeof deliverPassthroughResponse>[6],
  );
}

describe("native passthrough exact media types", () => {
  for (const contentType of ['application/json; profile="text/event-stream"', 'Application/JSON; note="TEXT/EVENT-STREAM"']) {
    test(`JSON remains JSON when a parameter mentions SSE: ${contentType}`, async () => {
      const response = await deliver(JSON.stringify(payload), contentType);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(await response.json()).toEqual(payload);
    });
  }

  for (const contentType of ["text/event-stream-extra", 'application/octet-stream; profile="text/event-stream"']) {
    test(`an explicit unrelated media type is relayed without SSE folding: ${contentType}`, async () => {
      const response = await deliver(eventStream, contentType);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(await response.text()).toBe(eventStream);
    });
  }

  for (const contentType of ["Text/Event-Stream; charset=UTF-8", undefined]) {
    test(`canonical SSE still folds for a JSON client: ${contentType ?? "missing header"}`, async () => {
      const response = await deliver(eventStream, contentType);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual(payload);
    });
  }

  test("plaintext V2 validates typed events instead of treating a parameter as JSON", async () => {
    const response = await deliver(eventStream, 'text/plain; profile="application/json"', true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(payload);
  });
});

describe("buffered required-tool media type boundary", () => {
  const request = { tools: [{ type: "function", name: "fixture_tool" }], tool_choice: "required" };
  test("mixed-case JSON is checked for the required call", async () => {
    const response = await guardBufferedComboRequiredTool(new Response(JSON.stringify(payload), {
      headers: { "content-type": "Application/JSON; charset=UTF-8" },
    }), request, "openai-responses");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "required_tool_contract_unsatisfied" } });
  });

  for (const contentType of ["application/json-seq", 'application/octet-stream; profile="application/json"']) {
    test(`an unrelated body is not consumed or classified as required-tool failure: ${contentType}`, async () => {
      const original = new Response(JSON.stringify(payload), { headers: { "content-type": contentType } });
      const result = await guardBufferedComboRequiredTool(original, request, "openai-responses");
      expect(result).toBe(original);
      expect(original.bodyUsed).toBe(false);
      expect(await original.json()).toEqual(payload);
    });
  }
});
