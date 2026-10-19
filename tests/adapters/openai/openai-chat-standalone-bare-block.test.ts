import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { recoverStandaloneBareBlocks, scanSerializedToolCalls, SerializedToolCallContentBuffer } from "../../../src/adapters/openai-chat/serialized-tool-call-content";
import { StandaloneBareToolCallBuffer } from "../../../src/adapters/openai-chat/standalone-bare-tool-calls";
import { createOpenAIChatToolNameRegistry } from "../../../src/adapters/openai-chat/tool-name-registry";
import type { AdapterEvent, OcxParsedRequest } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

const exec = { name: "exec", description: "Code", parameters: {}, freeform: true };
const block = (body = "text(1);", name = "exec") => `<tool_call><function=${name}>${body}</parameter></function></tool_call>`;
const visible = (events: AdapterEvent[]) => events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("");
const argumentsIn = (events: AdapterEvent[]) => events.flatMap(event => event.type === "tool_call_delta" ? [event.arguments] : []);
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
type Options = { model?: string; tools?: OcxParsedRequest["context"]["tools"]; structured?: boolean; error?: boolean };

async function parse(mode: "buffered" | "streamed", chunks: string[], options: Options = {}) {
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter({
    adapter: "openai-chat", baseUrl: "https://gateway.example.test/v1", apiKey: "key",
  }));
  adapter.buildRequest({ modelId: options.model ?? "mimo-v2.6-pro", stream: mode === "streamed", options: {},
    context: { messages: [{ role: "user", content: "Use exec", timestamp: 0 }], tools: options.tools ?? [exec] } });
  const call = { id: "structured", function: { name: "exec", arguments: JSON.stringify({ input: "text(1);" }) } };
  if (mode === "buffered") return adapter.parseResponse!(Response.json({ choices: [{
    message: { content: chunks.join(""), ...(options.structured ? { tool_calls: [call] } : {}) },
    finish_reason: options.error ? "error" : "stop", ...(options.error ? { error: { message: "failed" } } : {}),
  }] }), createTestTranslatorBudget());
  const body = chunks.map(content => frame({ choices: [{ delta: { content } }] })).join("")
    + (options.structured ? frame({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] }) : "")
    + (options.error ? frame({ error: { message: "failed" } }) : frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(new Response(body))) events.push(event);
  return events;
}

