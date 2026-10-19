import { describe, expect, test } from "bun:test";
import {
  chatCompletionsIncompleteOutcome,
  collectChatCompletion,
  responsesJsonToChatCompletion,
  responsesSseToChatCompletionsSse,
} from "../../src/chat/outbound";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Volcengine Ark Coding Plan `/responses` ends a capped turn with
// `status: "incomplete", incomplete_details: { reason: "length" }` (not OpenAI's
// `max_output_tokens`). Chat Completions must report that as finish_reason "length", not a 502.

function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const usage = { input_tokens: 12, output_tokens: 16, total_tokens: 28 };

describe("Responses incomplete reason \"length\" on Chat Completions", () => {
  test("the outcome is a length finish, not a failure", () => {
    expect(chatCompletionsIncompleteOutcome("length", undefined)).toEqual({ finishReason: "length" });
    expect(chatCompletionsIncompleteOutcome("max_output_tokens", undefined)).toEqual({ finishReason: "length" });
    expect(chatCompletionsIncompleteOutcome("content_filter", undefined)).toEqual({ finishReason: "content_filter" });
  });

  test("proxy-synthesized incompletes still fail", () => {
    for (const reason of ["adapter_eof", "upstream_stall_timeout", "missing_terminal_event", undefined]) {
      expect("failMessage" in chatCompletionsIncompleteOutcome(reason, undefined)).toBe(true);
    }
  });

  test("buffered (stream:false) projection of an SSE turn returns finish_reason length", async () => {
    const budget = createTestTranslatorBudget();
    const response = { id: "resp_1", status: "incomplete", incomplete_details: { reason: "length" }, usage };
    const chat = responsesSseToChatCompletionsSse(sse([
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "o" },
      { type: "response.incomplete", response },
    ]), "volcengine-coding-plan/glm-5.3-flash", { translatorBudget: budget });
    const completion = await collectChatCompletion(chat, "volcengine-coding-plan/glm-5.3-flash", budget);
    const choice = (completion.choices as Array<Record<string, unknown>>)[0]!;
    expect(choice.finish_reason).toBe("length");
  });

  test("JSON projection returns finish_reason length", () => {
    const completion = responsesJsonToChatCompletion({
      id: "resp_2", status: "incomplete", incomplete_details: { reason: "length" }, usage,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "o" }] }],
    }, "volcengine-coding-plan/glm-5.3-flash");
    const choice = (completion.choices as Array<Record<string, unknown>>)[0]!;
    expect(choice.finish_reason).toBe("length");
  });
});
