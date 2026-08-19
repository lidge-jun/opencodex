import { describe, expect, test } from "bun:test";
import {
  createResponsesFieldBackfillBlockRewrite,
  backfillResponsesFieldsJson,
} from "../src/server/responses/responses-field-backfill";

const rewrite = createResponsesFieldBackfillBlockRewrite();

function apply(block: string): string[] {
  return [...rewrite(block)];
}

function sseBlock(data: Record<string, unknown>): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseData(blocks: string[]): Record<string, unknown>[] {
  return blocks.map((b) => {
    const match = b.match(/^data: (.+)$/m);
    return JSON.parse(match![1]);
  });
}

describe("responses-field-backfill", () => {
  test("adds annotations to output_item.done message content", () => {
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.item.content[0].annotations).toEqual([]);
    expect(parsed.item.content[0].text).toBe("hello");
  });

  test("preserves existing annotations", () => {
    const existing = [{ type: "url_citation", url: "https://example.com" }];
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hi", annotations: existing }],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.item.content[0].annotations).toEqual(existing);
  });

  test("adds annotations to content_part.added", () => {
    const event = {
      type: "response.content_part.added",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.part.annotations).toEqual([]);
  });
  test("adds annotations to response.completed output items", () => {
    const event = {
      type: "response.completed",
      sequence_number: 42,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "grok-4.5",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].content[0].annotations).toEqual([]);
  });

  test("does not modify events without output_text parts", () => {
    const event = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "do_thing",
        arguments: "{}",
      },
    };
    const result = apply(sseBlock(event));
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sseBlock(event));
  });

  test("handles multiple content parts with mixed types", () => {
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "first" },
          { type: "refusal", refusal: "no" },
          { type: "output_text", text: "second", annotations: [] },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.item.content[0].annotations).toEqual([]);
    expect(parsed.item.content[1]).not.toHaveProperty("annotations");
    expect(parsed.item.content[2].annotations).toEqual([]);
  });

  test("backfillResponsesFieldsJson adds missing annotations and preserves existing", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "no annotations" },
            { type: "output_text", text: "has annotations", annotations: [{ type: "url_citation", url: "https://example.com" }] },
            { type: "output_text", text: "null annotations", annotations: null },
            { type: "output_text", text: "malformed annotations", annotations: "not-an-array" },
            { type: "output_text", text: "object annotations", annotations: { unexpected: true } },
          ],
        },
      ],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as typeof response;
    expect(result.output[0].content[0].annotations).toEqual([]);
    expect(result.output[0].content[1].annotations).toEqual([{ type: "url_citation", url: "https://example.com" }]);
    expect(result.output[0].content[2].annotations).toBeNull();
    expect(result.output[0].content[3].annotations).toBe("not-an-array");
    expect(result.output[0].content[4].annotations).toEqual({ unexpected: true });
  });

  test("backfills missing ids on response.completed output items", () => {
    const event = {
      type: "response.completed",
      sequence_number: 42,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hello" }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "todo_write",
            arguments: "{}",
          },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].id).toBe("rs_ocx_0");
    expect(parsed.response.output[1].id).toBe("msg_ocx_1");
    expect(parsed.response.output[2].id).toBe("fc_ocx_2");
  });

  test("preserves existing item ids", () => {
    const event = {
      type: "response.completed",
      sequence_number: 42,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [
          { type: "message", id: "msg_real", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].id).toBe("msg_real");
  });

  test("uses output_index when backfilling output_item.done id", () => {
    const event = {
      type: "response.output_item.done",
      output_index: 3,
      item: {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hi" }],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.item.id).toBe("msg_ocx_3");
  });

  test("falls back to item_ prefix for inherited type names", () => {
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "toString",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hi" }],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.item.id).toBe("item_ocx_0");
  });

  test("rejects invalid output_index and falls back to 0", () => {
    for (const badIndex of [-1, 1.5, NaN, Infinity, "0", null, undefined]) {
      const event = {
        type: "response.output_item.done",
        output_index: badIndex,
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hi" }],
        },
      };
      const [out] = apply(sseBlock(event));
      const parsed = parseData([out])[0];
      expect(parsed.item.id).toBe("msg_ocx_0");
    }
  });

  test("backfillResponsesFieldsJson backfills missing ids on output items", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "todo_write",
          arguments: "{}",
        },
      ],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as typeof response;
    expect(result.output[0].id).toBe("rs_ocx_0");
    expect(result.output[1].id).toBe("msg_ocx_1");
    expect(result.output[2].id).toBe("fc_ocx_2");
  });

  test("backfillResponsesFieldsJson preserves existing item ids", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        { type: "message", id: "msg_real", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as typeof response;
    expect(result.output[0].id).toBe("msg_real");
  });
});