for (const mode of ["buffered", "streamed"] as const) {
  test.each(["", "Running.\n", "Running. "])(`${mode} recovers a declared freeform bare block after %j`, async prefix => {
    const content = prefix + block() + "\nDone.";
    const events = await parse(mode, [...content]);
    expect(visible(events)).toBe(prefix + "\nDone.");
    expect(argumentsIn(events)).toEqual([JSON.stringify({ input: "text(1);" })]);
    expect(events.filter(event => event.type === "tool_call_start")).toEqual([{ type: "tool_call_start", id: "call_1", name: "exec" }]);
    expect(events.filter(event => event.type === "tool_call_end")).toHaveLength(1);
  });

  test(`${mode} recovers a block followed by prose beyond the streaming bound`, async () => {
    const prose = "more prose ".repeat(1500);
    const events = await parse(mode, [block(), prose, " tail"]);
    expect(argumentsIn(events)).toEqual([JSON.stringify({ input: "text(1);" })]);
    // The streaming bound favors prompt text delivery; already released markup stays visible.
    expect(visible(events)).toBe((mode === "streamed" ? block() : "") + prose + " tail");
  });

  test.each([
    ["prose", "Here is ordinary commentary."],
    ["empty", block(" \n")],
    ["nested bare header", block("outer\n<tool_call><function=exec>inner")],
    ["nested mid-line header", block("outer <tool_call><function=exec>inner")],
    ["nested identified header", block("outer <tool_call_deadbeef><function=exec>inner")],
    ["nested function header", block("outer <function=exec>inner")],
    ["named parameter", block("<parameter=input>text(1);")],
    ["nested parameter", block("text('<parameter=');")],
    ["parameter close in body", block("text('</parameter>');")],
    ["unknown tool", block("text(1);", "other")],
    ["identified wrapper", "<tool_call_deadbeef><function=exec>text(1);</function></tool_call_deadbeef>"],
    ["indented", "    " + block()],
    ["quoted", "> " + block()],
    ["fenced", "```xml\n" + block() + "\n```"],
    ["mid-line fenced", "Example:\n```xml\nExample " + block() + "\n```"],
    ["inline", "Example `" + block() + "` remains literal."],
    ["double inline", "Example ``" + block() + "`` remains literal."],
  ])(`${mode} preserves %s and executes no call`, async (_, content) => {
    for (const chunks of [[content!], [...content!]]) {
      const events = await parse(mode, chunks);
      expect(visible(events)).toBe(content!);
      expect(argumentsIn(events)).toEqual([]);
    }
  });

  test.each(["```xml\nExample " + block() + "\n```", "Example `" + block() + "`"])(
    `${mode} preserves a complete literal example with no tools or an agreeing structured call: %j`, async content => {
      for (const chunks of [[content], [...content]]) {
        const noTools = await parse(mode, chunks, { tools: [] });
        expect(visible(noTools)).toBe(content);
        expect(argumentsIn(noTools)).toEqual([]);
        const structured = await parse(mode, chunks, { structured: true });
        expect(visible(structured)).toBe(content);
        expect(argumentsIn(structured)).toEqual([JSON.stringify({ input: "text(1);" })]);
      }
    },
  );

  test.each(["other-model", "mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash"])(`${mode} leaves %s outside the recovery gate`, async model => {
    const events = await parse(mode, [block()], { model });
    expect(visible(events)).toBe(block());
    expect(argumentsIn(events)).toEqual([]);
  });

  test(`${mode} does not recover for ordinary functions or an empty tool catalog`, async () => {
    for (const tools of [[], [{ ...exec, freeform: false }]]) {
      const events = await parse(mode, ["Running. " + block()], { tools });
      expect(visible(events)).toBe("Running. " + block());
      expect(argumentsIn(events)).toEqual([]);
    }
  });

  test(`${mode} a structured call prevents synthetic calls`, async () => {
    const events = await parse(mode, [block()], { structured: true });
    expect(argumentsIn(events)).toEqual([JSON.stringify({ input: "text(1);" })]);
    expect(events.filter(event => event.type === "tool_call_start")).toEqual([{ type: "tool_call_start", id: "structured", name: "exec" }]);
  });

  test(`${mode} a late structured call invalidates candidates saved before prose release`, async () => {
    const events = await parse(mode, [block(), "more prose ".repeat(1500)], { structured: true });
    expect(argumentsIn(events)).toEqual([JSON.stringify({ input: "text(1);" })]);
  });

  test(`${mode} preserves the existing structured-call contract for mid-line bare blocks`, async () => {
    const content = "Running. " + block();
    const events = await parse(mode, [content], { structured: true });
    expect(visible(events)).toBe(content);
    expect(argumentsIn(events)).toHaveLength(1);
  });

  test.each(["mimo-v2", "xiaomi/mimo-v2.6-pro", "mimo-v2.6-flash"])(`${mode} recovers for %s`, async model => {
    expect(argumentsIn(await parse(mode, [block()], { model }))).toEqual([JSON.stringify({ input: "text(1);" })]);
  });

  test(`${mode} restores aliases and namespaces using the exact declared wire name`, async () => {
    const tool = { ...exec, namespace: "a_long_namespace_".repeat(5) };
    const registry = createOpenAIChatToolNameRegistry([tool]);
    const wire = registry.alias(tool);
    const events = await parse(mode, [block("text(1);", wire)], { tools: [tool] });
    expect(events.filter(event => event.type === "tool_call_start")).toEqual([{ type: "tool_call_start", id: "call_1", name: registry.restore(wire) }]);
    expect(argumentsIn(events)).toEqual([JSON.stringify({ input: "text(1);" })]);
  });

  test(`${mode} restores malformed parameter input and several separate bare calls`, async () => {
    const events = await parse(mode, [block("<parameter=\ntext(1);") + "\n" + block("text(2);")]);
    expect(visible(events)).toBe("\n");
    expect(argumentsIn(events)).toEqual([1, 2].map(n => JSON.stringify({ input: `text(${n});` })));
    expect(events.filter(event => event.type === "tool_call_start").map(event => event.id)).toEqual(["call_1", "call_2"]);
  });

  test(`${mode} errors never dispatch a recovered call`, async () => {
    const events = await parse(mode, [block(), "more prose ".repeat(1500)], { error: true });
    expect(argumentsIn(events)).toEqual([]);
    expect(events.some(event => event.type === "error")).toBe(true);
  });

  test(`${mode} synthetic bare-call removal never claims an identified wrapper`, async () => {
    const identified = "<tool_call_deadbeef><function=exec>text(1);</function></tool_call_deadbeef>";
    const events = await parse(mode, [block() + "\n" + identified]);
    expect(visible(events)).toBe("\n" + identified);
    expect(argumentsIn(events)).toEqual([JSON.stringify({ input: "text(1);" })]);
  });

  test(`${mode} repeated bare calls keep their multiplicity without the structured-pair ambiguity rule`, async () => {
    const events = await parse(mode, [block() + "\n" + block()]);
    expect(visible(events)).toBe("\n");
    expect(argumentsIn(events)).toEqual(Array(2).fill(JSON.stringify({ input: "text(1);" })));
  });

  test(`${mode} a released control body's backtick cannot expose a later inline example`, async () => {
    const first = block('text("`");');
    const prose = "x".repeat(9000);
    const example = "Example `" + block("text(2);") + "`";
    const events = await parse(mode, [first, prose, example]);
    expect(argumentsIn(events)).toEqual([JSON.stringify({ input: 'text("`");' })]);
    expect(visible(events)).toBe((mode === "streamed" ? first : "") + prose + example);
  });

  test(`${mode} a byte-bound release cannot authorize a nested header in an unfinished outer block`, async () => {
    const chunks = ["<tool_call><function=exec>" + "x".repeat(4 * 1024 * 1024), block("text(2);"), "</function></tool_call>"];
    const events = await parse(mode, chunks);
    expect(argumentsIn(events)).toEqual([]);
    expect(visible(events)).toBe(chunks.join(""));
  });

  test(`${mode} an ambiguous nested close cannot expose subsequent nested calls`, async () => {
    const outer = "<tool_call><function=exec>outer\n" + block("text(2);");
    for (const prose of ["", "x".repeat(9000)]) {
      const chunks = [outer, prose, "\n" + block("text(3);"), "</function></tool_call>"];
      const events = await parse(mode, chunks);
      expect(argumentsIn(events)).toEqual([]);
      expect(visible(events)).toBe(chunks.join(""));
    }
  });
}

