import { normalizeNativeChatContent } from "../../../src/adapters/openai-chat/native-content";
import { applyChatDestinationPolicy } from "../../../src/adapters/openai-chat/destination-policy";
import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { buildOpenAIChatPassthroughRequest } from "../../../src/adapters/openai-chat/passthrough";
import { enrichProviderFromRegistry } from "../../../src/providers/derive";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";

const model = "deepseek-v4-1-flash-1017";
function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  const result: OcxProviderConfig = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "test-key", ...overrides };
  enrichProviderFromRegistry("mistral", result);
  return result;
}
function native(raw: Record<string, unknown>, target = provider()) {
  return JSON.parse(buildOpenAIChatPassthroughRequest(target, {
    messages: [{ role: "developer", content: "Be concise" }, { role: "user", content: "Hi" }], ...raw,
  }, model, false).body as string);
}
function translated(effort: string, target = provider()) {
  const parsed = parseRequest({ model, input: [{ role: "developer", content: "Be concise" }, { role: "user", content: "Hi" }], max_output_tokens: 123, reasoning: { effort } });
  return JSON.parse(createOpenAIChatAdapter(target).buildRequest(parsed).body as string);
}

describe("canonical Mistral Chat wire policy", () => {
  test("renames the completion limit, retaining an explicit max_tokens", () => {
    expect(native({ max_completion_tokens: 123 })).toMatchObject({ max_tokens: 123 });
    expect(native({ max_completion_tokens: 123 })).not.toHaveProperty("max_completion_tokens");
    expect(native({ max_completion_tokens: 123, max_tokens: 45 })).toMatchObject({ max_tokens: 45 });
    expect(native({ max_completion_tokens: 123, max_tokens: 0 })).toMatchObject({ max_tokens: 0 });
    expect(native({ max_completion_tokens: 123, max_tokens: null })).toMatchObject({ max_tokens: 123 });
  });
  for (const [field, value] of Object.entries({ user: "synthetic-user", store: false, thinking: { type: "enabled" }, include_reasoning: true, reasoning: { enabled: true }, top_k: 10 })) {
    test(`omits rejected ${field}`, () => {
      expect(native({ [field]: value })).not.toHaveProperty(field);
    });
  }
  test("retains accepted native fields and caller input", () => {
    const raw = { prompt_cache_key: "synthetic-cache", stream_options: { include_usage: true }, parallel_tool_calls: false,
      metadata: { fixture: true }, service_tier: "standard_only", tools: [{ type: "function", function: { name: "check", parameters: { type: "object" }, strict: true } }], max_tokens: 123 };
    expect(native(raw, provider({ chatServiceTier: true }))).toMatchObject(raw);
    expect(raw).not.toHaveProperty("model");
  });
  test("new registrations fold developer messages on both paths; an operator false wins", () => {
    expect(provider().foldDeveloperRoleToSystem).toBe(true);
    expect(native({}).messages[0].role).toBe("system");
    expect(translated("xhigh").messages[0].role).toBe("system");
    expect(native({}, provider({ foldDeveloperRoleToSystem: false })).messages[0].role).toBe("developer");
  });
  test("translated requests use max_tokens and only the supported effort", () => {
    expect(translated("medium")).toMatchObject({ max_tokens: 123, reasoning_effort: "low" });
    for (const field of ["max_completion_tokens", "user", "store", "thinking", "include_reasoning", "reasoning", "top_k"]) {
      expect(translated("xhigh")).not.toHaveProperty(field);
    }
  });
  test("the policy does not affect other destinations or auth modes", () => {
    for (const overrides of [{ baseUrl: "https://gateway.example/v1" }, { baseUrl: "https://api.mistral.ai/custom" }, { authMode: "oauth" as const }]) {
      expect(native({ max_completion_tokens: 123, user: "synthetic-user", store: false, reasoning_effort: "medium" }, provider(overrides)))
        .toMatchObject({ max_completion_tokens: 123, user: "synthetic-user", store: false, reasoning_effort: "medium" });
    }
  });
});

test("the final policy removes rejected controls even when another serializer generated them", () => {
  const body = { max_completion_tokens: 12, thinking: { type: "enabled" }, include_reasoning: true, reasoning: { effort: "high" }, top_k: 1 };
  applyChatDestinationPolicy(body, provider());
  expect(body).toEqual({ max_tokens: 12 });
});

test("typed response normalization preserves choices, tools, usage, and existing reasoning", () => {
  const value = { id: "fixture", usage: { prompt_tokens: 1 }, choices: [{ index: 0, finish_reason: "tool_calls", delta: {
    content: [{ type: "thinking", thinking: [{ type: "text", text: "We" }], closed: true }, { type: "text", text: "A" }],
    reasoning_content: "Before ", tool_calls: [{ index: 0, id: "call_fixture", function: { name: "check", arguments: "{}" } }],
  } }, { index: 1, delta: { content: [] } }] };
  const result = normalizeNativeChatContent(value, provider()) as typeof value;
  expect(result.choices[0]).toEqual({ ...value.choices[0], delta: { ...value.choices[0]!.delta, content: "A", reasoning_content: "Before We" } });
  expect(result.choices[1]!.delta.content).toBe("");
  expect(result.usage).toBe(value.usage);
  expect(Array.isArray(value.choices[0]!.delta.content)).toBe(true);
  expect(normalizeNativeChatContent(value, provider({ authMode: "oauth" }))).toBe(value);
});
