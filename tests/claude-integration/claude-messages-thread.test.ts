import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-thread-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-thread-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function mockChatUpstream() {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push(await req.json() as Record<string, unknown>);
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

function routedConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl, apiKey: "k", allowPrivateNetwork: true } },
  } as OcxConfig;
}

const headers = {
  "content-type": "application/json",
  "x-api-key": "placeholder",
  "anthropic-beta": "message-threads-2026-08-12",
};

// Turn 2 of a Claude Code subagent as the message-threads beta sends it: only the delta after
// the anchor, with system and tools left to the server-side thread.
const continueTurn = {
  model: "mock/test-model",
  max_tokens: 64,
  thread: { type: "continue", previous_message_id: "msg_turn_one" },
  messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }] }],
};

// The stateless resend Claude Code makes after the unsupported error.
const statelessTurn = {
  model: "mock/test-model",
  max_tokens: 64,
  system: [{ type: "text", text: "You are a subagent." }],
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: "Read the file and report the secret word." },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }] },
  ],
};

test("a translated route refuses message threads with Claude Code's unsupported code before inference", async () => {
  const upstream = mockChatUpstream();
  saveConfig(routedConfig(new URL("/v1", upstream.server.url).href));
  const server = startServer(0);
  try {
    clearRequestLogsForTests();
    for (const [index, thread] of [
      { type: "continue", previous_message_id: "msg_turn_one" },
      { type: "create" },
    ].entries()) {
      const response = await fetch(new URL("/v1/messages?beta=true", server.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ ...continueTurn, stream: index === 0, thread }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "message threads are not supported on translated routes",
          details: { error_code: "thread_unsupported_request" },
        },
      });
      expect(getRequestLogEntries().at(-1)?.errorCode).toBe("claude_thread_unsupported");
    }
    expect(upstream.captured).toHaveLength(0);

    // A thread delta would undercount, so count_tokens refuses it the same way.
    const counted = await fetch(new URL("/v1/messages/count_tokens?beta=true", server.url), {
      method: "POST",
      headers,
      body: JSON.stringify(continueTurn),
    });
    expect(counted.status).toBe(400);
    expect(await counted.json()).toMatchObject({ error: { details: { error_code: "thread_unsupported_request" } } });

    const resent = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers,
      body: JSON.stringify(statelessTurn),
    });
    expect(resent.status).toBe(200);
    await resent.text();
    expect(upstream.captured).toHaveLength(1);
    const sent = JSON.stringify(upstream.captured[0]);
    expect(sent).toContain("You are a subagent.");
    expect(sent).toContain("Read the file and report the secret word.");
  } finally {
    await server.stop(true);
    upstream.server.stop(true);
  }
});

test("native Anthropic passthrough still forwards the thread unchanged", async () => {
  let captured: Record<string, unknown> | null = null;
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured = await req.json() as Record<string, unknown>;
      return Response.json({
        id: "msg_turn_two",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  saveConfig({
    ...routedConfig("http://127.0.0.1:1/v1"),
    claudeCode: { anthropicBaseUrl: upstream.url.toString().replace(/\/$/, "") },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { ...headers, "x-api-key": "sk-ant-test" },
      body: JSON.stringify({ ...continueTurn, model: "claude-haiku-4-5" }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toMatchObject({ thread: { type: "continue", previous_message_id: "msg_turn_one" } });
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});
