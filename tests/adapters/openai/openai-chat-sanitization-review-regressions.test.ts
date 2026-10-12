import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import type { AdapterEvent, OcxParsedRequest, OcxTool } from "../../../src/types";
import { namespacedToolName } from "../../../src/types/tools";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const provider = {
  adapter: "openai-chat",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "fixture-key",
} as const;

const frame = (delta: Record<string, unknown>, finishReason?: string) => ({
  choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
});
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const textOf = (events: AdapterEvent[]): string => events
  .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
  .map(event => event.text).join("");
const argsOf = (events: AdapterEvent[]): string => events
  .filter((event): event is Extract<AdapterEvent, { type: "tool_call_delta" }> => event.type === "tool_call_delta")
  .map(event => event.arguments).join("");
const tool = (input: string) => ({
  index: 0,
  id: "call_exec",
  function: { name: "exec", arguments: input },
});
const block = (name: string, body: string): string =>
  `<tool_call><function=${name}>${body}\n</parameter></function></tool_call>`;

async function buffered(content: string, argumentsText: string): Promise<AdapterEvent[]> {
  return createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: { content, tool_calls: [tool(argumentsText)] },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());
}

async function streamed(frames: unknown[], done = true): Promise<AdapterEvent[]> {
  const response = new Response(frames.map(sse).join("") + (done ? "data: [DONE]\n\n" : ""));
  const result: AdapterEvent[] = [];
  for await (const event of createOpenAIChatAdapter(provider).parseStream!(response, createTestTranslatorBudget())) {
    result.push(event);
  }
  return result;
}

test("review control: reported duplicated input is repaired in buffered and streaming modes", async () => {
  const script = "text('ok');";
  const argumentsText = JSON.stringify({ input: script });
  const content = "Running it.\n" + block("exec", script);
  const bufferedEvents = await buffered(content, script + argumentsText);
  const streamingEvents = await streamed([
    frame({ content }),
    frame({ tool_calls: [tool(script + argumentsText)] }),
    frame({}, "tool_calls"),
  ]);
  for (const events of [bufferedEvents, streamingEvents]) {
    expect(textOf(events)).toBe("Running it.\n");
    expect(argsOf(events)).toBe(argumentsText);
    expect(events.some(event => event.type === "error")).toBe(false);
  }
});

test("review P1: held content frames must still yield adapter activity", async () => {
  const script = "text('ok');";
  const chunks = ["Running it.\n", "<tool_call>", "<function=exec>", script, "</function></tool_call>"];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const events: AdapterEvent[] = [];
  const progressByChunk: boolean[] = [];
  const pump = (async () => {
    for await (const event of createOpenAIChatAdapter(provider).parseStream!(new Response(stream), createTestTranslatorBudget())) {
      events.push(event);
    }
  })();

  try {
    for (const content of chunks) {
      const before = events.length;
      controller.enqueue(encoder.encode(sse(frame({ content }))));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      progressByChunk.push(events.slice(before).some(event =>
        event.type === "text_delta" || event.type === "heartbeat"));
    }
    controller.enqueue(encoder.encode(
      sse(frame({ tool_calls: [tool(JSON.stringify({ input: script }))] }))
      + sse(frame({}, "tool_calls"))
      + "data: [DONE]\n\n",
    ));
  } finally {
    controller.close();
    await pump;
  }
  expect(textOf(events)).toBe("Running it.\n");
  expect(progressByChunk).toEqual(chunks.map(() => true));
});

test("review P2: a same-name different-body fenced example is not a duplicate", async () => {
  const example = "Example only:\n```xml\n<tool_call><function=exec>text('example');</function></tool_call>\n```\nActual call follows.";
  const argumentsText = JSON.stringify({ input: "text('actual');" });
  const bufferedEvents = await buffered(example, argumentsText);
  const streamingEvents = await streamed([
    frame({ content: example }),
    frame({ tool_calls: [tool(argumentsText)] }),
    frame({}, "tool_calls"),
  ]);
  for (const events of [bufferedEvents, streamingEvents]) {
    expect(textOf(events)).toBe(example);
    expect(argsOf(events)).toBe(argumentsText);
  }
});

test("review P2: previously received nonduplicate text survives a terminal upstream error", async () => {
  const chunks = ["Explanation: ", "<tool_call>", " is an XML-like marker. This is ordinary text."];
  const events = await streamed([
    ...chunks.map(content => frame({ content })),
    { error: { message: "fixture error" } },
  ], false);
  expect(events.some(event => event.type === "error")).toBe(true);
  expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  expect(events.some(event => event.type === "done")).toBe(false);
  expect(textOf(events)).toBe(chunks.join(""));
});

