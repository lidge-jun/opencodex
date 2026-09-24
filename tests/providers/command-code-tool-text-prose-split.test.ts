import { describe, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { CommandCodeToolTextFilter } from "../../src/adapters/command-code-tool-text";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const provider: OcxProviderConfig = {
  adapter: "command-code",
  baseUrl: "https://api.commandcode.ai",
  authMode: "oauth",
  apiKey: "secret-command-key",
};

const JS = "const r = await tools.exec_command({cmd:\"sed -n '1,40p' src/a.ts\"});\ntext(r.output);";
const MARKUP = "<tool_call><function=exec>" + JS + "</function></tool_call>";

// Captured 2026-09-23 from xiaomi/mimo-v2.6-pro through the live proxy: the echoed envelope lost the
// parameter key, its ">" and its closing tag, so the body runs to </tool_call> and cannot parse.
const MALFORMED = [
  "<tool_call><function=exec><parameter= results = await Promise.all([",
  "  tools.exec_command({cmd:\"sed -n '1,40p' src/a.ts\"})",
  "]);",
  "results.forEach((r, i) => text(r.output)); </tool_call>",
].join("\n");

const EXEC_TOOL = { name: "exec", description: "Run JavaScript", freeform: true,
  parameters: { type: "object", properties: { input: { type: "string", description: "Raw freeform input for this tool." } }, required: ["input"] } };

const READ_TOOL = { name: "read", description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

function ndjson(events: unknown[]): Response {
  return new Response(events.map(event => JSON.stringify(event)).join("\n"));
}

function parsed(): OcxParsedRequest {
  return {
    modelId: "xiaomi/mimo-v2.6-flash",
    stream: true,
    context: { systemPrompt: ["system"], messages: [{ role: "user", content: "go", timestamp: 1 }], tools: [EXEC_TOOL] },
    options: { maxOutputTokens: 100 },
  };
}

/** Run events through one adapter instance the way the server does: buildRequest, fetchResponse, parseStream. */
async function adapterEvents(events: unknown[]): Promise<AdapterEvent[]> {
  const adapter = createCommandCodeAdapter({ ...provider, fetch: (async () => ndjson(events)) as typeof fetch } as OcxProviderConfig);
  const request = await adapter.buildRequest(parsed());
  const response = await adapter.fetchResponse!(request);
  const out: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(response, createTestTranslatorBudget())) out.push(event);
  return out;
}

const texts = (events: AdapterEvent[]) => events.filter(event => event.type === "text_delta").map(event => (event as { text: string }).text).join("");
const calls = (events: AdapterEvent[]) => {
  const out: Array<{ id: string; name: string; args: string }> = [];
  for (const event of events) {
    if (event.type === "tool_call_start") out.push({ id: event.id, name: event.name, args: "" });
    if (event.type === "tool_call_delta") out[out.length - 1]!.args += event.arguments;
  }
  return out;
};
const done = (events: AdapterEvent[]) => events.find(event => event.type === "done") as { stopReason?: string } | undefined;

const textBlock = (text: string) => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text },
  { type: "text-end", id: "t" },
];

/** A filter that declares only the freeform exec tool, plus its budget for leak assertions. */
function execFilter() {
  const budget = createTestTranslatorBudget();
  return { budget, filter: new CommandCodeToolTextFilter(budget, new Map([["exec", { freeform: true, schema: EXEC_TOOL.parameters }]])) };
}

/** A filter that also declares a second tool, for native calls that are not the envelope's. */
function twoToolFilter() {
  const budget = createTestTranslatorBudget();
  return { budget, filter: new CommandCodeToolTextFilter(budget, new Map([
    ["exec", { freeform: true, schema: EXEC_TOOL.parameters }],
    ["read", { freeform: false, schema: READ_TOOL.parameters }],
  ])) };
}

