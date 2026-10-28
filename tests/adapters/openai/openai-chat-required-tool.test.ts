import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { withRequiredChatToolResult } from "../../../src/adapters/openai-chat/required-tool-result";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxToolChoice } from "../../../src/types";

const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 };
const tools = Array.from({ length: 151 }, (_, i) => ({ name: `marker_${i}`, description: "Synthetic marker", parameters: { type: "object", properties: {} } }));
const request = (choice: OcxToolChoice | undefined): OcxParsedRequest => ({ modelId: "fixture", stream: false,
  context: { messages: [{ role: "user", content: "Use a marker", timestamp: 0 }], tools }, options: { toolChoice: choice } });

test("an explicitly unfinished call cannot satisfy a required client call", async () => {
  const adapter = withRequiredChatToolResult({
    name: "fixture", buildRequest: () => ({ url: "https://fixture.invalid", method: "POST", headers: {}, body: "{}" }),
    async *parseStream() {
      yield { type: "tool_call_start", id: "call", name: "marker_0" };
      yield { type: "tool_call_delta", arguments: "{}" };
      yield { type: "tool_call_end", incomplete: true };
      yield { type: "done" };
    },
  });
  await adapter.buildRequest(request("required"));
  const events = await Array.fromAsync(adapter.parseStream(new Response(), createTestTranslatorBudget()));
  expect(events.at(-1)).toMatchObject({ type: "error", code: "required_tool_not_called" });
});
async function parse(choice: OcxToolChoice | undefined, stream: boolean, call?: string, finish = "stop") {
  const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key" });
  await adapter.buildRequest(request(choice), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() });
  const fn = { id: "call_fixture", type: "function", function: { name: call, arguments: "{}" } };
  if (!stream) return adapter.parseResponse!(Response.json({ choices: [{ message: { content: "visible text", ...(call ? { tool_calls: [fn] } : {}) }, finish_reason: finish }], usage }), createTestTranslatorBudget());
  const chunks = [
    { choices: [{ delta: { content: "visible text" }, finish_reason: null }] },
    ...(call ? [{ choices: [{ delta: { tool_calls: [{ ...fn, index: 0 }] }, finish_reason: null }] }] : []),
    { choices: [{ delta: {}, finish_reason: finish }], usage },
  ];
  const response = new Response(chunks.map(x => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const events: AdapterEvent[] = [];
  for await (const e of adapter.parseStream(response, createTestTranslatorBudget())) events.push(e);
  return events;
}
for (const stream of [false, true]) {
  test(`required tool missing is a typed terminal failure with usage (stream=${stream})`, async () => {
    const events = await parse("required", stream);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "required_tool_not_called", usage: { inputTokens: 7, outputTokens: 2 } });
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(events.some(e => e.type === "text_delta" && e.text === "visible text")).toBe(true);
  });
  test(`a named mandatory request without a call fails (stream=${stream})`, async () => {
    expect((await parse({ name: "marker_0" }, stream)).at(-1)).toMatchObject({ type: "error", code: "required_tool_not_called" });
  });
  for (const choice of ["auto", "none", undefined] as const) test(`ordinary text succeeds for ${choice} (stream=${stream})`, async () => {
    expect((await parse(choice, stream)).at(-1)?.type).toBe("done");
  });
  for (const choice of ["required", { name: "marker_150" }, { allowedTools: ["marker_150"], mode: "required" }] as const) test(`a declared required tool survives the full 151-tool catalog (stream=${stream}, choice=${JSON.stringify(choice)})`, async () => {
    const events = await parse(choice, stream, "marker_150", "tool_calls");
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter(e => e.type === "tool_call_start")).toHaveLength(1);
  });
  for (const finish of ["length", "content_filter"]) test(`non-success terminal ${finish} retains its existing outcome (stream=${stream})`, async () => {
    expect((await parse("required", stream, undefined, finish)).at(-1)).toMatchObject({ type: "done", stopReason: finish === "length" ? "max_tokens" : "content_filter" });
  });
}
