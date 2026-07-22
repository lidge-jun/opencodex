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