describe("Command Code markup echoed after prose in one text block", () => {
  const PROSE = "Running it now.\n";
  const proseMarkup = PROSE + MARKUP;

  test("drops the markup and keeps the prose when the native call carries the same input", async () => {
    const events = await adapterEvents([
      { type: "tool-input-start", id: "call_c1", toolName: "exec" },
      ...textBlock(proseMarkup),
      { type: "tool-call", toolCallId: "call_c1", toolName: "exec", input: JS, dynamic: true, invalid: true },
      { type: "finish", rawFinishReason: "tool_calls" },
    ]);
    expect(texts(events)).toBe(PROSE);
    expect(calls(events)).toEqual([{ id: "call_c1", name: "exec", args: JS }]);
    expect(done(events)?.stopReason).toBe("tool_calls");
  });

  test("restores the trailing markup as a call on a clean finish", async () => {
    const events = await adapterEvents([...textBlock(proseMarkup), { type: "finish", rawFinishReason: "stop" }]);
    expect(texts(events)).toBe(PROSE);
    const [call] = calls(events);
    expect(call).toMatchObject({ name: "exec", args: JSON.stringify({ input: JS }) });
    expect(call!.id).toMatch(/^call_ocx_[0-9a-f]{32}$/);
    expect(done(events)?.stopReason).toBe("tool_calls");
  });

  test("holds a marker that opens a fresh block after streamed prose", () => {
    const { budget, filter } = execFilter();
    expect(filter.textDelta("t", "Running it now.")).toEqual([{ type: "text_delta", text: "Running it now." }]);
    // The streamed block used to pass the marker straight through instead of holding it.
    expect(filter.textDelta("t", MARKUP)).toEqual([]);
    const finished = filter.finish();
    expect(finished.salvaged).toBe(true);
    expect(finished.events.map(event => event.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end"]);
    expect(texts(finished.events)).toBe("");
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("keeps markup behind a newline on the ordinary hold path", async () => {
    const events = await adapterEvents([...textBlock("\n" + MARKUP), { type: "finish", rawFinishReason: "stop" }]);
    expect(texts(events)).toBe("");
    expect(calls(events)).toMatchObject([{ name: "exec", args: JSON.stringify({ input: JS }) }]);
    expect(done(events)?.stopReason).toBe("tool_calls");
  });

  test("keeps a held block through an interleaved reasoning event", () => {
    const { budget, filter } = execFilter();
    const thinking: AdapterEvent = { type: "thinking_delta", thinking: "about to call exec" };
    expect(filter.textStart("t")).toEqual([]);
    expect(filter.textDelta("t", MARKUP)).toEqual([]);
    // Reasoning used to break the held block open and put the echoed call on screen as text.
    expect(filter.enqueueEvent(thinking, "about to call exec")).toEqual([]);
    expect(filter.textEnd("t")).toEqual([]);
    const finished = filter.finish();
    expect(finished.salvaged).toBe(true);
    expect(finished.events.map(event => event.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end", "thinking_delta"]);
    expect(texts(finished.events)).toBe("");
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});

describe("Command Code malformed envelope echo", () => {
  test("drops a malformed envelope when the native call arrives for it", async () => {
    const events = await adapterEvents([
      { type: "tool-input-start", id: "call_c1", toolName: "exec" },
      ...textBlock(MALFORMED),
      { type: "tool-call", toolCallId: "call_c1", toolName: "exec", input: JS, dynamic: true, invalid: true },
      { type: "finish", rawFinishReason: "tool_calls" },
    ]);
    expect(texts(events)).toBe("");
    expect(calls(events)).toEqual([{ id: "call_c1", name: "exec", args: JS }]);
    expect(done(events)?.stopReason).toBe("tool_calls");
  });

  test("releases a malformed envelope when the native call is for another tool", () => {
    const { budget, filter } = twoToolFilter();
    const args = JSON.stringify({ path: "src/a.ts" });
    expect(filter.textDelta("t", MALFORMED)).toEqual([]);
    expect(filter.textEnd("t")).toEqual([]);
    // A read call proves nothing about an exec envelope, so it must not consume the echo the way a
    // matching exec call does: the text is released rather than dropped, still ahead of the call.
    const events = [...filter.nativeCall("call_r1", "read", args), ...filter.releaseAll()];
    expect(texts(events)).toBe(MALFORMED);
    expect(calls(events)).toEqual([{ id: "call_r1", name: "read", args }]);
    expect(events.findIndex(event => event.type === "text_delta"))
      .toBeLessThan(events.findIndex(event => event.type === "tool_call_start"));
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("drops a malformed envelope when the native call names it", () => {
    const { budget, filter } = twoToolFilter();
    expect(filter.textDelta("t", MALFORMED)).toEqual([]);
    expect(filter.textEnd("t")).toEqual([]);
    const events = [...filter.nativeCall("call_c1", "exec", JS), ...filter.releaseAll()];
    expect(texts(events)).toBe("");
    expect(calls(events)).toEqual([{ id: "call_c1", name: "exec", args: JS }]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("drops a malformed envelope on a clean finish instead of restoring it", async () => {
    const events = await adapterEvents([...textBlock(MALFORMED), { type: "finish", rawFinishReason: "stop" }]);
    expect(texts(events)).toBe("");
    expect(calls(events)).toEqual([]);
    expect(done(events)?.stopReason).toBe("stop");
  });

  test("releases a marker pair with no function name as text", async () => {
    const junk = "<tool_call>junk</tool_call>";
    const events = await adapterEvents([...textBlock(junk), { type: "finish", rawFinishReason: "stop" }]);
    expect(texts(events)).toBe(junk);
    expect(calls(events)).toEqual([]);
  });

  test("releases a never-closing envelope as text", async () => {
    const partial = "<tool_call><function=exec>abc";
    const events = await adapterEvents([...textBlock(partial), { type: "finish", rawFinishReason: "stop" }]);
    expect(texts(events)).toBe(partial);
    expect(calls(events)).toEqual([]);
  });
});
