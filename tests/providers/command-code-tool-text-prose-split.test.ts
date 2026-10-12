import { describe, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { CommandCodeToolTextFilter, MAX_HELD_TOOL_TEXT_BYTES } from "../../src/adapters/command-code-tool-text";
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

describe("Command Code markup after prose in one text block", () => {
  const PROSE = "Running it now.\n";
  const proseMarkup = PROSE + MARKUP;

  test("strips the markup when the native call carries the same input", async () => {
    const events = await adapterEvents([
      { type: "tool-input-start", id: "call_c1", toolName: "exec" },
      ...textBlock(proseMarkup),
      { type: "tool-call", toolCallId: "call_c1", toolName: "exec", input: JS, dynamic: true, invalid: true },
      { type: "finish", rawFinishReason: "tool_calls" },
    ]);
    // The separate native call carries the execution, so the post-prose echo leaves the screen.
    expect(texts(events)).toBe(PROSE);
    expect(calls(events)).toEqual([{ id: "call_c1", name: "exec", args: JS }]);
    expect(done(events)?.stopReason).toBe("tool_calls");
  });

  test("keeps markup after prose as text when the native call is for another tool", () => {
    const { budget, filter } = twoToolFilter();
    const args = JSON.stringify({ path: "src/a.ts" });
    filter.toolInputStart("call_r1", "read");
    expect(filter.textDelta("t", PROSE)).toEqual([{ type: "text_delta", text: PROSE }]);
    // The tail is held for the dedup check, then released: a read call proves nothing about exec markup.
    expect(filter.textDelta("t", MARKUP)).toEqual([]);
    const events = [...filter.nativeCall("call_r1", "read", args), ...filter.releaseAll()];
    expect(texts(events)).toBe(MARKUP);
    expect(calls(events)).toEqual([{ id: "call_r1", name: "read", args }]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("a native call matching a post-prose marker strips the echo", () => {
    const { budget, filter } = execFilter();
    filter.toolInputStart("call_c1", "exec");
    expect(filter.textDelta("t", PROSE)).toEqual([{ type: "text_delta", text: PROSE }]);
    expect(filter.textDelta("t", MARKUP)).toEqual([]);
    const events = [...filter.nativeCall("call_c1", "exec", JS), ...filter.releaseAll()];
    expect(texts(events)).toBe("");
    expect(calls(events)).toEqual([{ id: "call_c1", name: "exec", args: JS }]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("flushes a newly opened tail when earlier held text fills the byte queue", () => {
    const { budget, filter } = execFilter();
    const earlier = "<tool_call>" + "x".repeat(MAX_HELD_TOOL_TEXT_BYTES - 48 - "<tool_call>".length);
    filter.toolInputStart("call_c1", "exec");
    expect(filter.textDelta("held", earlier)).toEqual([]);
    expect(filter.textEnd("held")).toEqual([]);
    expect(filter.textDelta("t", PROSE)).toEqual([]);
    // Earlier text uses bound - 48 bytes; prose leaves only 48 - PROSE.length bytes.
    expect(MARKUP.length).toBeGreaterThan(48 - PROSE.length);
    const released = filter.textDelta("t", MARKUP);
    expect(released).toEqual([
      { type: "text_delta", text: earlier },
      { type: "text_delta", text: PROSE },
      { type: "text_delta", text: MARKUP },
    ]);
    const native = filter.nativeCall("call_c1", "exec", JS);
    expect(texts([...released, ...native])).toBe(earlier + PROSE + MARKUP);
    expect(calls(native)).toEqual([{ id: "call_c1", name: "exec", args: JS }]);
    expect(filter.finish()).toEqual({ events: [], salvaged: false });
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("strips a post-prose echo whose native input starts while an unrelated input is open", () => {
    const { budget, filter } = twoToolFilter();
    const readArgs = JSON.stringify({ path: "src/a.ts" });
    filter.toolInputStart("call_r1", "read");
    const proseEvents = filter.textDelta("t", PROSE);
    expect(proseEvents).toEqual([{ type: "text_delta", text: PROSE }]);
    expect(filter.textDelta("t", MARKUP)).toEqual([]);
    expect(filter.textEnd("t")).toEqual([]);
    filter.toolInputStart("call_c1", "exec");
    const unrelated = filter.nativeCall("call_r1", "read", readArgs);
    // The echo's own input is still open, so the tail and the call queued behind it wait.
    expect(unrelated).toEqual([]);
    const events = [
      ...proseEvents,
      ...unrelated,
      ...filter.nativeCall("call_c1", "exec", JS),
      ...filter.releaseAll(),
    ];
    expect(texts(events)).toBe(PROSE);
    expect(calls(events)).toEqual([
      { id: "call_r1", name: "read", args: readArgs },
      { id: "call_c1", name: "exec", args: JS },
    ]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("releases a post-prose tail as text once every input it could echo has closed", () => {
    const { budget, filter } = twoToolFilter();
    const readArgs = JSON.stringify({ path: "src/a.ts" });
    filter.toolInputStart("call_r1", "read");
    expect(filter.textDelta("t", PROSE)).toEqual([{ type: "text_delta", text: PROSE }]);
    expect(filter.textDelta("t", MARKUP)).toEqual([]);
    expect(filter.textEnd("t")).toEqual([]);
    // The only open input closes without matching: the tail is released at once, before the
    // call queued behind it, instead of waiting for the end of the turn.
    const released = filter.nativeCall("call_r1", "read", readArgs);
    expect(texts(released)).toBe(MARKUP);
    expect(calls(released)).toEqual([{ id: "call_r1", name: "read", args: readArgs }]);
    expect(filter.finish().events).toEqual([]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("admits only one later input of the envelope's own tool, so starts cannot extend the wait", () => {
    const { budget, filter } = twoToolFilter();
    const readArgs = JSON.stringify({ path: "src/a.ts" });
    filter.toolInputStart("call_r1", "read");
    expect(filter.textDelta("t", PROSE)).toEqual([{ type: "text_delta", text: PROSE }]);
    expect(filter.textDelta("t", MARKUP)).toEqual([]);
    expect(filter.textEnd("t")).toEqual([]);
    // Of the inputs that start while the tail is held, only the first exec input is admitted.
    filter.toolInputStart("call_r2", "read");
    filter.toolInputStart("call_c1", "exec");
    filter.toolInputStart("call_c2", "exec");
    expect(filter.nativeCall("call_r1", "read", readArgs)).toEqual([]);
    // The admitted exec input closes with different content: the tail is released right away,
    // although call_r2 and call_c2 are still open.
    const released = filter.nativeCall("call_c1", "exec", "text(1);");
    expect(texts(released)).toBe(MARKUP);
    expect(calls(released)).toEqual([
      { id: "call_r1", name: "read", args: readArgs },
      { id: "call_c1", name: "exec", args: "text(1);" },
    ]);
    expect(filter.finish().events).toEqual([]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("splits a prose-prefixed marker inside a single delta", () => {
    const { budget, filter } = execFilter();
    expect(filter.textDelta("t", PROSE + MARKUP)).toEqual([{ type: "text_delta", text: PROSE }]);
    const finished = filter.finish();
    expect(finished.salvaged).toBe(false);
    expect(texts(finished.events)).toBe(MARKUP);
    expect(calls(finished.events)).toEqual([]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("preserves a quoted trailing envelope on a clean finish", async () => {
    const quoted = "Do not execute; this is only an example: > " + MARKUP;
    const events = await adapterEvents([...textBlock(quoted), { type: "finish", rawFinishReason: "stop" }]);
    expect(texts(events)).toBe(quoted);
    expect(calls(events)).toEqual([]);
    expect(done(events)?.stopReason).toBe("stop");
  });

  test("a marker that follows already streamed prose is held, not executed", () => {
    const { budget, filter } = execFilter();
    expect(filter.textDelta("t", "Running it now.")).toEqual([{ type: "text_delta", text: "Running it now." }]);
    // The echo is held for the dedup check, not streamed; with no matching call it is released.
    expect(filter.textDelta("t", MARKUP)).toEqual([]);
    const finished = filter.finish();
    expect(finished.salvaged).toBe(false);
    expect(finished.events).toEqual([{ type: "text_delta", text: MARKUP }]);
    expect(texts(finished.events)).toBe(MARKUP);
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

describe("post-prose marker prefixes", () => {
  const PROSE = "Running it now.\n";
  const MARKER = "<tool_call>";

  test.each(Array.from({ length: MARKER.length - 1 }, (_, index) => index + 1))(
    "holds a marker split after byte %i until its matching native call", split => {
      const { budget, filter } = execFilter();
      filter.toolInputStart("call_split", "exec");
      expect(filter.textDelta("t", PROSE + MARKUP.slice(0, split)))
        .toEqual([{ type: "text_delta", text: PROSE }]);
      expect(budget.snapshot().currentBytes).toBe(split);
      expect(filter.textDelta("t", MARKUP.slice(split))).toEqual([]);
      const events = [...filter.nativeCall("call_split", "exec", JS), ...filter.finish().events];
      expect(texts(events)).toBe("");
      expect(calls(events)).toEqual([{ id: "call_split", name: "exec", args: JS }]);
      expect(budget.snapshot().currentBytes).toBe(0);
    },
  );

  test("recognizes a marker delivered one byte at a time after prose", () => {
    const { budget, filter } = execFilter();
    const events = filter.textDelta("t", PROSE);
    for (const char of MARKUP) events.push(...filter.textDelta("t", char));
    events.push(...filter.nativeCall("native", "exec", JS), ...filter.finish().events);
    expect(texts(events)).toBe(PROSE);
    expect(calls(events)).toEqual([{ id: "native", name: "exec", args: JS }]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each(["end", "finish", "failure", "boundary"] as const)(
    "releases an incomplete prefix as text on %s", ending => {
      const { budget, filter } = execFilter();
      const events = filter.textDelta("t", PROSE + "<tool_");
      if (ending === "end") events.push(...filter.textEnd("t"));
      if (ending === "boundary") events.push(...filter.boundary());
      events.push(...(ending === "failure" ? filter.releaseAll() : filter.finish().events));
      expect(texts(events)).toBe(PROSE + "<tool_");
      expect(calls(events)).toEqual([]);
      expect(budget.snapshot().currentBytes).toBe(0);
    },
  );

  test("releases a disproven prefix before a later native call", () => {
    const { budget, filter } = execFilter();
    const events = [
      ...filter.textDelta("t", PROSE + "<tool_"),
      ...filter.textDelta("t", "example>"),
      ...filter.nativeCall("native", "exec", JS),
      ...filter.finish().events,
    ];
    expect(texts(events)).toBe(PROSE + "<tool_example>");
    expect(events.at(-1)?.type).toBe("tool_call_end");
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("a failed prefix does not hide the next complete marker", () => {
    const { budget, filter } = execFilter();
    const events = [
      ...filter.textDelta("t", PROSE + "<tool_"),
      ...filter.textDelta("t", "example> " + MARKUP),
      ...filter.nativeCall("native", "exec", JS),
      ...filter.finish().events,
    ];
    expect(texts(events)).toBe(PROSE + "<tool_example> ");
    expect(calls(events)).toEqual([{ id: "native", name: "exec", args: JS }]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each([true, false])("an unmatched split envelope stays inert on clean=%s", clean => {
    const { budget, filter } = execFilter();
    const events = [
      ...filter.textDelta("t", PROSE + "<tool_"),
      ...filter.textDelta("t", MARKUP.slice(6)),
      ...(clean ? filter.finish().events : filter.releaseAll()),
    ];
    expect(texts(events)).toBe(PROSE + MARKUP);
    expect(calls(events)).toEqual([]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("reasoning interrupts an unresolved prefix without changing output order", () => {
    const { budget, filter } = execFilter();
    const thinking: AdapterEvent = { type: "thinking_delta", thinking: "thinking" };
    const events = [
      ...filter.textDelta("t", PROSE + "<tool_"),
      ...filter.enqueueEvent(thinking, "thinking"),
      ...filter.textDelta("t", "example>"),
      ...filter.finish().events,
    ];
    expect(texts(events)).toBe(PROSE + "<tool_example>");
    const index = events.indexOf(thinking);
    expect(texts(events.slice(0, index))).toBe(PROSE + "<tool_");
    expect(texts(events.slice(index + 1))).toBe("example>");
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});
