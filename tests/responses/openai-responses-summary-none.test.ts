import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const targets: OcxProviderConfig[] = [
  { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
  { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key" as const, apiKey: "sk-test" },
];

function outboundReasoning(target: OcxProviderConfig, body: Record<string, unknown>): Record<string, unknown> | undefined {
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(target));
  const request = adapter.buildRequest(parseRequest(body), { headers: new Headers() });
  return (JSON.parse(request.body) as { reasoning?: Record<string, unknown> }).reasoning;
}

describe("Responses summary:none wire marker", () => {
  test("Claude omitted thinking retains parser intent but removes the marker for both destinations", () => {
    const claudeBody = anthropicToResponsesBody({
      model: "gpt-6-astra",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "high" },
    });
    expect((claudeBody as { reasoning?: unknown }).reasoning).toEqual({ summary: "none", effort: "high" });
    expect(parseRequest(claudeBody).options.hideThinkingSummary).toBe(true);

    for (const target of targets) {
      expect(outboundReasoning(target, claudeBody)).toEqual({ effort: "high" });
      expect(outboundReasoning(target, { model: "gpt-6-astra", input: "hi", reasoning: { summary: "none" } })).toBeUndefined();
    }
  });

  test.each(["auto", "concise", "detailed"])("preserves valid summary %s", summary => {
    for (const target of targets) {
      expect(outboundReasoning(target, { model: "gpt-6-astra", input: "hi", reasoning: { effort: "medium", summary } }))
        .toEqual({ effort: "medium", summary });
    }
  });

  test("strips the internal thinking toggle unless a custom Responses wire declares it", () => {
    const bodies = [
      { model: "gpt-6-astra", input: "hi", reasoning: { enabled: false, effort: "high", summary: "detailed" } },
      chatCompletionsToResponsesBody({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hi" }],
        reasoning: { enabled: true, effort: "low" },
      }),
      anthropicToResponsesBody({
        model: "gpt-6-astra",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled" },
        output_config: { effort: "medium" },
      }),
    ];

    for (const body of bodies) {
      const reasoning = body.reasoning as Record<string, unknown>;
      for (const target of targets) {
        expect(outboundReasoning(target, body)).toEqual(
          Object.fromEntries(Object.entries(reasoning).filter(([key]) => key !== "enabled")),
        );
      }
    }

    const routed = { adapter: "openai-responses", baseUrl: "https://compat.example.test/v1", authMode: "key" as const };
    for (const body of bodies) {
      expect(outboundReasoning(routed, body)).toEqual(
        Object.fromEntries(Object.entries(body.reasoning as Record<string, unknown>).filter(([key]) => key !== "enabled")),
      );
      expect(outboundReasoning({ ...routed, reasoningWireFormat: "gateway-object" }, body)).toEqual(body.reasoning);
    }
    const toggleOnly = { model: "gpt-6-astra", input: "hi", reasoning: { enabled: false } };
    for (const target of targets) expect(outboundReasoning(target, toggleOnly)).toBeUndefined();
    expect(toggleOnly.reasoning).toEqual({ enabled: false });
    expect(outboundReasoning(routed, toggleOnly)).toBeUndefined();
    expect(outboundReasoning({ ...routed, reasoningWireFormat: "gateway-object" }, toggleOnly)).toEqual({ enabled: false });
    for (const target of targets) {
      expect(outboundReasoning({ ...target, reasoningWireFormat: "gateway-object" }, toggleOnly)).toBeUndefined();
    }
  });
});
