import { afterEach, describe, expect, test } from "bun:test";
import {
  chatCompletionsIncompleteOutcome,
  collectChatCompletion,
  responsesJsonToChatCompletion,
  responsesSseToChatCompletionsSse,
} from "../../src/chat/outbound";
import { handleChatCompletions } from "../../src/server/chat-completions";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Volcengine Ark Coding Plan `/responses` ends a capped turn with
// `status: "incomplete", incomplete_details: { reason: "length" }` (not OpenAI's
// `max_output_tokens`). Chat Completions must report that as finish_reason "length", not a 502.

const MODEL = "volcengine-coding-plan/glm-5.3-flash";
const usage = { input_tokens: 12, output_tokens: 16, total_tokens: 28 };

function sseText(events: Array<Record<string, unknown>>): string {
  return events.map(e => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const text = sseText(events);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function lengthTurn(id: string): Array<Record<string, unknown>> {
  return [
    { type: "response.created", response: { id, status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "o" },
    { type: "response.incomplete", response: { id, status: "incomplete", incomplete_details: { reason: "length" }, usage } },
  ];
}

function dataFrames(wire: string): string[] {
  return wire.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6));
}

function finishReasons(wire: string): unknown[] {
  return dataFrames(wire).filter(data => data !== "[DONE]").flatMap(data => {
    const chunk = JSON.parse(data) as { choices?: Array<{ finish_reason?: unknown }>; error?: unknown };
    if (chunk.error !== undefined) return ["<error>"];
    return (chunk.choices ?? []).map(choice => choice.finish_reason).filter(reason => reason != null);
  });
}

describe("Responses incomplete reason \"length\" on Chat Completions", () => {
  test("the outcome is a length finish, not a failure", () => {
    expect(chatCompletionsIncompleteOutcome("length", undefined)).toEqual({ finishReason: "length" });
    expect(chatCompletionsIncompleteOutcome("max_output_tokens", undefined)).toEqual({ finishReason: "length" });
    expect(chatCompletionsIncompleteOutcome("content_filter", undefined)).toEqual({ finishReason: "content_filter" });
  });

  test("proxy-synthesized incompletes still fail", () => {
    for (const reason of ["adapter_eof", "upstream_stall_timeout", "missing_terminal_event", "max_messages", "steered", undefined]) {
      expect("failMessage" in chatCompletionsIncompleteOutcome(reason, undefined)).toBe(true);
    }
  });

  test("streamed SSE wire ends with finish_reason length and [DONE]", async () => {
    const budget = createTestTranslatorBudget();
    const wire = await new Response(responsesSseToChatCompletionsSse(sse(lengthTurn("resp_s")), MODEL, { translatorBudget: budget })).text();
    expect(finishReasons(wire)).toEqual(["length"]);
    expect(dataFrames(wire).at(-1)).toBe("[DONE]");
  });

  test("buffered (stream:false) projection of an SSE turn returns finish_reason length", async () => {
    const budget = createTestTranslatorBudget();
    const chat = responsesSseToChatCompletionsSse(sse(lengthTurn("resp_1")), MODEL, { translatorBudget: budget });
    const completion = await collectChatCompletion(chat, MODEL, budget);
    const choice = (completion.choices as Array<Record<string, unknown>>)[0]!;
    expect(choice.finish_reason).toBe("length");
  });

  test("JSON projection returns finish_reason length", () => {
    const completion = responsesJsonToChatCompletion({
      id: "resp_2", status: "incomplete", incomplete_details: { reason: "length" }, usage,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "o" }] }],
    }, MODEL);
    const choice = (completion.choices as Array<Record<string, unknown>>)[0]!;
    expect(choice.finish_reason).toBe("length");
  });
});

describe("handleChatCompletions with an openai-responses upstream reporting \"length\"", () => {
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let releaseSpendHome: (() => void) | undefined;
  afterEach(async () => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    await upstream?.stop(true);
    upstream = undefined;
  });

  async function dispatch(stream: boolean, reply: () => Response): Promise<Response> {
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: reply });
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-responses", baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true, models: ["model"],
    } } };
    releaseSpendHome ??= acquireOwnedSpendHome();
    return handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/model", stream, max_tokens: 16, messages: [{ role: "user", content: "fixture" }] }),
    }), config, { model: "", provider: "" }, { requestId: `chat-length-${crypto.randomUUID()}`, start: Date.now() });
  }

  const sseReply = () => new Response(sseText(lengthTurn("resp_h")), { headers: { "content-type": "text/event-stream" } });
  const jsonReply = () => Response.json({
    id: "resp_j", status: "incomplete", incomplete_details: { reason: "length" }, usage,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "o" }] }],
  });

  test.each([["SSE", sseReply], ["JSON", jsonReply]] as const)("%s upstream, stream:true client gets a length wire", async (_, reply) => {
    const response = await dispatch(true, reply);
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(finishReasons(wire)).toEqual(["length"]);
    expect(dataFrames(wire).at(-1)).toBe("[DONE]");
  });

  test.each([["SSE", sseReply], ["JSON", jsonReply]] as const)("%s upstream, stream:false client gets a length completion", async (_, reply) => {
    const response = await dispatch(false, reply);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ finish_reason: "length" }] });
  });
});
