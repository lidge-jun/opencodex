import { describe, expect, test } from "bun:test";
import { stripOpenAiInternalRequestMetadata } from "../src/server/responses/internal-request-metadata";

describe("stripOpenAiInternalRequestMetadata", () => {
  test("strips passthrough metadata from message items", () => {
    const body = {
      model: "cov-x/gpt-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["input_text"],
          },
        },
      ],
    };
    stripOpenAiInternalRequestMetadata(body);
    const item = body.input[0] as Record<string, unknown>;
    expect(item.internal_chat_message_metadata_passthrough).toBeUndefined();
    // Other fields must survive intact.
    expect(item.type).toBe("message");
    expect(item.role).toBe("user");
    expect(item.content).toEqual([{ type: "input_text", text: "hi" }]);
  });

  test("strips from every item in a mixed request", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [], internal_chat_message_metadata_passthrough: {} },
        { type: "reasoning", summary: [], internal_chat_message_metadata_passthrough: { scratch_pad: "x" } },
        { type: "function_call", name: "exec", arguments: "{}", call_id: "c1" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    };
    stripOpenAiInternalRequestMetadata(body);
    for (const item of body.input) {
      expect((item as Record<string, unknown>).internal_chat_message_metadata_passthrough).toBeUndefined();
    }
  });

  test("preserves other metadata fields on the same item", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [],
          internal_chat_message_metadata_passthrough: {},
          extra_content: { gemini: { thought_signature: "sig-123" } },
          id: "msg_1",
        },
      ],
    };
    stripOpenAiInternalRequestMetadata(body);
    const item = body.input[0] as Record<string, unknown>;
    expect(item.internal_chat_message_metadata_passthrough).toBeUndefined();
    expect(item.extra_content).toEqual({ gemini: { thought_signature: "sig-123" } });
    expect(item.id).toBe("msg_1");
  });

  test("no-op when the field is absent", () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] }],
    };
    expect(() => stripOpenAiInternalRequestMetadata(body)).not.toThrow();
    expect((body.input[0] as Record<string, unknown>).content).toEqual([
      { type: "input_text", text: "ok" },
    ]);
  });

  test("tolerates malformed input without throwing", () => {
    expect(() => stripOpenAiInternalRequestMetadata(null)).not.toThrow();
    expect(() => stripOpenAiInternalRequestMetadata(undefined)).not.toThrow();
    expect(() => stripOpenAiInternalRequestMetadata({})).not.toThrow();
    expect(() => stripOpenAiInternalRequestMetadata({ input: "not-an-array" })).not.toThrow();
    expect(() =>
      stripOpenAiInternalRequestMetadata({ input: [null, "x", 42, undefined] }),
    ).not.toThrow();
  });

  test("leaves items unchanged when body.input is absent or empty", () => {
    const body = { model: "m", input: [] };
    stripOpenAiInternalRequestMetadata(body);
    expect(body.input).toEqual([]);
  });
});
