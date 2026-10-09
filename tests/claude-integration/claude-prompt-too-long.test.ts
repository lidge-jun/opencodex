/**
 * Oversized-input refusals reach Claude clients in Anthropic's wording, which is what Claude Code
 * keys its reactive compaction on (devlog/_plan/261009_claude_1m_default/010). Local fixtures only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import {
  anthropicErrorBody,
  claudeOverflowSsePayload,
  claudePromptTooLongMessage,
  responsesSseToAnthropicSse,
} from "../../src/claude/outbound";
import { PROVIDER_INPUT_TOO_LARGE_MESSAGE } from "../../src/server/responses/context-overflow";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

/** The parser Claude Code 2.1.288 applies to size the gap (binary function `fdt`). */
const CLAUDE_CODE_GAP_RE = /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i;
/** Claude Code's prompt_too_long classifier (binary function `b4n`). */
const claudeCodeSeesPromptTooLong = (message: string) => {
  const text = message.toLowerCase();
  return text.includes("prompt is too long") || text.includes("input is too long for requested model");
};

function errorMessage(body: Record<string, unknown>): string {
  return (body.error as { message: string }).message;
}

describe("claudePromptTooLongMessage", () => {
  test("prefixes provider wording that Claude Code would not recognize", () => {
    const body = anthropicErrorBody(400, "Your input exceeds the context window", undefined, "context_length_exceeded");
    expect(body).toEqual({ type: "error", error: {
      type: "invalid_request_error",
      message: "prompt is too long: Your input exceeds the context window",
      code: "context_length_exceeded",
    } });
    expect(claudeCodeSeesPromptTooLong(errorMessage(body))).toBe(true);
  });

  test("carries both counts when the upstream states them", () => {
    const message = claudePromptTooLongMessage(
      "This model's maximum context length is 272000 tokens. However, your messages resulted in 301234 tokens.",
    );
    expect(message).toBe("prompt is too long: 301234 tokens > 272000 maximum");
    const gap = CLAUDE_CODE_GAP_RE.exec(message);
    expect(gap?.slice(1, 3)).toEqual(["301234", "272000"]);
  });

  test("never guesses a count the upstream did not state as the request size", () => {
    const message = claudePromptTooLongMessage("maximum context length is 272000 tokens; 3 tokens of overhead");
    expect(message).toBe("prompt is too long: maximum context length is 272000 tokens; 3 tokens of overhead");
    expect(CLAUDE_CODE_GAP_RE.test(message)).toBe(false);
  });

  test("leaves Anthropic wording unchanged", () => {
    for (const text of ["prompt is too long: 1000 tokens > 900 maximum", "Input is too long for requested model."]) {
      expect(claudePromptTooLongMessage(text)).toBe(text);
      expect(errorMessage(anthropicErrorBody(400, text, undefined, "context_length_exceeded"))).toBe(text);
    }
  });

  test("a throughput limit filed under context_length_exceeded keeps its text", () => {
    // The shared classifier's "too many tokens" match also catches token-per-minute limits; worded
    // as an overflow, Claude Code would compact a conversation that only has to wait.
    for (const text of ["too many tokens per minute", "Rate limit reached: too many tokens", "TPM quota exhausted"]) {
      expect(errorMessage(anthropicErrorBody(400, text, undefined, "context_length_exceeded"))).toBe(text);
      const payload = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: text } });
      expect(claudeOverflowSsePayload(payload)).toBe(payload);
    }
  });

  test("other error codes keep their message", () => {
    expect(errorMessage(anthropicErrorBody(429, "context window rate limit", undefined, "rate_limit"))).toBe("context window rate limit");
    expect(errorMessage(anthropicErrorBody(413, "budget", "request_too_large", "translation_buffer_limit"))).toBe("budget");
    expect(errorMessage(anthropicErrorBody(400, "bad request"))).toBe("bad request");
  });
});

describe("claudeOverflowSsePayload", () => {
  test("rewrites an invalid_request_error that refuses an oversized input", () => {
    const payload = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your request exceeded model token limit: 262144" } });
    expect(JSON.parse(claudeOverflowSsePayload(payload))).toEqual({ type: "error", error: {
      type: "invalid_request_error", message: "prompt is too long: Your request exceeded model token limit: 262144",
    } });
  });

  test("keeps a rate limit that mentions the context window and unrelated payloads byte-identical", () => {
    const rateLimit = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "context window quota exhausted" } });
    expect(claudeOverflowSsePayload(rateLimit)).toBe(rateLimit);
    const delta = JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\"error\" context window" } });
    expect(claudeOverflowSsePayload(delta)).toBe(delta);
  });
});

