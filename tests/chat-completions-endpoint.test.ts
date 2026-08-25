import { waitForNativeMainStartupGate } from "../src/codex/native-profile-startup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { ownedServiceHomeInspection } from "./helpers/owned-service-home-inspection";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { chatCompletionsToResponsesBody, ChatCompletionsRequestError } from "../src/chat/inbound";
import { chatCompletionsUsage } from "../src/chat/outbound";
import { parseRequest } from "../src/responses/parser";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { TranslatorBudget } from "../src/lib/translator-budget";
import {
  resetProviderRequestPacingForTest,
  setProviderRequestPacingRuntimeForTest,
} from "../src/providers/request-pacing";
import {
  acquireNativeMainProfileDrain,
  activeRegistryMetrics,
  getActiveTurnCount,
  getNativeMainProfileRequestCount,
  resetLifecycleDrainStateForTests,
  tryAdmitTurn,
} from "../src/server/lifecycle";
import {
  blockNativeMainRecovery,
  completeNativeMainRecovery,
  nativeMainStartupGateSnapshot,
  waitForNativeMainStartupGate,
} from "../src/codex/native-profile-startup";

function budgetedChatOutbound(module: typeof import("../src/chat/outbound")) {
  const translatorBudget = createTestTranslatorBudget();
  return {
    ...module,
    responsesSseToChatCompletionsSse(
      upstream: ReadableStream<Uint8Array>,
      model: string,
      opts?: { translatorBudget?: TranslatorBudget },
    ) {
      return module.responsesSseToChatCompletionsSse(upstream, model, {
        translatorBudget: opts?.translatorBudget ?? translatorBudget,
      });
    },
    collectChatCompletion(
      stream: ReadableStream<Uint8Array>,
      model: string,
      budget?: TranslatorBudget,
    ) {
      return module.collectChatCompletion(stream, model, budget ?? translatorBudget);
    },
  };
}

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-completions-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-completions-"));
  process.env.OPENCODEX_HOME = testDir;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  globalThis.fetch = originalFetch;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function mockChatUpstream() {
  return mockChatUpstreamCapturing().server;
}

function mockChatUpstreamCapturing() {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* keep streaming */ }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " from mock" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

/**
 * Serves both wires and records which one each request took (#404). The chat-only
 * helper above cannot answer "did this model reach the Responses API", which is the
 * whole question behind the per-model override.
 */
function mockDualWireUpstream() {
  const captured: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> = {};
      try { body = await req.json() as Record<string, unknown>; } catch { /* keep going */ }
      captured.push({ pathname: url.pathname, body });

      if (url.pathname.endsWith("/responses")) {
        const frames = [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
              usage: { input_tokens: 5, output_tokens: 2 },
            },
          })}\n\n`,
        ];
        return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
      }

      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

function mockConfig(baseUrl: string, providerOverrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "k",
        allowPrivateNetwork: true,
        ...providerOverrides,
      },
    },
  } as OcxConfig;
}

type StreamedToolCall = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type ChatStreamChunk = {
  choices?: Array<{
    delta?: { tool_calls?: StreamedToolCall[] };
    finish_reason?: string | null;
  }>;
};

async function convertResponsesFrames(frames: string[], model = "gpt-test") {
  const { responsesSseToChatCompletionsSse } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const stream = responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), model);
  const text = await new Response(stream).text();
  const chunks = text.split("\n\n")
    .map(block => block.trim())
    .filter(block => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map(block => JSON.parse(block.slice(6)) as ChatStreamChunk);
  return {
    chunks,
    toolCalls: chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? []),
    raw: text,
  };
}

test("chatCompletionsToResponsesBody maps messages/tools/system", () => {
  const body = chatCompletionsToResponsesBody({
    model: "mock/test-model",
    stream: true,
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "look up",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    }],
    tool_choice: "auto",
    max_tokens: 64,
    reasoning_effort: "high",
  });
  expect(body.model).toBe("mock/test-model");
  expect(body.stream).toBe(true);
  expect(body.instructions).toBe("be brief");
  expect(body.max_output_tokens).toBe(64);
  expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(body.tool_choice).toBe("auto");
  expect(Array.isArray(body.tools)).toBe(true);
  expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "function", name: "lookup" });
  const input = body.input as Array<Record<string, unknown>>;
  expect(input.some(i => i.type === "message" && i.role === "user")).toBe(true);
  expect(input.some(i => i.type === "function_call" && i.call_id === "call_1")).toBe(true);
  expect(input.some(i => i.type === "function_call_output" && i.call_id === "call_1")).toBe(true);
});

describe("chatCompletionsToResponsesBody service_tier", () => {
  test("preserves a caller-supplied service_tier", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hi" }],
      service_tier: "flex",
    });
    expect(body.service_tier).toBe("flex");
  });

  test("does not inject service_tier when the caller omitted it", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body).not.toHaveProperty("service_tier");
  });
});

async function driveChatFallbackServiceTier(
  providerOverrides: Partial<OcxProviderConfig>,
): Promise<Record<string, unknown>> {
  const { handleChatCompletions } = await import("../src/server/chat-completions");
  const captured: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const providerName = "chat-tier-fixture";
  const config = {
    port: 0,
    defaultProvider: providerName,
    providers: {
      [providerName]: {
        adapter: "openai-chat",
        baseUrl: "https://chat-tier.example.test/v1",
        authMode: "key",
        apiKey: "sk-test",
        chatServiceTier: true,
        supportsServiceTier: true,
        ...providerOverrides,
      },
    },
  } as OcxConfig;
  const response = await handleChatCompletions(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `${providerName}/model`,
        messages: [{ role: "user", content: "ping" }],
        stream: true,
        // Force the Chat -> Responses fallback so this exercises the converter.
        store: true,
        service_tier: "flex",
      }),
    }),
    config,
    { model: "", provider: "" },
  );

  expect(response.status).toBe(200);
  await response.text();
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe("POST /v1/chat/completions service_tier fallback", () => {
  test("forwards the caller tier through a service-tier-capable openai-chat route", async () => {
    const outboundBody = await driveChatFallbackServiceTier({});
    expect(outboundBody.service_tier).toBe("flex");
  });

  test("strips the caller tier when the provider explicitly disables service tiers", async () => {
    const outboundBody = await driveChatFallbackServiceTier({ supportsServiceTier: false });
    expect(outboundBody).not.toHaveProperty("service_tier");
  });
});

describe("chatCompletionsToResponsesBody reasoning summary", () => {
  test("defaults summary to auto when the client only sent reasoning_effort", () => {
    const body = chatCompletionsToResponsesBody({
      model: "opencode-go/deepseek-v4-flash",
      messages: [{ role: "user", content: "What is 17*19?" }],
      reasoning_effort: "max",
    });
    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
    const parsed = parseRequest(body);
    expect(parsed.options.hideThinkingSummary).not.toBe(true);
    expect(parsed.options.reasoning).toBe("max");
  });

  test("preserves an explicit reasoning.summary", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high", summary: "concise" },
    });
    expect(body.reasoning).toEqual({ effort: "high", summary: "concise" });
  });

  test("include_reasoning false hides thinking even when effort is set", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      include_reasoning: false,
    });
    expect(body.reasoning).toEqual({ effort: "high", summary: "none" });
    expect(parseRequest(body).options.hideThinkingSummary).toBe(true);
  });

  test("include_reasoning true requests a visible summary without an effort", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hi" }],
      include_reasoning: true,
    });
    expect(body.reasoning).toEqual({ summary: "auto" });
    expect(parseRequest(body).options.hideThinkingSummary).not.toBe(true);
  });

  test("explicit reasoning.summary wins over include_reasoning true", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hi" }],
      include_reasoning: true,
      reasoning: { summary: "none" },
    });
    expect(body.reasoning).toEqual({ summary: "none" });
    expect(parseRequest(body).options.hideThinkingSummary).toBe(true);
  });

  test("explicit reasoning.summary wins over include_reasoning false", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hi" }],
      include_reasoning: false,
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(parseRequest(body).options.hideThinkingSummary).not.toBe(true);
  });

  test("omits reasoning when the client sent no reasoning knobs", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.reasoning).toBeUndefined();
    expect(parseRequest(body).options.hideThinkingSummary).toBe(true);
  });
});

test("chatCompletionsToResponsesBody rejects missing model", () => {
  expect(() => chatCompletionsToResponsesBody({ messages: [{ role: "user", content: "x" }] }))
    .toThrow(ChatCompletionsRequestError);
});

test("chatCompletionsUsage always emits detail objects with zero defaults", () => {
  // Strict OpenAI-compatible clients (grok-build) require token-detail objects;
  // routed providers that report no cache/reasoning numbers must still produce them.
  expect(chatCompletionsUsage({ input_tokens: 9, output_tokens: 4 })).toEqual({
    prompt_tokens: 9,
    completion_tokens: 4,
    total_tokens: 13,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  expect(chatCompletionsUsage(undefined)).toEqual({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  expect(chatCompletionsUsage({
    input_tokens: 20,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  })).toEqual({
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 5 },
    completion_tokens_details: { reasoning_tokens: 3 },
  });
});

test("responsesSseToChatCompletionsSse consumes response.heartbeat without forwarding a raw frame", async () => {
  // Upstream responses SSE may contain heartbeat events (SSE comment keep-alive in
  // bridge.ts, but some upstreams emit them as typed frames). The chat-completions
  // converter must drop them rather than forwarding raw Responses-vocab frames.
  const { responsesSseToChatCompletionsSse } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const upstream = new Response([
    `event: response.heartbeat\ndata: ${JSON.stringify({ type: "response.heartbeat" })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`,
    `event: response.heartbeat\ndata: ${JSON.stringify({ type: "response.heartbeat" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  const stream = responsesSseToChatCompletionsSse(upstream.body!, "routed/model");
  const text = await new Response(stream).text();
  expect(text).not.toContain("response.heartbeat");
  expect(text).toContain('"content":"hi"');
  expect(text).toContain("data: [DONE]");
  // Every data frame must be a chat.completion.chunk — no Responses-vocab leaks.
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const parsed = JSON.parse(line.slice(6)) as { object?: string };
    expect(parsed.object).toBe("chat.completion.chunk");
  }
});

test("POST /v1/chat/completions streams OpenAI-shaped chunks end to end", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("Hello");
    expect(text).toContain("from mock");
    expect(text).toContain("data: [DONE]");
    expect(text).toContain("\"finish_reason\":\"stop\"");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("non-streaming /v1/chat/completions returns chat.completion JSON", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as {
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string | null }; finish_reason: string }>;
    };
    expect(json.object).toBe("chat.completion");
    expect(json.model).toBe("mock/test-model");
    expect(json.choices[0]?.message.role).toBe("assistant");
    expect(json.choices[0]?.message.content).toContain("Hello");
    expect(json.choices[0]?.finish_reason).toBe("stop");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("GET /v1/models returns OpenAI list shape for Copilot App discovery", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models", server.url));
    expect(response.status).toBe(200);
    const json = await response.json() as { object: string; data: Array<{ id: string; object: string }> };
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);
    // Routed mock model may or may not appear depending on liveModels; list shape is the contract.
    expect(json.data.every(m => m.object === "model" && typeof m.id === "string")).toBe(true);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("invalid chat completions body returns OpenAI-style 400", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string; type: string } };
    expect(json.error.message).toContain("model");
    expect(json.error.type).toBe("invalid_request_error");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("large image chat-completions request remains within its bounded replay budget", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: false,
        messages: [{
          role: "user",
          content: [{
            type: "image_url",
            image_url: { url: `data:image/png;base64,${"a".repeat(25 * 1024 * 1024)}` },
          }],
        }],
      }),
    });
    expect(response.status).toBe(200);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-completions replay copy overflow returns JSON 413", async () => {
  // The serialized replay body is the one retained request copy. A payload above
  // the 32 MiB turn limit must remain a structured client error.
  saveConfig(mockConfig("http://127.0.0.1:1/v1"));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: false,
        messages: [{ role: "user", content: "x".repeat(33 * 1024 * 1024) }],
      }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const json = await response.json() as { error?: { message?: string; type?: string; code?: string } };
    expect(json.error).toMatchObject({
      message: "request translation buffer exceeded the safe limit",
      type: "request_too_large",
      code: "translation_buffer_limit",
    });
  } finally {
    await server.stop(true);
  }
});

