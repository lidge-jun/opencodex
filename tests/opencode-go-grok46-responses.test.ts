import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const registryEntry = getProviderRegistryEntry("opencode-go");
if (!registryEntry) throw new Error("missing opencode-go registry fixture");

function provider(baseUrl = "https://opencode.ai/zen/go/v1"): OcxProviderConfig {
  return {
    ...providerConfigSeed(registryEntry),
    adapter: "openai-responses",
    baseUrl,
    apiKey: "test-key",
  } as OcxProviderConfig;
}

function build(
  modelId: string,
  rawBody: Record<string, unknown>,
  configuredProvider = provider(),
): Record<string, unknown> {
  const request = createResponsesPassthroughAdapter(configuredProvider).buildRequest({
    modelId,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: modelId, input: "ping", ...rawBody },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("OpenCode Go Grok 4.6 Responses compatibility", () => {
  test("routes only the documented Grok model to Responses", () => {
    const configured = providerConfigSeed(registryEntry);

    expect(resolveWireProtocolOverride("opencode-go", "grok-4.6", configured).adapter)
      .toBe("openai-responses");
    expect(resolveWireProtocolOverride("opencode-go", "grok-4.5", configured).adapter)
      .toBe("openai-chat");
  });

  test("maps a stale Codex max request to Grok's highest supported effort", () => {
    const body = build("grok-4.6", { reasoning: { effort: "max" } });

    expect(body.reasoning).toEqual({ effort: "xhigh" });
    expect(registryEntry.modelReasoningEfforts?.["grok-4.6"])
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(registryEntry.modelDefaultReasoningEfforts?.["grok-4.6"]).toBe("high");
  });

  test("drops the hosted search tool that this exact destination rejects", () => {
    const functionTool = { type: "function", name: "lookup", parameters: { type: "object" } };
    const body = build("grok-4.6", {
      tools: [
        { type: "web_search", search_context_size: "medium" },
        { type: "web_search_preview" },
        functionTool,
      ],
    });

    expect(body.tools).toEqual([functionTool]);
  });

  test("drops hosted search from an additional_tools-only request", () => {
    const functionTool = { type: "function", name: "lookup", parameters: { type: "object" } };
    const body = build("grok-4.6", {
      input: [{
        type: "additional_tools",
        tools: [{ type: "web_search_preview" }, functionTool],
      }],
    });

    expect(body.input).toEqual([{ type: "additional_tools", tools: [functionTool] }]);
  });

  test("disables an explicit choice for a removed hosted tool", () => {
    const body = build("grok-4.6", {
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
    });

    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe("none");
  });

  test("narrows allowed_tools to declarations that remain", () => {
    const functionTool = { type: "function", name: "lookup", parameters: { type: "object" } };
    const body = build("grok-4.6", {
      tools: [{ type: "web_search_preview" }, functionTool],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "web_search_preview" }, { type: "function", name: "lookup" }],
      },
    });

    expect(body.tools).toEqual([functionTool]);
    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "lookup" }],
    });
  });

  test("disables required mode when every declared tool is removed", () => {
    const body = build("grok-4.6", {
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    });

    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe("none");
  });

  test("preserves hosted search for another model on OpenCode Go", () => {
    const webSearch = { type: "web_search", search_context_size: "medium" };
    const body = build("gpt-5.6-luna", { tools: [webSearch] });

    expect(body.tools).toEqual([webSearch]);
  });

  test("preserves hosted search for Grok 4.6 on another destination", () => {
    const webSearch = { type: "web_search", search_context_size: "medium" };
    const body = build("grok-4.6", { tools: [webSearch] }, provider("https://api.x.ai/v1"));

    expect(body.tools).toEqual([{ type: "web_search" }]);
  });
});
