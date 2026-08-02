import { describe, expect, test } from "bun:test";
import {
  createResponsesSnapshotPayloadRewrite,
  hasResponsesSnapshotRepair,
} from "../src/server/responses-snapshot-repair";

describe("Responses passthrough sparse-snapshot repair", () => {
  test("backfills canonical lifecycle fields missing from created and in-progress snapshots", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();

    for (const type of ["response.created", "response.in_progress"] as const) {
      const payload = JSON.stringify({
        type,
        sequence_number: 0,
        response: {
          id: "resp_sparse",
          created_at: 1,
          model: "example-model",
          object: "response",
          service_tier: "default",
          store: false,
        },
      });

      const event = JSON.parse(rewrite(payload)) as {
        response: Record<string, unknown>;
      };
      expect(event.response).toMatchObject({
        id: "resp_sparse",
        status: "in_progress",
        output: [],
        parallel_tool_calls: true,
        tool_choice: "auto",
        tools: [],
      });
    }
  });

  test("repairs sparse output-item, content-part, text, and terminal snapshots", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    const cases = [
      {
        input: { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", status: "in_progress" } },
        expected: { item: { summary: [] } },
      },
      {
        input: { type: "response.output_item.added", item: { id: "msg_1", type: "message", status: "in_progress" } },
        expected: { item: { role: "assistant", content: [] } },
      },
      {
        input: { type: "response.reasoning_summary_part.added", part: { type: "summary_text" } },
        expected: { part: { type: "summary_text", text: "" } },
      },
      {
        input: { type: "response.content_part.added", part: { type: "output_text", text: "" } },
        expected: { part: { type: "output_text", text: "", annotations: [] } },
      },
      {
        input: { type: "response.output_text.delta", delta: "ok" },
        expected: { logprobs: [] },
      },
      {
        input: {
          type: "response.completed",
          response: {
            id: "resp_terminal",
            created_at: 1,
            model: "model",
            object: "response",
            status: "completed",
            output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }],
          },
        },
        expected: {
          response: {
            status: "completed",
            parallel_tool_calls: true,
            tool_choice: "auto",
            tools: [],
            output: [{ content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          },
        },
      },
    ];

    for (const { input, expected } of cases) {
      expect(JSON.parse(rewrite(JSON.stringify(input)))).toMatchObject(expected);
    }
  });

  test("preserves upstream values and leaves unrelated events byte-for-byte", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    const created = JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_complete_shape",
        created_at: 1,
        model: "model",
        object: "response",
        status: "queued",
        output: [],
        parallel_tool_calls: false,
        tool_choice: "none",
        tools: [{ type: "function", name: "lookup" }],
      },
    });
    const unrelated = JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "thinking" });
    const malformed = "{not-json}";

    expect(JSON.parse(rewrite(created))).toEqual(JSON.parse(created));
    expect(rewrite(unrelated)).toBe(unrelated);
    expect(rewrite(malformed)).toBe(malformed);
  });

  test("reports explicit provider opt-in only", () => {
    expect(hasResponsesSnapshotRepair(undefined)).toBe(false);
    expect(hasResponsesSnapshotRepair(false)).toBe(false);
    expect(hasResponsesSnapshotRepair(true)).toBe(true);
  });
});