test("chatCompletionsToResponsesBody maps response_format and rejects unknown types", () => {
  const jsonObject = chatCompletionsToResponsesBody({
    model: "mock/test-model",
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_object" },
  });
  expect(jsonObject.text).toEqual({ format: { type: "json_object" } });

  expect(() => chatCompletionsToResponsesBody({
    model: "mock/test-model",
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "xml" },
  })).toThrow(ChatCompletionsRequestError);
});

test("responsesSseToChatCompletionsSse emits parallel tool calls once with stable indices", async () => {
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "alpha", arguments: "" } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "beta", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"a":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_b", delta: '{"b":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "1}" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "alpha", arguments: '{"a":1}' } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "beta", arguments: '{"b":2}' } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  ];
  const { toolCalls } = await convertResponsesFrames(frames, "mock/test-model");
  expect(toolCalls).toEqual([
    {
      index: 0,
      id: "call_a",
      type: "function",
      function: { name: "alpha", arguments: '{"a":1}' },
    },
    {
      index: 1,
      id: "call_b",
      type: "function",
      function: { name: "beta", arguments: '{"b":2}' },
    },
  ]);
});

test("responsesSseToChatCompletionsSse bounds upstream reads until the chat client pulls", async () => {
  const { responsesSseToChatCompletionsSse } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const encoder = new TextEncoder();
  let pulls = 0;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(encoder.encode(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: `${pulls}` })}\n\n`,
      ));
      if (pulls === 100) controller.close();
    },
  });

  const stream = responsesSseToChatCompletionsSse(upstream, "mock/test-model");
  await new Promise(resolve => setTimeout(resolve, 25));

  expect(pulls).toBeLessThanOrEqual(2);
  await stream.cancel();
});

test("responsesSseToChatCompletionsSse delivers the first frame before a macrotask turn", async () => {
  const { responsesSseToChatCompletionsSse } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { status: "in_progress" } })}\n\n`,
      ));
    },
  });
  const reader = responsesSseToChatCompletionsSse(upstream, "mock/test-model").getReader();
  let macrotaskRan = false;
  const timer = setTimeout(() => { macrotaskRan = true; }, 0);

  const first = await reader.read();

  clearTimeout(timer);
  expect(first.done).toBe(false);
  expect(new TextDecoder().decode(first.value)).toContain("chat.completion.chunk");
  expect(macrotaskRan).toBe(false);
  await reader.cancel();
});

