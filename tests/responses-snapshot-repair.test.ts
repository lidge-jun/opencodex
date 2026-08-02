import { describe, expect, test } from "bun:test";
import {
  createResponsesSnapshotPayloadRewrite,
  hasResponsesSnapshotRepair,
} from "../src/server/responses-snapshot-repair";
import { handleResponses } from "../src/server/responses";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { isEagerRelaySseResponse } from "../src/server/relay";
import type { OcxConfig } from "../src/types";

function parsedSseEvents(text: string): Array<Record<string, unknown>> {
  return text.split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).find(line => line.startsWith("data:")))
    .map(line => line?.slice(5).trim())
    .filter((payload): payload is string => !!payload && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
}

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

  test("backfills both required output_text fields when a sparse gateway omits them", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    const event = JSON.parse(rewrite(JSON.stringify({
      type: "response.content_part.added",
      part: { type: "output_text" },
    }))) as { part: Record<string, unknown> };

    expect(event.part).toEqual({ type: "output_text", text: "", annotations: [] });
  });

  test("repairs output-item status and nested reasoning summary parts", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    for (const invalidStatus of [undefined, null, 42]) {
      const added = JSON.parse(rewrite(JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          ...(invalidStatus === undefined ? {} : { status: invalidStatus }),
        },
      }))) as { item: Record<string, unknown> };
      expect(added.item.status).toBe("in_progress");
    }
    const done = JSON.parse(rewrite(JSON.stringify({
      type: "response.output_item.done",
      output_index: 1,
      item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text" }] },
    }))) as { item: { status?: unknown; summary?: unknown } };

    expect(done.item.status).toBe("completed");
    expect(done.item.summary).toEqual([{ type: "summary_text", text: "" }]);
  });

  test("preserves protocol-valid response and output-item statuses", () => {
    for (const status of ["queued", "in_progress", "completed", "failed", "incomplete", "cancelled", "future_status"]) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      const event = JSON.parse(rewrite(JSON.stringify({
        type: "response.created",
        response: { id: "resp_status", object: "response", status },
      }))) as { response: Record<string, unknown> };
      expect(event.response.status).toBe(status);
    }
    for (const status of ["in_progress", "completed", "incomplete"]) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      const event = JSON.parse(rewrite(JSON.stringify({
        type: "response.output_item.added",
        item: { id: "msg_status", type: "message", status },
      }))) as { item: Record<string, unknown> };
      expect(event.item.status).toBe(status);
    }
    for (const item of [
      { type: "web_search_call", status: "searching" },
      { type: "image_generation_call", status: "generating" },
      { type: "code_interpreter_call", status: "interpreting" },
    ]) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      const event = JSON.parse(rewrite(JSON.stringify({
        type: "response.output_item.added",
        item,
      }))) as { item: Record<string, unknown> };
      expect(event.item.status).toBe(item.status);
    }
  });

  test("replaces structurally invalid response statuses with the event status", () => {
    for (const invalidStatus of [null, 42]) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      const event = JSON.parse(rewrite(JSON.stringify({
        type: "response.completed",
        response: { id: "resp_invalid_status", object: "response", status: invalidStatus },
      }))) as { response: Record<string, unknown> };
      expect(event.response.status).toBe("completed");
    }
  });

  test("does not invent nested statuses for a mixed in-progress snapshot", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    const event = JSON.parse(rewrite(JSON.stringify({
      type: "response.in_progress",
      response: {
        id: "resp_mixed",
        object: "response",
        output: [
          { id: "msg_done", type: "message", status: "completed" },
          { id: "msg_active", type: "message" },
        ],
      },
    }))) as { response: { output: Array<Record<string, unknown>> } };

    expect(event.response.output[0]?.status).toBe("completed");
    expect(event.response.output[1]?.status).toBeUndefined();
  });

  test("reconstructs a sparse completed output from prior done items", () => {
    for (const sparseOutput of [undefined, null, [], "invalid"]) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      rewrite(JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      }));
      const terminal = JSON.parse(rewrite(JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          ...(sparseOutput === undefined ? {} : { output: sparseOutput }),
        },
      }))) as { response: { output?: unknown } };

      expect(terminal.response.output).toEqual([{
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      }]);
    }
  });

  test("uses request tool metadata when sparse snapshots omit or corrupt it", () => {
    const requestDefaults = {
      parallel_tool_calls: false,
      tool_choice: { type: "function", name: "lookup" },
      tools: [{ type: "function", name: "lookup", parameters: {} }],
    };
    const rewrite = createResponsesSnapshotPayloadRewrite(requestDefaults);

    for (const invalidChoice of [undefined, null, 42, "", " ", [], {}, { type: "" }, { type: 42 }]) {
      const response = JSON.parse(rewrite(JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_sparse",
          object: "response",
          ...(invalidChoice === undefined ? {} : { tool_choice: invalidChoice }),
        },
      }))) as { response: Record<string, unknown> };
      expect(response.response.parallel_tool_calls).toBe(false);
      expect(response.response.tool_choice).toEqual(requestDefaults.tool_choice);
      expect(response.response.tools).toEqual(requestDefaults.tools);
    }

    const upstreamChoice = { type: "function", name: "upstream-choice" };
    const preserved = JSON.parse(rewrite(JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_complete",
        object: "response",
        parallel_tool_calls: true,
        tool_choice: upstreamChoice,
        tools: [{ type: "function", name: "upstream-choice" }],
      },
    }))) as { response: Record<string, unknown> };
    expect(preserved.response.parallel_tool_calls).toBe(true);
    expect(preserved.response.tool_choice).toEqual(upstreamChoice);
    expect(preserved.response.tools).toEqual([{ type: "function", name: "upstream-choice" }]);

    const futureChoice = { type: "web_search_preview_2025_03_11" };
    const futureRewrite = createResponsesSnapshotPayloadRewrite({ tool_choice: futureChoice });
    const future = JSON.parse(futureRewrite(JSON.stringify({
      type: "response.created",
      response: { id: "resp_future", object: "response", tool_choice: futureChoice },
    }))) as { response: Record<string, unknown> };
    expect(future.response.tool_choice).toEqual(futureChoice);
  });

  test("ignores inherited object keys as lifecycle event types", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    const payload = JSON.stringify({ type: "__proto__", response: { id: "resp_proto" } });
    expect(rewrite(payload)).toBe(payload);
  });

  test("charges retained output items and releases them on terminal or dispose", () => {
    for (const end of ["terminal", "dispose"] as const) {
      const budget = createTranslatorBudget();
      const rewrite = createResponsesSnapshotPayloadRewrite(undefined, budget);
      const retainedEvent = JSON.parse(rewrite(JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_budget",
          type: "message",
          content: [{ type: "output_text", text: "x".repeat(4096) }],
        },
      }))) as { item: Record<string, unknown> };
      const retainedItemBytes = new TextEncoder().encode(JSON.stringify(retainedEvent.item)).byteLength;
      expect(budget.snapshot().currentBytes).toBeGreaterThanOrEqual(retainedItemBytes);
      if (end === "terminal") {
        rewrite(JSON.stringify({
          type: "response.completed",
          response: { id: "resp_budget", object: "response" },
        }));
      } else {
        rewrite.dispose?.();
      }
      expect(budget.snapshot().currentBytes).toBe(0);
      budget.dispose();
    }
  });

  test("does not reconstruct a partial terminal after the retained-item cap is exceeded", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    for (let outputIndex = 0; outputIndex <= 256; outputIndex += 1) {
      rewrite(JSON.stringify({
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { id: `msg_${outputIndex}`, type: "message" },
      }));
    }
    const terminal = JSON.parse(rewrite(JSON.stringify({
      type: "response.completed",
      response: { id: "resp_capped", object: "response" },
    }))) as { response: { output?: unknown } };

    expect(terminal.response.output).toEqual([]);
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

  test("handleResponses keeps the repair default-off and applies an explicit opt-in", async () => {
    const savedFetch = globalThis.fetch;
    const doneItem = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hello" }],
    };
    const upstream = [
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: doneItem,
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", object: "response", status: "completed" },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    globalThis.fetch = (async () => new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    try {
      for (const enabled of [false, true]) {
        const config = {
          port: 0,
          streamMode: "eager-relay",
          defaultProvider: "fixture",
          providers: {
            fixture: {
              adapter: "openai-responses",
              baseUrl: "https://fixture.test/v1",
              authMode: "key",
              apiKey: "fixture-key",
              ...(enabled ? { responsesSnapshotRepair: true } : {}),
            },
          },
        } as OcxConfig;
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "fixture/example-model",
            stream: true,
            input: "hello",
            parallel_tool_calls: false,
            tool_choice: { type: "function", name: "lookup" },
            tools: [{ type: "function", name: "lookup", parameters: {} }],
          }),
        }), config, { model: "", provider: "" });
        const events = parsedSseEvents(await response.text());
        expect(isEagerRelaySseResponse(response)).toBe(
          process.platform === "darwin" || process.platform === "win32",
        );
        const terminal = events.find(event => event.type === "response.completed") as {
          response: Record<string, unknown>;
        } | undefined;
        if (!enabled) {
          expect(terminal?.response).toEqual({ id: "resp_1", object: "response", status: "completed" });
          continue;
        }
        expect(terminal?.response.parallel_tool_calls).toBe(false);
        expect(terminal?.response.tool_choice).toEqual({ type: "function", name: "lookup" });
        expect(terminal?.response.tools).toEqual([{ type: "function", name: "lookup", parameters: {} }]);
        expect(terminal?.response.output).toEqual([{
          ...doneItem,
          status: "completed",
          content: [{ type: "output_text", text: "hello", annotations: [] }],
        }]);
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses repairs non-streaming JSON only for an opted-in provider", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "resp_json",
      object: "response",
      output: [{ id: "msg_json", type: "message", content: [{ type: "output_text" }] }],
    }), { headers: { "content-type": "application/json" } })) as typeof fetch;

    try {
      for (const enabled of [false, true]) {
        const config = {
          port: 0,
          defaultProvider: "fixture",
          providers: {
            fixture: {
              adapter: "openai-responses",
              baseUrl: "https://fixture.test/v1",
              authMode: "key",
              apiKey: "fixture-key",
              ...(enabled ? { responsesSnapshotRepair: true } : {}),
            },
          },
        } as OcxConfig;
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fixture/example-model", input: "hello" }),
        }), config, { model: "", provider: "" });
        const body = await response.json() as { status?: unknown; output: Array<Record<string, unknown>> };
        if (!enabled) {
          expect(body.status).toBeUndefined();
          expect(body.output[0]).toEqual({
            id: "msg_json",
            type: "message",
            content: [{ type: "output_text" }],
          });
          continue;
        }
        expect(body.status).toBe("completed");
        expect(body.output[0]).toEqual({
          id: "msg_json",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "", annotations: [] }],
        });
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
