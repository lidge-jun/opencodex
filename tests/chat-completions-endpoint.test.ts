import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { chatCompletionsToResponsesBody, ChatCompletionsRequestError } from "../src/chat/inbound";
import { chatCompletionsUsage } from "../src/chat/outbound";

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

function mockConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl, apiKey: "k", allowPrivateNetwork: true },
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
  const { responsesSseToChatCompletionsSse } = await import("../src/chat/outbound");
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
  expect(body.reasoning).toEqual({ effort: "high" });
  expect(body.tool_choice).toBe("auto");
  expect(Array.isArray(body.tools)).toBe(true);
  expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "function", name: "lookup" });
  const input = body.input as Array<Record<string, unknown>>;
  expect(input.some(i => i.type === "message" && i.role === "user")).toBe(true);
  expect(input.some(i => i.type === "function_call" && i.call_id === "call_1")).toBe(true);
  expect(input.some(i => i.type === "function_call_output" && i.call_id === "call_1")).toBe(true);
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
  // grok-build's strict Responses decoder dies on unknown variants (response.heartbeat),
  // which is why the injected Grok config pins api_backend = "chat_completions". This
  // regression pins the safety property: heartbeats never surface as raw frames here —
  // at most a valid role chunk is emitted.
  const { responsesSseToChatCompletionsSse } = await import("../src/chat/outbound");
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
    server.stop(true);
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
    server.stop(true);
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
    server.stop(true);
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
    server.stop(true);
    upstream.stop(true);
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
  const { responsesSseToChatCompletionsSse } = await import("../src/chat/outbound");
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
  const { responsesSseToChatCompletionsSse } = await import("../src/chat/outbound");
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

test("POST /v1/chat/completions rejects response_format for routed openai-chat", async () => {
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
        response_format: { type: "json_object" },
      }),
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { message: string; type: string } };
    expect(json.error.message).toContain("response_format");
    expect(json.error.type).toBe("invalid_request_error");
  } finally {
    server.stop(true);
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
    server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});

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
    server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
    clearRequestLogsForTests();
  }
});


test("responsesSseToChatCompletionsSse reconciles done-frame final arguments (last-write-wins)", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion } = await import("../src/chat/outbound");
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
  const { responsesSseToChatCompletionsSse, collectChatCompletion, ChatCompletionsStreamError } = await import("../src/chat/outbound");
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

test("responsesSseToChatCompletionsSse emits error frame on truncated stream", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion, ChatCompletionsStreamError } = await import("../src/chat/outbound");
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
    server.stop(true);
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
    server.stop(true);
    upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
});


test("responsesSseToChatCompletionsSse emits one complete named tool call", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion } = await import("../src/chat/outbound");
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
  // Simulate replace-style client history: a later assistant tool_call has id+args but empty name,
  // while an earlier function_call in the same transcript already named it.
  // Our translator processes messages in order; recovery looks at previously emitted function_calls.
  // First push a prior named call via a previous assistant message, then a nameless replay.
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
        // Client lost the name on a re-serialized tool_call with same id (should still recover if same turn
        // already registered the name earlier in the same tool_calls array / prior items).
        tool_calls: [
          { id: "call_b", type: "function", function: { name: "exec_command", arguments: '{"cmd":"pwd"}' } },
          { id: "call_b", type: "function", function: { arguments: '{"cmd":"pwd"}' } },
        ],
      },
    ],
  });
  const calls = (body.input as Array<Record<string, unknown>>).filter(i => i.type === "function_call");
  expect(calls.some(c => c.call_id === "call_b" && c.name === "exec_command")).toBe(true);
});

// Local-stack fixup regressions (Sol audit of #279, devlog 100_merge_records.md WP5):
// CRLF framing and a terminal event without a trailing blank line must not be reported
// as truncation now that the shared SSE decoder drives the converter.
test("responsesSseToChatCompletionsSse accepts CRLF-framed SSE with terminal event at EOF", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion } = await import("../src/chat/outbound");
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
  const { responsesSseToChatCompletionsSse } = await import("../src/chat/outbound");
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
    await import("../src/chat/outbound");
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