test("POST /v1/chat/completions forwards response_format to routed openai-chat", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true } },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    // Round trip: chat nested -> internal flat text.format -> re-nested on the wire, byte-identical.
    expect(captured.length).toBe(1);
    expect(captured[0]!.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    });
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("native Chat SSE holds its active-turn lease until terminal completion", async () => {
  const encoder = new TextEncoder();
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller;
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "held" } }] })}\n\n`,
          ));
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  const before = getActiveTurnCount();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(getActiveTurnCount()).toBe(before + 1);

    upstreamController!.enqueue(encoder.encode("data: [DONE]\n\n"));
    try { upstreamController!.close(); } catch { /* parser may cancel after terminal */ }
    while (!(await reader.read()).done) { /* drain terminal frames */ }
    reader = undefined;
    expect(getActiveTurnCount()).toBe(before);
  } finally {
    await reader?.cancel();
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("POST /v1/responses carries text.format onto the routed chat wire", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        text: { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.length).toBe(1);
    expect(captured[0]!.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    });
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("POST /v1/chat/completions honors the per-model response_format opt-out", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`, {
    noStructuredOutputModels: ["test-model"],
  }));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.response_format).toBeUndefined();
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("POST /v1/responses honors the per-model response_format opt-out", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`, {
    noStructuredOutputModels: ["test-model"],
  }));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.response_format).toBeUndefined();
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native consumes pacing before the response-header timeout starts", async () => {
  const { handleChatCompletions } = await import("../src/server/chat-completions");
  let pacingTimer: (() => void) | undefined;
  let now = 0;
  setProviderRequestPacingRuntimeForTest({
    now: () => now,
    setTimer: callback => {
      pacingTimer = callback;
      return callback;
    },
    clearTimer: () => { pacingTimer = undefined; },
    enqueueMicrotask: callback => callback(),
  });

  let starts = 0;
  const providerExecutor = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    starts += 1;
    return Response.json({
      id: `chatcmpl_paced_${starts}`,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });
  }, { preconnect() {} }) as typeof globalThis.fetch;
  const config = mockConfig("https://provider.example/v1", {
    requestPacing: { enabled: true, minIntervalMs: 100 },
    fetch: providerExecutor,
  } as Partial<OcxProviderConfig> & { fetch: typeof globalThis.fetch });
  config.connectTimeoutMs = 1;
  const request = () => new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock/test-model",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  const first = await handleChatCompletions(request(), config, {} as Parameters<typeof handleChatCompletions>[2]);
  expect(first.status).toBe(200);
  const secondPending = handleChatCompletions(request(), config, {} as Parameters<typeof handleChatCompletions>[2]);
  await Bun.sleep(5);
  expect(starts).toBe(1);
  expect(pacingTimer).toBeDefined();
  now = 100;
  const release = pacingTimer;
  pacingTimer = undefined;
  release?.();
  const second = await secondPending;
  expect(second.status).toBe(200);
  expect(starts).toBe(2);
});

test("chat-native stays outside the Responses empty-completion retry guard", async () => {
  const { handleChatCompletions } = await import("../src/server/chat-completions");
  let upstreamCalls = 0;
  const providerExecutor = Object.assign(async () => {
    upstreamCalls += 1;
    return Response.json({
      id: "chatcmpl_empty_native",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    });
  }, { preconnect() {} }) as typeof globalThis.fetch;
  const config = mockConfig("https://provider.example/v1", {
    fetch: providerExecutor,
  } as Partial<OcxProviderConfig> & { fetch: typeof globalThis.fetch });
  config.emptyCompletionRetry = true;

  const response = await handleChatCompletions(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    config,
    {} as Parameters<typeof handleChatCompletions>[2],
  );

  expect(response.status).toBe(200);
  expect(upstreamCalls).toBe(1);
  expect(await response.json()).toMatchObject({
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
  });
});

test("chat-native does not forward ChatGPT account headers to third-party providers", async () => {
  const seen: Array<{ authorization: string | null; account: string | null }> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({
        authorization: req.headers.get("authorization"),
        account: req.headers.get("chatgpt-account-id"),
      });
      return Response.json({
        id: "chatcmpl_safe",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "chat-main-access", account_id: "chat-main-account" },
  }));
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`, {
    apiKey: "third-party-key",
  }));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ authorization: "Bearer third-party-key", account: null }]);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native non-stream fold preserves tool calls and finish reason", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return new Response([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: false,
        messages: [{ role: "user", content: "use lookup" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as {
      choices: Array<{ finish_reason: string; message: { tool_calls?: unknown[] } }>;
    };
    expect(json.choices[0]?.finish_reason).toBe("tool_calls");
    expect(json.choices[0]?.message.tool_calls).toEqual([{
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    }]);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});


