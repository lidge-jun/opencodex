/**
 * Audit F6 (2026-09-14): the translated Chat path dropped an assistant turn's
 * `reasoning_content`/`reasoning_details` and never carried the sampling penalties.
 *
 * Both are asymmetries rather than missing features. The outbound direction already
 * reconstructs reasoning for `preserveReasoningContentModels`
 * (src/adapters/openai-chat.ts), so a client replaying a turn sends it back and the
 * proxy threw it away. And `presence_penalty`/`frequency_penalty` are accepted by
 * responsesRequestSchema, parsed into options, and written back to the wire by the
 * openai-chat adapter — only this first link was missing.
 *
 * Safety boundary asserted here: a synthesized reasoning item carries representable
 * plaintext only. No signature, encrypted payload or provider item id is forged, and
 * the Anthropic adapter's signature filter rejects anything this path could produce.
 */
import { describe, expect, test } from "bun:test";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { sanitizeReasoningInputContent } from "../../src/adapters/openai-responses";
import { responsesRequestSchema } from "../../src/responses/schema";

type Item = Record<string, unknown>;

function body(messages: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return chatCompletionsToResponsesBody({ model: "m", messages, ...extra });
}

function items(out: Record<string, unknown>): Item[] {
  return out.input as Item[];
}

const USER = { role: "user", content: "question" };

describe("F6 assistant reasoning survives translation", () => {
  test("a reasoning_content string becomes a reasoning item before its assistant message", () => {
    const out = items(body([USER, { role: "assistant", content: "answer", reasoning_content: "prior analysis" }]));
    const idx = out.findIndex(i => i.type === "reasoning");

    expect(idx).toBeGreaterThanOrEqual(0);
    expect(out[idx]!.content).toEqual([{ type: "reasoning_text", text: "prior analysis" }]);
    // Adjacency matters: the parser prepends a buffered reasoning item to the NEXT
    // assistant message, so it must sit immediately before it.
    expect(out[idx + 1]).toMatchObject({ type: "message", role: "assistant" });
  });

  // Regression: a Pi/Aside chat replay reached a Responses backend as
  // `{ type: "reasoning", content: [...] }` with no `summary`, and the upstream refused the
  // whole request with `Missing required parameter: 'input[2].summary'`. The field is optional
  // in responsesRequestSchema, so only the live call failed.
  test("the synthesized reasoning item carries the summary the Responses API requires", () => {
    const item = items(body([USER, { role: "assistant", content: "a", reasoning_content: "prior analysis" }]))
      .find(i => i.type === "reasoning")!;

    expect(item.summary).toEqual([{ type: "summary_text", text: "prior analysis" }]);
  });

  // sanitizeReasoningInputContent blanks `content` on every destination that does not opt into
  // plaintext replay, so the summary is what actually reaches a native backend.
  test("the replayed thinking survives reasoning-content sanitization", () => {
    const sanitized = sanitizeReasoningInputContent(
      body([USER, { role: "assistant", content: "a", reasoning_content: "prior analysis" }]),
    ) as Record<string, unknown>;
    const item = (sanitized.input as Item[]).find(i => i.type === "reasoning")!;

    expect(item.content).toEqual([]);
    expect(item.summary).toEqual([{ type: "summary_text", text: "prior analysis" }]);
  });

  test("reasoning_details segments are joined in order", () => {
    const out = items(body([USER, {
      role: "assistant",
      content: "answer",
      reasoning_details: [
        { type: "reasoning.text", text: "first " },
        { type: "reasoning.text", text: "second" },
      ],
    }]));

    expect(out.find(i => i.type === "reasoning")!.content).toEqual([{ type: "reasoning_text", text: "first second" }]);
  });

  test("no signature, encrypted payload or item id is forged", () => {
    const item = items(body([USER, { role: "assistant", content: "a", reasoning_content: "t" }])).find(i => i.type === "reasoning")!;

    expect(item.signature).toBeUndefined();
    expect(item.encrypted_content).toBeUndefined();
    expect(item.id).toBeUndefined();
  });

  test("reasoning is carried for a tool-calling assistant turn too", () => {
    const out = items(body([USER, {
      role: "assistant",
      reasoning_content: "deciding",
      tool_calls: [{ id: "call1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    }]));

    expect(out.some(i => i.type === "reasoning")).toBe(true);
    expect(out.some(i => i.type === "function_call")).toBe(true);
  });

  test("an assistant turn with no reasoning produces no reasoning item", () => {
    expect(items(body([USER, { role: "assistant", content: "answer" }])).some(i => i.type === "reasoning")).toBe(false);
  });

  test("empty reasoning is treated as absent rather than an empty item", () => {
    expect(items(body([USER, { role: "assistant", content: "a", reasoning_content: "" }])).some(i => i.type === "reasoning")).toBe(false);
    expect(items(body([USER, { role: "assistant", content: "a", reasoning_details: [] }])).some(i => i.type === "reasoning")).toBe(false);
  });

  test("the produced body still validates against responsesRequestSchema", () => {
    const out = body([USER, { role: "assistant", content: "a", reasoning_content: "t" }]);
    expect(responsesRequestSchema.safeParse(out).success).toBe(true);
  });
});

describe("F6 sampling penalties reach the Responses body", () => {
  test("both penalties are carried", () => {
    const out = body([USER], { presence_penalty: 0.4, frequency_penalty: -0.2 });

    expect(out.presence_penalty).toBe(0.4);
    expect(out.frequency_penalty).toBe(-0.2);
  });

  test("omitted penalties stay absent", () => {
    const out = body([USER]);

    expect(out.presence_penalty).toBeUndefined();
    expect(out.frequency_penalty).toBeUndefined();
  });

  test("a non-numeric penalty is ignored rather than forwarded", () => {
    const out = body([USER], { presence_penalty: "high" });
    expect(out.presence_penalty).toBeUndefined();
  });

  test("a penalty-carrying body still validates", () => {
    const out = body([USER], { presence_penalty: 0.4, frequency_penalty: 0.1 });
    expect(responsesRequestSchema.safeParse(out).success).toBe(true);
  });
});
