import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex/catalog";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { configuredReasoningEfforts, mapReasoningEffort, sanitizeCodexReasoningEfforts } from "../src/reasoning-effort";
import { routeModel } from "../src/router";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

function parsed(modelId: string, providerOptions: OcxParsedRequest["options"]): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: false,
    options: providerOptions,
  };
}

function buildBody(provider: OcxProviderConfig, modelId: string, options: OcxParsedRequest["options"]): Record<string, unknown> {
  const req = createOpenAIChatAdapter(provider).buildRequest(parsed(modelId, options));
  return JSON.parse(req.body as string) as Record<string, unknown>;
}

describe("provider-specific reasoning effort mapping", () => {
  test("Codex catalog advertises only the efforts actually supported by a routed model", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "neuralwatt", id: "glm-5.2", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      { provider: "moonshot", id: "kimi-k2.7-code", reasoningEfforts: [] },
    ]);

    const neuralwatt = entries.find(e => e.slug === "neuralwatt/glm-5.2");
    const kimi = entries.find(e => e.slug === "moonshot/kimi-k2.7-code");

    expect((neuralwatt?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(neuralwatt?.default_reasoning_level).toBe("medium");
    expect(kimi?.supported_reasoning_levels).toEqual([]);
    expect(kimi).not.toHaveProperty("default_reasoning_level");
  });

  test("Z.AI GLM-5.2 keeps xhigh and max as distinct upstream efforts", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      modelReasoningEfforts: { "glm-5.2": ["low", "medium", "high", "xhigh", "max"] },
    };

    expect(buildBody(provider, "glm-5.2", { reasoning: "xhigh" }).reasoning_effort).toBe("xhigh");
    expect(buildBody(provider, "glm-5.2", { reasoning: "max" }).reasoning_effort).toBe("max");
    expect(buildBody(provider, "glm-5.2", { reasoning: "medium" }).reasoning_effort).toBe("medium");
  });

  test("low/medium/high-only models clamp stale xhigh and max requests to high", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.neuralwatt.com/v1",
      reasoningEfforts: ["low", "medium", "high"],
    };

    expect(buildBody(provider, "glm-5.2", { reasoning: "xhigh" }).reasoning_effort).toBe("high");
    expect(buildBody(provider, "glm-5.2", { reasoning: "max" }).reasoning_effort).toBe("high");
  });

  test("Neuralwatt GLM-5.2 sends direct max and preserves reasoning history", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.neuralwatt.com/v1",
      modelReasoningEfforts: { "glm-5.2": ["low", "medium", "high", "xhigh", "max"] },
      preserveReasoningContentModels: ["glm-5.2"],
    };

    const req = createOpenAIChatAdapter(provider).buildRequest({
      modelId: "glm-5.2",
      context: {
        messages: [
          { role: "user", content: "first", timestamp: 0 },
          { role: "assistant", timestamp: 1, content: [
            { type: "thinking", thinking: "prior reasoning" },
            { type: "text", text: "prior answer" },
          ] },
          { role: "user", content: "continue", timestamp: 2 },
        ],
      },
      stream: false,
      options: { reasoning: "max" },
    });
    const body = JSON.parse(req.body as string) as { reasoning_effort?: string; messages: Record<string, unknown>[] };

    expect(body.reasoning_effort).toBe("max");
    expect(body.messages[1].reasoning_content).toBe("prior reasoning");
  });

  test("DeepSeek V4 thinking models replay reasoning_content beside tool calls", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "key",
          models: ["deepseek-v4-pro"],
        },
      },
    };
    const route = routeModel(config, "deepseek/deepseek-v4-pro");

    const req = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [
          { role: "user", content: "inspect the repo", timestamp: 0 },
          { role: "assistant", timestamp: 1, content: [
            { type: "thinking", thinking: "I need to inspect files before answering." },
            { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "README.md" } },
          ] },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            content: "contents",
            isError: false,
            timestamp: 2,
          },
        ],
      },
      stream: true,
      options: { reasoning: "xhigh" },
    });
    const body = JSON.parse(req.body as string) as { reasoning_effort?: string; messages: Record<string, unknown>[] };

    expect(body.reasoning_effort).toBe("max");
    expect(body.messages[1].reasoning_content).toBe("I need to inspect files before answering.");
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
      }],
    });
  });

  test("DeepSeek legacy reasoner does not inherit V4 thinking-mode history replay", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "key",
          models: ["deepseek-reasoner"],
        },
      },
    };
    const route = routeModel(config, "deepseek/deepseek-reasoner");

    const req = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [
          { role: "user", content: "first", timestamp: 0 },
          { role: "assistant", timestamp: 1, content: [
            { type: "thinking", thinking: "legacy hidden reasoning" },
            { type: "text", text: "answer" },
          ] },
          { role: "user", content: "continue", timestamp: 2 },
        ],
      },
      stream: false,
      options: {},
    });
    const body = JSON.parse(req.body as string) as { messages: Record<string, unknown>[] };

    expect(route.provider.preserveReasoningContentModels).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(body.messages[1].reasoning_content).toBeUndefined();
  });

  test("Kimi K2.7 Code does not receive unsupported OpenAI reasoning/sampling controls", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.moonshot.ai/v1",
      noReasoningModels: ["kimi-k2.7-code"],
      noTemperatureModels: ["kimi-k2.7-code"],
      noTopPModels: ["kimi-k2.7-code"],
      noPenaltyModels: ["kimi-k2.7-code"],
      autoToolChoiceOnlyModels: ["kimi-k2.7-code"],
      preserveReasoningContentModels: ["kimi-k2.7-code"],
    };

    const body = buildBody(provider, "kimi-k2.7-code", {
      reasoning: "high",
      temperature: 0.2,
      topP: 0.7,
      presencePenalty: 1,
      frequencyPenalty: 1,
      toolChoice: { name: "run_tests" },
    });

    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("presence_penalty");
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("tool_choice");
  });

  test("Kimi K3 context aliases share the k3 wire id and normalize the documented effort tiers", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "kimi",
      providers: {
        kimi: {
          adapter: "openai-chat",
          baseUrl: "https://api.kimi.com/coding/v1",
          authMode: "oauth",
          apiKey: "test-token",
        },
      },
    };
    for (const selector of ["kimi/k3", "kimi/k3[1m]"]) {
      const route = routeModel(config, selector);
      expect(configuredReasoningEfforts(route.provider, route.modelId)).toEqual(["low", "high", "max"]);
      for (const [requested, wire] of Object.entries({
        none: "none",
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
        ultra: "max",
      })) {
        const body = buildBody(route.provider, route.modelId, {
          reasoning: requested,
          temperature: 0.2,
          topP: 0.7,
          presencePenalty: 1,
          frequencyPenalty: 1,
        });

        expect(body.model).toBe("k3");
        expect(body.reasoning_effort).toBe(wire);
        expect(body).not.toHaveProperty("temperature");
        expect(body).not.toHaveProperty("top_p");
        expect(body).not.toHaveProperty("presence_penalty");
        expect(body).not.toHaveProperty("frequency_penalty");
      }
    }
  });

  test("Kimi K3 stale max-only configs self-heal from the registry map without mutation", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "kimi",
      providers: {
        kimi: {
          adapter: "openai-chat",
          baseUrl: "https://api.kimi.com/coding/v1",
          authMode: "oauth",
          apiKey: "test-token",
          modelReasoningEfforts: { k3: ["max"], "k3[1m]": ["max"] },
        },
      },
    };

    for (const selector of ["kimi/k3", "kimi/k3[1m]"]) {
      const route = routeModel(config, selector);
      expect(route.provider.modelReasoningEfforts?.[route.modelId]).toEqual(["max"]);
      expect(configuredReasoningEfforts(route.provider, route.modelId)).toEqual(["low", "high", "max"]);
    }
    expect(config.providers.kimi.modelReasoningEfforts).toEqual({ k3: ["max"], "k3[1m]": ["max"] });
  });

  test("OpenAI-compatible chat omits tool_choice when there are no tools", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.neuralwatt.com/v1",
    };

    const body = buildBody(provider, "glm-5.2", { toolChoice: "auto" });

    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  test("OpenAI-compatible chat keeps tool_choice when tools are present", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.moonshot.ai/v1",
      autoToolChoiceOnlyModels: ["kimi-k2.7-code"],
    };

    const req = createOpenAIChatAdapter(provider).buildRequest({
      modelId: "kimi-k2.7-code",
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [{ name: "run_tests", description: "Run tests", parameters: { type: "object", properties: {} } }],
      },
      stream: false,
      options: { toolChoice: { name: "run_tests" } },
    });
    const body = JSON.parse(req.body as string) as Record<string, unknown>;

    expect(body).toHaveProperty("tools");
    expect(body.tool_choice).toBe("auto");
  });

  test("OpenAI-compatible chat filters tools for Responses allowed_tools choices", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.neuralwatt.com/v1",
    };

    const req = createOpenAIChatAdapter(provider).buildRequest({
      modelId: "glm-5.2",
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [
          { name: "web_search", description: "Search", parameters: { type: "object", properties: {} } },
          { name: "run_tests", description: "Run tests", parameters: { type: "object", properties: {} } },
        ],
      },
      stream: false,
      options: { toolChoice: { allowedTools: ["web_search"], mode: "required" } },
    });
    const body = JSON.parse(req.body as string) as { tools: Array<{ function: { name: string } }>; tool_choice: string };

    expect(body.tools.map(t => t.function.name)).toEqual(["web_search"]);
    expect(body.tool_choice).toBe("required");
  });

  test("OpenAI-compatible chat accepts dot-style namespaced allowed_tools from Responses", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.umans.ai/v1",
    };

    const req = createOpenAIChatAdapter(provider).buildRequest({
      modelId: "umans-kimi-k2.7",
      context: {
        messages: [{ role: "user", content: "run it", timestamp: 0 }],
        tools: [{
          namespace: "functions",
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        }],
      },
      stream: false,
      options: { toolChoice: { allowedTools: ["functions.exec_command"], mode: "required" } },
    });
    const body = JSON.parse(req.body as string) as { tools: Array<{ function: { name: string } }>; tool_choice: string };

    expect(body.tools.map(t => t.function.name)).toEqual(["functions__exec_command"]);
    expect(body.tool_choice).toBe("required");
  });

  test("named namespaced tool_choice resolves to the chat wire name", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.umans.ai/v1",
    };

    const req = createOpenAIChatAdapter(provider).buildRequest({
      modelId: "umans-kimi-k2.7",
      context: {
        messages: [{ role: "user", content: "run it", timestamp: 0 }],
        tools: [{
          namespace: "functions",
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        }],
      },
      stream: false,
      options: { toolChoice: { name: "functions.exec_command" } },
    });
    const body = JSON.parse(req.body as string) as { tool_choice: { function: { name: string } } };

    expect(body.tool_choice.function.name).toBe("functions__exec_command");
  });

  test("Anthropic filters dot-style namespaced allowed_tools without dropping the tool", async () => {
    const provider: OcxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "test-key",
    };

    const req = await createAnthropicAdapter(provider).buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [{ role: "user", content: "run it", timestamp: 0 }],
        tools: [{
          namespace: "functions",
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        }],
      },
      stream: false,
      options: { toolChoice: { allowedTools: ["functions.exec_command"], mode: "required" } },
    });
    const body = JSON.parse(req.body as string) as { tools: Array<{ name: string }>; tool_choice: { type: string } };

    expect(body.tools.map(t => t.name)).toEqual(["functions__exec_command"]);
    expect(body.tool_choice).toEqual({ type: "any" });
  });

  test("sanitizeCodexReasoningEfforts keeps max and strips unknown catalog labels", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "test", id: "model-with-max", reasoningEfforts: ["low", "max", "turbo", "high"] },
      { provider: "test", id: "model-clean", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
      { provider: "test", id: "model-empty", reasoningEfforts: [] },
    ]);

    const withMax = entries.find(e => e.slug === "test/model-with-max");
    const clean = entries.find(e => e.slug === "test/model-clean");
    const empty = entries.find(e => e.slug === "test/model-empty");

    const withMaxEfforts = (withMax?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort);
    expect(withMaxEfforts).toEqual(["low", "high", "max", "ultra"]);

    expect((clean?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);

    expect(empty?.supported_reasoning_levels).toEqual([]);
  });
});

