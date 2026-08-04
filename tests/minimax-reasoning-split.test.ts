import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { enrichProviderFromRegistry } from "../src/providers/derive";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

type ReasoningEffort = OcxParsedRequest["options"]["reasoning"];

function parsed(modelId: string, reasoning?: ReasoningEffort): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
    stream: false,
    options: reasoning ? { reasoning } : {},
  };
}

function body(provider: OcxProviderConfig, modelId: string, reasoning?: ReasoningEffort): Record<string, unknown> {
  const request = createOpenAIChatAdapter(provider).buildRequest(parsed(modelId, reasoning));
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

function minimaxRoute(modelId = "MiniMax-M3", provider: Partial<OcxProviderConfig> = {}) {
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "minimax",
    providers: {
      minimax: {
        adapter: "openai-chat",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "test-key",
        ...provider,
      },
    },
  };
  return routeModel(config, `minimax/${modelId}`);
}

describe("MiniMax split reasoning", () => {
  test("M3 maps Codex effort to MiniMax adaptive/disabled and separates reasoning", () => {
    const route = minimaxRoute();

    expect(body(route.provider, route.modelId, "low")).toMatchObject({
      model: "MiniMax-M3",
      reasoning_split: true,
      thinking: { type: "disabled" },
    });
    expect(body(route.provider, route.modelId, "medium")).toMatchObject({
      model: "MiniMax-M3",
      reasoning_split: true,
      thinking: { type: "adaptive" },
    });
    expect(body(route.provider, route.modelId, "high")).toMatchObject({
      reasoning_split: true,
      thinking: { type: "adaptive" },
    });
    expect(body(route.provider, route.modelId, "high")).not.toHaveProperty("reasoning_effort");
  });

  test("all MiniMax M-series models request split reasoning and preserve it in history", () => {
    const route = minimaxRoute("MiniMax-M2.7");
    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [
          { role: "user", content: "first", timestamp: 0 },
          {
            role: "assistant",
            timestamp: 1,
            content: [
              { type: "thinking", thinking: "prior reasoning" },
              { type: "text", text: "prior answer" },
            ],
          },
          { role: "user", content: "continue", timestamp: 2 },
        ],
      },
      stream: false,
      options: {},
    });
    const requestBody = JSON.parse(request.body as string) as {
      reasoning_split?: boolean;
      messages: Array<Record<string, unknown>>;
    };

    expect(requestBody.reasoning_split).toBe(true);
    expect(requestBody.messages[1]?.reasoning_content).toBe("prior reasoning");
  });

  test("routing merges registry capabilities while explicit user effort mappings win", () => {
    const route = minimaxRoute("MiniMax-M3", {
      reasoningSplitModels: ["user-split-model"],
      modelReasoningEffortMap: { "MiniMax-M3": { medium: "disabled" } },
    });

    expect(route.provider.reasoningSplitModels).toEqual(expect.arrayContaining(["MiniMax-M3", "user-split-model"]));
    expect(route.provider.modelReasoningEffortMap?.["MiniMax-M3"]).toMatchObject({
      medium: "disabled",
      high: "adaptive",
    });
  });

  test("registry enrichment never replaces explicit split-reasoning fields", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.minimax.io/v1",
      reasoningSplitModels: ["only-user-model"],
      modelReasoningEffortMap: { "MiniMax-M3": { medium: "disabled" } },
    };

    enrichProviderFromRegistry("minimax", provider);

    expect(provider.reasoningSplitModels).toEqual(["only-user-model"]);
    expect(provider.modelReasoningEffortMap).toEqual({ "MiniMax-M3": { medium: "disabled" } });
  });

  test("unconfigured OpenAI-compatible providers remain unchanged", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
    };

    expect(body(provider, "example-model", "high")).not.toHaveProperty("reasoning_split");
  });
});