test("chat-native non-stream upstream overflow returns 502 without hanging", async () => {
  // Provider-controlled overflow is a 502; the second request proves the reader was released.
  let calls = 0;
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      if (calls === 1) {
        const chunk = new TextEncoder().encode('{"id":"chatcmpl_x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"' + "y".repeat(33 * 1024 * 1024) + '"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
        return new Response(chunk, { headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "chatcmpl_ok", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(502);
    const json = await response.json() as { error?: { code?: string } };
    expect(json.error?.code).toBe("translation_buffer_limit");
    const response2 = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response2.status).toBe(200);
    // Prove the overflow path released the body/reader: second request consumed a fresh upstream response.
    expect(calls).toBe(2);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native non-stream invalid JSON returns a provider error", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return new Response("not-json-at-all", { headers: { "content-type": "application/json" } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(502);
    const json = await response.json() as { error?: { type?: string } };
    expect(json.error?.type).toBe("upstream_error");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native uses the shared request builder and normalized Chat Completions URL", async () => {
  const captured: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({ pathname: new URL(req.url).pathname, body: await req.json() as Record<string, unknown> });
      return Response.json({
        id: "chatcmpl_builder",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    },
  });
  const endpointBase = `${upstream.url.toString().replace(/\/$/, "")}/v1/chat/completions/`;
  saveConfig(mockConfig(endpointBase, { noTemperatureModels: ["test-model"] }));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: false,
        temperature: 0.9,
        service_tier: "priority",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.pathname).toBe("/v1/chat/completions");
    expect(captured[0]?.body.model).toBe("test-model");
    expect(captured[0]?.body.temperature).toBeUndefined();
    expect(captured[0]?.body.service_tier).toBeUndefined();
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native preserves caller Chat fields on the upstream wire", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`, {
    chatServiceTier: true,
    parallelToolCalls: true,
  }));
  const server = startServer(0);
  const messages = [
    { role: "system", name: "system-sentinel", content: "system sentinel" },
    { role: "developer", name: "developer-sentinel", content: "developer sentinel" },
    { role: "user", name: "user-sentinel", content: "user sentinel" },
  ];
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        messages,
        stream: true,
        stream_options: { include_usage: false, sentinel_option: "preserved" },
        max_completion_tokens: 321,
        service_tier: "priority",
        seed: 42,
        n: 2,
        logprobs: true,
        top_logprobs: 3,
        logit_bias: { "123": -5 },
        user: "user-wire-sentinel",
        metadata: { trace: "metadata-sentinel" },
        parallel_tool_calls: false,
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      model: "test-model",
      messages,
      stream: true,
      stream_options: { include_usage: true, sentinel_option: "preserved" },
      max_completion_tokens: 321,
      service_tier: "priority",
      seed: 42,
      n: 2,
      logprobs: true,
      top_logprobs: 3,
      logit_bias: { "123": -5 },
      user: "user-wire-sentinel",
      metadata: { trace: "metadata-sentinel" },
      parallel_tool_calls: false,
    });
    expect(captured[0]!.messages).toEqual(messages);
    expect(captured[0]).not.toHaveProperty("max_tokens");
    expect(captured[0]).not.toHaveProperty("instructions");
    expect(captured[0]).not.toHaveProperty("input");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native streaming accepts CRLF events split across transport chunks", async () => {
  const encoder = new TextEncoder();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"split"}}]}\r'));
          controller.enqueue(encoder.encode('\n\r'));
          controller.enqueue(encoder.encode('\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n'));
          controller.enqueue(encoder.encode('\r\ndata: [DONE]\r\n\r\n'));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"content":"split"');
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain("data: [DONE]");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native streaming rejects an unterminated SSE event", async () => {
  const before = getActiveTurnCount();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"code":"upstream_sse_unterminated"');
    expect(text).not.toContain("data: [DONE]");
    expect(getActiveTurnCount()).toBe(before);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native streaming bounds an oversized unterminated SSE event", async () => {
  let calls = 0;
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      if (calls === 1) {
        return new Response(`data: ${"x".repeat(33 * 1024 * 1024)}`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const first = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const firstText = await first.text();
    expect(firstText).toContain('"code":"translation_buffer_limit"');
    expect(firstText).not.toContain("data: [DONE]");

    const second = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(await second.text()).toContain("data: [DONE]");
    expect(calls).toBe(2);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native redacts structured provider errors before returning them", async () => {
  const echoedSecret = "Authorization: Bearer opaquecredential123456";
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        error: {
          message: `upstream echoed ${echoedSecret}`,
          type: "authentication_error",
          code: "invalid_api_key",
        },
      }, { status: 401 });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).toContain("Bearer [REDACTED]");
    expect(text).not.toContain("opaquecredential123456");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native preserves a structured cyber_policy type on JSON and SSE failures", async () => {
  const secret = `blocked by upstream policy Authorization: ${["Bear", "er"].join("")} chatnativesecret123456`;
  const safeMessage = "blocked by upstream policy Authorization: Bearer [REDACTED]";
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { stream?: boolean };
      const error = {
        message: secret,
        type: "server_error",
        code: "cyber_policy",
        status: 502,
      };
      if (body.stream) {
        return new Response(`data: ${JSON.stringify({ error })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(error, { status: 502, headers: { "retry-after": "120" } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const request = (stream: boolean) => fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream, messages: [{ role: "user", content: "hi" }] }),
    });

    const jsonResponse = await request(false);
    expect(jsonResponse.status).toBe(400);
    expect(jsonResponse.headers.get("retry-after")).toBeNull();
    await expect(jsonResponse.json()).resolves.toMatchObject({
      error: { type: "server_error", code: "cyber_policy", message: safeMessage },
    });

    const sseResponse = await request(true);
    expect(sseResponse.status).toBe(200);
    const sseText = await sseResponse.text();
    expect(sseText).toContain('"type":"server_error"');
    expect(sseText).toContain('"code":"cyber_policy"');
    expect(sseText).toContain("Authorization: Bearer [REDACTED]");
    expect(sseText).not.toContain("chatnativesecret123456");
    expect(sseText).not.toContain("data: [DONE]");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("chat-native preserves same-key retry, key rotation, usage, and request logging", async () => {
  const { clearRequestLogsForTests, getRequestLogEntries } = await import("../src/server/request-log");
  const { clearKeyCooldowns } = await import("../src/providers/key-failover");
  clearRequestLogsForTests();
  clearKeyCooldowns("mock");
  const authorizations: Array<string | null> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      authorizations.push(req.headers.get("authorization"));
      if (authorizations.length < 3) {
        return Response.json({ error: { message: "rate limited", type: "rate_limit_error" } }, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return Response.json({
        id: "chatcmpl_retry",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`, {
    authMode: "key",
    apiKey: "key-one",
    apiKeyPool: [{ id: "one", key: "key-one" }, { id: "two", key: "key-two" }],
    retryOn429: { attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false },
  }));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(authorizations).toEqual(["Bearer key-one", "Bearer key-one", "Bearer key-two"]);
    const entry = getRequestLogEntries().at(-1);
    expect(entry?.status).toBe(200);
    expect(entry?.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(entry?.attempts?.[0]?.recoveryKinds).toEqual(["rate-limit-429", "key-429"]);
  } finally {
    await server.stop(true);
    upstream.stop(true);
    clearKeyCooldowns("mock");
  }
});

test("chat-native client cancellation cancels the upstream stream and logs 499", async () => {
  const { clearRequestLogsForTests, getRequestLogEntries } = await import("../src/server/request-log");
  const { handleChatCompletions } = await import("../src/server/chat-completions");
  clearRequestLogsForTests();
  let markCancelled!: () => void;
  const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
  const encoder = new TextEncoder();
  const releaseMisses = activeRegistryMetrics().activeTurns.releaseMisses;
  const before = getActiveTurnCount();
  const lease = tryAdmitTurn();
  if (!lease) throw new Error("failed to admit native Chat cancellation test turn");
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"held"}}]}\n\n'));
        },
        cancel() {
          markCancelled();
        },
      }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const logCtx = {} as Parameters<typeof handleChatCompletions>[2];
    const response = await handleChatCompletions(
      request,
      mockConfig("https://provider.example/v1"),
      logCtx,
      { requestId: "chat-cancel", start: Date.now(), turnAdmissionLease: lease },
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(lease.isTransferred()).toBe(true);
    expect(getActiveTurnCount()).toBe(before + 1);
    const cancelOutcome = await Promise.race([
      Promise.all([reader.cancel("client done"), cancelled]).then(() => "cancelled" as const),
      Bun.sleep(2_000).then(() => "timeout" as const),
    ]);
    expect(cancelOutcome).toBe("cancelled");
    expect(getRequestLogEntries().at(-1)?.status).toBe(499);
    expect(getActiveTurnCount()).toBe(before);
    expect(activeRegistryMetrics().activeTurns.releaseMisses).toBe(releaseMisses);
  } finally {
    lease.release();
    globalThis.fetch = originalFetch;
  }
});

test("chat-native request abort releases its active-turn lease and logs 499", async () => {
  const { clearRequestLogsForTests, getRequestLogEntries } = await import("../src/server/request-log");
  const { handleChatCompletions } = await import("../src/server/chat-completions");
  clearRequestLogsForTests();
  let markCancelled!: () => void;
  const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
  const encoder = new TextEncoder();
  const releaseMisses = activeRegistryMetrics().activeTurns.releaseMisses;
  const before = getActiveTurnCount();
  const lease = tryAdmitTurn();
  if (!lease) throw new Error("failed to admit native Chat request-abort test turn");
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"held"}}]}\n\n'));
        },
        cancel() {
          markCancelled();
        },
      }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    const clientAbort = new AbortController();
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
      signal: clientAbort.signal,
    });
    const response = await handleChatCompletions(
      request,
      mockConfig("https://provider.example/v1"),
      {} as Parameters<typeof handleChatCompletions>[2],
      { requestId: "chat-request-abort", start: Date.now(), turnAdmissionLease: lease },
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(lease.isTransferred()).toBe(true);
    expect(getActiveTurnCount()).toBe(before + 1);

    const nextRead = reader.read();
    clientAbort.abort("client done");
    const abortOutcome = await Promise.race([
      Promise.all([nextRead, cancelled]).then(([read]) => ({ kind: "cancelled" as const, read })),
      Bun.sleep(2_000).then(() => ({ kind: "timeout" as const })),
    ]);
    expect(abortOutcome.kind).toBe("cancelled");
    if (abortOutcome.kind === "cancelled") expect(abortOutcome.read.done).toBe(true);
    expect(getRequestLogEntries().at(-1)?.status).toBe(499);
    expect(getActiveTurnCount()).toBe(before);
    expect(activeRegistryMetrics().activeTurns.releaseMisses).toBe(releaseMisses);
  } finally {
    lease.release();
    globalThis.fetch = originalFetch;
  }
});

