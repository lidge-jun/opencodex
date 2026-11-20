import { describe, expect, jest, test } from "bun:test";
import { preflightComboStreamResponse } from "../../src/server/responses/combo-stream-preflight";
import { rememberPausedTurn } from "../../src/lib/client-error-body";
import type { RequestLogContext } from "../../src/server/request-log";

const encoder = new TextEncoder();
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const logContext = () => ({ model: "m1", provider: "a" });
const headers = { "content-type": "text/event-stream" };
const created = { type: "response.created", response: { id: "r1", status: "in_progress" } };
const commentary = { type: "message", id: "msg_c", phase: "commentary", role: "assistant", content: [] };
const refusal = { type: "refusal", refusal: "I cannot help with that." };
const added = { type: "response.output_item.added", item: commentary };
const completed = { type: "response.completed", response: { id: "r1", status: "completed", output: [commentary] } };
const flushMicrotasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function expectCommitted(...payloads: unknown[]): Promise<void> {
  const body = payloads.map(frame).join("");
  const result = await preflightComboStreamResponse(
    new Response(body, { headers }), logContext(), undefined, { degeneratePrelude: true },
  );
  expect(result.kind).toBe("accepted");
  expect(await result.response.text()).toBe(body);
}

test.each([false, true])("the hold starts at response.created (later reasoning: %j)", async laterReasoning => {
  jest.useFakeTimers();
  const abort = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const first = encoder.encode(frame(created));
  const reasoning = encoder.encode(frame({ type: "response.reasoning_text.delta", delta: "thinking" }));
  const terminal = encoder.encode(frame(completed));
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; controller.enqueue(first); },
  }), { headers });
  const pending = preflightComboStreamResponse(response, logContext(), undefined, {
    degeneratePrelude: true, signal: abort.signal,
  });
  let result: Awaited<typeof pending> | undefined;
  void pending.then(value => { result = value; }, () => {});
  try {
    await flushMicrotasks();
    jest.advanceTimersByTime(900);
    if (laterReasoning) source.enqueue(reasoning);
    await flushMicrotasks();
    jest.advanceTimersByTime(99);
    await flushMicrotasks();
    expect(result).toBeUndefined();

    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(result?.kind).toBe("accepted");

    const reader = result!.response.body!.getReader();
    expect((await reader.read()).value).toEqual(first);
    if (laterReasoning) expect((await reader.read()).value).toEqual(reasoning);
    const last = reader.read();
    source.enqueue(terminal);
    source.close();
    expect((await last).value).toEqual(terminal);
    expect((await reader.read()).done).toBe(true);
  } finally {
    abort.abort();
    await pending.catch(() => {});
    jest.useRealTimers();
  }
});

test.each([
  { type: "response.refusal.delta", item_id: commentary.id, delta: refusal.refusal },
  { type: "response.refusal.done", item_id: commentary.id, refusal: refusal.refusal },
  { type: "response.content_part.added", item_id: commentary.id, part: refusal },
  { type: "response.content_part.done", item_id: commentary.id, part: refusal },
  { type: "response.output_item.done", item: { ...commentary, content: [refusal] } },
])("a commentary refusal frame commits the stream (%j)", async event => {
  await expectCommitted(created, added, event, completed);
});

test.each([
  { ...commentary, content: [refusal] },
  { ...commentary, content: [{ type: "output_audio", audio: "example" }] },
  { type: "reasoning", id: "rs_1", content: [refusal] },
])("a terminal-only item with non-prelude content commits the stream (%j)", async item => {
  await expectCommitted(created, { ...completed, response: { ...completed.response, output: [item] } });
  await expectCommitted(created, { ...completed, output: [item] });
});

const vetoCases = [
  { root: { incomplete_details: { retryable: false } }, nested: { incomplete_details: { retryable: true } } },
  { root: { end_turn: false }, nested: { end_turn: true } },
];
test.each(vetoCases.flatMap(veto => [[], [commentary]].map(output => ({ ...veto, output }))))(
  "an event-level incomplete veto survives a conflicting response snapshot (%j)", async ({ root, nested, output }) => {
    const details = { reason: "upstream_stall_timeout", ...nested.incomplete_details };
    await expectCommitted(created, {
      type: "response.incomplete",
      ...root,
      response: { id: "r1", status: "incomplete", output, ...nested, incomplete_details: details },
    });
});

test.each([
  { ...completed, end_turn: false },
  { ...completed, response: { ...completed.response, incomplete_details: { retryable: false } } },
])("a completed commentary terminal honors a replay veto on either carrier (%j)", async terminal => {
  await expectCommitted(created, added, terminal);
});

test.each(["completed", "incomplete"].flatMap(status => ["event", "response"].map(carrier => ({ status, carrier }))))(
  "a commentary $status terminal preserves a structured error on the $carrier", async ({ status, carrier }) => {
    const error = { type: "invalid_request_error", code: "content_policy_violation", message: "Request refused" };
    await expectCommitted(created, added, {
      type: `response.${status}`,
      ...(carrier === "event" ? { error } : {}),
      response: { ...completed.response, status, ...(carrier === "response" ? { error } : {}) },
    });
  },
);

