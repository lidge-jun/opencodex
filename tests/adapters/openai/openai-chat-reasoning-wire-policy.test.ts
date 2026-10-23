import { describe, expect, test } from "bun:test";
import {
  buildOpenAIChatPassthroughRequest,
  createOpenAIChatAdapter,
} from "../../../src/adapters/openai-chat";
import { chatCompletionsToResponsesBody } from "../../../src/chat/inbound";
import { providerConfigSeed } from "../../../src/providers/derive";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
  reasoningWireFormat: "gateway-object",
  omitReasoningEffortWithToolsModels: ["reasoning-policy-model"],
};
const modelId = provider.omitReasoningEffortWithToolsModels![0]!;

const input: Record<string, unknown> = {
  model: modelId,
  messages: [{ role: "user", content: "What is the weather?" }],
  reasoning_effort: "none",
};
const tool: Record<string, unknown> = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};
const inputWithTool: Record<string, unknown> = { ...input, tools: [tool] };

const toggleModel = "toggle-only-model";
const toggleProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
  thinkingToggleModels: [toggleModel],
  modelCapabilities: {
    [toggleModel]: {
      supportsReasoning: true,
      supportsThinkingToggle: true,
      supportsReasoningEffort: false,
      defaultThinkingEnabled: true,
    },
  },
};

function finalBodies(rawInput: Record<string, unknown>): Record<"translated" | "native", Record<string, unknown>> {
  const parsed = parseRequest(chatCompletionsToResponsesBody(rawInput));
  const translated = createOpenAIChatAdapter(provider).buildRequest(parsed);
  const native = buildOpenAIChatPassthroughRequest(provider, rawInput, modelId, false);

  return {
    translated: JSON.parse(translated.body) as Record<string, unknown>,
    native: JSON.parse(native.body) as Record<string, unknown>,
  };
}

function finalToggleBodies(
  rawInput: Record<string, unknown>,
  target: OcxProviderConfig = toggleProvider,
  targetModel = toggleModel,
  thinkingEnabled?: boolean,
): Record<"translated" | "native", Record<string, unknown>> {
  const requestForModel = {
    ...rawInput, model: targetModel,
    ...(thinkingEnabled === undefined ? {} : { reasoning: { enabled: thinkingEnabled } }),
  };
  const parsed = parseRequest(chatCompletionsToResponsesBody(requestForModel));
  const translated = createOpenAIChatAdapter(target).buildRequest(parsed);
  const native = buildOpenAIChatPassthroughRequest(target, requestForModel, targetModel, false);
  return {
    translated: JSON.parse(translated.body) as Record<string, unknown>,
    native: JSON.parse(native.body) as Record<string, unknown>,
  };
}

describe("OpenAI Chat reasoning wire policy parity", () => {
  test("plain reasoning disable uses the gateway object on both final wires", () => {
    const bodies = finalBodies(input);
    const projection = Object.fromEntries(Object.entries(bodies).map(([builder, body]) => [
      builder,
      {
        reasoning: body.reasoning,
        hasReasoningEffort: Object.hasOwn(body, "reasoning_effort"),
      },
    ]));

    expect(projection).toEqual({
      translated: { reasoning: { enabled: false }, hasReasoningEffort: false },
      native: { reasoning: { enabled: false }, hasReasoningEffort: false },
    });
  });

  test("a function tool survives while both final wires omit all reasoning fields", () => {
    const bodies = finalBodies(inputWithTool);
    const projection = Object.fromEntries(Object.entries(bodies).map(([builder, body]) => [
      builder,
      {
        tools: body.tools,
        hasReasoning: Object.hasOwn(body, "reasoning"),
        hasReasoningEffort: Object.hasOwn(body, "reasoning_effort"),
      },
    ]));

    expect(projection).toEqual({
      translated: { tools: [tool], hasReasoning: false, hasReasoningEffort: false },
      native: { tools: [tool], hasReasoning: false, hasReasoningEffort: false },
    });
  });
});