test("review control: unmatched marker content survives normal completion", async () => {
  const content = "Explanation: <tool_call> is just a literal marker.";
  const events = await streamed([frame({ content }), frame({}, "stop")]);
  expect(textOf(events)).toBe(content);
  expect(events.some(event => event.type === "done")).toBe(true);
});

test("only the matching block is removed when several blocks use the same name", async () => {
  const example = block("exec", "text('example');");
  const actual = block("exec", "text('actual');");
  const content = `Example:\n${example}\nActual:\n${actual}`;
  const argumentsText = JSON.stringify({ input: "text('actual');" });
  const expected = `Example:\n${example}\nActual:\n`;
  for (const events of [
    await buffered(content, argumentsText),
    await streamed([frame({ content }), frame({ tool_calls: [tool(argumentsText)] }), frame({}, "tool_calls")]),
  ]) {
    expect(textOf(events)).toBe(expected);
    expect(argsOf(events)).toBe(argumentsText);
  }
});

test("held ordinary text survives malformed SSE and pending-call truncation", async () => {
  const prefix = "Explanation: <tool_call> is ordinary text.";
  const malformedEvents: AdapterEvent[] = [];
  const malformed = new Response(sse(frame({ content: prefix })) + "data: {bad json\n\n");
  for await (const event of createOpenAIChatAdapter(provider).parseStream!(malformed, createTestTranslatorBudget())) {
    malformedEvents.push(event);
  }
  expect(textOf(malformedEvents)).toBe(prefix);
  expect(malformedEvents.some(event => event.type === "error")).toBe(true);

  const truncatedEvents = await streamed([
    frame({ content: prefix }),
    frame({ tool_calls: [tool('{"input":"unfinished"')] }),
  ], false);
  expect(textOf(truncatedEvents)).toBe(prefix);
  expect(truncatedEvents.some(event => event.type === "error")).toBe(true);
  expect(truncatedEvents.some(event => event.type === "tool_call_start")).toBe(false);
});

test.each([
  ["upstream error", sse({ error: { message: "fixture error" } })],
  ["error finish reason", sse({ choices: [{ finish_reason: "error", error: { message: "fixture error" } }] })],
  ["malformed SSE", "data: {bad json\n\n"],
  ["invalid choices", sse({ choices: {} })],
  ["invalid tool calls", sse(frame({ tool_calls: {} }))],
  ["truncated stream", ""],
])("terminal %s retains serialized text without dispatching its pending tool", async (_, terminal) => {
  const script = "text('ok');";
  const argumentsText = JSON.stringify({ input: script });
  const content = "Running it.\n" + block("exec", script);
  const response = new Response(sse(frame({ content }))
    + sse(frame({ tool_calls: [tool(argumentsText)] })) + terminal);
  const events: AdapterEvent[] = [];
  for await (const event of createOpenAIChatAdapter(provider).parseStream!(response, createTestTranslatorBudget())) events.push(event);
  expect(textOf(events)).toBe(content);
  expect(events.at(-1)?.type).toBe("error");
  expect(events.some(event => event.type === "error")).toBe(true);
  expect(events.some(event => event.type.startsWith("tool_call_") || event.type === "done")).toBe(false);
});

test("an unnamed pending call cannot hide text for a later undispatched call", async () => {
  const script = "text('ok');";
  const content = block("exec", script);
  const events = await streamed([
    frame({ content }),
    frame({ tool_calls: [
      { index: 0, id: "unnamed", function: { arguments: "{}" } },
      { ...tool(JSON.stringify({ input: script })), index: 1 },
    ] }),
  ]);
  expect(textOf(events)).toBe(content);
  expect(events.at(-1)?.type).toBe("error");
  expect(events.some(event => event.type.startsWith("tool_call_") || event.type === "done")).toBe(false);
});

test("tolerant EOF evaluates narrowly repaired arguments before rejecting the call", async () => {
  const script = "text('ok');";
  const argumentsText = JSON.stringify({ input: script });
  const tolerantProvider = { ...provider, openaiChatEofTolerance: true };
  const response = new Response(
    sse(frame({ content: block("exec", script) }))
    + sse(frame({ tool_calls: [tool(script + argumentsText)] })),
  );
  const events: AdapterEvent[] = [];
  for await (const event of createOpenAIChatAdapter(tolerantProvider).parseStream!(response, createTestTranslatorBudget())) {
    events.push(event);
  }
  expect(textOf(events)).toBe("");
  expect(argsOf(events)).toBe(argumentsText);
  expect(events.some(event => event.type === "done")).toBe(true);
  expect(events.some(event => event.type === "error")).toBe(false);
});