test.each(["other-model", "mimo-v2.6-pro"])("streamed %s keeps identified control bodies opaque across bounded release", async model => {
  const identified = (body: string) => `<tool_call_deadbeef><function=exec>${body}</function></tool_call_deadbeef>`;
  const first = identified('text("`");');
  const prose = "x".repeat(9000);
  const example = "\nExample `" + identified("text(1);") + "` stays literal";
  for (const chunks of [[first, prose, example], [first, prose, ...example]]) {
    const events = await parse("streamed", chunks, { model, structured: true });
    expect(visible(events)).toBe(first + prose + example);
    expect(argumentsIn(events)).toEqual([JSON.stringify({ input: "text(1);" })]);
  }
  // The shared buffer also owns this contract without the standalone subclass.
  const budget = createTestTranslatorBudget();
  const buffer = new SerializedToolCallContentBuffer(budget);
  const events = [first, prose, example].flatMap(chunk => buffer.ingestStreaming(chunk));
  events.push(...buffer.drain([{ names: new Set(["exec"]), argumentsText: JSON.stringify({ input: "text(1);" }) }]));
  expect(visible(events)).toBe(first + prose + example);
  buffer.dispose();
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("a stream cut without a terminal signal never executes a bare block", async () => {
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://gateway.example.test/v1", apiKey: "key" }));
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {},
    context: { messages: [{ role: "user", content: "Use exec", timestamp: 0 }], tools: [exec] } });
  const events: AdapterEvent[] = [];
  // No finish_reason and no [DONE]: the connection closed after a complete-looking block.
  for await (const event of adapter.parseStream(new Response(frame({ choices: [{ delta: { content: "Running.\n" + block() } }] })))) events.push(event);
  expect(events.filter(event => event.type === "tool_call_start")).toEqual([]);
  expect(visible(events)).toBe("Running.\n" + block());
});

test("a bare block arriving after the terminal finish_reason never executes", async () => {
  for (const tail of ["", "data: [DONE]\n\n"]) {
    const adapter = withTestTranslatorBudget(createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://gateway.example.test/v1", apiKey: "key" }));
    adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {},
      context: { messages: [{ role: "user", content: "Use exec", timestamp: 0 }], tools: [exec] } });
    const body = frame({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] })
      + frame({ choices: [{ delta: { content: "\n" + block() } }] }) + tail;
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(body))) events.push(event);
    expect(events.filter(event => event.type === "tool_call_start")).toEqual([]);
  }
});

