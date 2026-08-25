import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const config = {
  port: 0,
  defaultProvider: "claude-se",
  providers: {
    "claude-se": {
      adapter: "anthropic",
      baseUrl: "https://example.test",
      apiKey: "sk-test",
    },
  },
} as unknown as OcxConfig;

/** Build an Anthropic SSE response from raw frames. */
function anthropicSse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const firstTurn = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我接下来会修改相关文件。"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const continuationTurn = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"exec_command","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

/** Build an OpenAI Chat Completions SSE response from raw frames. */
function chatSse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// A clean end-of-turn with only assistant text and no tool call — the suspicious
// no-tool completion the guard is meant to re-ask (mirrors firstTurn for openai-chat).
const chatFirstTurn = [
  'data: {"choices":[{"delta":{"content":"我接下来会修改相关文件。"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
].join("");

// The continuation turn emits the tool call the model should have produced.
const chatContinuationTurn = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":""}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
].join("");

function openAiChatConfig(terminalContinuationGuard?: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: "glm-gw",
    providers: {
      "glm-gw": {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "key",
        defaultModel: "glm-5.2",
        models: ["glm-5.2"],
        ...(terminalContinuationGuard !== undefined ? { terminalContinuationGuard } : {}),
      },
    },
  } as unknown as OcxConfig;
}