test("chat-native direct streaming without an admission lease does not record a release miss", async () => {
  const { handleChatCompletions } = await import("../src/server/chat-completions");
  const releaseMisses = activeRegistryMetrics().activeTurns.releaseMisses;
  globalThis.fetch = (async () => new Response(
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )) as typeof fetch;
  try {
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await handleChatCompletions(
      request,
      mockConfig("https://provider.example/v1"),
      {} as Parameters<typeof handleChatCompletions>[2],
      { requestId: "chat-no-lease", start: Date.now() },
    );
    expect(await response.text()).toContain("data: [DONE]");
    expect(activeRegistryMetrics().activeTurns.releaseMisses).toBe(releaseMisses);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat-native streaming synthesizes tool-call SSE from Chat JSON", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        id: "chatcmpl_tc",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("lookup");
    expect(text).toContain("tool_calls");
    expect(text).toContain("data: [DONE]");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("POST /v1/chat/completions direct mode forwards caller Authorization", async () => {
  const seen: Array<{ authorization: string | null }> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ authorization: req.headers.get("authorization") });
      return Response.json({
        id: "resp_direct",
        object: "response",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(seen.some(hit => hit.authorization === ["Bear" + "er", "caller-direct-token"].join(" "))).toBe(true);
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});

/**
 * This case sandboxes CODEX_HOME, so the service installed on the developer's
 * machine is not evidence about it. See tests/helpers/owned-service-home.ts.
 */
const inspectNativeCodexOwnership = ownedServiceHomeInspection("chat replay main-enrichment test");

test("chat-native skips optional main enrichment while routed work survives drain and recovery", async () => {
  resetLifecycleDrainStateForTests();
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "chat-main-access", account_id: "chat-main-account" },
  }));
  let upstreamCalls = 0;
  let finishUpstream: (() => void) | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const encoder = new TextEncoder();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      upstreamCalls += 1;
      if (upstreamCalls > 1) {
        return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"held"}}]}\n\n'));
          finishUpstream = () => {
            finishUpstream = undefined;
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          };
          markStarted();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  let server = startServer(0, { inspectNativeCodexOwnership });
  await waitForNativeMainStartupGate();
  const request = () => fetch(new URL("/v1/chat/completions", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock/test-model",
      stream: true,
      messages: [{ role: "user", content: "hold" }],
    }),
  });
  let drain: ReturnType<typeof acquireNativeMainProfileDrain> = null;
  let recoveryHomeId: string | null = null;
  try {
    await waitForNativeMainStartupGate();
    const pending = request();
    await started;
    const response = await pending;
    expect(response.status).toBe(200);
    expect(getNativeMainProfileRequestCount()).toBe(0);
    drain = acquireNativeMainProfileDrain("chat-overlap");
    expect(drain).not.toBeNull();
    const routedDuringDrain = await request();
    expect(routedDuringDrain.status).toBe(200);
    await routedDuringDrain.text();
    expect(upstreamCalls).toBe(2);

    finishUpstream?.();
    await response.text();
    expect(getNativeMainProfileRequestCount()).toBe(0);
    drain?.release();
    drain = null;

    recoveryHomeId = nativeMainStartupGateSnapshot().homeId ?? "chat-recovery-home";
    expect(blockNativeMainRecovery(recoveryHomeId, "manual")).toBe(true);
    const routedDuringRecovery = await request();
    expect(routedDuringRecovery.status).toBe(200);
    await routedDuringRecovery.text();
    expect(upstreamCalls).toBe(3);

    completeNativeMainRecovery(recoveryHomeId);
    recoveryHomeId = null;
    await server.stop(true);
    saveConfig({
      port: 0,
      openaiProviderTierVersion: 2,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      codexAccounts: [],
      activeCodexAccountId: "__main__",
      autoSwitchThreshold: 0,
    } as OcxConfig);
    server = startServer(0, { inspectNativeCodexOwnership });
    await waitForNativeMainStartupGate();
    recoveryHomeId = nativeMainStartupGateSnapshot().homeId ?? "chat-main-recovery-home";
    expect(blockNativeMainRecovery(recoveryHomeId, "manual")).toBe(true);
    const mainBlocked = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-test",
        stream: false,
        messages: [{ role: "user", content: "main blocked" }],
      }),
    });
    expect(mainBlocked.status).toBe(503);
    expect(upstreamCalls).toBe(3);
  } finally {
    if (recoveryHomeId) completeNativeMainRecovery(recoveryHomeId);
    drain?.release();
    finishUpstream?.();
    await server.stop(true);
    upstream.stop(true);
    resetLifecycleDrainStateForTests();
  }
}, 15_000);

test("POST /v1/chat/completions finalizes native passthrough request logs", async () => {
  const { clearRequestLogsForTests, getRequestLogEntries } = await import("../src/server/request-log");
  clearRequestLogsForTests();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      const frames = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_log" } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_log", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`,
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("hi");
    await Bun.sleep(50);
    const entry = getRequestLogEntries().findLast(e =>
      e.path === "/v1/chat/completions" || e.model === "gpt-test" || e.requestedModel === "gpt-test"
    );
    expect(entry).toBeTruthy();
    expect(entry?.status).toBe(200);
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
    clearRequestLogsForTests();
  }
});

test("POST /v1/chat/completions logs native cyber terminals as 400 cyber_policy", async () => {
  const { clearRequestLogsForTests, getRequestLogEntries } = await import("../src/server/request-log");
  clearRequestLogsForTests();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return new Response([
        "event: response.failed",
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            status: "failed",
            error: { type: "invalid_request_error", code: "cyber_policy", message: "blocked" },
          },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const prefix = "/backend-api/codex";
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
      return originalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("blocked");
    const entry = getRequestLogEntries().findLast(e => e.inboundProtocol === "chat");
    expect(entry).toMatchObject({
      status: 400,
      errorCode: "cyber_policy",
      terminalStatus: "failed",
      closeReason: "terminal",
      upstreamError: "blocked",
    });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    globalThis.fetch = originalFetch;
    clearRequestLogsForTests();
  }
});


test("responsesSseToChatCompletionsSse reconciles done-frame final arguments (last-write-wins)", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "alpha", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"q":"partial' })}\n\n`,
    // Done frame carries the authoritative final arguments after partial deltas.
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "alpha", arguments: '{"q":"final"}' } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  ];
  const stream = responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), "mock/test-model");
  const completion = await collectChatCompletion(stream, "mock/test-model");
  const toolCalls = (completion.choices as Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>)[0]
    ?.message?.tool_calls ?? [];
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]?.function?.arguments).toBe('{"q":"final"}');
});

test("responsesSseToChatCompletionsSse emits error frame on response.failed (no clean DONE)", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion, ChatCompletionsStreamError } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const frames = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_fail" } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`,
    `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "upstream exploded" } } })}\n\n`,
  ];
  const stream = responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), "mock/test-model");

  const text = await new Response(stream).text();
  expect(text).toContain('"error"');
  expect(text).toContain("upstream exploded");
  expect(text).not.toContain("[error]");
  expect(text).not.toContain("data: [DONE]");

  // Non-stream collectors must surface a typed error, not a 200 completion.
  const stream2 = responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), "mock/test-model");
  await expect(collectChatCompletion(stream2, "mock/test-model")).rejects.toBeInstanceOf(ChatCompletionsStreamError);
});