test("64k adjacent bare blocks scan and fail closed within a bounded time", () => {
  const content = block().repeat(64_000);
  const start = performance.now();
  const scan = scanSerializedToolCalls(content, undefined, true);
  const recovered = recoverStandaloneBareBlocks(content, new Map([["exec", exec]]));
  // Shared Markdown-context traversal must remain linear even without the recovery count cap.
  const complete = scanSerializedToolCalls(content, undefined, true, Infinity);
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(500);
  expect(scan.calls.length).toBeLessThanOrEqual(128);
  expect(complete.calls).toHaveLength(64_000);
  expect(recovered).toEqual([]);
});

test.each([128, 129])("%i adjacent blocks respect the standalone candidate limit", async count => {
  const content = block().repeat(count);
  for (const mode of ["buffered", "streamed"] as const) {
    const events = await parse(mode, [content]);
    expect(argumentsIn(events)).toEqual(count === 128 ? Array(128).fill(JSON.stringify({ input: "text(1);" })) : []);
    expect(visible(events)).toBe(count === 128 ? "" : content);
  }
});

test.each([false, true])("candidate overflow after bounded release disables saved recovery (streaming=%s)", streaming => {
  const budget = createTestTranslatorBudget();
  const buffer = new StandaloneBareToolCallBuffer(budget, "mimo-v2.6-pro", new Map([["exec", exec]]));
  buffer.ingestStreaming(block());
  buffer.ingestStreaming("x".repeat(9000));
  const overflow = "\n" + block().repeat(129) + (streaming ? "x".repeat(9000) : "");
  if (streaming) buffer.ingestStreaming(overflow);
  else buffer.ingest(overflow);
  expect([...buffer.recoverStandalone(true, () => "must-not-run", name => name)]).toEqual([]);
  buffer.ingest("\n" + block());
  expect([...buffer.recoverStandalone(true, () => "still-disabled", name => name)]).toEqual([]);
  buffer.dispose();
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("released prose is not retained with the bounded candidate and disposal releases its budget", () => {
  const budget = createTestTranslatorBudget();
  const buffer = new StandaloneBareToolCallBuffer(budget, "mimo-v2.6-pro", new Map([["exec", exec]]));
  buffer.ingestStreaming(block());
  buffer.ingestStreaming("x".repeat(9000));
  expect(buffer.current()).toBe("");
  const retained = budget.snapshot().currentBytes;
  expect(retained).toBeGreaterThan(0);
  expect(retained).toBeLessThan(1024);
  for (let i = 0; i < 10; i++) buffer.ingestStreaming("more prose ".repeat(1500));
  expect(budget.snapshot().currentBytes).toBe(retained);
  const recovered = [...buffer.recoverStandalone(true, () => "synthetic", name => name)];
  expect(argumentsIn(recovered)).toEqual([JSON.stringify({ input: "text(1);" })]);
  expect([...buffer.recoverStandalone(true, () => "duplicate", name => name)]).toEqual([]);
  buffer.dispose();
  expect(budget.snapshot().currentBytes).toBe(0);
});

test.each(["argument bytes", "aggregate bytes", "call count"])("standalone %s overflow leaves the whole batch inert", kind => {
  const budget = createTestTranslatorBudget();
  const buffer = new StandaloneBareToolCallBuffer(budget, "mimo-v2.6-pro", new Map([["exec", exec]]));
  const content = kind === "argument bytes" ? block("x".repeat(2 * 1024 * 1024))
    : kind === "aggregate bytes" ? Array(3).fill(block("x".repeat(1500 * 1024))).join("\n")
    : Array(129).fill(block()).join("\n");
  buffer.ingest(content);
  expect([...buffer.recoverStandalone(true, () => "must-not-run", name => name)]).toEqual([]);
  expect(visible(buffer.drain([]))).toBe(content);
  buffer.dispose();
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("cancellation disposes retained recovery evidence without dispatch", () => {
  const budget = createTestTranslatorBudget();
  const buffer = new StandaloneBareToolCallBuffer(budget, "mimo-v2.6-pro", new Map([["exec", exec]]));
  buffer.ingestStreaming(block());
  buffer.ingestStreaming("x".repeat(9000));
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  buffer.dispose();
  expect(budget.snapshot().currentBytes).toBe(0);
});