test.each([
  { eventReason: "content_filter", responseReason: "upstream_stall_timeout" },
  { eventReason: "upstream_stall_timeout", responseReason: "content_filter" },
].flatMap(reasons => [[], [commentary]].map(output => ({ ...reasons, output }))))(
  "an incomplete refusal reason on either carrier commits the original stream (%j)",
  async ({ eventReason, responseReason, output }) => {
    await expectCommitted(created, {
      type: "response.incomplete",
      incomplete_details: { reason: eventReason },
      response: { id: "r1", status: "incomplete", output, incomplete_details: { reason: responseReason } },
    });
  },
);

test.each([
  { ...completed, incomplete_details: { reason: "content_filter" } },
  { ...completed, response: { ...completed.response, incomplete_details: { reason: "content_filter" } } },
])("a completed commentary terminal honors a refusal reason on either carrier (%j)", async terminal => {
  await expectCommitted(created, added, terminal);
});

test("the zero-output fallback preserves an event-level limit alongside a nested stall reason", async () => {
  const terminal = {
    type: "response.incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    response: {
      id: "r1", status: "incomplete", output: [], incomplete_details: { reason: "upstream_stall_timeout" },
      usage: { input_tokens: 25, output_tokens: 0 },
    },
  };
  const result = await preflightComboStreamResponse(new Response(frame(terminal), { headers }), logContext());
  expect(result.kind).toBe("failed");
  expect(result.response.status).toBe(502);
  expect(await result.response.json()).toMatchObject({
    error: { code: "zero_output_token_limit", message: "Provider reached its output token limit before producing output" },
    response: { usage: terminal.response.usage },
  });
});

const sse = (...payloads: unknown[]): Response => new Response(payloads.map(frame).join(""), { headers });

