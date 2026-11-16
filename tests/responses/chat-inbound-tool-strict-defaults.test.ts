import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import type { OcxConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const pointerSchema = {
  type: "object", required: ["app"],
  properties: { app: { type: "string" }, element_index: { type: "integer" }, x: { type: "number" }, y: { type: "number" } },
};
const textSchema = {
  type: "object", required: ["app", "text"],
  properties: { app: { type: "string" }, text: { type: "string" }, element_index: { type: "integer" }, window: { type: "integer" } },
};
function parsedRequest(schema: object, strict?: boolean, legacy = false) {
  const fn = { name: "operate_control", parameters: schema, ...(strict === undefined ? {} : { strict }) };
  return parseRequest(chatCompletionsToResponsesBody({
    model: "test-model", messages: [{ role: "user", content: "Operate the indexed control" }],
    ...(legacy ? { functions: [fn] } : { tools: [{ type: "function", function: fn }] }),
  }));
}
function wireBody(parsed: ReturnType<typeof parsedRequest>, forward: boolean, chatWire = false, baseUrl = "https://api.openai.com/v1") {
  const provider = forward
    ? { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const }
    : { adapter: "openai-responses", baseUrl, apiKey: "k" };
  const adapter = chatWire ? createOpenAIChatAdapter({ ...provider, adapter: "openai-chat" }) : createResponsesPassthroughAdapter(provider);
  const budget = createTestTranslatorBudget();
  const request = adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
  try { return JSON.parse(request.body); }
  finally { request.releaseBodyObservation?.(); budget.dispose(); }
}

describe("Chat function defaults at the Responses wire", () => {
  for (const forward of [false, true]) {
    for (const [label, schema] of [["click", pointerSchema], ["type_text", textSchema]] as const) {
      for (const chatInput of [false, true]) {
        for (const strict of [undefined, false, true]) {
          test(`${label}: strict=${String(strict)}, chatInput=${chatInput}, forward=${forward}`, () => {
            const parsed = parsedRequest(schema, strict);
            parsed._chatCompletionsInput = chatInput;
            const before = structuredClone(parsed._rawBody);
            const tool = wireBody(parsed, forward).tools[0];
            const expected = strict ?? (chatInput ? false : undefined);
            if (expected === undefined) expect(tool).not.toHaveProperty("strict");
            else expect(tool.strict).toBe(expected);
            expect(tool.parameters).toEqual(schema);
            expect(parsed._rawBody).toEqual(before);
          });
        }
      }
    }
    test(`legacy Chat functions keep their non-strict default (forward=${forward})`, () => {
      const parsed = parsedRequest(pointerSchema, undefined, true);
      parsed._chatCompletionsInput = true;
      expect(wireBody(parsed, forward).tools[0]).toEqual({
        type: "function", name: "operate_control", parameters: pointerSchema, strict: false,
      });
    });
  }
  test("a translated Chat destination keeps its original tool declaration", () => {
    const parsed = parsedRequest(pointerSchema);
    parsed._chatCompletionsInput = true;
    expect(wireBody(parsed, false, true).tools[0].function).toEqual({ name: "operate_control", parameters: pointerSchema });
  });
  test("third-party Responses destinations keep their original tool declaration", () => {
    const parsed = parsedRequest(pointerSchema);
    parsed._chatCompletionsInput = true;
    expect(wireBody(parsed, false, false, "https://example.test/v1").tools[0]).not.toHaveProperty("strict");
  });
  for (const inboundWire of ["chat", "responses"] as const) {
    test(`trusted ${inboundWire} ingress determines the final default after parsing`, async () => {
      const parsed = parsedRequest(pointerSchema);
      // A stale attempt flag or a caller-supplied body field must not choose the wire contract.
      parsed._chatCompletionsInput = inboundWire !== "chat";
      (parsed._rawBody as Record<string, unknown>)._chatCompletionsInput = inboundWire !== "chat";
      const config: OcxConfig = {
        port: 0, defaultProvider: "P",
        providers: { P: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "k" } },
      };
      await applyFinalRouteRequestNormalization({
        parsed, config, route: routeModel(config, parsed.modelId), inboundWire,
        req: new Request(`http://localhost/v1/${inboundWire === "chat" ? "chat/completions" : "responses"}`),
        logCtx: { model: parsed.modelId, provider: "P" },
      });
      const tool = wireBody(parsed, false).tools[0];
      if (inboundWire === "chat") expect(tool.strict).toBe(false);
      else expect(tool).not.toHaveProperty("strict");
    });
  }
});