test("wire aliases use the restored identity for suppression and argument repair", async () => {
  const namespace = "mcp__codex_apps__codex_document_control";
  const name = "execute_document_command";
  const originalName = namespacedToolName(namespace, name);
  const declared: OcxTool = { namespace, name, description: "fixture", parameters: { type: "object" } };
  const parsed: OcxParsedRequest = {
    modelId: "test-model",
    stream: false,
    options: {},
    context: { tools: [declared], messages: [{ role: "user", content: "run", timestamp: 0 }] },
  };
  const adapter = createOpenAIChatAdapter(provider);
  const request = adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() });
  if (request instanceof Promise) throw new Error("unexpected async request");
  const alias = (JSON.parse(request.body) as { tools: Array<{ function: { name: string } }> }).tools[0]!.function.name;
  expect(alias).not.toBe(originalName);

  const script = "text('ok');";
  const argumentsText = JSON.stringify({ input: script });
  const events = await adapter.parseResponse!(Response.json({
    choices: [{
      message: { content: block(originalName, script), tool_calls: [{ ...tool(script + argumentsText), function: { name: alias, arguments: script + argumentsText } }] },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());
  expect(textOf(events)).toBe("");
  expect(argsOf(events)).toBe(argumentsText);
});

test("ambiguous raw closing delimiters are preserved instead of partially suppressed", async () => {
  const script = "text('</function></tool_call>');";
  const content = block("exec", script);
  const argumentsText = script + JSON.stringify({ input: script });
  const events = await buffered(content, argumentsText);
  expect(textOf(events)).toBe(content);
  expect(argsOf(events)).toBe(argumentsText);
});

test("quoted and fenced copies remain visible beside an identical actual call, at every split", async () => {
  const script = "text('ok');";
  const actual = block("exec", script);
  const argumentsText = JSON.stringify({ input: script });
  for (const example of [
    `Example: \`${actual}\`\n`,
    `Example: \`\`\n${actual}\n\`\`\n`,
    `> ${actual}\n`,
    `\`\`\`xml\n${actual}\n\`\`\`\n`,
    `   ~~~~xml\n${actual}\n~~~\n${actual}\n~~~~\n`,
  ]) {
    const content = example + actual;
    expect(textOf(await buffered(content, argumentsText))).toBe(example);
    for (let split = 0; split <= content.length; split++) {
      const events = await streamed([
        frame({ content: content.slice(0, split) }),
        frame({ content: content.slice(split) }),
        frame({ tool_calls: [tool(argumentsText)] }),
        frame({}, "tool_calls"),
      ]);
      expect(textOf(events)).toBe(example);
      expect(argsOf(events)).toBe(argumentsText);
    }
  }
});

test("a quoted example cannot authorize argument repair", async () => {
  const script = "text('ok');";
  const content = `\`\`\`xml\n${block("exec", script)}\n\`\`\``;
  const argumentsText = script + JSON.stringify({ input: script });
  for (const events of [
    await buffered(content, argumentsText),
    await streamed([frame({ content }), frame({ tool_calls: [tool(argumentsText)] }), frame({}, "tool_calls")]),
  ]) {
    expect(textOf(events)).toBe(content);
    expect(argsOf(events)).toBe(argumentsText);
  }
});

test("literal markers resume text delivery before the terminal frame", async () => {
  const chunks = ["<tool_call>", " is an XML-like marker.", " More ordinary text."];
  const response = new Response(chunks.map(content => sse(frame({ content }))).join("") + sse(frame({}, "stop")));
  const iterator = createOpenAIChatAdapter(provider).parseStream!(response, createTestTranslatorBudget());
  try {
    expect((await iterator.next()).value).toEqual({ type: "heartbeat" });
    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: chunks[0]! + chunks[1]! });
    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: chunks[2]! });
  } finally {
    await iterator.return();
  }
});

test.each([false, true])("transport read failures retain held text with a pending matching call: %s", async (pendingCall) => {
  const script = "text('ok');";
  const content = block("exec", script);
  const failure = new Error("fixture read failure");
  let sent = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) controller.error(failure);
      else {
        sent = true;
        controller.enqueue(new TextEncoder().encode(sse(frame({ content }))
          + (pendingCall ? sse(frame({ tool_calls: [tool(JSON.stringify({ input: script }))] })) : "")));
      }
    },
  }));
  const events: AdapterEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of createOpenAIChatAdapter(provider).parseStream!(response, createTestTranslatorBudget())) events.push(event);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(textOf(events)).toBe(content);
  expect(events.some(event => event.type === "tool_call_start" || event.type === "done")).toBe(false);
});
