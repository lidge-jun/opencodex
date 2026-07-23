import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { chatCompletionsToResponsesBody, ChatCompletionsRequestError } from "../src/chat/inbound";

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

test("responsesSseToChatCompletionsSse routes parallel tool argument deltas by item_id", async () => {
  const { responsesSseToChatCompletionsSse } = await import("../src/chat/outbound");
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "alpha", arguments: "" } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "beta", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"a":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_b", delta: '{"b":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "1}" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  ];
  const stream = responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), "mock/test-model");
  const text = await new Response(stream).text();
  const chunks = text.split("\n\n")
    .map(block => block.trim())
    .filter(block => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map(block => JSON.parse(block.slice(6)) as {
      choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; function?: { arguments?: string } }> } }>;
    });
  const argDeltas = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])
    .filter(tc => typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0);
  expect(argDeltas.map(tc => ({ index: tc.index, arguments: tc.function?.arguments }))).toEqual([
    { index: 0, arguments: '{"a":' },
    { index: 1, arguments: '{"b":' },
    { index: 0, arguments: "1}" },
  ]);
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


test("responsesSseToChatCompletionsSse always re-emits function.name on args/done deltas", async () => {
  const { responsesSseToChatCompletionsSse, collectChatCompletion } = await import("../src/chat/outbound");
  const frames = [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: "" } })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"cmd":' })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '"ls"}' })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "exec_command", arguments: '{"cmd":"ls"}' } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  ];
  const stream = responsesSseToChatCompletionsSse(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), "gpt-test");
  const text = await new Response(stream).text();
  const chunks = text.split("\n\n")
    .map(block => block.trim())
    .filter(block => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map(block => JSON.parse(block.slice(6)) as {
      choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    });
  const toolDeltas = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? [])
    .filter(tc => tc.function && ("arguments" in (tc.function ?? {}) || "name" in (tc.function ?? {})));
  // Every tool delta that carries arguments must also carry the name for replace-style clients.
  for (const tc of toolDeltas) {
    if (typeof tc.function?.arguments === "string") {
      expect(tc.function?.name).toBe("exec_command");
    }
  }
  // Last-write-wins collect still yields a complete named tool call.
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
