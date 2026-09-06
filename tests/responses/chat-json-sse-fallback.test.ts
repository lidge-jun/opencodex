import { afterEach, expect, test } from "bun:test";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { translatorObservedBufferSnapshot } from "../../src/lib/translator-budget";
import type { OcxConfig } from "../../src/types";

let upstream: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { await upstream?.stop(true); upstream = undefined; });

interface Chunk {
  choices: Array<{ index: number; delta: {
    role?: string; content?: string; reasoning_content?: string;
    tool_calls?: Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }>;
  }; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

async function streamFixture(output: unknown[], status = "completed", cancel = false): Promise<Chunk[]> {
  const budgetBefore = translatorObservedBufferSnapshot().currentBytes;
  let requests = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/v1/responses");
    expect((await req.json() as { stream: boolean }).stream).toBe(true);
    requests++;
    return Response.json({ id: "resp_fixture", status, output,
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      usage: { input_tokens: 11, output_tokens: 7 } });
  } });
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
    adapter: "openai-responses", baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true, models: ["model"],
  } } };
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", stream: true, messages: [{ role: "user", content: "fixture" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] }),
  }), config, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (cancel) {
    await response.body!.cancel("fixture cancellation");
    expect(requests).toBe(1);
    expect(translatorObservedBufferSnapshot().currentBytes).toBe(budgetBefore);
    return [];
  }
  const text = await response.text();
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
