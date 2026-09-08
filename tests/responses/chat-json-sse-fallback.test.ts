import { afterEach, expect, test } from "bun:test";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { createTranslatorBudget, isTranslatorBudgetExceededError, translatorObservedBufferSnapshot } from "../../src/lib/translator-budget";
import type { OcxConfig } from "../../src/types";
import { responsesJsonToChatCompletion, isChatCompletionsStreamError } from "../../src/chat/outbound";
import { jsonCompletionSse } from "../../src/server/chat-native-sse";
import { getRequestLogEntries } from "../../src/server/request-log";
import { readUsageEntries } from "../../src/usage/log";

let upstream: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { await upstream?.stop(true); upstream = undefined; });

interface Chunk {
  choices: Array<{ index: number; delta: {
    role?: string; content?: string; reasoning_content?: string;
    tool_calls?: Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }>;
  }; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

async function streamFixture(output: unknown[], status = "completed", cancel = false, reason = "max_output_tokens", delivery: { jsonFinish?: string; error?: boolean; errorCode?: string } = {}): Promise<Chunk[]> {
  const budgetBefore = translatorObservedBufferSnapshot().currentBytes;
  const requestId = `chat-json-fixture-${crypto.randomUUID()}`;
  let requests = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/v1/responses");
    expect((await req.json() as { stream: boolean }).stream).toBe(true);
    requests++;
    return Response.json({ id: "resp_fixture", status, output,
      ...(status === "incomplete" ? { incomplete_details: { reason } } : {}),
      usage: { input_tokens: 11, output_tokens: 7 } });
  } });
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
    adapter: "openai-responses", baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true, models: ["model"],
  } } };
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", stream: !delivery.jsonFinish, messages: [{ role: "user", content: "fixture" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] }),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  const assertSingleFinal = () => {
    const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(delivery.error ? 502 : 200);
    const persisted = readUsageEntries().filter(entry => entry.requestId === requestId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe(delivery.error ? 502 : 200);
  };
  if (delivery.error) {
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { type: "upstream_error", code: delivery.errorCode ?? "upstream_incomplete" } });
    assertSingleFinal();
    expect(requests).toBe(1);
    expect(translatorObservedBufferSnapshot().currentBytes).toBe(budgetBefore);
    return [];
  }
  expect(response.status).toBe(200);
  if (delivery.jsonFinish) {
    expect(await response.json()).toMatchObject({ choices: [{ finish_reason: delivery.jsonFinish }] });
    assertSingleFinal();
    expect(requests).toBe(1);
    expect(translatorObservedBufferSnapshot().currentBytes).toBe(budgetBefore);
    return [];
  }
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (cancel) {
    await response.body!.cancel("fixture cancellation");
    assertSingleFinal();
    expect(requests).toBe(1);
    expect(translatorObservedBufferSnapshot().currentBytes).toBe(budgetBefore);
    return [];
  }
  const text = await response.text();
  assertSingleFinal();
  expect(translatorObservedBufferSnapshot().currentBytes).toBe(budgetBefore);
  expect(requests).toBe(1);
  const payloads = text.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6));
  expect(payloads.filter(value => value === "[DONE]")).toHaveLength(1);
  expect(payloads.at(-1)).toBe("[DONE]");
  const chunks = payloads.filter(value => value !== "[DONE]").map(value => JSON.parse(value) as Chunk);
  expect(chunks.flatMap(chunk => chunk.choices).filter(choice => choice.finish_reason !== null)).toHaveLength(1);
  expect(chunks.at(-1)?.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  return chunks;
}

test.each([1, 2])("JSON-to-SSE keeps %s indexed tool calls and tool_calls finish", async count => {
  const calls = Array.from({ length: count }, (_, index) => ({ type: "function_call",
    call_id: `call_fixture_${index}`, name: "lookup", arguments: JSON.stringify({ index }) }));
  const chunks = await streamFixture(calls);
  expect(chunks.flatMap(chunk => chunk.choices.flatMap(choice => choice.delta.tool_calls ?? [])))
    .toEqual(calls.map((call, index) => ({ index, id: call.call_id, type: "function",
      function: { name: call.name, arguments: call.arguments } })));
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
});

test("JSON-to-SSE keeps reasoning alongside answer text", async () => {
  const chunks = await streamFixture([
    { type: "reasoning", summary: [{ type: "summary_text", text: "Fixture reasoning." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer." }] },
  ]);
  expect(chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta.reasoning_content ?? "").join(""))
    .toBe("Fixture reasoning.");
  expect(chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta.content ?? "").join(""))
    .toBe("Answer.");
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
});

test("JSON-to-SSE preserves length instead of claiming a normal stop", async () => {
  const chunks = await streamFixture([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Partial answer." }] },
  ], "incomplete");
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("length");
});

test("JSON-to-SSE preserves ordinary text and a single empty completion terminal", async () => {
  const chunks = await streamFixture([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ordinary text." }] },
  ]);
  expect(chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta.content ?? "").join(""))
    .toBe("Ordinary text.");
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
});

test("JSON-to-SSE empty completion still terminates once", async () => {
  const chunks = await streamFixture([]);
  expect(chunks).toHaveLength(2);
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
});

test("JSON-to-SSE cancellation releases the existing translation budget", async () => {
  await streamFixture([{ type: "function_call", call_id: "call_cancel", name: "lookup", arguments: "{}" }], "completed", true);
});