describe("server terminal guard integration", () => {
  let originalFetch: typeof fetch;
  let calls: number;
  let requestBodies: Record<string, unknown>[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = 0;
    requestBodies = [];
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return anthropicSse(calls === 1 ? firstTurn : continuationTurn);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("re-asks Claude once inside the same Responses turn and forwards the tool call", async () => {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), config, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(text).toContain("response.completed");
    expect(text).toContain("exec_command");
    const messages = requestBodies[1]?.messages as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.content?.[0]?.text).toContain("你刚才只描述了计划");
  });

  test("terminal-guard continuation 429 replays on the same key before surfacing", async () => {
    const retryConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    const requestBodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      sends += 1;
      requestBodies.push(String(init?.body ?? ""));
      if (sends === 2) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return anthropicSse(sends === 1 ? firstTurn : continuationTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), retryConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    // initial turn + 429 continuation + replayed continuation
    expect(sends).toBe(3);
    expect(text).toContain("response.completed");
    expect(text).toContain("exec_command");
    // The 429 continuation (send 2) and its same-key replay (send 3) must be byte-identical.
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[1]).toBe(requestBodies[2]);
  });

  test("terminal-guard continuation retry budget stays per request across key failover", async () => {
    const budgetConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          apiKeyPool: [
            { id: "k1", key: "sk-test", addedAt: 1 },
            { id: "k2", key: "sk-test-2", addedAt: 2 },
          ],
          retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async (_input, init) => {
      sends += 1;
      if (sends === 1) {
        return anthropicSse(firstTurn);
      }
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), budgetConfig, { model: "", provider: "" });

    await response.text();
    // initial turn + continuation retry (same key) + failover continuation (second key) = 4.
    // A per-iteration budget would replay on the second key too (5+ sends).
    expect(sends).toBe(4);
  });

  test("terminal-guard continuation shares the request-wide 429 budget with the main loop", async () => {
    const budgetConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) {
        // The main recovery loop consumes the only same-key replay...
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      if (sends === 2) {
        // ...the replay succeeds and the terminal-guard continuation starts.
        return anthropicSse(firstTurn);
      }
      // Continuation 429 with the request budget already spent: surfaces, never replays.
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), budgetConfig, { model: "", provider: "" });

    const text = await response.text();
    // main 429 -> same-key replay -> continuation 429 (no budget left) = exactly 3 sends.
    expect(sends).toBe(3);
    expect(text).toContain("Provider continuation error 429");
  });

  test("terminal-guard continuation preserves structured cyber_policy semantics", async () => {
    const secret = `OpenAI flagged this request for potential high-risk cybersecurity activity. Authorization: ${["Bear", "er"].join("")} continuationsecret123456`;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) return anthropicSse(firstTurn);
      return Response.json({
        error: {
          message: secret,
          type: "server_error",
          code: "cyber_policy",
        },
      }, { status: 400, headers: { "retry-after": "120" } });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), config, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(sends).toBe(2);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).toContain('"type":"server_error"');
    expect(text).toContain('"code":"cyber_policy"');
    expect(text).toContain("Authorization: Bearer [REDACTED]");
    expect(text).not.toContain("continuationsecret123456");
    expect(text).not.toContain("Provider continuation error 400");
  });

  test("terminal-guard continuation abort during the 429 wait yields 499 without replaying", async () => {
    const abortConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 3, intervalMs: 30_000, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) {
        return anthropicSse(firstTurn);
      }
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const abort = new AbortController();
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), abortConfig, { model: "", provider: "" }, { abortSignal: abort.signal });

    // The terminal-guard continuation runs inside the SSE producer, so consume the body to
    // drive it, then wait until the continuation's 429 lands and its retry sleep is running.
    const response = await pending;
    const textPromise = response.text();
    for (let i = 0; i < 100 && sends < 2; i += 1) await Bun.sleep(10);
    expect(sends).toBe(2);
    abort.abort(new DOMException("client disconnected", "AbortError"));
    const text = await textPromise;
    expect(text).toContain("client closed request during terminal continuation");
    expect(sends).toBe(2);
  });

  test("terminal-guard 429 wait longer than the stall budget still succeeds (heartbeats)", async () => {
    const stallConfig = {
      ...config,
      stallTimeoutSec: 1,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 1, intervalMs: 1_500, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) {
        return anthropicSse(firstTurn);
      }
      if (sends === 2) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return anthropicSse(continuationTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), stallConfig, { model: "", provider: "" });

    const text = await response.text();
    // A 1.5s continuation backoff under a 1s stall budget must not trip upstream_stall_timeout:
    // the wait yields heartbeat events, the replay lands, and the turn completes.
    expect(sends).toBe(3);
    expect(text).toContain("response.completed");
    expect(text).not.toContain("upstream_stall_timeout");
  }, 5_000);

  test("openai-chat provider without terminalContinuationGuard does not re-ask", async () => {
    const chatConfig = openAiChatConfig();
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return chatSse(chatFirstTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-gw/glm-5.2",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), chatConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    // Guard is opt-in for openai-chat: no continuation, so exactly one upstream call.
    expect(sends).toBe(1);
    expect(text).toContain("response.completed");
  });

  test("openai-chat provider with terminalContinuationGuard false does not re-ask", async () => {
    const chatConfig = openAiChatConfig(false);
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return chatSse(chatFirstTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-gw/glm-5.2",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), chatConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
    expect(text).toContain("response.completed");
  });

  test("openai-chat provider with terminalContinuationGuard re-asks once and forwards the tool call", async () => {
    const chatConfig = openAiChatConfig(true);
    let sends = 0;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      sends += 1;
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return chatSse(sends === 1 ? chatFirstTurn : chatContinuationTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-gw/glm-5.2",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), chatConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    // Opted-in openai-chat provider: one bounded continuation, so two upstream calls.
    expect(sends).toBe(2);
    expect(text).toContain("response.completed");
    expect(text).toContain("exec_command");
    const messages = bodies[1]?.messages as Array<{ role?: string; content?: unknown }>;
    expect(messages.some(m => m.role === "developer" || m.role === "system")).toBe(true);
  });

  test("combo attempts do not run an opted-in openai-chat terminal guard", async () => {
    const comboConfig = {
      ...openAiChatConfig(true),
      combos: {
        guarded: {
          strategy: "failover",
          targets: [{ provider: "glm-gw", model: "glm-5.2" }],
        },
      },
    } as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return chatSse(chatFirstTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/guarded",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), comboConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
    expect(text).toContain("response.completed");
  });

  test("routed compaction does not run an opted-in openai-chat terminal guard", async () => {
    const chatConfig = openAiChatConfig(true);
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return chatSse(chatFirstTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-gw/glm-5.2",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
          { type: "compaction_trigger" },
        ],
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), chatConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
    expect(text).toContain('"type":"compaction"');
    expect(text).toContain("response.completed");
  });

});