test("responsesSseToChatCompletionsSse preserves translator overflow and cancels upstream", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion, isChatCompletionsStreamError } =
    budgetedChatOutbound(await import("../src/chat/outbound"));
  const frame = `event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed",
    response: {
      status: "failed",
      error: {
        message: "upstream translation buffer exceeded the safe limit",
        type: "upstream_error",
        code: "translation_buffer_limit",
      },
    },
  })}\n\n`;
  let cancelled = false;
  const source = () => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
    },
    cancel() {
      cancelled = true;
    },
  });

  const text = await new Response(responsesSseToChatCompletionsSse(source(), "mock/test-model")).text();
  expect(text).toContain('"code":"translation_buffer_limit"');
  expect(text).toContain('"type":"upstream_error"');
  expect(text).not.toContain("data: [DONE]");
  expect(cancelled).toBe(true);

  try {
    await collectChatCompletion(
      responsesSseToChatCompletionsSse(source(), "mock/test-model"),
      "mock/test-model",
    );
    throw new Error("expected translator overflow");
  } catch (error) {
    expect(isChatCompletionsStreamError(error)).toBe(true);
    if (isChatCompletionsStreamError(error)) {
      // Provider-controlled overflow is an upstream failure (502), not a client error.
      expect(error).toMatchObject({ status: 502, type: "upstream_error", code: "translation_buffer_limit" });
    }
  }
});

test("collectChatCompletion enforces the per-call argument cap", async () => {
  const module = await import("../src/chat/outbound");
  const budget = createTestTranslatorBudget({ maxCallArgumentBytes: 1024 });
  const bigArgs = "x".repeat(2048);
  const frame = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_big", function: { name: "f", arguments: bigArgs } }] } }],
  })}\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  try {
    await module.collectChatCompletion(stream, "mock/test-model", budget);
    throw new Error("expected per-call overflow");
  } catch (error) {
    expect(module.isChatCompletionsStreamError(error)).toBe(true);
    if (module.isChatCompletionsStreamError(error)) {
      expect(error).toMatchObject({ status: 502, type: "upstream_error", code: "translation_buffer_limit" });
    }
  }
  // The failed call's scope is released on the error path.
  expect(budget.snapshot().activeCalls).toBe(0);
});

test("collectChatCompletion enforces the turn cap across many calls", async () => {
  const module = await import("../src/chat/outbound");
  const budget = createTestTranslatorBudget({ maxCallArgumentBytes: 512, maxTurnBytes: 4096 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // 12 calls x 512 bytes: per-call fits, the turn cap trips mid-stream.
      for (let index = 0; index < 12; index++) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name: "f", arguments: "y".repeat(512) } }] } }],
        })}\n\n`));
      }
      controller.close();
    },
  });
  try {
    await module.collectChatCompletion(stream, "mock/test-model", budget);
    throw new Error("expected turn overflow");
  } catch (error) {
    expect(module.isChatCompletionsStreamError(error)).toBe(true);
    if (module.isChatCompletionsStreamError(error)) {
      expect(error).toMatchObject({ status: 502, type: "upstream_error", code: "translation_buffer_limit" });
    }
  }
  expect(budget.snapshot().activeCalls).toBe(0);
});

test("collectChatCompletion releases every call scope after the final owner is charged", async () => {
  const module = await import("../src/chat/outbound");
  const budget = createTestTranslatorBudget();
  const encoder = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "alpha", arguments: "{\"q\":\"pa" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "rtial\"}" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "beta", arguments: "{\"z\":1}" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: {} }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  const completion = await module.collectChatCompletion(stream, "mock/test-model", budget);
  const toolCalls = (completion.choices as Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>)[0]
    ?.message?.tool_calls ?? [];
  expect(toolCalls).toHaveLength(2);
  expect(toolCalls[0]?.function?.arguments).toBe('{"q":"partial"}');
  // All per-call scopes closed: ownership moved to the serialized copies only.
  expect(budget.snapshot().activeCalls).toBe(0);
  // Exact surviving charge: the two serialized owners, nothing else.
  const copyA = { id: "call_a", type: "function", function: { name: "alpha", arguments: '{"q":"partial"}' } };
  const copyB = { id: "call_b", type: "function", function: { name: "beta", arguments: '{"z":1}' } };
  expect(budget.snapshot().currentBytes).toBe(
    Buffer.byteLength(JSON.stringify(copyA)) + Buffer.byteLength(JSON.stringify(copyB)),
  );
});

test("collectChatCompletion final-copy overflow cleans up scopes and charges", async () => {
  const module = await import("../src/chat/outbound");
  // Args (100 bytes) fit; args + serialized copy exceed the turn cap, so the
  // overflow fires during the final owner transfer, not mid-stream. The 250
  // threshold lets the ~213-byte frame and the 100-byte args through first.
  const budget = createTestTranslatorBudget({ maxCallArgumentBytes: 4096, maxTurnBytes: 250 });
  const frame = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "f", arguments: "a".repeat(100) } }] } }],
  })}\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  try {
    await module.collectChatCompletion(stream, "mock/test-model", budget);
    throw new Error("expected final-copy overflow");
  } catch (error) {
    expect(module.isChatCompletionsStreamError(error)).toBe(true);
    if (module.isChatCompletionsStreamError(error)) {
      expect(error).toMatchObject({ status: 502, type: "upstream_error", code: "translation_buffer_limit" });
    }
  }
  expect(budget.snapshot().activeCalls).toBe(0);
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("responsesSseToChatCompletionsSse emits error frame on truncated stream", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion, ChatCompletionsStreamError } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const frames = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_trunc" } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "half" })}\n\n`,
    // No terminal frame — stream ends abruptly.
  ];
  const stream = responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), "mock/test-model");

  const text = await new Response(stream).text();
  expect(text).toContain("truncated response");
  expect(text).not.toContain("data: [DONE]");
  await expect(collectChatCompletion(responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), "mock/test-model"), "mock/test-model")).rejects.toBeInstanceOf(ChatCompletionsStreamError);
});

test("non-streaming /v1/chat/completions returns error status on upstream failure", async () => {
  // Mock openai-chat upstream that streams a Responses-like failure through our adapter
  // is hard; instead drive handleResponses via a native responses mock that fails.
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      const frames = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_fail" } })}\n\n`,
        `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "provider blew up" } } })}\n\n`,
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const json = await response.json() as { error?: { message?: string; type?: string }; choices?: unknown };
    expect(json.error?.message ?? "").toContain("provider blew up");
    expect(json.choices).toBeUndefined();
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});

test("streaming /v1/chat/completions does not clean-DONE after response.failed", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      const frames = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_fail" } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`,
        `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "stream boom" } } })}\n\n`,
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // Stream opens with 200, then body carries an error frame and ends without [DONE].
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("stream boom");
    expect(text).toContain('"error"');
    expect(text).not.toContain("[error]");
    expect(text).not.toContain("data: [DONE]");
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});


