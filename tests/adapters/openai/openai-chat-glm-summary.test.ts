import { describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { chatCompletionsToResponsesBody } from "../../../src/chat/inbound";
import { concreteComboRequestBody } from "../../../src/combos/request";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";

const model = "glm-5.3-flash";
const provider: OcxProviderConfig = {
  adapter: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4",
  reasoningEfforts: ["low", "medium", "high", "max"],
};
const messages = [
  { role: "system", content: "You are a context-summarization assistant. Produce a checkpoint." },
  { role: "user", content: "<conversation>User: implement the feature.</conversation>" },
];
function bodies(overrides: Record<string, unknown> = {}, config = provider) {
  const raw = { model, messages, max_tokens: 512, reasoning_effort: "max", ...overrides };
  const parsed = parseRequest(chatCompletionsToResponsesBody(raw));
  return [
    JSON.parse(createOpenAIChatAdapter(config).buildRequest(parsed).body),
    JSON.parse(buildOpenAIChatPassthroughRequest(config, raw, String(raw.model), false).body),
  ];
}

describe("GLM tiny standalone summary compatibility", () => {
  test.each([1, 512, 819, 1024])("raises cap %i and lowers effort on both Chat paths", cap => {
    for (const body of bodies({ max_tokens: cap })) {
      expect(body.max_tokens).toBe(4096);
      expect(body.reasoning_effort).toBe("low");
      expect(body.messages).toEqual(messages);
    }
  });
  test("final adapter wins after successive combo force overrides", () => {
    let raw = chatCompletionsToResponsesBody({ model, messages, max_tokens: 819, reasoning_effort: "high" });
    for (const target of [{ provider: "proxy", model: "inner" }, { provider: "zai", model }]) {
      raw = concreteComboRequestBody(raw, target, "max", provider.reasoningEfforts, "strict", "force");
    }
    const parsed = parseRequest(raw);
    parsed.modelId = model;
    expect(parsed.options.reasoning).toBe("max");
    const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body);
    expect(body.max_tokens).toBe(4096);
    expect(body.reasoning_effort).toBe("low");
    expect(parsed.options.maxOutputTokens).toBe(819);
    expect(parsed.options.reasoning).toBe("max");
  });
  test.each([0, -1, 1025, 4096, undefined])("preserves cap outside the mitigation: %s", cap => {
    for (const body of bodies({ max_tokens: cap })) {
      expect(body.max_tokens).toBe(cap);
      expect(body.reasoning_effort).toBe("max");
    }
  });
  test("does not change other models, ordinary prompts, tools, or ongoing conversations", () => {
    for (const overrides of [
      { model: "glm-5.3" }, { model: "glm-5.3-flashx" }, { model: "gpt-5" },
      { messages: [{ role: "system", content: "Be helpful." }, { role: "user", content: "Summarize this article." }] },
      { messages: [...messages, { role: "assistant", content: "Previous checkpoint" }] },
      { tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }] },
    ]) for (const body of bodies(overrides)) {
      expect(body.max_tokens).toBe(512);
      expect(body.reasoning_effort).toBe("max");
    }
  });
});
