import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import {
  CommandCodeToolTextFilter,
  MAX_HELD_TOOL_TEXT_BYTES,
  markupMatchesInput,
  parseToolCallMarkup,
  salvagedArguments,
} from "../../src/adapters/command-code-tool-text";
import { saveCredential } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { handleResponses } from "../../src/server/responses";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const provider: OcxProviderConfig = {
  adapter: "command-code",
  baseUrl: "https://api.commandcode.ai",
  authMode: "oauth",
  apiKey: "secret-command-key",
};

// Trimmed from the /alpha/generate stream captured on 2026-09-23 while `codex exec` ran
// xiaomi/mimo-v2.6-flash at high effort: the gateway echoes MiMo's markup as a text block inside
// the tool-input stream, then sends the same call as an invalid native tool-call.
const JS = "const r = await tools.exec_command({cmd:\"sed -n '1,40p' src/a.ts\"});\ntext(r.output);";
const CAPTURED = [
  { type: "start" },
  { type: "start-step" },
  { type: "reasoning-start", id: "reasoning-0" },
  { type: "reasoning-delta", id: "reasoning-0", text: "Read the file." },
  { type: "reasoning-end", id: "reasoning-0" },
  { type: "tool-input-start", id: "call_c1", toolName: "exec", dynamic: false },
  { type: "tool-input-delta", id: "call_c1", delta: JS },
  { type: "text-start", id: "txt-0" },
  { type: "text-delta", id: "txt-0", text: `<tool_call><function=exec>${JS}</parameter></function></tool_call>` },
  { type: "text-end", id: "txt-0" },
  { type: "tool-input-end", id: "call_c1" },
  { type: "tool-call", toolCallId: "call_c1", toolName: "exec", input: JS, dynamic: true, invalid: true, error: { name: "AI_JSONParseError" } },
  { type: "tool-error", toolCallId: "call_c1", toolName: "exec", input: JS, error: "Invalid input for tool exec: JSON parsing failed" },
  { type: "finish-step", finishReason: "tool-calls", rawFinishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 5 } },
  { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool_calls", totalUsage: { inputTokens: 10, outputTokens: 5 } },
];

const EXEC_TOOL = { name: "exec", description: "Run JavaScript", freeform: true,
  parameters: { type: "object", properties: { input: { type: "string", description: "Raw freeform input for this tool." } }, required: ["input"] } };
