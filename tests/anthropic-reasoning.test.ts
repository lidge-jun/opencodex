import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseRequest } from "../src/responses/parser";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

function parsed(reasoning?: string, extraOpts: Record<string, unknown> = {}, modelId = "anthropic/claude-sonnet-4.5"): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    options: { ...(reasoning !== undefined ? { reasoning } : {}), ...extraOpts },
    context: { systemPrompt: ["sys"], messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
}

async function bodyOf(p: OcxParsedRequest): Promise<Record<string, unknown>> {
  const { body } = await createAnthropicAdapter(provider).buildRequest(p);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as Record<string, unknown>;
}

describe("anthropic extended-thinking gate", () => {
  test("reasoning 'none' does NOT enable thinking and preserves temperature/top_p", async () => {
    const b = await bodyOf(parsed("none", { temperature: 0.3, topP: 0.9 }));
    expect(b.thinking).toBeUndefined();
    expect(b.temperature).toBe(0.3);
    expect(b.top_p).toBe(0.9);
  });

  test("reasoning absent does NOT enable thinking and preserves sampling", async () => {
    const b = await bodyOf(parsed(undefined, { temperature: 0.5, topP: 0.8 }));
    expect(b.thinking).toBeUndefined();
    expect(b.temperature).toBe(0.5);
    expect(b.top_p).toBe(0.8);
  });

  test("reasoning 'high' enables thinking and drops sampling (extended-thinking rule)", async () => {
    const b = await bodyOf(parsed("high", { temperature: 0.3, topP: 0.9 }));
    const thinking = b.thinking as { type: string; budget_tokens: number } | undefined;
    expect(thinking?.type).toBe("enabled");
    expect(typeof thinking?.budget_tokens).toBe("number");
    expect(b.max_tokens as number).toBeGreaterThan(thinking!.budget_tokens);
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
  });

  test.each([
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-4-8[1m]",
  ])("adaptive-thinking model %s sends thinking.adaptive + output_config.effort", async (modelId) => {
    const b = await bodyOf(parsed("xhigh", { temperature: 0.3, topP: 0.9 }, modelId));
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.output_config).toEqual({ effort: "xhigh" });
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
  });

  test.each([
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
  ])("adaptive-thinking model %s defaults max_tokens well above 8192 when Codex omits it", async (modelId) => {
    const b = await bodyOf(parsed("xhigh", {}, modelId));
    expect(b.max_tokens).toBe(128_000);
  });

  test("adaptive-thinking model preserves explicit maxOutputTokens", async () => {
    const b = await bodyOf(parsed("high", { maxOutputTokens: 20_000 }, "claude-fable-5"));
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.max_tokens).toBe(20_000);
  });

  test("adaptive-thinking model maps unsupported 'minimal' effort to 'low'", async () => {
    const b = await bodyOf(parsed("minimal", {}, "claude-fable-5"));
    expect(b.output_config).toEqual({ effort: "low" });
  });

  test.each([
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-6",
    "claude-opus-4-20250514",
  ])("budget-thinking model %s keeps thinking.enabled with budget_tokens", async (modelId) => {
    const b = await bodyOf(parsed("high", {}, modelId));
    const thinking = b.thinking as { type: string; budget_tokens: number } | undefined;
    expect(thinking?.type).toBe("enabled");
    expect(typeof thinking?.budget_tokens).toBe("number");
    expect(b.output_config).toBeUndefined();
  });

  test("adaptive-thinking model with reasoning 'none' sends no thinking config", async () => {
    const b = await bodyOf(parsed("none", { temperature: 0.3 }, "claude-fable-5"));
    expect(b.thinking).toBeUndefined();
    expect(b.output_config).toBeUndefined();
    expect(b.temperature).toBe(0.3);
  });

  test("drops reconstructed Responses reasoning signatures when switching into Anthropic", async () => {
    const b = await bodyOf(parseRequest({
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
