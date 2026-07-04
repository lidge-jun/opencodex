import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseRequest } from "../src/responses/parser";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

function parsed(reasoning?: string, extraOpts: Record<string, unknown> = {}): OcxParsedRequest {
  return {
    modelId: "anthropic/claude-sonnet-4.5",
    stream: false,
    options: { ...(reasoning !== undefined ? { reasoning } : {}), ...extraOpts },
    context: { systemPrompt: ["sys"], messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
}

function bodyOf(p: OcxParsedRequest): Record<string, unknown> {
  const { body } = createAnthropicAdapter(provider).buildRequest(p);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as Record<string, unknown>;
}

describe("anthropic extended-thinking gate", () => {
  test("reasoning 'none' does NOT enable thinking and preserves temperature/top_p", () => {
    const b = bodyOf(parsed("none", { temperature: 0.3, topP: 0.9 }));
    expect(b.thinking).toBeUndefined();
    expect(b.temperature).toBe(0.3);
    expect(b.top_p).toBe(0.9);
  });

  test("reasoning absent does NOT enable thinking and preserves sampling", () => {
    const b = bodyOf(parsed(undefined, { temperature: 0.5, topP: 0.8 }));
    expect(b.thinking).toBeUndefined();
    expect(b.temperature).toBe(0.5);
    expect(b.top_p).toBe(0.8);
  });

  test("reasoning 'high' enables thinking and drops sampling (extended-thinking rule)", () => {
    const b = bodyOf(parsed("high", { temperature: 0.3, topP: 0.9 }));
    const thinking = b.thinking as { type: string; budget_tokens: number } | undefined;
    expect(thinking?.type).toBe("enabled");
    expect(typeof thinking?.budget_tokens).toBe("number");
    expect(b.max_tokens as number).toBeGreaterThan(thinking!.budget_tokens);
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
  });

  test("drops reconstructed Responses reasoning signatures when switching into Anthropic", () => {
    const b = bodyOf(parseRequest({
      model: "anthropic/claude-sonnet-4.5",
      input: [
        {
          type: "reasoning",
          id: "rs_other_provider",
          summary: [],
          content: [{ type: "reasoning_text", text: "raw routed reasoning" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue on anthropic" }],
        },
      ],
      reasoning: { effort: "high" },
    }));
    const messages = b.messages as { role: string; content: unknown }[];

    expect(b.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(messages)).not.toContain("rs_other_provider");
    expect(JSON.stringify(messages)).not.toContain("signature");
    expect(messages).toEqual([{ role: "user", content: "continue on anthropic" }]);
  });
});
