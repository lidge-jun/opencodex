import { describe, expect, test } from "bun:test";
import {
  createResponsesFieldBackfillBlockRewrite,
  backfillResponsesFieldsJson,
} from "../../src/server/responses/responses-field-backfill";

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

  test("an invalid output_index still yields a well-formed synthesized id", () => {
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
      // The fallback carries its own namespace so it can never equal an index-derived id.
      expect(parsed.item.id).toMatch(/^msg_ocx_fallback_\d+$/);
    }
  });

  test("two items with an unusable output_index do not collide on one id", () => {
    // Collapsing an unusable index to 0 would synthesize `msg_ocx_0` twice, which is the
    // duplicate-id defect this backfill exists to prevent. Position is unrecoverable here;
    // uniqueness is not optional.
    const event = (text: string) => ({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    });
    const first = parseData(apply(sseBlock(event("one"))))[0];
    const second = parseData(apply(sseBlock(event("two"))))[0];

    expect(first.item.id).toMatch(/^msg_ocx_fallback_\d+$/);
    expect(second.item.id).toMatch(/^msg_ocx_fallback_\d+$/);
    expect(first.item.id).not.toBe(second.item.id);
  });

  test("a well-formed output_index still produces the stable index-derived id", () => {
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
    // Stability across events referencing the same item is the whole point of index-derivation,
    // so the fallback must not leak into the well-formed path.
    expect(parseData(apply(sseBlock(event)))[0].item.id).toBe("msg_ocx_3");
    expect(parseData(apply(sseBlock(event)))[0].item.id).toBe("msg_ocx_3");
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

  test("backfills missing status on output_item.done message", () => {
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.item.status).toBe("completed");
  });

  test("preserves existing status on message items", () => {
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "in_progress",
        content: [{ type: "output_text", text: "hi" }],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.item.status).toBe("in_progress");
  });

  test("backfills missing status on response.completed output items", () => {
    const event = {
      type: "response.completed",
      sequence_number: 42,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].status).toBe("completed");
  });

  test("does not add status to non-message items", () => {
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "do_thing",
        arguments: "{}",
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.item).not.toHaveProperty("status");
  });

  test("backfillResponsesFieldsJson backfills missing status on message items", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as typeof response;
    expect(result.output[0].status).toBe("completed");
  });

  // `queued` is a real Responses lifecycle status: the response exists but has not
  // started generating. It is neither a valid OutputMessage status nor covered by the
  // event-type table, so before these cases it fell through to the `completed`
  // default — marking an unstarted message as finished, which is exactly the
  // overclaim messageStatusFromResponseStatus exists to prevent.
  test("a queued response marks its message items in_progress, not completed", () => {
    const event = {
      type: "response.queued",
      sequence_number: 1,
      response: {
        id: "resp_1",
        object: "response",
        status: "queued",
        model: "grok-4.5",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
          },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].status).toBe("in_progress");
  });

  test("backfillResponsesFieldsJson treats a queued response as in_progress", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "queued",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        },
      ],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as {
      output: { status?: string }[];
    };
    expect(result.output[0].status).toBe("in_progress");
  });

  test("backfillResponsesFieldsJson derives incomplete status on message items", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "incomplete",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "partial" }],
        },
      ],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as typeof response;
    expect(result.output[0].status).toBe("incomplete");
  });

  test("backfills in_progress status on output_item.added message", () => {
    const event = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    // output_item.added means the item is still being generated; marking it "completed"
    // would misrepresent the stream state to strict clients.
    expect(parsed.item.status).toBe("in_progress");
  });

  test("backfills in_progress status on response.created output items", () => {
    const event = {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp_1",
        object: "response",
        status: "in_progress",
        model: "grok-4.5",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
          },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].status).toBe("in_progress");
  });

  test("backfills in_progress when both response status and item status are absent", () => {
    // response.created with no status on either the response or the message item:
    // the event type alone must drive the inference, not a "completed" default.
    const event = {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp_1",
        object: "response",
        model: "grok-4.5",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
          },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].status).toBe("in_progress");
  });

  test("backfills incomplete status on response.incomplete output items", () => {
    const event = {
      type: "response.incomplete",
      sequence_number: 10,
      response: {
        id: "resp_1",
        object: "response",
        status: "incomplete",
        model: "grok-4.5",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].status).toBe("incomplete");
  });

  test("maps response.failed to incomplete message status", () => {
    // response.failed carries status: "failed" on the response object, but
    // OutputMessage.status only accepts in_progress/completed/incomplete.
    // "failed" means the message did not finish generating, so "incomplete"
    // is the correct semantic mapping — not "completed", which would falsely
    // claim the message is whole.
    const event = {
      type: "response.failed",
      sequence_number: 5,
      response: {
        id: "resp_1",
        object: "response",
        status: "failed",
        model: "grok-4.5",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
      },
    };
    const [out] = apply(sseBlock(event));
    const parsed = parseData([out])[0];
    expect(parsed.response.output[0].status).toBe("incomplete");
  });


  test("the canonical image_generation_call type gets its own prefix", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "image_generation_call", result: "..." }],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as {
      output: { id: string }[];
    };
    // The wire type is `image_generation_call`; keying the table on the short spelling alone
    // silently demoted every real one to the generic `item_` prefix.
    expect(result.output[0]!.id).toBe("ig_ocx_0");
  });

  // A routed tool_search lowering is restored as `tool_search_call` with no id, so this
  // backfill names it. The generic `item_` fallback was not cosmetic: `stripInvalidItemIds`
  // in the Responses adapter deletes an id whose prefix does not match its type, so the item
  // silently lost its id on the NEXT turn and the client could no longer correlate it.
  test("tool_search_call gets the prefix the request serializer accepts", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "tool_search_call", call_id: "call_x", execution: "client" }],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as {
      output: { id: string }[];
    };
    expect(result.output[0]!.id).toBe("tsc_ocx_0");
  });

  test("custom_tool_call gets its own prefix too", () => {
    const response = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "custom_tool_call", call_id: "call_y" }],
    };
    const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as {
      output: { id: string }[];
    };
    expect(result.output[0]!.id).toBe("ctc_ocx_0");
  });

  // A malformed `output_index` falls back to a counter. While that counter lived in the same
  // numeric namespace as real indexes, a response whose real index reached the counter's base
  // produced the SAME id as a fallback — a duplicate, which is the one thing this backfill
  // exists to prevent.
  test("a fallback id cannot collide with any index-derived id", () => {
    const malformed = parseData(apply(sseBlock({
      type: "response.output_item.added",
      output_index: "not-a-number",
      item: { type: "message", role: "assistant", content: [] },
    })));
    const fallbackId = (malformed[0]!.item as { id: string }).id;

    // Every index-derived id is `msg_ocx_<digits>`; the fallback namespace is lexically
    // disjoint from it, so no integer index can ever produce this string.
    expect(fallbackId).toMatch(/^msg_ocx_fallback_\d+$/);
    expect(fallbackId).not.toMatch(/^msg_ocx_\d+$/);

    for (const index of [0, 1, 1_000_000, 1_000_001, 1_000_002]) {
      const derived = parseData(apply(sseBlock({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "message", role: "assistant", content: [] },
      })));
      expect((derived[0]!.item as { id: string }).id).not.toBe(fallbackId);
    }
  });

  test("consecutive malformed indexes still get distinct ids", () => {
    const ids = [0, 1].map(() => {
      const out = parseData(apply(sseBlock({
        type: "response.output_item.added",
        item: { type: "message", role: "assistant", content: [] },
      })));
      return (out[0]!.item as { id: string }).id;
    });
    expect(new Set(ids).size).toBe(2);
  });

  // The compact wire family is the /v1/responses/compact format, not Responses output items: they
  // carry no id in that contract, clients compare the body exactly, and the client replays the item
  // on every later turn where the minting backend rejects a modified one. Synthesizing an id here
  // changed a response that had nothing to do with strict Responses decoding — a defect that only
  // appeared once this backfill and the compact endpoint were on the same tree. It originally
  // covered `compaction` alone, so the sibling types kept receiving synthesized ids.
  test("every compact wire item type is returned byte-for-byte", () => {
    for (const type of ["compaction", "compaction_summary", "context_compaction"]) {
      const item = { type, encrypted_content: "gAAAAAB-test-opaque" };
      const response = { id: "resp_1", object: "response", status: "completed", output: [item] };
      const result = JSON.parse(backfillResponsesFieldsJson(JSON.stringify(response))) as {
        output: Record<string, unknown>[];
      };
      expect(result.output[0]).toEqual(item);
      expect(result.output[0]).not.toHaveProperty("id");

      const streamed = parseData(apply(sseBlock({ type: "response.output_item.done", output_index: 0, item })));
      expect(streamed[0].item).toEqual(item);
      expect(streamed[0].item).not.toHaveProperty("id");
    }
  });
});