describe("toggle-only Chat reasoning capability", () => {
  const request = (reasoning_effort?: string): Record<string, unknown> => ({
    model: toggleModel,
    messages: [{ role: "user", content: "think" }],
    ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
  });

  test.each([[false, "disabled"], [true, "enabled"]] as const)("serializes direct boolean %s as %s", (thinkingEnabled, type) => {
    const bodies = finalToggleBodies(request(), toggleProvider, toggleModel, thinkingEnabled);
    for (const body of Object.values(bodies)) {
      expect(body.thinking).toEqual({ type });
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test.each([[false, "enabled", "disabled"], [true, "disabled", "enabled"]] as const)(
    "explicit reasoning.enabled %s wins over conflicting raw thinking %s",
    (enabled, conflictingType, type) => {
      for (const body of Object.values(finalToggleBodies({
        ...request(), reasoning: { enabled }, thinking: { type: conflictingType },
      }))) expect(body.thinking).toEqual({ type });
    },
  );

  test("translates legacy Chat effort on both final wires", () => {
    for (const body of Object.values(finalToggleBodies(request("none")))) {
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("uses the capability default and retains an explicit native toggle when compatibility input is omitted", () => {
    const bodies = finalToggleBodies(request());
    expect(bodies.translated.thinking).toEqual({ type: "enabled" });
    expect(bodies.native.thinking).toEqual({ type: "enabled" });

    const native = buildOpenAIChatPassthroughRequest(toggleProvider, {
      ...request(),
      thinking: { type: "disabled" },
    }, toggleModel, false);
    expect((JSON.parse(native.body) as Record<string, unknown>).thinking).toEqual({ type: "disabled" });
  });

  test("an explicit empty effort list does not disable the independent toggle", () => {
    for (const body of Object.values(finalToggleBodies(request(), {
      ...toggleProvider,
      modelReasoningEfforts: { [toggleModel]: [] },
    }))) {
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("an omitted legacy alias does not revive the toggle default", () => {
    for (const body of Object.values(finalToggleBodies(request("high"), {
      ...toggleProvider,
      modelReasoningEffortMap: { [toggleModel]: { high: "__omit__" } },
    }))) {
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("an effort capability false strips native and translated strength without a toggle declaration", () => {
    const modelId = "effort-disabled-model";
    const target: OcxProviderConfig = {
      ...toggleProvider,
      thinkingToggleModels: undefined,
      modelCapabilities: { [modelId]: { supportsReasoning: true, supportsReasoningEffort: false } },
    };
    for (const body of Object.values(finalToggleBodies({ ...request("high"), reasoning: { enabled: true } }, target, modelId))) {
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
    }
  });

  test("a toggle capability false retains a separately supported raw effort", () => {
    const target: OcxProviderConfig = {
      ...toggleProvider,
      modelCapabilities: { [toggleModel]: {
        supportsReasoning: true,
        supportsThinkingToggle: false,
        supportsReasoningEffort: true,
      } },
      modelReasoningEffortMap: { [toggleModel]: { high: "enabled" } },
    };
    for (const body of Object.values(finalToggleBodies({ ...request("high"), thinking: { type: "enabled" } }, target))) {
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBe("high");
    }
  });

  test.each([
    [undefined, "medium", false, "medium", "high"],
    [undefined, "enabled", false, "high", "high"],
    [undefined, "__omit__", false, undefined, "high"],
    [undefined, "medium", true, undefined, "high"],
    [undefined, "enabled", false, "max", "ultra"],
    ["gateway-object", "medium", false, "medium", "high"],
    ["gateway-object", "enabled", false, "high", "high"],
    ["gateway-object", "__omit__", false, undefined, "high"],
    ["gateway-object", "medium", true, undefined, "high"],
    ["gateway-object", "enabled", false, "max", "ultra"],
  ] as const)("toggle-disabled effort keeps %s mapping %s with tools=%s for %s (%s)", (reasoningWireFormat, mapped, hasTools, expected, requested) => {
    const target: OcxProviderConfig = {
      ...toggleProvider, reasoningWireFormat,
      modelCapabilities: { [toggleModel]: {
        supportsReasoning: true, supportsThinkingToggle: false, supportsReasoningEffort: true,
      } },
      modelReasoningEffortMap: { [toggleModel]: { [requested === "ultra" ? "max" : requested]: mapped } },
      omitReasoningEffortWithToolsModels: [toggleModel],
    };
    const raw = { ...request(requested), thinking: { type: "enabled" }, ...(hasTools ? { tools: [tool] } : {}) };
    const results = [
      createOpenAIChatAdapter(target).buildRequest(parseRequest(chatCompletionsToResponsesBody(raw))),
      buildOpenAIChatPassthroughRequest(target, raw, toggleModel, false),
    ];
    for (const result of results) {
      const body = JSON.parse(result.body) as Record<string, unknown>;
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBe(reasoningWireFormat ? undefined : expected);
      expect(body.reasoning).toEqual(reasoningWireFormat && expected ? { enabled: true, effort: expected } : undefined);
      expect(result.reasoningLog).toEqual(expected ? {
        effectiveEffort: expected,
        wireField: reasoningWireFormat ? "reasoning.effort" : "reasoning_effort",
        wireValue: expected,
      } : undefined);
      if (hasTools) expect(body.tools).toEqual([tool]);
    }
  });

  test.each([
    ["reasoning disabled", { supportsReasoning: false }],
    ["both controls disabled", { supportsThinkingToggle: false, supportsReasoningEffort: false }],
  ])("an explicit capability with %s drops both control wires", (_label, overrides) => {
    const modelCapabilities = { [toggleModel]: { ...toggleProvider.modelCapabilities![toggleModel]!, ...overrides } };
    for (const body of Object.values(finalToggleBodies({ ...request("high"), thinking: { type: "enabled" } }, {
      ...toggleProvider,
      modelCapabilities,
    }))) {
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
    }
  });

  test("noReasoningModels remains authoritative", () => {
    for (const body of Object.values(finalToggleBodies(request("none"), {
      ...toggleProvider,
      noReasoningModels: [toggleModel],
    }))) {
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("a declared dual-axis wire preserves explicit thinking alongside low effort", () => {
    const bothProvider: OcxProviderConfig = {
      ...toggleProvider,
      modelCapabilities: { [toggleModel]: {
        supportsReasoning: true,
        supportsThinkingToggle: true,
        supportsReasoningEffort: true,
        defaultThinkingEnabled: true,
      } },
      modelReasoningEfforts: { [toggleModel]: ["low"] },
    };
    const raw = { ...request("low"), thinking: { type: "enabled" } };
    const parsed = parseRequest(chatCompletionsToResponsesBody(raw));
    const translated = JSON.parse(createOpenAIChatAdapter(bothProvider).buildRequest(parsed).body) as Record<string, unknown>;
    const native = JSON.parse(buildOpenAIChatPassthroughRequest(bothProvider, raw, toggleModel, false).body) as Record<string, unknown>;
    for (const body of [translated, native]) {
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("low");
    }
  });
});

describe("legacy mapped thinking discriminator wires", () => {
  test.each([
    ["zhipu-bigmodel", "glm-4.6", "enabled"],
    ["opencode-go", "mimo-v2.5", "enabled"],
    ["volcengine", "doubao-seed-2-1-pro-260628", "enabled"],
    ["minimax", "MiniMax-M3", "adaptive"],
  ] as const)("%s/%s emits %s on the declared wire", (providerId, modelId, type) => {
    const entry = getProviderRegistryEntry(providerId);
    if (!entry) throw new Error(`Missing registry seed ${providerId}`);
    const target = { ...providerConfigSeed(entry), apiKey: "sk-test" };
    const raw = { model: modelId, messages: [{ role: "user", content: "think" }], reasoning_effort: "high" };
    const parsed = parseRequest(chatCompletionsToResponsesBody(raw));
    const bodies = [
      JSON.parse(createOpenAIChatAdapter(target).buildRequest(parsed).body) as Record<string, unknown>,
      JSON.parse(buildOpenAIChatPassthroughRequest(target, raw, modelId, false).body) as Record<string, unknown>,
    ];
    for (const body of bodies) {
      expect(body.thinking).toEqual({ type });
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("an explicit boolean disables a mapped legacy alias", () => {
    const entry = getProviderRegistryEntry("zhipu-bigmodel");
    if (!entry) throw new Error("Missing registry seed zhipu-bigmodel");
    const target = {
      ...providerConfigSeed(entry),
      apiKey: "sk-test",
      modelCapabilities: { "glm-4.6": {
        supportsReasoning: true,
        supportsThinkingToggle: true,
        supportsReasoningEffort: true,
      } },
    };
    const raw = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "think" }],
      reasoning_effort: "high",
      reasoning: { enabled: false },
    };
    const parsed = parseRequest(chatCompletionsToResponsesBody(raw));
    const bodies = [
      JSON.parse(createOpenAIChatAdapter(target).buildRequest(parsed).body) as Record<string, unknown>,
      JSON.parse(buildOpenAIChatPassthroughRequest(target, raw, "glm-4.6", false).body) as Record<string, unknown>,
    ];
    for (const body of bodies) {
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("an undeclared wire keeps the ordinary reasoning effort", () => {
    const raw = { model: "ordinary-model", messages: [{ role: "user", content: "think" }], reasoning_effort: "high" };
    const target = { ...toggleProvider, thinkingToggleModels: undefined, modelCapabilities: undefined };
    const parsed = parseRequest(chatCompletionsToResponsesBody(raw));
    const bodies = [
      JSON.parse(createOpenAIChatAdapter(target).buildRequest(parsed).body) as Record<string, unknown>,
      JSON.parse(buildOpenAIChatPassthroughRequest(target, raw, "ordinary-model", false).body) as Record<string, unknown>,
    ];
    for (const body of bodies) {
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBe("high");
    }
  });
});