// Expected finish values come from the official Chat contract, not the converter.
test.each([
  ["max_output_tokens", "length"],
  ["content_filter", "content_filter"],
])("JSON-to-SSE incomplete %s takes precedence over a partial tool call", async (reason, finish) => {
  const chunks = await streamFixture([
    { type: "function_call", call_id: "call_partial", name: "lookup", arguments: '{"unfinished":' },
  ], "incomplete", false, reason);
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe(finish);
});

test.each(["max_output_tokens", "content_filter"])("JSON projection preserves incomplete %s with tools", reason => {
  const completion = responsesJsonToChatCompletion({ status: "incomplete", incomplete_details: { reason },
    output: [{ type: "function_call", call_id: "call_partial", name: "lookup", arguments: "{}" }],
  }, "fixture/model");
  expect(completion.choices).toMatchObject([{ finish_reason: reason === "max_output_tokens" ? "length" : "content_filter" }]);
});

test.each([undefined, "max_messages", "steered", "adapter_eof"])("JSON projection does not invent length for %s", reason => {
  try {
    responsesJsonToChatCompletion({ status: "incomplete", incomplete_details: { reason }, output: [] }, "fixture/model");
    throw new Error("expected typed truncation");
  } catch (error) {
    expect(isChatCompletionsStreamError(error)).toBe(true);
    expect(error).toMatchObject({ status: 502, type: "upstream_error", code: "upstream_incomplete" });
  }
});

test("shared JSON-to-SSE serializer assigns tool indices and charges positive retained output", () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 8192 });
  try {
    const converted = responsesJsonToChatCompletion({ status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: "Fixture answer" }] },
      { type: "function_call", call_id: "call_one", name: "lookup", arguments: "{}" },
    ] }, "model", budget);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    const text = jsonCompletionSse(converted, "model", budget);
    const chunks = text.split("\n").filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6)) as Chunk);
    const calls = chunks.flatMap(c => c.choices.flatMap(x => x.delta.tool_calls ?? []));
    expect(calls[0]?.index).toBe(0);
    expect(budget.snapshot().currentBytes).toBeGreaterThanOrEqual(Buffer.byteLength(text) * 2);
    expect(budget.snapshot().highWaterBytes).toBeLessThanOrEqual(8192);
  } finally { budget.dispose(); }
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("shared JSON-to-SSE serializer rejects an oversized terminal batch before returning success", () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 128 });
  try {
    expect(() => jsonCompletionSse({ choices: [{ message: { content: "fixture" }, finish_reason: "stop" }] }, "model", budget))
      .toThrow();
    expect(budget.snapshot().overflows).toBe(1);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("JSON projection rejects retained output overflow with the existing typed budget error", () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 16 });
  try {
    let failure: unknown;
    try { responsesJsonToChatCompletion({ output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(32) }] }] }, "model", budget); }
    catch (error) { failure = error; }
    expect(isTranslatorBudgetExceededError(failure)).toBe(true);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});


test.each(["max_messages", "steered", "adapter_eof"])("handler reports unsupported incomplete %s as a typed error", async reason => {
  await streamFixture([], "incomplete", false, reason, { error: true });
});

test.each([["max_output_tokens", "length"], ["content_filter", "content_filter"]])(
  "JSON client receives %s boundary rather than tool_calls", async (reason, finish) => {
    await streamFixture([{ type: "function_call", call_id: "call_partial", name: "lookup", arguments: "{}" }],
      "incomplete", false, reason, { jsonFinish: finish });
  },
);


test("JSON projection accounts split Unicode and ignores empty fragments", () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 8192 });
  try {
    const completion = responsesJsonToChatCompletion({ output: [
      { type: "message", content: [
        { type: "output_text", text: "\ud83d" },
        ...Array.from({ length: 100 }, () => ({ type: "output_text", text: "" })),
        { type: "output_text", text: "\ude00" },
      ] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "\ud83d" }, { type: "summary_text", text: "\ude00" }] },
    ] }, "model", budget);
    expect(completion.choices).toMatchObject([{ message: { content: "😀", reasoning_content: "😀" } }]);
    expect(budget.snapshot().currentBytes).toBe(8);
  } finally { budget.dispose(); }
});


test("buffered calls enforce their per-call cap, including an empty upstream ID", () => {
  for (const call_id of ["fixture-call", ""]) {
    const budget = createTranslatorBudget({ maxCallArgumentBytes: 4, maxTurnBytes: 8192 });
    try {
      let failure: unknown;
      try {
        responsesJsonToChatCompletion({ output: [{ type: "function_call", call_id, name: "lookup", arguments: "12345" }] }, "model", budget);
      } catch (error) { failure = error; }
      expect(isTranslatorBudgetExceededError(failure)).toBe(true);
      expect(failure).toMatchObject({ code: "translation_buffer_limit", kind: "tool_args", limitBytes: 4 });
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().activeCalls).toBe(0);
      const result = responsesJsonToChatCompletion({ output: [{ type: "function_call", call_id, name: "lookup", arguments: "1234" }] }, "model", budget);
      expect(result.choices).toMatchObject([{ message: { tool_calls: [{ function: { arguments: "1234" } }] } }]);
      expect(budget.snapshot().activeCalls).toBe(0);
    } finally { budget.dispose(); }
  }
});

test("JSON-to-SSE rejects a call above 2 MiB without success output or duplicate usage", async () => {
  await streamFixture([{ type: "function_call", call_id: "large-call", name: "lookup", arguments: JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) }) }],
    "completed", false, "max_output_tokens", { error: true, errorCode: "translation_buffer_limit" });
});
