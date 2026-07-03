import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex-catalog";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { routeModel } from "../src/router";
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
      { provider: "neuralwatt", id: "glm-5.2", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
      { provider: "moonshot", id: "kimi-k2.7-code", reasoningEfforts: [] },
    ]);

    const neuralwatt = entries.find(e => e.slug === "neuralwatt/glm-5.2");
    const kimi = entries.find(e => e.slug === "moonshot/kimi-k2.7-code");

    expect((neuralwatt?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(neuralwatt?.default_reasoning_level).toBe("medium");
    expect(kimi?.supported_reasoning_levels).toEqual([]);
    expect(kimi).not.toHaveProperty("default_reasoning_level");
  });

  test("Z.AI GLM-5.2 maps Codex xhigh to the upstream max effort", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      modelReasoningEfforts: { "glm-5.2": ["low", "medium", "high", "xhigh"] },
      modelReasoningEffortMap: {
        "glm-5.2": { none: "none", minimal: "none", low: "high", medium: "high", high: "high", xhigh: "max", max: "max" },
      },
    };

    expect(buildBody(provider, "glm-5.2", { reasoning: "xhigh" }).reasoning_effort).toBe("max");
    expect(buildBody(provider, "glm-5.2", { reasoning: "medium" }).reasoning_effort).toBe("high");
  });

  test("low/medium/high-only models clamp stale xhigh requests to high", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.neuralwatt.com/v1",
      reasoningEfforts: ["low", "medium", "high"],
    };

    expect(buildBody(provider, "glm-5.2", { reasoning: "xhigh" }).reasoning_effort).toBe("high");
  });

  test("Neuralwatt GLM-5.2 maps Codex xhigh to max and preserves reasoning history", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.neuralwatt.com/v1",
      modelReasoningEfforts: { "glm-5.2": ["low", "medium", "high", "xhigh"] },
      modelReasoningEffortMap: {
        "glm-5.2": { none: "none", minimal: "none", low: "high", medium: "high", high: "high", xhigh: "max", max: "max" },
      },
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
      options: { reasoning: "xhigh" },
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
      content: null,
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

  test("named namespaced tool_choice resolves to the chat wire name", () => {
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

  test("Anthropic filters dot-style namespaced allowed_tools without dropping the tool", () => {
    const provider: OcxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    };

    const req = createAnthropicAdapter(provider).buildRequest({
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

  test("sanitizeCodexReasoningEfforts strips non-Codex labels like 'max' from the catalog", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "test", id: "model-with-max", reasoningEfforts: ["low", "max", "high"] },
      { provider: "test", id: "model-clean", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
      { provider: "test", id: "model-empty", reasoningEfforts: [] },
    ]);

    const withMax = entries.find(e => e.slug === "test/model-with-max");
    const clean = entries.find(e => e.slug === "test/model-clean");
    const empty = entries.find(e => e.slug === "test/model-empty");

    // "max" must never appear in catalog — Codex parser rejects it
    const withMaxEfforts = (withMax?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort);
    expect(withMaxEfforts).toEqual(["low", "high"]);
    expect(withMaxEfforts).not.toContain("max");

    expect((clean?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual(["low", "medium", "high", "xhigh"]);

    expect(empty?.supported_reasoning_levels).toEqual([]);
  });
});
