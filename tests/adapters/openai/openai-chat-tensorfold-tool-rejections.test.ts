import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { buildResponseJSON, bridgeToResponsesSSE } from "../../../src/bridge";
import { preflightComboStreamResponse } from "../../../src/server/responses/combo-stream-preflight";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";
import type { AdapterEvent, OcxToolChoice } from "../../../src/types";

const rejected = { tool_call_rejections: [{ reason: "unknown_tool_name", name: "tools.apply_patch" }] };
const markup = "<tool_call>tools.apply_patch<arg_key>input</arg_key><arg_value>synthetic private argument</arg_value></tool_call>";
const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 };
interface Options { diagnostic?: unknown; tools?: boolean; choice?: OcxToolChoice; realCall?: boolean; sameChunk?: boolean }

async function parse(stream: boolean, options: Options = {}): Promise<AdapterEvent[]> {
  const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1" });
  await adapter.buildRequest({ modelId: "local-model-alias", stream, options: { toolChoice: options.choice }, context: {
    messages: [], tools: options.tools === false ? [] : [{ name: "exec", description: "Run JavaScript", freeform: true, parameters: {} }],
  } });
  const tool_calls = options.realCall ? [{ id: "actual_call", index: 0, type: "function", function: { name: "exec", arguments: '{"input":"text(42);"}' } }] : undefined;
  const budget = createTestTranslatorBudget();
  if (!stream) return adapter.parseResponse!(Response.json({
    choices: [{ message: { content: markup, tool_calls }, finish_reason: options.realCall ? "tool_calls" : "stop" }],
    usage, tensorfold: options.diagnostic,
  }), budget);
  const chunks = [
    { choices: [{ delta: { content: markup, tool_calls } }] },
    { choices: [{ delta: {}, finish_reason: options.realCall ? "tool_calls" : "stop" }], usage,
      ...(options.sameChunk ? { tensorfold: options.diagnostic } : {}) },
    ...(!options.sameChunk ? [{ choices: [], tensorfold: options.diagnostic }] : []),
  ];
  const wire = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return Array.fromAsync(adapter.parseStream(new Response(wire), budget));
}

for (const stream of [false, true]) {
  test(`TensorFold rejected calls fail explicitly with usage (stream=${stream})`, async () => {
    const events = await parse(stream, { diagnostic: rejected });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "upstream_tool_call_rejected", retryable: false,
      usage: { inputTokens: 7, outputTokens: 2 } });
    expect(events.some(event => event.type === "done" || event.type === "tool_call_start")).toBe(false);
    const terminal = events.at(-1);
    expect(terminal?.type === "error" && terminal.message).not.toContain("synthetic private argument");
    expect(terminal?.type === "error" && terminal.message).not.toContain("tools.apply_patch");
  });
  const preserved: [string, Options][] = [
    ["literal markup without diagnostics", {}],
    ["empty rejection list", { diagnostic: { tool_call_rejections: [] } }],
    ["unrelated statistics", { diagnostic: { prefill_s: 1 } }],
    ["malformed diagnostic", { diagnostic: { tool_call_rejections: [{ reason: "unknown_tool_name", name: {} }] } }],
    ["no tools", { tools: false, diagnostic: rejected }],
    ["tool_choice none", { choice: "none", diagnostic: rejected }],
  ];
  for (const [label, options] of preserved) test(`${label} preserves text (stream=${stream})`, async () => {
    const events = await parse(stream, options);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe(markup);
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  });
  test(`real calls keep their identity without diagnostics (stream=${stream})`, async () => {
    const events = await parse(stream, { realCall: true });
    expect(events.find(event => event.type === "tool_call_start")).toMatchObject({ id: "actual_call", name: "exec" });
    expect(events.at(-1)?.type).toBe("done");
  });
}
test("a diagnostic in the final choices chunk also fails", async () => {
  expect((await parse(true, { diagnostic: rejected, sameChunk: true })).at(-1)).toMatchObject({ type: "error", code: "upstream_tool_call_rejected" });
});
test("late rejection does not replay already delivered structured calls", async () => {
  const events = await parse(true, { diagnostic: rejected, realCall: true });
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
});
test("buffered Responses consumers receive a failed status", async () => {
  expect(buildResponseJSON(await parse(false, { diagnostic: rejected }), "fixture")).toMatchObject({ status: "failed", error: { code: "upstream_tool_call_rejected" } });
});
test("streamed Responses consumers receive failed rather than completed", async () => {
  const events = await parse(true, { diagnostic: rejected });
  async function* source() { yield* events; }
  const wire = await new Response(bridgeToResponsesSSE(source(), "fixture")).text();
  expect(wire).toContain("event: response.failed");
  expect(wire).not.toContain("event: response.completed");
});
test("zero-output rejections never trigger a combo replay", async () => {
  async function* source(): AsyncGenerator<AdapterEvent> {
    yield { type: "error", code: "upstream_tool_call_rejected", errorType: "upstream_error", status: 502,
      message: "TensorFold rejected an unoffered tool", retryable: false };
  }
  const response = new Response(bridgeToResponsesSSE(source(), "fixture"), { headers: { "content-type": "text/event-stream" } });
  const result = await preflightComboStreamResponse(response, { provider: "fixture", model: "fixture" });
  expect(result.kind).toBe("accepted");
  if (result.kind === "accepted") await result.response.body?.cancel();
});