test("responsesSseToChatCompletionsSse emits one complete named tool call", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"cmd":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '"ls"}' })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: '{"cmd":"ls"}' } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  ];
  const { toolCalls: toolDeltas } = await convertResponsesFrames(frames);
  // Responses emits two argument deltas plus a full done snapshot. Chat Completions clients
  // append function fields, so expose one complete tool-call delta rather than all three.
  expect(toolDeltas).toEqual([{
    index: 0,
    id: "call_a",
    type: "function",
    function: { name: "exec_command", arguments: '{"cmd":"ls"}' },
  }]);
  // Buffered non-stream collection still yields the same complete named tool call.
  const completion = await collectChatCompletion(responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), "gpt-test"), "gpt-test");
  const toolCalls = (completion.choices as Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>)[0]
    ?.message?.tool_calls ?? [];
  expect(toolCalls[0]?.function?.name).toBe("exec_command");
  expect(toolCalls[0]?.function?.arguments).toBe('{"cmd":"ls"}');
});

test("responsesSseToChatCompletionsSse falls back to buffered arguments when the done item omits them", async () => {
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"cmd":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '"pwd"}' })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command" } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
  ];
  const { toolCalls } = await convertResponsesFrames(frames);
  expect(toolCalls).toEqual([{
    index: 0,
    id: "call_a",
    type: "function",
    function: { name: "exec_command", arguments: '{"cmd":"pwd"}' },
  }]);
});

test("responsesSseToChatCompletionsSse flushes buffered tool calls before an incomplete terminal frame", async () => {
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"cmd":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '"pwd"}' })}\n\n`,
    `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })}\n\n`,
  ];
  const { chunks, toolCalls } = await convertResponsesFrames(frames);
  expect(toolCalls).toEqual([{
    index: 0,
    id: "call_a",
    type: "function",
    function: { name: "exec_command", arguments: '{"cmd":"pwd"}' },
  }]);
  const toolChunkIndex = chunks.findIndex(chunk =>
    (chunk.choices?.[0]?.delta?.tool_calls?.length ?? 0) > 0
  );
  const finishChunkIndex = chunks.findIndex(chunk =>
    chunk.choices?.[0]?.finish_reason === "length"
  );
  expect(toolChunkIndex).toBeGreaterThanOrEqual(0);
  expect(finishChunkIndex).toBeGreaterThan(toolChunkIndex);
});

test("responsesSseToChatCompletionsSse keeps buffered arguments when the done snapshot is empty", async () => {
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"cmd":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '"pwd"}' })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: "" } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
  ];
  const { toolCalls } = await convertResponsesFrames(frames);
  expect(toolCalls).toEqual([{
    index: 0,
    id: "call_a",
    type: "function",
    function: { name: "exec_command", arguments: '{"cmd":"pwd"}' },
  }]);
});

test("responsesSseToChatCompletionsSse ignores duplicate done events for a tool call", async () => {
  const done = `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: '{"cmd":"pwd"}' } })}\n\n`;
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: "" } })}\n\n`,
    done,
    done,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
  ];
  const { toolCalls } = await convertResponsesFrames(frames);
  expect(toolCalls).toEqual([{
    index: 0,
    id: "call_a",
    type: "function",
    function: { name: "exec_command", arguments: '{"cmd":"pwd"}' },
  }]);
});

test("responsesSseToChatCompletionsSse uses finalized arguments when the item done event is absent", async () => {
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"cmd":"partial' })}\n\n`,
    `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_a", name: "exec_command", arguments: '{"cmd":"final"}' })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
  ];
  const { chunks, toolCalls } = await convertResponsesFrames(frames);
  expect(toolCalls).toEqual([{
    index: 0,
    id: "call_a",
    type: "function",
    function: { name: "exec_command", arguments: '{"cmd":"final"}' },
  }]);
  expect(chunks.some(chunk => chunk.choices?.[0]?.finish_reason === "tool_calls")).toBe(true);
});

test("chatCompletionsToResponsesBody recovers tool_calls function.name from earlier call_id", () => {
  const body = chatCompletionsToResponsesBody({
    model: "gpt-test",
    messages: [
      { role: "user", content: "run ls" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_a", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }],
      },
      { role: "tool", tool_call_id: "call_a", content: "ok" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          // The client lost call_a's name while re-serializing an earlier message.
          { id: "call_a", type: "function", function: { arguments: '{"cmd":"ls"}' } },
          // Same-array recovery remains supported as well.
          { id: "call_b", type: "function", function: { name: "exec_command", arguments: '{"cmd":"pwd"}' } },
          { id: "call_b", type: "function", function: { arguments: '{"cmd":"pwd"}' } },
        ],
      },
    ],
  });
  const calls = (body.input as Array<Record<string, unknown>>).filter(i => i.type === "function_call");
  expect(calls.filter(c => c.call_id === "call_a").map(c => c.name)).toEqual(["exec_command", "exec_command"]);
  expect(calls.filter(c => c.call_id === "call_b").map(c => c.name)).toEqual(["exec_command", "exec_command"]);
});

test("chatCompletionsToResponsesBody indexes tool-call names once per call", () => {
  const count = 1_000;
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "start" }];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `linear_call_${i}`,
        type: "function",
        function: { name: "exec_command", arguments: "{}" },
      }],
    });
  }

  const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, "set");
  if (!descriptor || typeof descriptor.value !== "function") throw new Error("Map.prototype.set is unavailable");
  const nativeSet = descriptor.value as (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) => Map<unknown, unknown>;
  let matchingSetCalls = 0;
  let body: Record<string, unknown> | null = null;
  const countingSet: typeof Map.prototype.set = function <K, V>(
    this: Map<K, V>,
    key: K,
    value: V,
  ): Map<K, V> {
    if (typeof key === "string" && key.startsWith("linear_call_") && value === "exec_command") {
      matchingSetCalls += 1;
    }
    return Reflect.apply(nativeSet, this, [key, value]) as Map<K, V>;
  };

  Object.defineProperty(Map.prototype, "set", { ...descriptor, value: countingSet });
  try {
    body = chatCompletionsToResponsesBody({ model: "gpt-test", messages });
  } finally {
    Object.defineProperty(Map.prototype, "set", descriptor);
  }

  expect((body!.input as unknown[]).length).toBe(count + 1);
  expect(matchingSetCalls).toBe(count);
});

// Local-stack fixup regressions (Sol audit of #279, devlog 100_merge_records.md WP5):
// CRLF framing and a terminal event without a trailing blank line must not be reported
// as truncation now that the shared SSE decoder drives the converter.
test("responsesSseToChatCompletionsSse accepts CRLF-framed SSE with terminal event at EOF", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion } = budgetedChatOutbound(await import("../src/chat/outbound"));
  const raw = [
    `event: response.created\r\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_crlf" } })}\r\n\r\n`,
    `event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\r\n\r\n`,
    // Terminal frame: CRLF line ending, NO trailing blank line, no final newline.
    `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } })}`,
  ].join("");
  const bytes = new TextEncoder().encode(raw);
  // Split at awkward boundaries to exercise chunk-boundary handling too.
  const cuts = [7, 41, 97, 155, bytes.length];
  const stream = responsesSseToChatCompletionsSse(new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      for (const end of cuts) {
        if (end <= offset) continue;
        controller.enqueue(bytes.slice(offset, Math.min(end, bytes.length)));
        offset = end;
      }
      controller.close();
    },
  }), "mock/test-model");
  const completion = await collectChatCompletion(stream, "mock/test-model");
  const choice = (completion.choices as Array<{ message?: { content?: string }; finish_reason?: string }>)[0];
  expect(choice?.message?.content).toBe("hello");
  expect(choice?.finish_reason).toBe("stop");
});

