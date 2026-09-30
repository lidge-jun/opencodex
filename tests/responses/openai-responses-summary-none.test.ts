import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { parseRequest } from "../../src/responses/parser";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const targets = [
  { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
  { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key" as const, apiKey: "sk-test" },
];

function outboundReasoning(target: (typeof targets)[number], body: Record<string, unknown>): Record<string, unknown> | undefined {
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
});
