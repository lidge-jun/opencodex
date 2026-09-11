import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { normalizeOpenCodeGoAdditionalTools } from "../../src/adapters/opencode-go-additional-tools";

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

function buildRequest(
  modelId: string,
  rawBody: Record<string, unknown>,
  configuredProvider = provider(),
) {
  return createResponsesPassthroughAdapter(configuredProvider).buildRequest({
    modelId,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: modelId, input: "ping", ...rawBody },
  }, { headers: new Headers() });
}

function build(modelId: string, rawBody: Record<string, unknown>, configuredProvider = provider()): Record<string, unknown> {
  const request = buildRequest(modelId, rawBody, configuredProvider);
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

  test("promotes additional_tools-only declarations before dropping refused hosted search", () => {
    const functionTool = { type: "function", name: "lookup", parameters: { type: "object" } };
    const body = build("grok-4.6", {
      input: [{
        type: "additional_tools",
        tools: [{ type: "web_search_preview" }, functionTool],
      }],
    });

    expect(body.input).toEqual([]);
    expect(body.tools).toEqual([functionTool]);
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

describe("OpenCode Go additional_tools placement", () => {
  const lookup = { type: "function", name: "lookup", parameters: { type: "object" } };
  const group = (name: string, tools: unknown[]) => ({ type: "namespace", name, tools });

  test("preserves the canonical namespace dedupe and distinct response aliases", () => {
    const raw = {
      tools: [lookup, lookup],
      input: [
        { type: "additional_tools", tools: [group("functions", [lookup, lookup]), group("alpha", [lookup])] },
        { type: "additional_tools", tools: [group("alpha", [lookup]), group("beta", [lookup])] },
      ],
    };
    const original = structuredClone(raw);
    const request = buildRequest("gpt-5.6-luna", raw);
    const sent = JSON.parse(request.body);
    expect(sent.input).toEqual([]);
    expect(sent.tools).toEqual([lookup, { ...lookup, name: "alpha__lookup" }, { ...lookup, name: "beta__lookup" }]);
    expect(request.convertedRoutedNamespaceToolAliases?.get("alpha__lookup"))
      .toEqual({ namespace: "alpha", name: "lookup", kind: "function" });
    expect(request.convertedRoutedNamespaceToolAliases?.get("beta__lookup"))
      .toEqual({ namespace: "beta", name: "lookup", kind: "function" });
    expect(raw).toEqual(original);
  });

  test.each(["none", "allowed"])("preserves custom/function lowering and %s authorization", choice => {
    const request = buildRequest("gpt-5.6-luna", {
      input: [{ type: "additional_tools", tools: [
        group("alpha", [lookup, { type: "custom", name: "custom_probe", description: "Freeform input" }]),
      ] }],
      tool_choice: choice === "none" ? "none" : {
        type: "allowed_tools", mode: "auto", tools: [{ type: "function", namespace: "alpha", name: "lookup" }],
      },
    }, { ...provider(), supportsResponsesCustomTools: false });
    const sent = JSON.parse(request.body);
    expect(sent.input).toEqual([]);
    expect(sent.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "alpha__lookup" }),
      expect.objectContaining({ type: "function", name: "alpha__custom_probe" }),
    ]));
    expect(request.convertedRoutedNamespaceToolAliases?.has("alpha__custom_probe")).toBe(false);
    expect(request.convertedRoutedNamespaceToolAliases?.has("alpha__lookup")).toBe(choice === "allowed");
    expect(sent.tool_choice).toEqual(choice === "none" ? "none" : {
      type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "alpha__lookup" }],
    });
  });

  test("keeps nameless hosted tools for Luna and prunes Go Grok selectors after promotion", () => {
    const web = { type: "web_search" };
    const raw = { input: [{ type: "additional_tools", tools: [web, lookup] }], tool_choice: {
      type: "allowed_tools", mode: "required", tools: [web, { type: "function", name: "lookup" }],
    } };
    expect(build("gpt-5.6-luna", raw).tools).toEqual([web, lookup]);
    const grok = build("grok-4.6", raw);
    expect(grok.tools).toEqual([lookup]);
    expect(grok.tool_choice).toEqual({
      type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "lookup" }],
    });
    expect(build("grok-4.6", { input: [{ type: "additional_tools", tools: [web] }], tool_choice: "required" }))
      .toMatchObject({ input: [], tools: [], tool_choice: "none" });
  });

  test("activates tools loaded by tool search before moving their catalog", () => {
    const sent = build("gpt-5.6-luna", { input: [
      { type: "additional_tools", tools: [{ ...lookup, defer_loading: true }] },
      { type: "tool_search_output", id: "tso_loaded", call_id: "call_search", tools: [lookup] },
    ] });
    expect(sent.tools).toEqual([lookup]);
    expect((sent.input as Array<{ type: string }>).some(item => item.type === "additional_tools")).toBe(false);
  });

  test.each(["https://opencode.ai/zen/go/v1/responses", "https://opencode.ai:443/zen/go/v1/responses"])(
    "promotes only wrappers on %s without mutating frozen caller data", responseUrl => {
      const message = Object.freeze({ type: "message", role: "user", content: "keep" });
      const tools = Object.freeze([lookup]);
      const raw = Object.freeze({ input: Object.freeze([message, Object.freeze({ type: "additional_tools", tools })]) });
      const result = normalizeOpenCodeGoAdditionalTools(raw, responseUrl) as { input: unknown[]; tools: unknown[] };
      expect(result).not.toBe(raw);
      expect(result.input).toEqual([message]);
      expect(result.input[0]).toBe(message);
      expect(result.tools).toEqual([lookup]);
      expect(result.tools[0]).toBe(lookup);
      expect(raw.input).toHaveLength(2);
    },
  );

  test.each([
    { baseUrl: "https://opencode.ai/zen/go/v1" },
    { baseUrl: "https://opencode.ai:443/zen/go/v1/" },
    { baseUrl: "https://opencode.ai/zen/go/v1//" },
    { baseUrl: "https://opencode.ai/zen/go/v1/responses" },
    { baseUrl: "https://opencode.ai", responsesPath: "/zen/go/v1/responses" },
  ])("promotes on the final Go endpoint for $baseUrl", destination => {
    const raw = { input: [{ type: "additional_tools", tools: [lookup] }] };
    const request = buildRequest("gpt-5.6-luna", raw, { ...provider(), ...destination });
    expect(new URL(request.url).href).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(JSON.parse(request.body)).toMatchObject({ input: [], tools: [lookup] });
  });

  test("a custom path overriding a Go base does not inherit Go placement", () => {
    const raw = { input: [{ type: "additional_tools", tools: [lookup] }] };
    const request = buildRequest("gpt-5.6-luna", raw, { ...provider(), responsesPath: "/../../v1/responses" });
    expect(new URL(request.url).href).toBe("https://opencode.ai/zen/v1/responses");
    expect(JSON.parse(request.body).input).toEqual(raw.input);
  });

  test.each([
    "https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1/responses/",
    "https://opencode.ai/zen/go/v1//responses",
  ])("leaves a noncanonical final resource %s unchanged", responseUrl => {
    const raw = { input: [{ type: "additional_tools", tools: [lookup] }] };
    expect(normalizeOpenCodeGoAdditionalTools(raw, responseUrl)).toBe(raw);
  });

  test.each([
    "https://opencode.ai/zen/v1", "https://opencode.ai.evil.test/zen/go/v1",
    "http://opencode.ai/zen/go/v1", "https://opencode.ai:444/zen/go/v1",
    "https://opencode.ai/zen/go/v10",
    (() => {
      const url = new URL("https://opencode.ai/zen/go/v1");
      url.username = "fixture-user";
      url.password = "synthetic-password";
      return url.href;
    })(), "https://opencode.ai/zen/go/v1?tenant=test",
    "https://opencode.ai/zen/go/v1?", "https://opencode.ai/zen/go/v1#",
    "https://opencode.ai/zen/go/v1#fragment", "https://example.test/v1",
  ])("does not promote for unapproved destination %s", baseUrl => {
    const raw = { input: [{ type: "additional_tools", tools: [lookup] }] };
    const request = buildRequest("gpt-5.6-luna", raw, provider(baseUrl));
    expect(normalizeOpenCodeGoAdditionalTools(raw, request.url)).toBe(raw);
    expect(JSON.parse(request.body).input).toEqual(raw.input);
  });

  test("keeps forward wrappers and mixed ciphertext unchanged", () => {
    const mixed = { type: "agent_message", content: [
      { type: "input_text", text: "Routing header" }, { type: "encrypted_content", encrypted_content: "opaque" },
    ] };
    const raw = { input: [mixed, { type: "additional_tools", tools: [lookup] }] };
    expect(build("gpt-5.6-luna", raw, { ...provider(), authMode: "forward" }).input).toEqual(raw.input);
    expect(build("gpt-5.6-luna", raw).input).toEqual([mixed]);
  });

  test("keeps malformed wrappers and no-op bodies; removes a valid empty wrapper", () => {
    const valid = { input: [{ type: "additional_tools", tools: [lookup] }] };
    expect(normalizeOpenCodeGoAdditionalTools(valid, "not a URL")).toBe(valid);
    for (const raw of [null, [], { input: "ping" }, { input: [] },
      { input: [{ type: "additional_tools", tools: null }] },
      { tools: null, input: [{ type: "additional_tools", tools: [lookup] }] },
    ]) expect(normalizeOpenCodeGoAdditionalTools(raw, "https://opencode.ai/zen/go/v1/responses")).toBe(raw);
    const malformed = { type: "additional_tools", tools: null };
    expect(build("gpt-5.6-luna", { input: [malformed, { type: "additional_tools", tools: [] }] }))
      .toMatchObject({ input: [malformed], tools: [] });
  });
});
