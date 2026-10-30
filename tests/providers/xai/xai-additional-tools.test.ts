import { providerConfigSchema } from "../../../src/config/schema/leaf-validators";
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createProductionAdapter } from "../../../src/adapters/openai-responses";
import {
  isXaiResponsesUrl,
  promoteResponsesAdditionalTools,
} from "../../../src/adapters/opencode-go-additional-tools";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import { CODEX_GPT5_IDENTITY_LINE, identifyRoutedModel } from "../../../src/adapters/identity";
import { tagHistoricalInputItems } from "../../../src/responses/item-provenance";
import { rewriteRoutedCustomToolsForUpstream } from "../../../src/responses/custom-tool-compat";
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
  test("custom-tool lowering carries historical and live provenance into promotion", () => {
    const input = tagHistoricalInputItems([
      { type: "additional_tools", tools: [{ type: "custom", name: "retired", description: "past tool" }] },
      { type: "additional_tools", tools: [lookup] },
    ], 1);
    const lowered = rewriteRoutedCustomToolsForUpstream({ input }, false);
    const promoted = promoteResponsesAdditionalTools(lowered.body) as { tools: unknown[] };
    expect(promoted.tools).toEqual([lookup]);
  });

  test("custom-tool lowering cannot reactivate a historical wrapper", () => {
    const { body } = build({
      adapter: "openai-responses", baseUrl: "https://api.x.ai/v1", supportsResponsesCustomTools: false,
    }, { input: [
      { type: "additional_tools", tools: [{ type: "custom", name: "retired", description: "past tool" }] },
      { type: "additional_tools", tools: [lookup] },
    ] }, 1);
    expect(body.tools).toEqual([lookup]);
    expect(body.input).toEqual([]);
  });

  test("forward cache-marker cleanup cannot promote historical declarations", () => {
    const retired = { ...lookup, name: "retired", prompt_cache_breakpoint: true };
    const raw = { input: [
      { type: "additional_tools", tools: [retired] },
      { type: "additional_tools", tools: [lookup] },
    ] };
    const before = structuredClone(raw);
    const { body } = build({
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", promoteAdditionalTools: true,
    }, raw, 1);
    expect(body.tools).toEqual([lookup]);
    expect(body.input).toEqual([]);
    expect(raw).toEqual(before);
  });

  test("forward opt-in preserves live tools after removing the historical identity message", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      promoteAdditionalTools: true,
    };
    const live = { ...lookup, name: "live" };
    const raw = {
      input: [
        { type: "message", role: "developer", content: identifyRoutedModel(CODEX_GPT5_IDENTITY_LINE, "old-model") },
        { type: "additional_tools", tools: [live] },
      ],
    };
    const before = structuredClone(raw);
    const adapter = withTestTranslatorBudget(createProductionAdapter(provider));
    const request = adapter.buildRequest({
      modelId: "gpt-5", context: { messages: [] }, stream: false, options: {},
      _rawBody: raw, _replayPrefixLen: 1,
    }, { headers: new Headers({ authorization: "Bearer caller-fixture", "chatgpt-account-id": "caller-account" }) });
    const body = JSON.parse(request.body);
    expect(body.tools).toEqual([live]);
    expect(body.input).toEqual([]);
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer caller-fixture");
    expect(new Headers(request.headers).get("chatgpt-account-id")).toBe("caller-account");
    expect(raw).toEqual(before);
    for (const item of raw.input) expect(Object.getOwnPropertySymbols(item)).toEqual([]);
  });

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

  test("custom provider with authMode: forward and promoteAdditionalTools: true promotes tools", () => {
    const forwardOptInProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://forward-proxy.example.com/v1",
      authMode: "forward",
      promoteAdditionalTools: true,
    };

    const raw = {
      model: "custom-model",
      input: [
        { type: "message", role: "user", content: "forward query" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };

    const { body } = build(forwardOptInProvider, raw);
    expect(body.input).toEqual([{ type: "message", role: "user", content: "forward query" }]);
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });

  test("custom provider with authMode: forward without flag leaves input untouched", () => {
    const forwardNoOptInProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      authMode: "forward",
    };

    const raw = {
      model: "custom-model",
      input: [
        { type: "message", role: "user", content: "forward query" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };

    const { body } = build(forwardNoOptInProvider, raw);
    expect(body.input).toEqual(raw.input);
  });

  test("promoteResponsesAdditionalTools recalculates replay boundary when reasoning items are dropped", () => {
    const xaiProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      dropResponsesReasoningItems: true,
      headers: { authorization: "Bearer xai-key" },
    };

    const raw = {
      model: "grok-4.7",
      input: [
        { type: "reasoning", content: "thinking..." },
        { type: "message", role: "user", content: "hello" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };

    // Original prefix len is 2 (reasoning + user message).
    // When reasoning is dropped, prefix len must adjust from 2 to 1.
    // additional_tools moves from index 2 to index 1, which matches the new prefix boundary (>= 1),
    // so its tools are promoted to top-level tools.
    const { body } = build(xaiProvider, raw, 2);
    expect(body.input).toEqual([{ type: "message", role: "user", content: "hello" }]);
    expect(body.tools).toBeArray();
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });

  test("promoteResponsesAdditionalTools recalculates replay boundary when canonical-only items are dropped", () => {
    const xaiProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      headers: { authorization: "Bearer xai-key" },
    };

    const raw = {
      model: "grok-4.7",
      input: [
        { type: "configuration_update", reasoning: { effort: "high" } },
        { type: "message", role: "user", content: "hello" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };

    // Original prefix len is 2 (configuration_update + user message).
    // When configuration_update is dropped, prefix len must adjust from 2 to 1.
    // additional_tools moves from index 2 to index 1, which matches the new prefix boundary (>= 1),
    // so its tools are promoted to top-level tools.
    const { body } = build(xaiProvider, raw, 2);
    expect(body.input).toEqual([{ type: "message", role: "user", content: "hello" }]);
    expect(body.tools).toBeArray();
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });
  test.each(["configuration_update", "reasoning"])("Finding 3: removing the entire %s replay prefix preserves current tools", type => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      dropResponsesReasoningItems: true,
    };
    const { body } = build(provider, {
      input: [{ type, content: "historical" }, { type: "additional_tools", tools: [lookup] }],
    }, 1);
    expect(body.tools).toEqual([lookup]);
  });

  test("Finding 1: historical declarations do not deduplicate current declarations before promotion", () => {
    const xaiProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      headers: { authorization: "Bearer xai-key" },
    };
    const raw = {
      model: "grok-4.7",
      input: [
        { type: "additional_tools", tools: [lookup] },
        { type: "message", role: "user", content: "hello" },
        { type: "additional_tools", tools: [lookup] },
      ],
    };
    const { body } = build(xaiProvider, raw, 2);
    expect(body.tools).toBeArray();
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });

  test("Finding 1: historical namespaced declarations do not deduplicate current namespaced declarations before promotion", () => {
    const xaiProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      headers: { authorization: "Bearer xai-key" },
    };
    const namespacedLookup = {
      type: "namespace",
      name: "functions",
      tools: [lookup],
    };
    const raw = {
      model: "grok-4.7",
      input: [
        { type: "additional_tools", tools: [namespacedLookup] },
        { type: "message", role: "user", content: "hello" },
        { type: "additional_tools", tools: [namespacedLookup] },
      ],
    };
    const { body } = build(xaiProvider, raw, 2);
    expect(body.tools).toBeArray();
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });

  test("Finding 2: newly loaded search tools survive when first additional_tools wrapper is historical", () => {
    const xaiProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      headers: { authorization: "Bearer xai-key" },
    };
    const raw = {
      model: "grok-4.7",
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "old_tool" }] },
        { type: "tool_search_output", tools: [lookup] },
      ],
    };
    const { body } = build(xaiProvider, raw, 1);
    expect(body.tools).toBeArray();
    expect((body.tools as any[]).some(t => t.name === "lookup")).toBe(true);
  });

  test("Finding 1: a historical bare declaration does not suppress the live functions namespace", () => {
    const { body } = build({ adapter: "openai-responses", baseUrl: "https://api.x.ai/v1" }, {
      input: [
        { type: "additional_tools", tools: [lookup] },
        { type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [lookup] }] },
      ],
    }, 1);
    expect(body.tools).toEqual([lookup]);
  });

  test("Finding 3: synthesizing missing historical tool output does not reactivate retired tools", () => {
    const pWithPairing: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      requiresPairedResponsesToolResults: true,
      headers: { authorization: "Bearer xai-key" },
    };
    const raw = {
      model: "grok-4.7",
      input: [
        { type: "function_call", call_id: "c1", name: "some_call" },
        { type: "additional_tools", tools: [{ type: "function", name: "retired_tool" }] },
      ],
    };
    const { body } = build(pWithPairing, raw, 2);
    const retired = (body.tools as any[] ?? []).find(t => t.name === "retired_tool");
    expect(retired).toBeUndefined();
  });
});
