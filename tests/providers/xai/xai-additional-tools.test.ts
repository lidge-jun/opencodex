import { providerConfigSchema } from "../../../src/config/schema/leaf-validators";
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createProductionAdapter } from "../../../src/adapters/openai-responses";
import {
  isXaiResponsesUrl,
  promoteResponsesAdditionalTools,
} from "../../../src/adapters/opencode-go-additional-tools";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { OcxProviderConfig } from "../../../src/types";

const lookup = {
  type: "function" as const,
  name: "lookup",
  description: "finds records",
  parameters: { type: "object", properties: { q: { type: "string" } } },
};

function build(providerConfig: OcxProviderConfig, rawBody: Record<string, unknown>, replayPrefixLen?: number) {
  const adapter = withTestTranslatorBudget(createProductionAdapter(providerConfig));
  const request = adapter.buildRequest({
    modelId: "grok-4.7",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: rawBody,
    ...(replayPrefixLen !== undefined ? { _replayPrefixLen: replayPrefixLen } : {}),
  });
  return { request, body: JSON.parse(request.body) as Record<string, unknown> };
}

describe("xAI Responses additional_tools promotion", () => {
  test("isXaiResponsesUrl matches official xAI endpoints and rejects lookalikes", () => {
    expect(isXaiResponsesUrl("https://api.x.ai/v1/responses")).toBe(true);
    expect(isXaiResponsesUrl("https://api.x.ai:443/v1/responses")).toBe(true);
    expect(isXaiResponsesUrl("https://cli-chat-proxy.grok.com/v1/responses")).toBe(true);
    expect(isXaiResponsesUrl("https://cli-chat-proxy.grok.com:443/v1/responses")).toBe(true);

    expect(isXaiResponsesUrl("http://api.x.ai/v1/responses")).toBe(false);
    expect(isXaiResponsesUrl("https://api.x.ai:8443/v1/responses")).toBe(false);
    expect(isXaiResponsesUrl("https://api.x.ai.evil.test/v1/responses")).toBe(false);
    expect(isXaiResponsesUrl("https://example.com/v1/responses")).toBe(false);
  });

  test("promoteResponsesAdditionalTools strips wrapper from input and moves tools to top-level", () => {
    const raw = {
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };
    const result = promoteResponsesAdditionalTools(raw) as { input: unknown[]; tools: unknown[] };
    expect(result.input).toEqual([{ type: "message", role: "user", content: "hello" }]);
    expect(result.tools).toEqual([lookup]);
  });

  test("promoteResponsesAdditionalTools respects replay prefix length", () => {
    const historicalTool = { type: "function", name: "old_tool" };
    const raw = {
      input: [
        { type: "additional_tools", tools: [historicalTool] },
        { type: "message", role: "user", content: "turn 1" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };
    // replayPrefixLength = 2 means index 0 and 1 are historical; only index 2 is current turn
    const result = promoteResponsesAdditionalTools(raw, 2) as { input: unknown[]; tools: unknown[] };
    expect(result.input).toEqual([{ type: "message", role: "user", content: "turn 1" }]);
    expect(result.tools).toEqual([lookup]);
  });

  test("xAI provider strips additional_tools and promotes declarations on buildRequest", () => {
    const xaiProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      headers: { authorization: "Bearer xai-key" },
    };

    const raw = {
      model: "grok-4.7",
      input: [
        { type: "message", role: "user", content: "test query" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };

    const { body } = build(xaiProvider, raw);
    expect(body.input).toEqual([{ type: "message", role: "user", content: "test query" }]);
    expect(body.tools).toBeArray();
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });

  test("cli-chat-proxy.grok.com also promotes additional_tools on buildRequest", () => {
    const grokCliProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      headers: { authorization: "Bearer grok-cli-token" },
    };

    const raw = {
      model: "grok-4.7",
      input: [
        { type: "message", role: "user", content: "test query" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };

    const { body } = build(grokCliProvider, raw);
    expect(body.input).toEqual([{ type: "message", role: "user", content: "test query" }]);
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });

  test("custom provider with promoteAdditionalTools: true promotes on buildRequest", () => {
    const customProvider = {
      adapter: "openai-responses",
      baseUrl: "https://custom-gateway.internal/v1",
      promoteAdditionalTools: true,
      headers: { authorization: "Bearer internal-token" },
    };

    const raw = {
      model: "custom-model",
      input: [
        { type: "message", role: "user", content: "custom query" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };

    const { body } = build(customProvider, raw);
    expect(body.input).toEqual([{ type: "message", role: "user", content: "custom query" }]);
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });

  test("providerConfigSchema validates promoteAdditionalTools as optional boolean", () => {
    expect(providerConfigSchema.safeParse({ adapter: "openai-responses", baseUrl: "https://example.com/v1", promoteAdditionalTools: true }).success).toBe(true);
    expect(providerConfigSchema.safeParse({ adapter: "openai-responses", baseUrl: "https://example.com/v1", promoteAdditionalTools: false }).success).toBe(true);
    expect(providerConfigSchema.safeParse({ adapter: "openai-responses", baseUrl: "https://example.com/v1", promoteAdditionalTools: "true" }).success).toBe(false);
  });

  test("unapproved custom provider without flag leaves input untouched", () => {
    const unapprovedProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://unapproved.internal/v1",
      headers: { authorization: "Bearer token" },
    };

    const raw = {
      model: "custom-model",
      input: [
        { type: "message", role: "user", content: "custom query" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };

    const { body } = build(unapprovedProvider, raw);
    expect(body.input).toEqual(raw.input);
  });
});