test("responsesSseToChatCompletionsSse cancel promptly cancels an idle upstream", async () => {
  const { responsesSseToChatCompletionsSse } = budgetedChatOutbound(await import("../src/chat/outbound"));
  let upstreamCancelled = false;
  // Never-ending upstream: enqueues one partial frame then goes silent.
  const idleUpstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: response.created\n"));
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const stream = responsesSseToChatCompletionsSse(idleUpstream, "mock/test-model");
  const reader = stream.getReader();
  // Simulate client disconnect while the decoder is parked on an idle read().
  const cancelled = reader.cancel("client disconnected").then(() => "cancelled");
  const outcome = await Promise.race([
    cancelled,
    new Promise<string>(resolve => setTimeout(() => resolve("hung"), 2000)),
  ]);
  expect(outcome).toBe("cancelled");
  // Give the abort->reader.cancel microtask a beat to reach the source.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(upstreamCancelled).toBe(true);
});

// --- WP3/030: incomplete error fidelity -------------------------------------

test("stall incomplete becomes an error frame with no [DONE] (WP3)", async () => {
  const frames = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`,
    `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "upstream_stall_timeout" } } })}\n\n`,
  ];
  const { raw, chunks } = await convertResponsesFrames(frames);
  const errorChunk = chunks.find(chunk => (chunk as { error?: unknown }).error !== undefined);
  expect(errorChunk).toBeDefined();
  expect(raw).not.toContain("[DONE]");
  expect(chunks.some(chunk => chunk.choices?.[0]?.finish_reason === "stop")).toBe(false);
});

test("adapter_eof incomplete surfaces the upstream message and no [DONE] (WP3)", async () => {
  const frames = [
    `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "adapter_eof", message: "upstream closed mid-turn" } } })}\n\n`,
  ];
  const { raw, chunks } = await convertResponsesFrames(frames);
  const errorChunk = chunks.find(chunk => (chunk as { error?: { message?: string } }).error !== undefined) as
    { error: { message: string } } | undefined;
  expect(errorChunk?.error.message).toBe("upstream closed mid-turn");
  expect(raw).not.toContain("[DONE]");
});

test("max_output_tokens incomplete still maps to finish_reason length with [DONE] (WP3 pin)", async () => {
  const frames = [
    `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })}\n\n`,
  ];
  const { raw, chunks } = await convertResponsesFrames(frames);
  expect(chunks.some(chunk => chunk.choices?.[0]?.finish_reason === "length")).toBe(true);
  expect(raw).toContain("[DONE]");
});

test("content_filter incomplete still maps to finish_reason content_filter with [DONE] (WP3 pin)", async () => {
  const frames = [
    `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } })}\n\n`,
  ];
  const { raw, chunks } = await convertResponsesFrames(frames);
  expect(chunks.some(chunk => chunk.choices?.[0]?.finish_reason === "content_filter")).toBe(true);
  expect(raw).toContain("[DONE]");
});

test("collectChatCompletion throws ChatCompletionsStreamError on a stall incomplete (WP3)", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion, isChatCompletionsStreamError } =
    budgetedChatOutbound(await import("../src/chat/outbound"));
  const frames = [
    `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "upstream_stall_timeout" } } })}\n\n`,
  ];
  const stream = responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), "gpt-test");
  let caught: unknown;
  try {
    await collectChatCompletion(stream, "gpt-test");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(isChatCompletionsStreamError(caught)).toBe(true);
});

// --- #404: one gateway, two wires. Without a per-model override the provider-wide
// adapter wins and Grok's hosted web_search is dropped before it ever goes out. ----

function dualWireConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "k",
        allowPrivateNetwork: true,
        modelAdapters: { "grok-4.5": "openai-responses" },
      },
    },
  } as OcxConfig;
}

test("an overridden model reaches the responses wire with its hosted tool intact (#404)", async () => {
  const { server: upstream, captured } = mockDualWireUpstream();
  saveConfig(dualWireConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/grok-4.5",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "search please" }] }],
        tools: [{ type: "web_search" }],
      }),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(captured.length).toBe(1);
    // The whole point: this model took the responses wire, not chat completions.
    expect(captured[0]!.pathname).toContain("/responses");
    // And the hosted tool survived — the chat translation would have dropped it.
    expect(JSON.stringify(captured[0]!.body)).toContain("web_search");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("a sibling model on the same provider still takes the chat wire (#404)", async () => {
  const { server: upstream, captured } = mockDualWireUpstream();
  saveConfig(dualWireConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/gemini-3-pro",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(captured.length).toBe(1);
    expect(captured[0]!.pathname).toContain("/chat/completions");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("inbound chat-completions honors the override when stripping sampling (#404)", async () => {
  const { server: upstream, captured } = mockDualWireUpstream();
  saveConfig(dualWireConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/grok-4.5",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
      }),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(captured.length).toBe(1);
    // The inbound path must read the effective adapter, not the provider default.
    expect(captured[0]!.pathname).toContain("/responses");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("/v1/chat/completions non-OK upstream preserves top-level structured cyber_policy type", async () => {
  const secret = `blocked by upstream policy Authorization: ${["Bear", "er"].join("")} chathttpsecret123456`;
  const safeMessage = "blocked by upstream policy Authorization: Bearer [REDACTED]";
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        message: secret,
        type: "server_error",
        code: "cyber_policy",
      }, { status: 400, headers: { "retry-after": "120" } });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "server_error", code: "cyber_policy", message: safeMessage },
    });
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});

test("/v1/chat/completions non-OK upstream preserves structured model_not_found", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      // Generic message would classify to invalid_request_error; structured code must win.
      return Response.json({
        error: {
          message: "Request failed",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      }, { status: 404 });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(404);
    const json = await response.json() as { error?: { code?: string; type?: string; message?: string } };
    expect(json.error).toMatchObject({
      code: "model_not_found",
      type: "invalid_request_error",
      message: "Request failed",
    });
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});

test("/v1/chat/completions status:failed replay normalizes translation_buffer_limit to 502 upstream_error", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        id: "resp_overflow",
        object: "response",
        status: "failed",
        error: {
          message: "upstream translation buffer exceeded the safe limit",
          type: "server_error",
          code: "translation_buffer_limit",
        },
      });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // Provider-controlled overflow is an upstream failure on every path.
    expect(response.status).toBe(502);
    const json = await response.json() as { error?: { code?: string; type?: string } };
    expect(json.error).toMatchObject({ code: "translation_buffer_limit", type: "upstream_error" });
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});

test("/v1/chat/completions status:failed replay preserves structured cyber_policy type", async () => {
  const secret = `blocked by upstream policy Authorization: ${["Bear", "er"].join("")} chatreplaysecret123456`;
  const safeMessage = "blocked by upstream policy Authorization: Bearer [REDACTED]";
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        id: "resp_policy",
        object: "response",
        status: "failed",
        error: {
          message: secret,
          type: "server_error",
          code: "cyber_policy",
        },
      });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "server_error", code: "cyber_policy", message: safeMessage },
    });
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});

test("/v1/chat/completions status:failed replay preserves structured model_not_found", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        id: "resp_fail",
        object: "response",
        status: "failed",
        error: {
          message: "Request failed",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-direct-token"].join(" "),
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(502);
    const json = await response.json() as { error?: { code?: string; type?: string; message?: string } };
    expect(json.error).toMatchObject({
      code: "model_not_found",
      type: "invalid_request_error",
      message: "Request failed",
    });
  } finally {
    await server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});