describe("thinking-toggle models (260707)", () => {
  const toggleProvider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    thinkingToggleModels: ["mimo-v2.5", "glm-5"],
    modelReasoningEfforts: { "mimo-v2.5": ["low", "medium", "high", "xhigh", "max"], "glm-5": ["low", "medium", "high", "xhigh", "max"] },
    modelReasoningEffortMap: {
      "mimo-v2.5": { none: "disabled", minimal: "disabled", low: "disabled", medium: "enabled", high: "enabled", xhigh: "enabled", max: "enabled" },
      "glm-5": { none: "disabled", minimal: "disabled", low: "disabled", medium: "enabled", high: "enabled", xhigh: "enabled", max: "enabled" },
    },
  };

  test("high effort emits thinking enabled, never reasoning_effort", () => {
    const body = buildBody(toggleProvider, "mimo-v2.5", { reasoning: "high" });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("low effort emits thinking disabled", () => {
    const body = buildBody(toggleProvider, "glm-5", { reasoning: "low" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("no requested effort sends neither knob", () => {
    const body = buildBody(toggleProvider, "mimo-v2.5", {});
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("non-toggle models on the same provider keep the reasoning_effort wire", () => {
    const body = buildBody({ ...toggleProvider, modelReasoningEfforts: {}, modelReasoningEffortMap: {} }, "glm-5.2", { reasoning: "high" });
    expect(body.reasoning_effort).toBe("high");
    expect(body).not.toHaveProperty("thinking");
  });

  test("opencode-go registry routes mimo/glm5 through the toggle with a five-step picker ladder", () => {
    const config = {
      port: 10100,
      defaultProvider: "opencode-go",
      providers: { "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k" } },
    } as unknown as OcxConfig;
    const route = routeModel(config, "opencode-go/mimo-v2.5");
    expect(route.provider.thinkingToggleModels).toContain("mimo-v2.5");
    expect(route.provider.modelReasoningEfforts?.["mimo-v2.5"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const mediumBody = buildBody(route.provider, "mimo-v2.5", { reasoning: "medium" });
    expect(mediumBody.thinking).toEqual({ type: "enabled" });
    const body = buildBody(route.provider, "mimo-v2.5", { reasoning: "xhigh" });
    expect(body.thinking).toEqual({ type: "enabled" });
    // Kimi K2.7 stays fully unadvertised (no fake knob).
    const kimiRoute = routeModel(config, "opencode-go/kimi-k2.7-code");
    const kimiBody = buildBody(kimiRoute.provider, "kimi-k2.7-code", { reasoning: "high" });
    expect(kimiBody).not.toHaveProperty("thinking");
    expect(kimiBody).not.toHaveProperty("reasoning_effort");

    // Kimi K3 is live on Zen Go and shares Kimi Code's documented three-tier contract.
    const k3Route = routeModel(config, "opencode-go/kimi-k3");
    expect(configuredReasoningEfforts(k3Route.provider, k3Route.modelId)).toEqual(["low", "high", "max"]);
    for (const [requested, wire] of Object.entries({
      none: "none",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
      ultra: "max",
    })) {
      const body = buildBody(k3Route.provider, k3Route.modelId, {
        reasoning: requested,
        temperature: 0.2,
        topP: 0.7,
        presencePenalty: 1,
        frequencyPenalty: 1,
      });
      expect(body.reasoning_effort).toBe(wire);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body).not.toHaveProperty("presence_penalty");
      expect(body).not.toHaveProperty("frequency_penalty");
    }
  });
});

describe("thinking-budget models (260709)", () => {
  const budgetProvider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://api.neuralwatt.com/v1",
    thinkingBudgetModels: ["qwen3.5-397b"],
    modelReasoningEfforts: { "qwen3.5-397b": ["low", "medium", "high", "xhigh", "max"] },
  };

  test("Qwen thinking_budget maps five Codex levels to output-token fractions", () => {
    const cases = [
      ["low", 2000],
      ["medium", 5000],
      ["high", 7500],
      ["xhigh", 9000],
      ["max", 10000],
    ] as const;

    for (const [reasoning, budget] of cases) {
      const body = buildBody(budgetProvider, "qwen3.5-397b", { reasoning, maxOutputTokens: 10000 });
      expect(body.thinking_budget).toBe(budget);
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("thinking");
    }
  });

  test("Qwen thinking_budget uses the default max budget when max output tokens are absent", () => {
    const body = buildBody(budgetProvider, "qwen3.5-397b", { reasoning: "medium" });
    expect(body.thinking_budget).toBe(16384);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("minimal Qwen reasoning maps to a zero budget", () => {
    const body = buildBody(budgetProvider, "qwen3.5-397b", { reasoning: "minimal", maxOutputTokens: 10000 });
    expect(body.thinking_budget).toBe(0);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("routed Qwen models advertise five levels and send thinking_budget over openai-chat", () => {
    const config = {
      port: 10100,
      defaultProvider: "opencode-go",
      providers: { "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k" } },
    } as unknown as OcxConfig;
    const route = routeModel(config, "opencode-go/qwen3.7-max");

    expect(route.provider.adapter).toBe("openai-chat");
    expect(route.provider.thinkingBudgetModels).toContain("qwen3.7-max");
    expect(route.provider.modelReasoningEfforts?.["qwen3.7-max"]).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const body = buildBody(route.provider, route.modelId, { reasoning: "max", maxOutputTokens: 65536 });
    expect(body.thinking_budget).toBe(65536);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("opencode-go Qwen models are no longer pinned to the Anthropic wire", () => {
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1" };

    expect(resolveWireProtocolOverride("opencode-go", "qwen3.7-max", provider).adapter).toBe("openai-chat");
    expect(resolveWireProtocolOverride("opencode-go", "minimax-m3", provider).adapter).toBe("anthropic");
  });

  test("Neuralwatt Qwen registry restores the five-level ladder", () => {
    const config = {
      port: 10100,
      defaultProvider: "neuralwatt",
      providers: { neuralwatt: { adapter: "openai-chat", baseUrl: "https://api.neuralwatt.com/v1", apiKey: "k" } },
    } as unknown as OcxConfig;
    const route = routeModel(config, "neuralwatt/qwen3.5-397b");

    expect(route.provider.thinkingBudgetModels).toContain("qwen3.5-397b");
    expect(route.provider.modelReasoningEfforts?.["qwen3.5-397b"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("ultra reasoning effort (upstream codex-rs parity)", () => {
  const base: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://provider.example/v1" };

  test("sanitize accepts ultra, dedupes, and orders it above max", () => {
    expect(sanitizeCodexReasoningEfforts(["ultra", "low", "max", "ultra"])).toEqual(["low", "max", "ultra"]);
  });

  test("clamps ultra down to the highest supported effort", () => {
    expect(mapReasoningEffort({ ...base, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] }, "m", "ultra")).toBe("max");
    expect(mapReasoningEffort({ ...base, reasoningEfforts: ["low", "high"] }, "m", "ultra")).toBe("high");
    expect(mapReasoningEffort({ ...base, reasoningEfforts: [] }, "m", "ultra")).toBeUndefined();
  });

  test("defensive direct-call boundary: ultra never reaches the wire even when advertised", () => {
    // The Responses parser normalizes ultra->max at ingest; this covers direct callers, mirroring
    // upstream core/src/client.rs reasoning_effort_for_request (Ultra => Max).
    expect(mapReasoningEffort({ ...base, reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }, "m", "ultra")).toBe("max");
    expect(mapReasoningEffort(base, "m", "ultra")).toBe("max");
  });

  test("a max wire alias applies to converted ultra; a raw ultra alias never bypasses the boundary", () => {
    expect(mapReasoningEffort({ ...base, reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], reasoningEffortMap: { max: "think-hard" } }, "m", "ultra")).toBe("think-hard");
    // Upstream never lets "ultra" influence the provider wire; the alias table is consulted with
    // the converted "max" value, so an ultra-keyed alias is inert.
    expect(mapReasoningEffort({ ...base, reasoningEffortMap: { ultra: "ultra-native" } }, "m", "ultra")).toBe("max");
  });

  test("routed opt-in ultra renders the canonical description; default routed ladder stays ultra-free", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "p", id: "m-ultra", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { provider: "p", id: "m-default" },
    ]);
    const opted = entries.find(e => e.slug === "p/m-ultra");
    const dflt = entries.find(e => e.slug === "p/m-default");
    const levels = opted?.supported_reasoning_levels as { effort: string; description: string }[];
    expect(levels.map(l => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(levels[levels.length - 1]?.description).toBe("Maximum reasoning with automatic task delegation");
    expect((dflt?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("no-template native GPT-5.6 fallback entries also advertise max and ultra", () => {
    const entries = buildCatalogEntries(null, ["gpt-5.6-sol", "gpt-5.5"], []);
    const gpt56 = entries.find(e => e.slug === "gpt-5.6-sol");
    const gpt55 = entries.find(e => e.slug === "gpt-5.5");
    expect((gpt56?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect((gpt55?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });
});

describe("stale reasoning-ladder self-heal", () => {
  const base: OcxProviderConfig = { baseUrl: "https://x", apiKey: "k" };

  test("ladder stopping at xhigh gains max when the wire map routes xhigh -> max", () => {
    const prov: OcxProviderConfig = {
      ...base,
      modelReasoningEfforts: { "glm-5.2": ["low", "medium", "high", "xhigh"] },
      modelReasoningEffortMap: { "glm-5.2": { low: "high", medium: "high", high: "high", xhigh: "max", max: "max" } },
    };
    expect(configuredReasoningEfforts(prov, "glm-5.2")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // A healed max request rides the wire map to "max", not a clamp down to xhigh.
    expect(mapReasoningEffort(prov, "glm-5.2", "max")).toBe("max");
  });

  test("thinking-toggle ladders can advertise five steps while the map emits enabled, never max", () => {
    const prov: OcxProviderConfig = {
      ...base,
      modelReasoningEfforts: { "mimo-v2.5": ["low", "medium", "high", "xhigh", "max"] },
      modelReasoningEffortMap: { "mimo-v2.5": { low: "disabled", medium: "enabled", high: "enabled", xhigh: "enabled", max: "enabled" } },
    };
    expect(configuredReasoningEfforts(prov, "mimo-v2.5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("no wire map means no heal — an xhigh-top ladder without max evidence is preserved", () => {
    const prov: OcxProviderConfig = { ...base, modelReasoningEfforts: { m: ["low", "medium", "high", "xhigh"] } };
    expect(configuredReasoningEfforts(prov, "m")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("Codex-native mapped values restore multiple missing tiers but wire sentinels stay hidden", () => {
    const prov: OcxProviderConfig = {
      ...base,
      modelReasoningEfforts: { k3: ["max"] },
      modelReasoningEffortMap: {
        k3: { none: "none", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
      },
    };
    expect(configuredReasoningEfforts(prov, "k3")).toEqual(["low", "high", "max"]);
  });

  test("an intentional empty ladder stays empty even when a wire map exists", () => {
    const prov: OcxProviderConfig = {
      ...base,
      modelReasoningEfforts: { model: [] },
      modelReasoningEffortMap: { model: { low: "low", high: "high" } },
    };
    expect(configuredReasoningEfforts(prov, "model")).toEqual([]);
  });
});