describe("translated Responses stream", () => {
  test("a response.failed context refusal ends in a prompt-too-long error frame", async () => {
    const failed = { type: "response.failed", response: { status: "failed", error: {
      type: "invalid_request_error", code: "context_length_exceeded", message: PROVIDER_INPUT_TOO_LARGE_MESSAGE,
    } } };
    const upstream = `event: response.created\ndata: {"type":"response.created","response":{}}\n\n`
      + `event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`;
    const body = new Response(upstream).body!;
    const text = await new Response(responsesSseToAnthropicSse(body, "m", { translatorBudget: createTestTranslatorBudget() })).text();
    const errorFrame = text.split("\n\n").find(frame => frame.startsWith("event: error"))!;
    const data = JSON.parse(errorFrame.split("\n").find(line => line.startsWith("data:"))!.slice(5));
    expect(data.error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded" });
    expect(claudeCodeSeesPromptTooLong(data.error.message)).toBe(true);
  });
});

describe("translated Responses stream throughput limit", () => {
  test("a response.failed token-per-minute limit is not reworded as an overflow", async () => {
    const failed = { type: "response.failed", response: { status: "failed", error: {
      type: "invalid_request_error", code: "context_length_exceeded", message: "too many tokens per minute",
    } } };
    const body = new Response(`event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`).body!;
    const text = await new Response(responsesSseToAnthropicSse(body, "m", { translatorBudget: createTestTranslatorBudget() })).text();
    expect(text).toContain("too many tokens per minute");
    expect(text).not.toContain("prompt is too long");
  });
});

describe("native Messages lane", () => {
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let releaseSpendHome: (() => void) | undefined;
  let testDir = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-prompt-too-long-"));
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(async () => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    await upstream?.stop(true);
    upstream = undefined;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (testDir) removeTreeWithRetry(testDir);
  });

  /** A configured Messages provider (not an Anthropic pool) on the managed native lane. */
  function nativeConfig(reply: (stream: boolean) => Response): OcxConfig {
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const body = await req.json() as { stream?: boolean };
      return reply(body.stream === true);
    } });
    releaseSpendHome ??= acquireOwnedSpendHome();
    const config = {
      port: 0,
      defaultProvider: "custom",
      providers: { custom: {
        adapter: "anthropic",
        baseUrl: `http://127.0.0.1:${upstream.port}`,
        authMode: "key",
        apiKey: "fixture-key-alpha",
        allowPrivateNetwork: true,
        models: ["long-model"],
      } },
      protocols: { rollout: { managedMessagesNative: true } },
    } as OcxConfig;
    saveConfig(config);
    return config;
  }

  async function send(config: OcxConfig, stream: boolean) {
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "custom/long-model", max_tokens: 32, stream, messages: [{ role: "user", content: "fixture" }] }),
    });
    const response = await handleClaudeMessages(request, config, { model: "", provider: "" },
      { requestId: `ptl-${crypto.randomUUID()}`, start: Date.now() });
    return { response, text: await response.text() };
  }

  const refusal = (message: string, status: number, extra: Record<string, unknown> = {}) => () =>
    Response.json({ type: "error", error: { type: "invalid_request_error", message, ...extra } }, { status });

  test("HTTP 400 in a provider's own wording is rewritten, status and shape kept", async () => {
    const { response, text } = await send(nativeConfig(refusal("Your request exceeded model token limit: 262144", 400)), false);
    expect(response.status).toBe(400);
    const body = JSON.parse(text);
    expect(body).toEqual({ type: "error", error: {
      type: "invalid_request_error", message: "prompt is too long: Your request exceeded model token limit: 262144",
    } });
  });

  test("HTTP 413 and an upstream context_length_exceeded code are both recognized", async () => {
    const large = await send(nativeConfig(refusal("model token limit reached", 413)), false);
    expect(large.response.status).toBe(413);
    expect(claudeCodeSeesPromptTooLong(JSON.parse(large.text).error.message)).toBe(true);
    await upstream?.stop(true);
    const coded = await send(nativeConfig(refusal("unfamiliar wording", 400, { code: "context_length_exceeded" })), false);
    expect(JSON.parse(coded.text).error.message).toBe("prompt is too long: unfamiliar wording");
  });

  test("HTTP 429 that mentions tokens is not treated as an overflow", async () => {
    const { response, text } = await send(nativeConfig(() => Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "too many tokens per minute" } }, { status: 429 })), false);
    expect(response.status).toBe(429);
    expect(JSON.parse(text).error.message).not.toContain("prompt is too long");
  });

  const overflowFrame = `event: error\ndata: ${JSON.stringify({ type: "error", error: {
    type: "invalid_request_error", message: "Your request exceeded model token limit: 262144",
  } })}\n\n`;
  const sseReply = () => new Response(overflowFrame, { headers: { "content-type": "text/event-stream" } });

  test("a streamed overflow error frame is rewritten for a streaming caller", async () => {
    const { response, text } = await send(nativeConfig(sseReply), true);
    expect(response.status).toBe(200);
    const data = JSON.parse(text.split("\n").find(line => line.startsWith("data:"))!.slice(5));
    expect(data.error.message).toBe("prompt is too long: Your request exceeded model token limit: 262144");
  });

  test("stall detection still times raw upstream bytes, not whole rewritten frames", async () => {
    // One large delta frame arrives in fragments over ~1.6s with a 1s stall limit. Each fragment
    // must reset the deadline; a frame-buffering rewrite placed before the tap would not.
    const encoder = new TextEncoder();
    const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: {
      id: "msg_f", type: "message", role: "assistant", model: "long-model", content: [], stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`;
    const delta = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "x".repeat(64) } })}\n\n`;
    const stop = `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const config = nativeConfig(() => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(start));
        const pieces = delta.match(/[\s\S]{1,40}/g)!;
        for (const piece of pieces) {
          await Bun.sleep(1_600 / pieces.length);
          controller.enqueue(encoder.encode(piece));
        }
        controller.enqueue(encoder.encode(stop));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    config.claudeCode = { bodyStallSec: 1 } as OcxConfig["claudeCode"];
    saveConfig(config);
    const { response, text } = await send(config, true);
    expect(response.status).toBe(200);
    expect(text).toContain("x".repeat(64));
    expect(text).toContain("message_stop");
    expect(text).not.toContain("event: error");
  });

  test("a streamed overflow folded for a non-streaming caller answers 400", async () => {
    const config = nativeConfig(sseReply);
    const { response, text } = await send(config, false);
    expect(response.status).toBe(400);
    expect(JSON.parse(text).error).toMatchObject({
      type: "invalid_request_error", message: "prompt is too long: Your request exceeded model token limit: 262144",
    });
  });
});