const READ_TOOL = { name: "read_file", description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" }, opts: { type: "object" } }, required: ["path"] } };

function ndjson(events: unknown[]): Response {
  return new Response(events.map(event => JSON.stringify(event)).join("\n"));
}

function parsed(tools = [EXEC_TOOL, READ_TOOL]): OcxParsedRequest {
  return {
    modelId: "xiaomi/mimo-v2.6-flash",
    stream: true,
    context: { systemPrompt: ["system"], messages: [{ role: "user", content: "go", timestamp: 1 }], tools },
    options: { maxOutputTokens: 100 },
  };
}

/** Run events through one adapter instance the way the server does: buildRequest, fetchResponse, parseStream. */
async function adapterEvents(events: unknown[], tools = [EXEC_TOOL, READ_TOOL], modelId = "xiaomi/mimo-v2.6-flash"): Promise<AdapterEvent[]> {
  const adapter = createCommandCodeAdapter({ ...provider, fetch: (async () => ndjson(events)) as typeof fetch } as OcxProviderConfig);
  const request = await adapter.buildRequest({ ...parsed(tools), modelId });
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

describe("MiMo tool-call markup parsing", () => {
  test("reads parameters, freeform bodies and the gateway's stray closing tag", () => {
    expect(parseToolCallMarkup("<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n<parameter=limit>10</parameter>\n</function>\n</tool_call>"))
      .toEqual({ name: "read_file", kind: "params", values: { path: "src/a.ts", limit: "10" } });
    expect(parseToolCallMarkup("<tool_call><function=apply_patch>*** Begin Patch\n*** End Patch</function></tool_call>"))
      .toEqual({ name: "apply_patch", kind: "raw", value: "*** Begin Patch\n*** End Patch" });
    expect(parseToolCallMarkup(`<tool_call><function=exec>${JS}</parameter></function></tool_call>`))
      .toEqual({ name: "exec", kind: "raw", value: JS });
  });

  test("rejects incomplete or mixed text", () => {
    expect(parseToolCallMarkup("<tool_call><function=exec>abc")).toBeUndefined();
    expect(parseToolCallMarkup("I will call <tool_call><function=exec>x</function></tool_call>")).toBeUndefined();
    expect(parseToolCallMarkup("<tool_call><function=read_file>stray<parameter=path>a</parameter></function></tool_call>")).toBeUndefined();
  });

  test("matches native input exactly, never by substring or subset", () => {
    const markup = parseToolCallMarkup("<tool_call><function=read_file><parameter=path>src/a.ts</parameter><parameter=limit>10</parameter></function></tool_call>")!;
    expect(markupMatchesInput(markup, { path: "src/a.ts", limit: 10 })).toBe(true);
    expect(markupMatchesInput(markup, '{"path":"src/a.ts","limit":10}')).toBe(true);
    expect(markupMatchesInput(markup, { path: "src/a.ts" })).toBe(false);
    expect(markupMatchesInput(markup, { path: "src/a.ts", limit: 10, extra: true })).toBe(false);
    expect(markupMatchesInput(markup, { path: "src/a", limit: 10 })).toBe(false);
    const raw = parseToolCallMarkup(`<tool_call><function=exec>${JS}</function></tool_call>`)!;
    expect(markupMatchesInput(raw, JS)).toBe(true);
    expect(markupMatchesInput(raw, JS.slice(0, 20))).toBe(false);
    expect(markupMatchesInput(raw, { input: JS })).toBe(true);
  });

  test("salvaged arguments must fit the declared tool", () => {
    const exec = { freeform: true, schema: EXEC_TOOL.parameters };
    const read = { freeform: false, schema: READ_TOOL.parameters };
    const markup = (body: string) => parseToolCallMarkup(`<tool_call><function=t>${body}</function></tool_call>`)!;
    expect(salvagedArguments(markup(JS), exec)).toBe(JSON.stringify({ input: JS }));
    expect(salvagedArguments(markup("<parameter=input>x</parameter>"), exec)).toBeUndefined();
    expect(salvagedArguments(markup('<parameter=path>a.ts</parameter><parameter=limit>5</parameter><parameter=opts>{"x":1}</parameter>'), read))
      .toBe(JSON.stringify({ path: "a.ts", limit: 5, opts: { x: 1 } }));
    expect(salvagedArguments(markup("<parameter=limit>5</parameter>"), read)).toBeUndefined();
    expect(salvagedArguments(markup("<parameter=path>a</parameter><parameter=other>1</parameter>"), read)).toBeUndefined();
    expect(salvagedArguments(markup("<parameter=path>a</parameter><parameter=limit>five</parameter>"), read)).toBeUndefined();
    expect(salvagedArguments(markup(JS), read)).toBeUndefined();
  });
});

describe("Command Code MiMo tool-call text", () => {
  test("drops the echoed markup when the native call carries the same input", async () => {
    const events = await adapterEvents(CAPTURED);
    expect(texts(events)).toBe("");
    expect(calls(events)).toEqual([{ id: "call_c1", name: "exec", args: JS }]);
    expect(done(events)?.stopReason).toBe("tool_calls");
  });

  test("holds markup split across deltas", async () => {
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    const events = await adapterEvents([
      { type: "tool-input-start", id: "call_c1", toolName: "exec" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: "\n<tool" },
      { type: "text-delta", id: "t", text: "_call>" },
      { type: "text-delta", id: "t", text: markup.slice("<tool_call>".length) },
      { type: "text-end", id: "t" },
      { type: "tool-call", toolCallId: "call_c1", toolName: "exec", input: JS, invalid: true },
      { type: "finish", rawFinishReason: "tool_calls" },
    ]);
    expect(texts(events)).toBe("");
    expect(calls(events)).toHaveLength(1);
  });

  test("pairs each block with its own call when inputs interleave", async () => {
    const other = "text('b');";
    const events = await adapterEvents([
      { type: "tool-input-start", id: "a", toolName: "exec" },
      { type: "tool-input-start", id: "b", toolName: "exec" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: `<tool_call><function=exec>${JS}</function></tool_call>` },
      { type: "text-end", id: "t1" },
      // Call b arrives first; block t1 duplicates call a, so it must stay held rather than leak.
      { type: "tool-call", toolCallId: "b", toolName: "exec", input: other },
      { type: "tool-call", toolCallId: "a", toolName: "exec", input: JS, invalid: true },
      { type: "finish", rawFinishReason: "tool_calls" },
    ]);
    expect(texts(events)).toBe("");
    expect(calls(events).map(call => call.id)).toEqual(["b", "a"]);
  });

  test("releases markup that does not match its call", async () => {
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    const events = await adapterEvents([
      { type: "tool-input-start", id: "a", toolName: "exec" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: markup },
      { type: "text-end", id: "t" },
      { type: "tool-call", toolCallId: "a", toolName: "exec", input: JS.slice(0, 20) },
      { type: "finish", rawFinishReason: "tool_calls" },
    ]);
    expect(texts(events)).toBe(markup);
    const order = events.map(event => event.type);
    expect(order.indexOf("text_delta")).toBeLessThan(order.indexOf("tool_call_start"));
  });

  test("restores a text-only freeform call for a declared tool", async () => {
    const events = await adapterEvents([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: `<tool_call><function=exec>${JS}</function></tool_call>` },
      { type: "text-end", id: "t" },
      { type: "finish-step", rawFinishReason: "stop" },
      { type: "finish", rawFinishReason: "stop" },
    ]);
    expect(texts(events)).toBe("");
    const [call] = calls(events);
    expect(call).toMatchObject({ name: "exec", args: JSON.stringify({ input: JS }) });
    expect(call!.id).toMatch(/^call_ocx_[0-9a-f]{32}$/);
    expect(done(events)?.stopReason).toBe("tool_calls");
  });

  test("restores a text-only function call with typed parameters", async () => {
    const events = await adapterEvents([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: "<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n<parameter=limit>40</parameter>\n</function>\n</tool_call>" },
      { type: "text-end", id: "t" },
      { type: "finish", rawFinishReason: "stop" },
    ]);
    expect(texts(events)).toBe("");
    expect(calls(events)).toMatchObject([{ name: "read_file", args: JSON.stringify({ path: "src/a.ts", limit: 40 }) }]);
  });

  test("a declared tool stays literal text outside the affected MiMo models", async () => {
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    const events = await adapterEvents([
      { type: "text-delta", id: "t", text: markup },
      { type: "tool-call", toolCallId: "native", toolName: "exec", input: JS },
      { type: "finish", rawFinishReason: "stop" },
    ], [EXEC_TOOL], "claude-opus-5-5");
    expect(texts(events)).toBe(markup);
    expect(calls(events)).toEqual([{ id: "native", name: "exec", args: JS }]);
  });

  test("truncated, filtered and unterminated turns never restore markup", async () => {
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    for (const reason of ["length", "content_filter", undefined]) {
      const events = await adapterEvents([
        { type: "text-delta", id: "t", text: markup },
        ...(reason ? [{ type: "finish", rawFinishReason: reason }] : []),
      ]);
      expect(texts(events)).toBe(markup);
      expect(calls(events)).toEqual([]);
      expect(done(events)?.stopReason).toBe(reason);
    }
  });

  test("later text waits for an earlier held block and keeps wire order", async () => {
    const markup = "<tool_call><function=exec>incomplete";
    const events = await adapterEvents([
      { type: "text-start", id: "a" }, { type: "text-delta", id: "a", text: markup }, { type: "text-end", id: "a" },
      { type: "text-start", id: "b" }, { type: "text-delta", id: "b", text: "explanation" }, { type: "text-end", id: "b" },
      { type: "finish", rawFinishReason: "stop" },
    ]);
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: markup }, { type: "text_delta", text: "explanation" },
    ]);
  });

  test("a restored call stays ahead of later text", async () => {
    const events = await adapterEvents([
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", text: `<tool_call><function=exec>${JS}</function></tool_call>` },
      { type: "text-end", id: "a" },
      { type: "text-start", id: "b" }, { type: "text-delta", id: "b", text: "after" }, { type: "text-end", id: "b" },
      { type: "finish", rawFinishReason: "stop" },
    ]);
    expect(events.findIndex(event => event.type === "tool_call_start"))
      .toBeLessThan(events.findIndex(event => event.type === "text_delta"));
    expect(texts(events)).toBe("after");
  });

  test("text, native calls and terminal events retain wire order across held markup", async () => {
    const held = `<tool_call><function=exec>${JS}</function></tool_call>`;
    const partial = "<tool_call><function=exec>incomplete";
    const text = (id: string, value: string) => [
      { type: "text-start", id }, { type: "text-delta", id, text: value }, { type: "text-end", id },
    ];
    const native = (id: string, input = JS) => ({ type: "tool-call", toolCallId: id, toolName: "exec", input });
    const sequence = (events: AdapterEvent[]) => events.flatMap(event => {
      if (event.type === "text_delta") return [`text:${event.text}`];
      if (event.type === "tool_call_start") return [`tool:${event.id}`];
      if (event.type === "thinking_delta") return [`thinking:${event.thinking}`];
      if (event.type === "done") return [`done:${event.stopReason ?? ""}`];
      if (event.type === "error") return ["error"];
      return [];
    });
    const cases: Array<{ name: string; wire: unknown[]; expected: string[] }> = [
      { name: "text-held-text", wire: [...text("pre", "before"), ...text("held", partial), ...text("post", "after"), { type: "finish", rawFinishReason: "stop" }], expected: ["text:before", `text:${partial}`, "text:after", "done:stop"] },
      { name: "held-native-text", wire: [...text("held", partial), native("c"), ...text("post", "after"), { type: "finish", rawFinishReason: "length" }], expected: [`text:${partial}`, "tool:c", "text:after", "done:length"] },
      { name: "duplicate call", wire: [{ type: "tool-input-start", id: "a", toolName: "exec" }, ...text("held", held), native("a"), ...text("post", "after"), { type: "finish", rawFinishReason: "tool_calls" }], expected: ["tool:a", "text:after", "done:tool_calls"] },
      { name: "native before held", wire: [native("c"), ...text("held", partial), { type: "finish", rawFinishReason: "stop" }], expected: ["tool:c", `text:${partial}`, "done:stop"] },
      { name: "native after held", wire: [...text("held", partial), native("c"), { type: "finish", rawFinishReason: "stop" }], expected: [`text:${partial}`, "tool:c", "done:stop"] },
      { name: "held text before unrelated native", wire: [{ type: "tool-input-start", id: "a", toolName: "exec" }, ...text("held", held), ...text("post", "after"), native("c"), native("a"), { type: "finish", rawFinishReason: "tool_calls" }], expected: ["text:after", "tool:c", "tool:a", "done:tool_calls"] },
      { name: "ordinary chunks straddle native", wire: [{ type: "tool-input-start", id: "a", toolName: "exec" }, ...text("held", held), { type: "text-start", id: "post" }, { type: "text-delta", id: "post", text: "before" }, native("c"), { type: "text-delta", id: "post", text: "after" }, { type: "text-end", id: "post" }, native("a"), { type: "finish", rawFinishReason: "tool_calls" }], expected: ["text:before", "tool:c", "text:after", "tool:a", "done:tool_calls"] },
      { name: "held chunks straddle native on clean finish", wire: [{ type: "tool-input-start", id: "a", toolName: "exec" }, { type: "text-start", id: "held" }, { type: "text-delta", id: "held", text: "<tool" }, native("c"), { type: "text-delta", id: "held", text: held.slice(5) }, { type: "text-end", id: "held" }, { type: "finish", rawFinishReason: "stop" }], expected: ["text:<tool", "tool:c", `text:${held.slice(5)}`, "done:stop"] },
      { name: "held chunks straddle native on length", wire: [{ type: "tool-input-start", id: "a", toolName: "exec" }, { type: "text-start", id: "held" }, { type: "text-delta", id: "held", text: "<tool" }, native("c"), { type: "text-delta", id: "held", text: held.slice(5) }, { type: "text-end", id: "held" }, { type: "finish", rawFinishReason: "length" }], expected: ["text:<tool", "tool:c", `text:${held.slice(5)}`, "done:length"] },
      { name: "held chunks straddle reasoning", wire: [{ type: "text-start", id: "held" }, { type: "text-delta", id: "held", text: "<tool" }, { type: "reasoning-delta", text: "thought" }, { type: "text-delta", id: "held", text: held.slice(5) }, { type: "finish", rawFinishReason: "stop" }], expected: ["text:<tool", "thinking:thought", `text:${held.slice(5)}`, "done:stop"] },
      { name: "error finish", wire: [...text("held", held), { type: "finish", rawFinishReason: "error" }], expected: [`text:${held}`, "error"] },
      { name: "length finish", wire: [...text("held", held), { type: "finish", rawFinishReason: "length" }], expected: [`text:${held}`, "done:length"] },
      { name: "EOF", wire: [...text("held", held)], expected: [`text:${held}`, "done:"] },
    ];
    for (const entry of cases) expect(sequence(await adapterEvents(entry.wire)), entry.name).toEqual(entry.expected);
  });

  test("the ordered queue releases as text when its byte bound is exceeded", () => {
    const budget = createTestTranslatorBudget();
    const filter = new CommandCodeToolTextFilter(budget, new Map([["exec", { freeform: true, schema: EXEC_TOOL.parameters }]]));
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    filter.textDelta("a", markup);
    const later = "x".repeat(MAX_HELD_TOOL_TEXT_BYTES);
    expect(filter.textDelta("b", later)).toEqual([
      { type: "text_delta", text: markup }, { type: "text_delta", text: later },
    ]);
    expect(filter.finish()).toEqual({ events: [], salvaged: false });
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("a large native call flushes an earlier held block before reserving queue bytes", () => {
    const budget = createTestTranslatorBudget();
    const filter = new CommandCodeToolTextFilter(budget, new Map([["exec", { freeform: true, schema: EXEC_TOOL.parameters }]]));
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    filter.toolInputStart("a", "exec");
    expect(filter.textDelta("t", markup)).toEqual([]);
    const large = "x".repeat(MAX_HELD_TOOL_TEXT_BYTES);
    const events = filter.nativeCall("c", "exec", large);
    expect(events.map(event => event.type)).toEqual(["text_delta", "tool_call_start", "tool_call_delta", "tool_call_end"]);
    expect(events[0]).toEqual({ type: "text_delta", text: markup });
    expect(filter.finish()).toEqual({ events: [], salvaged: false });
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("many one-byte chunks use bounded queue visits", () => {
    const budget = createTestTranslatorBudget();
    const filter = new CommandCodeToolTextFilter(budget, new Map([["exec", { freeform: true, schema: EXEC_TOOL.parameters }]]));
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    filter.textDelta("held", markup);
    filter.textEnd("held");
    filter.textStart("later");
    const count = 20_000;
    for (let index = 0; index < count; index++) expect(filter.textDelta("later", "x")).toEqual([]);
    const events = filter.releaseAll();
    expect(events).toEqual([{ type: "text_delta", text: markup }, { type: "text_delta", text: "x".repeat(count) }]);
    expect(filter.queueOperationsForTest()).toBeLessThan(count * 5);
    expect(budget.snapshot().currentBytes).toBe(0);

    const spacedBudget = createTestTranslatorBudget();
    const spaced = new CommandCodeToolTextFilter(spacedBudget, new Map([["exec", { freeform: true, schema: EXEC_TOOL.parameters }]]));
    for (let index = 0; index < count; index++) spaced.textDelta("t", " ");
    spaced.textDelta("t", markup);
    expect(spaced.finish().salvaged).toBe(true);
    expect(spaced.queueOperationsForTest()).toBeLessThan(count * 5);
    expect(spacedBudget.snapshot().currentBytes).toBe(0);
  });

  test("many empty text starts do not scan open blocks", () => {
    const budget = createTestTranslatorBudget();
    const filter = new CommandCodeToolTextFilter(budget, undefined);
    const count = 20_000;
    for (let index = 0; index < count; index++) expect(filter.textStart(`empty-${index}`)).toEqual([]);
    expect(filter.openBlockCountForTest()).toBe(count);
    expect(filter.boundary()).toEqual([]);
    expect(filter.queueOperationsForTest()).toBeLessThan(count * 2);
    expect(filter.finish()).toEqual({ events: [], salvaged: false });
    expect(filter.openBlockCountForTest()).toBe(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("leaves markup as text when it names an undeclared tool or does not fit", async () => {
    for (const markup of [
      "<tool_call><function=delete_everything><parameter=path>/</parameter></function></tool_call>",
      "<tool_call><function=read_file><parameter=limit>40</parameter></function></tool_call>",
      "<tool_call><function=read_file><parameter=path>a</parameter><parameter=limit>forty</parameter></function></tool_call>",
    ]) {
      const events = await adapterEvents([
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", text: markup },
        { type: "text-end", id: "t" },
        { type: "finish", rawFinishReason: "stop" },
      ]);
      expect(texts(events)).toBe(markup);
      expect(calls(events)).toEqual([]);
      expect(done(events)?.stopReason).toBe("stop");
    }
  });

  test("never restores a call when the adapter built no request", async () => {
    const events: AdapterEvent[] = [];
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    for await (const event of createCommandCodeAdapter(provider).parseStream(ndjson([
      { type: "text-delta", text: markup }, { type: "finish", rawFinishReason: "stop" },
    ]), createTestTranslatorBudget())) events.push(event);
    expect(texts(events)).toBe(markup);
    expect(calls(events)).toEqual([]);
  });

  test("streams ordinary text immediately, including text that only starts like markup", async () => {
    const events = await adapterEvents([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: "<" },
      { type: "text-delta", id: "t", text: "div> hello" },
      { type: "text-delta", id: "t", text: " world" },
      { type: "text-end", id: "t" },
      { type: "finish", rawFinishReason: "stop" },
    ]);
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "<div> hello" },
      { type: "text_delta", text: " world" },
    ]);
  });

  test("releases an oversized held block as text", async () => {
    const big = "<tool_call><function=exec>" + "x".repeat(MAX_HELD_TOOL_TEXT_BYTES) + "</function></tool_call>";
    const events = await adapterEvents([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: big },
      { type: "text-end", id: "t" },
      { type: "finish", rawFinishReason: "stop" },
    ]);
    expect(texts(events)).toBe(big);
    expect(calls(events)).toEqual([]);
  });

  test("a block that keeps streaming after its call is resolved loses nothing and leaks no budget", () => {
    const markup = "<tool_call><function=exec>" + JS + "</function></tool_call>";
    for (const input of [JS, "text('other');"]) {
      const budget = createTestTranslatorBudget();
      const filter = new CommandCodeToolTextFilter(budget, new Map([["exec", { freeform: true, schema: EXEC_TOOL.parameters }]]));
      filter.toolInputStart("a", "exec");
      expect(filter.textStart("t")).toEqual([]);
      expect(filter.textDelta("t", markup)).toEqual([]);
      const beforeCall = filter.toolCall("a", "exec", input);
      // Text arriving after the verdict, before text-end, streams instead of being held.
      expect(filter.textDelta("t", " trailing")).toEqual([{ type: "text_delta", text: " trailing" }]);
      expect(filter.textEnd("t")).toEqual([]);
      expect(filter.finish()).toEqual({ events: [], salvaged: false });
      expect(beforeCall).toEqual(input === JS ? [] : [{ type: "text_delta", text: markup }]);
      expect(budget.snapshot().currentBytes).toBe(0);
    }
  });

  test("a duplicate resolved behind an earlier held block keeps its trailing text and budget", () => {
    const budget = createTestTranslatorBudget();
    const filter = new CommandCodeToolTextFilter(budget, new Map([["exec", { freeform: true, schema: EXEC_TOOL.parameters }]]));
    const first = "text('a');";
    const second = "text('b');";
    filter.toolInputStart("a", "exec");
    filter.toolInputStart("b", "exec");
    filter.textStart("first");
    expect(filter.textDelta("first", `<tool_call><function=exec>${first}</function></tool_call>`)).toEqual([]);
    expect(filter.textEnd("first")).toEqual([]);
    filter.textStart("second");
    expect(filter.textDelta("second", `<tool_call><function=exec>${second}</function></tool_call>`)).toEqual([]);
    expect(filter.textEnd("second")).toEqual([]);
    expect(filter.toolCall("b", "exec", second)).toEqual([]);
    expect(filter.textDelta("second", " trailing")).toEqual([]);
    expect(filter.toolCall("a", "exec", first)).toEqual([{ type: "text_delta", text: " trailing" }]);
    expect(filter.textEnd("first")).toEqual([]);
    expect(filter.textEnd("second")).toEqual([]);
    expect(filter.finish()).toEqual({ events: [], salvaged: false });
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("restored arguments honour numeric safety, enum and bounds", () => {
    const tool = { freeform: false, schema: { type: "object", required: ["mode"], properties: {
      mode: { type: "string", enum: ["read", "write"] },
      count: { type: "integer", minimum: 1, maximum: 10 },
    } } };
    const markup = (body: string) => parseToolCallMarkup("<tool_call><function=t>" + body + "</function></tool_call>")!;
    expect(salvagedArguments(markup("<parameter=mode>read</parameter><parameter=count>3</parameter>"), tool))
      .toBe(JSON.stringify({ mode: "read", count: 3 }));
    expect(salvagedArguments(markup("<parameter=mode>delete</parameter>"), tool)).toBeUndefined();
    expect(salvagedArguments(markup("<parameter=mode>read</parameter><parameter=count>0</parameter>"), tool)).toBeUndefined();
    expect(salvagedArguments(markup("<parameter=mode>read</parameter><parameter=count>" + "9".repeat(400) + "</parameter>"), tool)).toBeUndefined();
    expect(salvagedArguments(markup("<parameter=mode>read</parameter><parameter=count>9007199254740993</parameter>"), tool)).toBeUndefined();
  });

  test("restored union arguments satisfy a complete alternative", () => {
    const tool = { freeform: false, schema: { type: "object", required: ["mode"], properties: {
      mode: { anyOf: [{ type: "string", enum: ["read"] }, { type: "null" }] },
    } } };
    const markup = (mode: string) => parseToolCallMarkup(`<tool_call><function=t><parameter=mode>${mode}</parameter></function></tool_call>`)!;
    expect(salvagedArguments(markup("read"), tool)).toBe('{"mode":"read"}');
    expect(salvagedArguments(markup("null"), tool)).toBe('{"mode":null}');
    expect(salvagedArguments(markup("delete"), tool)).toBeUndefined();
    tool.schema.properties.mode = { oneOf: [{ type: "string", const: "read" }, { type: "string", const: "write" }] };
    expect(salvagedArguments(markup("write"), tool)).toBe('{"mode":"write"}');
    expect(salvagedArguments(markup("delete"), tool)).toBeUndefined();
  });

  test("restored arguments fail closed on declared nested and unsupported constraints", () => {
    const markup = (raw: string) => parseToolCallMarkup(`<tool_call><function=t><parameter=value>${raw}</parameter></function></tool_call>`)!;
    const cases: Array<{ schema: Record<string, unknown>; raw: string }> = [
      { schema: { type: "string", pattern: "^/workspace/" }, raw: "/etc/passwd" },
      { schema: { type: "string", pattern: "^/workspace/" }, raw: "/workspace/a" },
      { schema: { type: "string", minLength: 3 }, raw: "x" },
      { schema: { type: "object", properties: { path: { type: "string", pattern: "^/workspace/" } }, required: ["path"] }, raw: "{}" },
      { schema: { type: "object", properties: { optional: { type: "string", format: "uri" } } }, raw: "{}" },
      { schema: { allOf: [{ type: "integer", minimum: 1 }, { maximum: 5 }] }, raw: "8" },
      { schema: { type: "string", format: "uri" }, raw: "anything" },
    ];
    for (const { schema, raw } of cases) {
      const tool = { freeform: false, schema: { type: "object", properties: { value: schema }, required: ["value"] } };
      expect(salvagedArguments(markup(raw), tool), JSON.stringify(schema)).toBeUndefined();
    }
    const safe = { freeform: false, schema: { type: "object", properties: { value: { type: "string", minLength: 12 } }, required: ["value"] } };
    expect(salvagedArguments(markup("/workspace/a"), safe)).toBe('{"value":"/workspace/a"}');
    const freeform = { freeform: true, schema: { type: "object", properties: { input: { type: "string", pattern: "^SAFE" } }, required: ["input"] } };
    expect(salvagedArguments(parseToolCallMarkup("<tool_call><function=t>unsafe</function></tool_call>")!, freeform)).toBeUndefined();
    expect(salvagedArguments(parseToolCallMarkup("<tool_call><function=t>SAFE input</function></tool_call>")!, freeform)).toBeUndefined();
  });

  test("an invalid declared schema leaves markup as text at the adapter boundary", async () => {
    const tool = { name: "read_file", description: "Read a file", parameters: {
      type: "object", properties: { path: { type: "string", pattern: "^/workspace/" } }, required: ["path"],
    } };
    const markup = "<tool_call><function=read_file><parameter=path>/elsewhere</parameter></function></tool_call>";
    const events = await adapterEvents([
      { type: "text-delta", id: "t", text: markup }, { type: "finish", rawFinishReason: "stop" },
    ], [tool]);
    expect(texts(events)).toBe(markup);
    expect(calls(events)).toEqual([]);
  });

  test("releases held text when the turn fails", () => {
    const filter = new CommandCodeToolTextFilter(createTestTranslatorBudget(), new Map([["exec", { freeform: true, schema: EXEC_TOOL.parameters }]]));
    const markup = `<tool_call><function=exec>${JS}</function></tool_call>`;
    expect(filter.textDelta("t", markup)).toEqual([]);
    expect(filter.releaseAll()).toEqual([{ type: "text_delta", text: markup }]);
    expect(filter.finish()).toEqual({ events: [], salvaged: false });
  });

  test("a restored call pairs with its tool result on the next request", async () => {
    const events = await adapterEvents([
      { type: "text-delta", id: "t", text: "<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>" },
      { type: "finish", rawFinishReason: "stop" },
    ]);
    const [call] = calls(events);
    const next = await createCommandCodeAdapter(provider).buildRequest({
      ...parsed(),
      context: { ...parsed().context, messages: [
        { role: "user", content: "go", timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: call!.id, name: "read_file", arguments: { path: "a.ts" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: call!.id, toolName: "read_file", content: "file body", isError: false, timestamp: 3 },
      ] } as OcxParsedRequest["context"],
    });
    const messages = JSON.parse(next.body).params.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[2]!.content[0]).toMatchObject({ type: "tool-result", toolCallId: call!.id, output: { type: "text", value: "file body" } });
  });

  test("the Responses bridge relays the deduplicated call without the markup", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const fixtureHome = mkdtempSync(join(tmpdir(), "ocx-command-mimo-"));
    process.env.OPENCODEX_HOME = fixtureHome;
    const originalFetch = globalThis.fetch;
    clearGenericFailoverHealth();
    let releaseSpendHome: (() => void) | undefined;
    try {
      // Direct dispatch skips startServer, so the case holds the spend-ledger writer lease itself.
      releaseSpendHome = acquireOwnedSpendHome();
      await saveCredential("command-code", {
        access: "synthetic-command", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, accountId: "fixture", source: "oauth",
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== "https://api.commandcode.ai/alpha/generate") throw new Error(`Unexpected fixture request: ${url}`);
        return ndjson([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", text: "<tool_call><function=read_file><parameter=path>src/a.ts</parameter></function></tool_call>" },
          { type: "text-end", id: "t" },
          { type: "finish", rawFinishReason: "stop", totalUsage: { inputTokens: 5, outputTokens: 3 } },
        ]);
      }) as typeof fetch;
      const cfg = { defaultProvider: "command-code", providers: {
        "command-code": { adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth", models: ["xiaomi/mimo-v2.6-flash"] },
      } } as OcxConfig;
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "command-code/xiaomi/mimo-v2.6-flash", input: "read it", stream: false,
          tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: READ_TOOL.parameters }] }),
      }), cfg, { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };
      expect(JSON.stringify(body.output)).not.toContain("<tool_call>");
      expect(body.output.filter(item => item.type === "function_call")).toMatchObject([
        { type: "function_call", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) },
      ]);
    } finally {
      releaseSpendHome?.();
      globalThis.fetch = originalFetch;
      clearGenericFailoverHealth();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(fixtureHome);
    }
  }, 20_000);
});
