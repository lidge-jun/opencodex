import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { createTranslatorBudget } from "../src/lib/translator-budget";
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

function adapterFor(provider: OcxProviderConfig, modelId: string) {
  const adapter = createOpenAIChatAdapter(provider);
  adapter.buildRequest(parsed(modelId));
  return adapter;
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
    // MiniMax's interleaved-thinking contract requires the structured
    // reasoning_details array back; a reasoning_content string replay is the
    // unsupported native-format pass-back.
    expect(requestBody.messages[1]?.reasoning_content).toBeUndefined();
    expect(requestBody.messages[1]?.reasoning_details).toEqual([
      {
        type: "reasoning.text",
        id: "reasoning-text-1",
        format: "MiniMax-response-v1",
        index: 0,
        text: "prior reasoning",
      },
    ]);
  });

  test("routing merges registry capabilities while explicit user effort mappings win", () => {
    const route = minimaxRoute("MiniMax-M3", {
      reasoningSplitModels: ["user-split-model"],
      modelReasoningEffortMap: { "MiniMax-M3": { medium: "disabled" } },
    });

    expect(route.provider.reasoningSplitModels).toEqual(expect.arrayContaining(["MiniMax-M3", "user-split-model"]));
    expect(route.provider.reasoningDetailsModels).toEqual(expect.arrayContaining(["MiniMax-M3"]));
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
      reasoningDetailsModels: ["only-user-model"],
      modelReasoningEffortMap: { "MiniMax-M3": { medium: "disabled" } },
    };

    enrichProviderFromRegistry("minimax", provider);

    expect(provider.reasoningSplitModels).toEqual(["only-user-model"]);
    expect(provider.reasoningDetailsModels).toEqual(["only-user-model"]);
    expect(provider.modelReasoningEffortMap).toEqual({ "MiniMax-M3": { medium: "disabled" } });
  });

  test("unconfigured OpenAI-compatible providers remain unchanged", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
    };

    expect(body(provider, "example-model", "high")).not.toHaveProperty("reasoning_split");
  });

  test("non-streaming responses read reasoning_details when reasoning_content is absent", async () => {
    const route = minimaxRoute("MiniMax-M3");
    const response = new Response(JSON.stringify({
      id: "resp-1",
      object: "chat.completion",
      created: 0,
      model: "MiniMax-M3",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "final answer",
          reasoning_details: [
            { type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "full thinking" },
          ],
        },
      }],
      usage: { total_tokens: 10 },
    }));

    const events = await adapterFor(route.provider, route.modelId).parseResponse(response, createTranslatorBudget());
    expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "full thinking" });
    expect(events).toContainEqual({ type: "text_delta", text: "final answer" });
  });

  test("streaming cumulative reasoning_details snapshots are prefix-diffed, not appended", async () => {
    const route = minimaxRoute("MiniMax-M3");
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_details: [{ type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "The user" }] } }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "The user is asking" }] } }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "The user is asking" }] } }] },
      { choices: [{ index: 0, delta: { content: "answer" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of adapterFor(route.provider, route.modelId).parseStream(new Response(stream), createTranslatorBudget())) {
      events.push(event);
    }

    const reasoningEvents = events.filter(e => e.type === "reasoning_raw_delta");
    expect(reasoningEvents).toEqual([
      { type: "reasoning_raw_delta", text: "The user" },
      { type: "reasoning_raw_delta", text: " is asking" },
    ]);
    expect(events).toContainEqual({ type: "text_delta", text: "answer" });
  });

  test("providers without reasoning_details opt-in keep ignoring the array", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
    };
    const response = new Response(JSON.stringify({
      id: "resp-1",
      object: "chat.completion",
      created: 0,
      model: "example-model",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "answer",
          reasoning_details: [{ type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "thinking" }],
        },
      }],
    }));

    const events = await createOpenAIChatAdapter(provider).parseResponse(response, createTranslatorBudget());

    expect(events.some(e => e.type === "reasoning_raw_delta")).toBe(false);
  });

  test("a non-matching model on an opted-in provider ignores reasoning_details", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      reasoningDetailsModels: ["MiniMax-M3"],
    };
    const response = new Response(JSON.stringify({
      id: "resp-1",
      object: "chat.completion",
      created: 0,
      model: "other-model",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "answer",
          reasoning_details: [{ type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "thinking" }],
        },
      }],
    }));

    const events = await adapterFor(provider, "other-model").parseResponse(response, createTranslatorBudget());

    expect(events.some(e => e.type === "reasoning_raw_delta")).toBe(false);
  });
});
