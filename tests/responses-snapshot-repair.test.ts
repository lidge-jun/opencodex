import { describe, expect, test } from "bun:test";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { isEagerRelaySseResponse, MAX_COMPLETED_OUTPUT_ITEMS } from "../src/server/relay";
import { handleResponses } from "../src/server/responses";
import {
  createResponsesSnapshotPayloadRewrite,
  hasResponsesSnapshotRepair,
  repairResponsesSnapshotJson,
} from "../src/server/responses-snapshot-repair";
import type { OcxConfig } from "../src/types";

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  return text.split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).find(line => line.startsWith("data:")))
    .map(line => line?.slice(5).trim())
    .filter((payload): payload is string => !!payload && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
}

describe("Responses sparse-snapshot repair", () => {
  test("backfills canonical lifecycle fields from request metadata", () => {
    const request = {
      parallel_tool_calls: false,
      tool_choice: { type: "function", name: "lookup" },
      tools: [{ type: "function", name: "lookup", parameters: {} }],
    };
    const rewrite = createResponsesSnapshotPayloadRewrite(request);

    for (const type of ["response.created", "response.in_progress"] as const) {
      const event = JSON.parse(rewrite(JSON.stringify({
        type,
        response: { id: "resp_sparse", object: "response" },
      }))) as { response: Record<string, unknown> };

      expect(event.response).toMatchObject({
        id: "resp_sparse",
        status: "in_progress",
        output: [],
        parallel_tool_calls: false,
        tool_choice: request.tool_choice,
        tools: request.tools,
      });
    }
  });

  test("repairs sparse output items, parts, text events, and terminal snapshots", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    const cases = [
      {
        input: {
          type: "response.output_item.added",
          item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text" }] },
        },
        expected: {
          item: { status: "in_progress", summary: [{ type: "summary_text", text: "" }] },
        },
      },
      {
        input: { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
        expected: { item: { status: "completed", role: "assistant", content: [] } },
      },
      {
        input: { type: "response.reasoning_summary_part.added", part: { type: "summary_text" } },
        expected: { part: { type: "summary_text", text: "" } },
      },
      {
        input: { type: "response.content_part.done", part: { type: "output_text" } },
        expected: { part: { type: "output_text", text: "", annotations: [] } },
      },
      {
        input: { type: "response.output_text.delta", delta: "ok" },
        expected: { logprobs: [] },
      },
      {
        input: { type: "response.output_text.done" },
        expected: { text: "", logprobs: [] },
      },
      {
        input: {
          type: "response.completed",
          response: {
            id: "resp_terminal",
            object: "response",
            output: [{
              id: "msg_1",
              type: "message",
              content: [{ type: "output_text", text: "ok" }],
            }],
          },
        },
        expected: {
          response: {
            status: "completed",
            parallel_tool_calls: true,
            tool_choice: "auto",
            tools: [],
            output: [{
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            }],
          },
        },
      },
    ];

    for (const { input, expected } of cases) {
      expect(JSON.parse(rewrite(JSON.stringify(input)))).toMatchObject(expected);
    }
  });

  test("replaces structurally invalid statuses, roles, and tool choices", () => {
    for (const invalidStatus of [undefined, null, 42, ""]) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      const event = JSON.parse(rewrite(JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_invalid",
          object: "response",
          ...(invalidStatus === undefined ? {} : { status: invalidStatus }),
          output: [{ id: "msg_invalid", type: "message", role: "user" }],
        },
      }))) as { response: { status?: unknown; output: Array<Record<string, unknown>> } };
      expect(event.response.status).toBe("completed");
      expect(event.response.output[0]?.role).toBe("assistant");
    }

    const requestChoice = { type: "function", name: "lookup" };
    for (const invalidChoice of [undefined, null, 42, "", " ", [], {}, { type: "" }, { type: 42 }]) {
      const rewrite = createResponsesSnapshotPayloadRewrite({ tool_choice: requestChoice });
      const event = JSON.parse(rewrite(JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_choice",
          object: "response",
          ...(invalidChoice === undefined ? {} : { tool_choice: invalidChoice }),
        },
      }))) as { response: Record<string, unknown> };
      expect(event.response.tool_choice).toEqual(requestChoice);
    }
  });

  test("preserves valid upstream and future-compatible values", () => {
    for (const status of ["queued", "in_progress", "completed", "failed", "future_status"]) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      const event = JSON.parse(rewrite(JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_status",
          object: "response",
          status,
          output: [],
          parallel_tool_calls: false,
          tool_choice: { type: "future_choice" },
          tools: [],
        },
      }))) as { response: Record<string, unknown> };
      expect(event.response.status).toBe(status);
      expect(event.response.tool_choice).toEqual({ type: "future_choice" });
    }

    const valid = JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_complete",
        object: "response",
        status: "queued",
        output: [],
        parallel_tool_calls: false,
        tool_choice: "none",
        tools: [{ type: "function", name: "lookup" }],
      },
    });
    const unrelated = JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "thinking" });
    const rewrite = createResponsesSnapshotPayloadRewrite();
    expect(rewrite(valid)).toBe(valid);
    expect(rewrite(unrelated)).toBe(unrelated);
    expect(rewrite("{not-json}")).toBe("{not-json}");
  });

  test("does not invent nested statuses for in-progress snapshots", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    const event = JSON.parse(rewrite(JSON.stringify({
      type: "response.in_progress",
      response: {
        id: "resp_mixed",
        object: "response",
        output: [
          { id: "msg_done", type: "message", role: "assistant", status: "completed" },
          { id: "msg_active", type: "message", role: "assistant" },
        ],
      },
    }))) as { response: { output: Array<Record<string, unknown>> } };

    expect(event.response.output[0]?.status).toBe("completed");
    expect(event.response.output[1]?.status).toBeUndefined();
  });

  test("reconstructs missing terminal output only from contiguous done indexes", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    rewrite(JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_0", type: "message" },
    }));
    rewrite(JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_0",
        type: "message",
        content: [{ type: "output_text", text: "hello" }],
      },
    }));
    const reconstructed = JSON.parse(rewrite(JSON.stringify({
      type: "response.completed",
      response: { id: "resp_reconstructed", object: "response" },
    }))) as { response: { output?: unknown } };

    expect(reconstructed.response.output).toEqual([{
      id: "msg_0",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    }]);

    const gapped = createResponsesSnapshotPayloadRewrite();
    for (const outputIndex of [0, 2]) {
      gapped(JSON.stringify({
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { id: `msg_${outputIndex}`, type: "message" },
      }));
    }
    const terminal = JSON.parse(gapped(JSON.stringify({
      type: "response.completed",
      response: { id: "resp_gapped", object: "response" },
    }))) as { response: { output?: unknown } };
    expect(terminal.response.output).toEqual([]);
  });

  test("preserves empty terminal output and repairs malformed values without reconstruction", () => {
    for (const output of [[], null, "invalid"]) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      rewrite(JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_explicit_output",
          type: "message",
          content: [{ type: "output_text", text: "must-not-be-reconstructed" }],
        },
      }));

      const terminal = JSON.parse(rewrite(JSON.stringify({
        type: "response.completed",
        response: { id: "resp_explicit_output", object: "response", output },
      }))) as { response: { output?: unknown } };

      expect(terminal.response.output).toEqual([]);
    }
  });

  test("suppresses reconstruction while an observed added item remains unfinished", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    rewrite(JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "msg_done", type: "message", content: [{ type: "output_text", text: "partial" }] },
    }));
    rewrite(JSON.stringify({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "msg_pending", type: "message" },
    }));

    const terminal = JSON.parse(rewrite(JSON.stringify({
      type: "response.completed",
      response: { id: "resp_pending_item", object: "response" },
    }))) as { response: { output?: unknown } };

    expect(terminal.response.output).toEqual([]);
  });

  test("suppresses reconstruction after malformed done events", () => {
    const malformedDoneEvents = [
      { type: "response.output_item.done", output_index: 1 },
      { type: "response.output_item.done", output_index: 1, item: "invalid" },
      { type: "response.output_item.done", output_index: "1", item: { type: "message" } },
      { type: "response.output_item.done", output_index: 1, item: { id: "msg_1" } },
    ];

    for (const malformedDoneEvent of malformedDoneEvents) {
      const rewrite = createResponsesSnapshotPayloadRewrite();
      rewrite(JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "msg_0", type: "message" },
      }));
      rewrite(JSON.stringify(malformedDoneEvent));

      const terminal = JSON.parse(rewrite(JSON.stringify({
        type: "response.completed",
        response: { id: "resp_malformed_done", object: "response" },
      }))) as { response: { output?: unknown } };

      expect(terminal.response.output).toEqual([]);
    }
  });

  test("reconstructs contiguous done items for incomplete terminal responses", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    rewrite(JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "msg_partial", type: "message", content: [{ type: "output_text", text: "partial" }] },
    }));

    const terminal = JSON.parse(rewrite(JSON.stringify({
      type: "response.incomplete",
      response: { id: "resp_incomplete", object: "response" },
    }))) as { response: { output?: unknown } };

    expect(terminal.response.output).toEqual([{
      id: "msg_partial",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "partial", annotations: [] }],
    }]);
  });

  test("suppresses partial reconstruction after retained-item bounds are exceeded", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    for (let outputIndex = 0; outputIndex <= MAX_COMPLETED_OUTPUT_ITEMS; outputIndex += 1) {
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

  test("charges reconstructed items to the translator budget and releases them at terminal", () => {
    for (const terminalType of ["response.completed", "response.failed", "response.incomplete"] as const) {
      const budget = createTranslatorBudget();
      const rewrite = createResponsesSnapshotPayloadRewrite(undefined, budget);
      rewrite(JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_budget",
          type: "message",
          content: [{ type: "output_text", text: "x".repeat(4096) }],
        },
      }));
      expect(budget.snapshot().currentBytes).toBeGreaterThan(4096);
      rewrite(JSON.stringify({
        type: terminalType,
        response: { id: "resp_budget", object: "response" },
      }));
      expect(budget.snapshot().currentBytes).toBe(0);
      budget.dispose();
    }
  });

  test("ignores inherited lifecycle names and requires explicit provider opt-in", () => {
    const rewrite = createResponsesSnapshotPayloadRewrite();
    const inherited = JSON.stringify({ type: "__proto__", response: { id: "resp_proto" } });
    expect(rewrite(inherited)).toBe(inherited);
    expect(hasResponsesSnapshotRepair(undefined)).toBe(false);
    expect(hasResponsesSnapshotRepair(false)).toBe(false);
    expect(hasResponsesSnapshotRepair(true)).toBe(true);
  });

  test("repairs non-streaming JSON without changing malformed payloads", () => {
    const repaired = JSON.parse(repairResponsesSnapshotJson(JSON.stringify({
      id: "resp_json",
      object: "response",
      output: [{ id: "msg_json", type: "message", content: [{ type: "output_text" }] }],
    }))) as Record<string, unknown>;
    expect(repaired).toMatchObject({
      status: "completed",
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      output: [{
        id: "msg_json",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "", annotations: [] }],
      }],
    });
    expect(repairResponsesSnapshotJson("{not-json}")).toBe("{not-json}");
  });

  test("does not complete sparse output items in an incomplete non-streaming response", () => {
    const repaired = JSON.parse(repairResponsesSnapshotJson(JSON.stringify({
      id: "resp_incomplete_json",
      object: "response",
      status: "incomplete",
      output: [{ id: "msg_partial", type: "message" }],
    }))) as { status?: unknown; output: Array<Record<string, unknown>> };

    expect(repaired.status).toBe("incomplete");
    expect(repaired.output[0]).toEqual({
      id: "msg_partial",
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: [],
    });
  });

  test("handleResponses keeps SSE repair default-off and preserves the existing relay gate", async () => {
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

        const expectedEager = process.platform === "win32"
          || (process.platform === "darwin" && !enabled);
        expect(isEagerRelaySseResponse(response)).toBe(expectedEager);
        const events = parseSseEvents(await response.text());
        const terminal = events.find(event => event.type === "response.completed") as {
          response: Record<string, unknown>;
        } | undefined;
        if (!enabled) {
          expect(terminal?.response).toEqual({ id: "resp_1", object: "response", status: "completed" });
          continue;
        }
        expect(terminal?.response).toMatchObject({
          parallel_tool_calls: false,
          tool_choice: { type: "function", name: "lookup" },
          tools: [{ type: "function", name: "lookup", parameters: {} }],
          output: [{
            ...doneItem,
            status: "completed",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          }],
        });
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses canonicalizes the exact sparse added-delta-completed stream from issue #893", async () => {
    const savedFetch = globalThis.fetch;
    const upstream = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_example","object":"response"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"msg_example","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_example","object":"response"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    globalThis.fetch = (async () => new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    try {
      const config = {
        port: 0,
        defaultProvider: "fixture",
        providers: {
          fixture: {
            adapter: "openai-responses",
            baseUrl: "https://fixture.test/v1",
            authMode: "key",
            apiKey: "fixture-key",
            responsesSnapshotRepair: true,
          },
        },
      } as OcxConfig;
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/example-model", stream: true, input: "hello" }),
      }), config, { model: "", provider: "" });
      const events = parseSseEvents(await response.text());

      // The issue fixture has no output_item.done, so the safe contract is to preserve its text
      // delta and emit a canonical empty terminal output, not invent a completed message item.
      expect(events).toEqual([
        {
          type: "response.created",
          response: {
            id: "resp_example",
            object: "response",
            status: "in_progress",
            output: [],
            parallel_tool_calls: true,
            tool_choice: "auto",
            tools: [],
          },
        },
        {
          type: "response.output_item.added",
          item: {
            id: "msg_example",
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        },
        { type: "response.output_text.delta", delta: "hello", logprobs: [] },
        {
          type: "response.completed",
          response: {
            id: "resp_example",
            object: "response",
            status: "completed",
            output: [],
            parallel_tool_calls: true,
            tool_choice: "auto",
            tools: [],
          },
        },
      ]);
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
        const body = await response.json() as {
          status?: unknown;
          output: Array<Record<string, unknown>>;
        };
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
