import { expect, jest, test } from "bun:test";
import { preflightComboStreamResponse } from "../../src/server/responses/combo-stream-preflight";

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