describe("degenerate completion prelude", () => {
  const logCtx: RequestLogContext = { model: "m1", provider: "a" };
  const commentaryItem = { type: "message", id: "msg_c", phase: "commentary", role: "assistant", content: [] };
  const finalItem = { type: "message", id: "msg_f", phase: "final_answer", role: "assistant", content: [] };
  const toolItem = { type: "function_call", id: "fc_1", call_id: "c1", name: "shell", arguments: "{}" };

  test("completed with only commentary and reasoning hops as degenerate", async () => {
    const result = await preflightComboStreamResponse(sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
      { type: "response.output_item.added", item: commentaryItem },
      { type: "response.output_text.delta", item_id: "msg_c", delta: "Now let me examine the skill" },
      { type: "response.output_item.done", item: commentaryItem },
      {
        type: "response.completed",
        response: { id: "r1", status: "completed", output: [
          { type: "reasoning", id: "rs_1" }, commentaryItem,
        ] },
      },
    ), logCtx, undefined, { degeneratePrelude: true });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      const body = await result.response.json();
      expect(body.error.code).toBe("degenerate_completion");
    }
  });

  test("completed with a final answer or tool call stays accepted", async () => {
    for (const item of [finalItem, toolItem]) {
      const result = await preflightComboStreamResponse(sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        { type: "response.output_item.added", item },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id: "r1", status: "completed", output: [item] } },
      ), logCtx, undefined, { degeneratePrelude: true });
      expect(result.kind).toBe("accepted");
    }
  });

  test("commentary followed by a tool call still commits the tool call", async () => {
    const result = await preflightComboStreamResponse(sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_item.added", item: commentaryItem },
      { type: "response.output_text.delta", item_id: "msg_c", delta: "checking" },
      { type: "response.output_item.added", item: toolItem },
      { type: "response.output_item.done", item: toolItem },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [commentaryItem, toolItem] } },
    ), logCtx, undefined, { degeneratePrelude: true });
    expect(result.kind).toBe("accepted");
  });

  test("incomplete with only commentary output hops as degenerate", async () => {
    const result = await preflightComboStreamResponse(sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_item.added", item: commentaryItem },
      { type: "response.output_item.done", item: commentaryItem },
      {
        type: "response.incomplete",
        response: {
          id: "r1", status: "incomplete",
          incomplete_details: { reason: "upstream_stall_timeout" },
          output: [commentaryItem],
        },
      },
    ), logCtx, undefined, { degeneratePrelude: true });
    expect(result.kind).toBe("failed");
  });

  test("incomplete degenerate hop also works alongside requiredToolPrelude", async () => {
    const result = await preflightComboStreamResponse(sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_item.added", item: commentaryItem },
      { type: "response.output_item.done", item: commentaryItem },
      {
        type: "response.incomplete",
        response: {
          id: "r1", status: "incomplete",
          incomplete_details: { reason: "upstream_stall_timeout" },
          output: [commentaryItem],
        },
      },
    ), logCtx, undefined, { degeneratePrelude: true, requiredToolPrelude: true });
    expect(result.kind).toBe("failed");
  });

  test("a tool call present only at event level blocks the degenerate hop", async () => {
    const result = await preflightComboStreamResponse(sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      {
        type: "response.incomplete",
        output: [toolItem],
        response: { id: "r1", status: "incomplete", output: [] },
      },
    ), logCtx, undefined, { degeneratePrelude: true });
    expect(result.kind).toBe("accepted");
  });

  test("non-retryable and output-limit incompletes never hop as degenerate", async () => {
    for (const terminal of [
      { incomplete_details: { reason: "max_output_tokens" }, output: [commentaryItem] },
      { incomplete_details: { reason: "upstream_stall_timeout", retryable: false }, output: [commentaryItem] },
      { end_turn: false, incomplete_details: { reason: "upstream_stall_timeout" }, output: [commentaryItem] },
      { incomplete_details: { reason: "content_filter" }, output: [commentaryItem] },
    ]) {
      const result = await preflightComboStreamResponse(sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        { type: "response.output_item.added", item: commentaryItem },
        { type: "response.output_item.done", item: commentaryItem },
        { type: "response.incomplete", response: { id: "r1", status: "incomplete", ...terminal } },
      ), logCtx, undefined, { degeneratePrelude: true });
      expect(result.kind).toBe("accepted");
    }
  });

  test("malformed reasons and non-retryable stall terminals stay accepted", async () => {
    for (const terminal of [
      { incomplete_details: { reason: { toString: null } }, output: [] },
      { incomplete_details: { reason: "upstream_stall_timeout", retryable: false }, output: [] },
      { end_turn: false, incomplete_details: { reason: "adapter_eof" }, output: [] },
    ]) {
      const result = await preflightComboStreamResponse(sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        { type: "response.incomplete", response: { id: "r1", status: "incomplete", ...terminal } },
      ), logCtx, undefined, { degeneratePrelude: true });
      expect(result.kind).toBe("accepted");
    }
  });

  test.each([
    { incomplete_details: { retryable: false } },
    { end_turn: false },
  ])("a missing incomplete reason preserves explicit replay guards (%j)", async terminal => {
    const result = await preflightComboStreamResponse(sse(
      { type: "response.incomplete", response: { status: "incomplete", output: [], ...terminal } },
    ), logCtx, undefined, { degeneratePrelude: true });
    expect(result.kind).toBe("accepted");
  });

  test("a paused turn with no incomplete reason stays accepted", async () => {
    const paused = { ...logCtx };
    rememberPausedTurn(paused);
    const result = await preflightComboStreamResponse(sse(
      { type: "response.incomplete", response: { status: "incomplete", output: [] } },
    ), paused, undefined, { degeneratePrelude: true });
    expect(result.kind).toBe("accepted");
  });

  test("an event-level non-retryable verdict keeps a nested incomplete on its target", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "response.incomplete",
      incomplete_details: { reason: "upstream_stall_timeout", retryable: false },
      response: { status: "incomplete", output: [] },
    }), logCtx, undefined, { degeneratePrelude: true });
    expect(result.kind).toBe("accepted");
  });

  test.each([false, true])("unrecognized event types commit before a retryable terminal (required tool: %j)", async requiredToolPrelude => {
    const response = sse(
      { type: ["response.reasoning_text.delta"], delta: "opaque progress" },
      { type: "response.incomplete", response: { status: "incomplete", output: [] } },
    );
    const expected = await response.clone().text();
    const result = await preflightComboStreamResponse(response, logCtx, undefined, { degeneratePrelude: true, requiredToolPrelude });
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("without degeneratePrelude a commentary completion stays accepted", async () => {
    const result = await preflightComboStreamResponse(sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_item.added", item: commentaryItem },
      { type: "response.output_item.done", item: commentaryItem },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [commentaryItem] } },
    ), logCtx);
    expect(result.kind).toBe("accepted");
  });

  test("degenerate prelude bounds reasoning hold to preserve time-to-first-byte", async () => {
    jest.useFakeTimers();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const reasoningChunk = new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: "pondering" })}\n\n`);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; controller.enqueue(reasoningChunk); },
    }), { headers: { "content-type": "text/event-stream" } });

    const pending = preflightComboStreamResponse(response, logCtx, undefined, {
      degeneratePrelude: true,
      signal: abort.signal,
    });
    let result: Awaited<typeof pending> | undefined;
    void pending.then(value => { result = value; }, () => {});

    try {
      const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
      await flush();
      expect(result).toBeUndefined();

      // Advancing to 999ms should still be waiting
      jest.advanceTimersByTime(999);
      await flush();
      expect(result).toBeUndefined();

      // At 1000ms (COMBO_REQUIRED_TOOL_REASONING_HOLD_MS), deadline expires and stream is accepted
      jest.advanceTimersByTime(1);
      await flush();
      expect(result?.kind).toBe("accepted");

      const reader = result!.response.body!.getReader();
      expect((await reader.read()).value).toEqual(reasoningChunk);
      source.close();
    } finally {
      abort.abort();
      await pending.catch(() => {});
      jest.useRealTimers();
    }
  });
});
