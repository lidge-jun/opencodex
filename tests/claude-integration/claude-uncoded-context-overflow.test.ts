/**
 * #8127: a Responses upstream can refuse an oversized input without the context_length_exceeded
 * code ("Your input exceeds the context window of this model"). On the translated Messages lane
 * that reached Claude Code as a retryable 502, so it retried instead of compacting.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicFailedStatus, isContextOverflowError, responsesSseToAnthropicSse } from "../../src/claude/outbound";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const OVERFLOW = "Your input exceeds the context window of this model. Please adjust your input and try again.";
const seesPromptTooLong = (message: string) => message.toLowerCase().includes("prompt is too long");
const previousFetch = globalThis.fetch;
let previousHome: string | undefined;
let home = "";
let releaseSpend: (() => void) | undefined;

beforeAll(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-uncoded-overflow-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
});
afterAll(() => {
  releaseSpend?.();
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("isContextOverflowError", () => {
  test.each([
    [{ code: "context_length_exceeded" }, "unfamiliar wording", true],
    [{}, OVERFLOW, true],
    [{ code: null, type: "server_error" }, OVERFLOW, true],
    [{ code: "server_error" }, OVERFLOW, true],
    [{}, "too many tokens per minute", false],
    [{ type: "rate_limit_error" }, "context window quota exhausted", false],
    [{ type: "authentication_error" }, OVERFLOW, false],
    [{ code: "invalid_prompt" }, OVERFLOW, false],
    [{}, "connection reset by peer", false],
    [{ type: "server_error" }, "Failed to load model context window configuration", false],
    [{}, "invalid field 'context_window': expected an integer, see maximum context docs", false],
    [{}, "This model's maximum context length is 272000 tokens. However, your messages resulted in 301234 tokens.", true],
    [{}, "Your request exceeded model token limit: 262144", true],
    [{}, "prompt is too long: 301234 tokens > 272000 maximum", true],
    [{}, "Your input's size exceeds the model's context window", true],
    [{}, "Maximum context length is 128000 tokens. You requested 10 tokens, but max_tokens must be at least 16.", false],
    [{}, "Your input does not exceed the context window; the service is unavailable", false],
    [{}, "Your request doesn\u2019t exceed the token limit; retry later", false],
    [{}, "Invalid tool name: \u2018prompt is too long\u2019", false],
    [{}, "Invalid value: \u201cinput exceeds the context window\u201d is not an allowed enum", false],
    [{}, "Your input is exceeding the context window", true],
    [{}, "The prompt is too long? No, the upstream service is unavailable", false],
    [{}, "if the prompt is too long, shorten it", false],
    [{}, "Your request exceeds neither the context window nor the token limit; the service is temporarily unavailable", false],
    [{}, "Invalid max_tokens: must be positive. The maximum context length is 128000 tokens.", false],
    [{}, "Invalid tool name: 'prompt is too long'", false],
    [{}, "Invalid value for 'input': \"input exceeds the context window\" is not an allowed enum", false],
    [{ type: "server_error", status: 429 }, OVERFLOW, false],
    [{ status: 401 }, OVERFLOW, false],
    [{ status: 403 }, OVERFLOW, false],
    [{ code: "context_length_exceeded", status: 500 }, "unfamiliar wording", true],
  ] as const)("%j %s -> %s", (error, message, expected) => {
    expect(isContextOverflowError(error, message)).toBe(expected);
  });

  test("a status-less uncoded overflow maps to 400; a reset keeps its 5xx", () => {
    expect(anthropicFailedStatus({ message: OVERFLOW }, OVERFLOW)).toBe(400);
    expect(anthropicFailedStatus({ type: "server_error", status: 500 }, OVERFLOW)).toBe(400);
    expect(anthropicFailedStatus({ status: 502 }, "connection reset by peer")).toBe(502);
  });
});

async function translatedErrorFrame(error: Record<string, unknown>) {
  const failed = { type: "response.failed", response: { status: "failed", error } };
  const body = new Response(`event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`).body!;
  const text = await new Response(responsesSseToAnthropicSse(body, "m", { translatorBudget: createTestTranslatorBudget() })).text();
  const frame = text.split("\n\n").find(part => part.startsWith("event: error"))!;
  return JSON.parse(frame.split("\n").find(line => line.startsWith("data:"))!.slice(5)).error as Record<string, unknown>;
}

describe("translated Responses stream", () => {
  test.each([{ message: OVERFLOW }, { type: "server_error", code: "server_error", message: OVERFLOW }])(
    "an uncoded or server_error overflow ends in a prompt-too-long 400 frame: %j", async error => {
      const frame = await translatedErrorFrame(error);
      expect(frame).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded" });
      expect(seesPromptTooLong(String(frame.message))).toBe(true);
    });

  test("a throughput limit and a reset keep their own classification", async () => {
    const limit = await translatedErrorFrame({ message: "too many tokens per minute" });
    expect(limit.type).not.toBe("invalid_request_error");
    expect(String(limit.message)).not.toContain("prompt is too long");
    const reset = await translatedErrorFrame({ message: "connection reset by peer" });
    expect(reset.type).toBe("overloaded_error");
  });

  test("a streamed overflow carrying a rate-limit or credential status is not an overflow", async () => {
    for (const status of [429, 401]) {
      const frame = await translatedErrorFrame({ type: "server_error", status, message: OVERFLOW });
      expect(frame.code).not.toBe("context_length_exceeded");
      expect(String(frame.message)).not.toContain("prompt is too long");
    }
  });

  test("a configuration failure that mentions the context window keeps its 5xx class", async () => {
    const frame = await translatedErrorFrame({ type: "server_error", message: "Failed to load model context window configuration" });
    expect(frame.type).toBe("overloaded_error");
  });
});

describe("translated Messages route end to end", () => {
  const provider = { adapter: "openai-responses", authMode: "key", baseUrl: "https://responses.example/v1", apiKey: "key-a", models: ["m"] } as OcxProviderConfig;
  const config = { defaultProvider: "a", providers: { a: provider } } as OcxConfig;

  async function send(upstream: () => Response, stream = false) {
    globalThis.fetch = (async () => upstream()) as unknown as typeof fetch;
    try {
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", max_tokens: 32, stream, messages: [{ role: "user", content: "fixture" }] }),
      }), config, { model: "", provider: "" });
      return { response, text: await response.text() };
    } finally { globalThis.fetch = previousFetch; }
  }

  test.each([400, 500])("an uncoded HTTP %i overflow answers 400 prompt is too long", async status => {
    const { response, text } = await send(() => Response.json({ error: { type: "server_error", message: OVERFLOW } }, { status }));
    expect(response.status).toBe(400);
    const error = JSON.parse(text).error;
    expect(error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded" });
    expect(seesPromptTooLong(error.message)).toBe(true);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test("a 429 that mentions the context window stays a rate limit", async () => {
    const { response, text } = await send(() => Response.json({ error: { type: "rate_limit_error", message: "context window quota exhausted" } }, { status: 429 }));
    expect(response.status).toBe(429);
    expect(JSON.parse(text).error.message).not.toContain("prompt is too long");
  });

  test("a failed JSON body with an uncoded overflow answers 400", async () => {
    const { response, text } = await send(() => Response.json({ id: "resp_x", object: "response", status: "failed", output: [], error: { message: OVERFLOW } }));
    expect(response.status).toBe(400);
    expect(seesPromptTooLong(JSON.parse(text).error.message)).toBe(true);
  });

  test("a failed JSON body with a non-string message answers the generic 502 instead of throwing", async () => {
    const { response } = await send(() => Response.json({ id: "resp_y", object: "response", status: "failed", output: [], error: { message: 42 } }));
    expect(response.status).toBe(502);
  });
});
