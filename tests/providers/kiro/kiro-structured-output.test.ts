import { afterEach, describe, expect, test } from "bun:test";
import { createKiroAdapter } from "../../../src/adapters/kiro";
import {
  KIRO_COMPLETION_TOOL_NAME,
  KIRO_STRUCTURED_OUTPUT_TOOL_NAME,
} from "../../../src/adapters/kiro-constants";
import { resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { parseKiroStructuredText, parseKiroStructuredToolInput, kiroStructuredOutputSpec } from "../../../src/adapters/kiro/structured-output";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { createTranslatorBudget, releaseTranslatedEvent } from "../../../src/lib/translator-budget";
import { parseRequest } from "../../../src/responses/parser";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

// Kiro has no schema-constrained response mode, so structured output is emulated through a private
// terminal tool whose input schema is the caller's format (src/adapters/kiro/structured-output.ts).
// The contract under test: the client receives JSON that tool (or a JSON-only text answer)
// produced, or an error — never prose — and an ordinary turn is untouched.

const provider: OcxProviderConfig = {
  adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", apiKey: "ksk_test",
};
const titleSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};
const bash = { type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } };

function structuredRequest(format: Record<string, unknown> = { type: "json_schema", name: "response", schema: titleSchema }, tools?: unknown[]): OcxParsedRequest {
  return parseRequest({
    model: "kiro/claude-opus-5.5",
    input: "Title this thread: fix the Kiro structured output bug",
    stream: true,
    text: { format },
    ...(tools ? { tools } : {}),
  } as never);
}

interface KiroTool { toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, any> } } }
async function payloadOf(parsed: OcxParsedRequest) {
  const body = JSON.parse((await createKiroAdapter(provider).buildRequest(parsed)).body);
  const current = body.conversationState.currentMessage.userInputMessage;
  const tools = (current.userInputMessageContext?.tools ?? []) as KiroTool[];
  return { current, tools, names: tools.map(tool => tool.toolSpecification.name) };
}

const frame = (type: string, payload: object) => encodeMessage(
  { ":message-type": "event", ":event-type": type },
  new TextEncoder().encode(JSON.stringify(payload)),
);
const text = (content: string) => frame("assistantResponseEvent", { content });
const stop = (stopReason: string) => frame("metadataEvent", { stopReason });
function tool(name: string, input: unknown, id = "call-1"): Uint8Array[] {
  return [
    frame("toolUseEvent", { name, toolUseId: id, input: typeof input === "string" ? input : JSON.stringify(input) }),
    frame("toolUseEvent", { name, toolUseId: id, stop: true }),
  ];
}
const structured = (input: unknown) => tool(KIRO_STRUCTURED_OUTPUT_TOOL_NAME, input);
function response(frames: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of frames) controller.enqueue(value);
      controller.close();
    },
  }));
}
afterEach(resetKiroThrottleStateForTests);

async function run(input: OcxParsedRequest, ...attempts: Uint8Array[][]) {
  return runWith(input, false, ...attempts);
}

async function runWith(input: OcxParsedRequest, buffered: boolean, ...attempts: Uint8Array[][]) {
  const adapter = createKiroAdapter(provider);
  const budget = createTranslatorBudget();
  const events: AdapterEvent[] = [];
  const bodies: string[] = [];
  try {
    const request = await adapter.buildRequest(input);
    const upstream = await adapter.fetchResponse!(request, {
      executor: (async (_url, init) => {
        bodies.push(String(init?.body));
        const frames = attempts[bodies.length - 1];
        if (!frames) throw new Error("unexpected extra Kiro attempt");
        return response(frames);
      }) as typeof fetch,
    });
    if (buffered) events.push(...await adapter.parseResponse!(upstream, budget));
    else for await (const event of adapter.parseStream(upstream, budget)) events.push(event);
    if (buffered) for (const event of events) releaseTranslatedEvent(event, budget);
    expect(budget.snapshot().currentBytes).toBe(0);
    const texts = events.filter(event => event.type === "text_delta");
    return { events, bodies, texts, terminal: events.at(-1) };
  } finally {
    budget.dispose();
  }
}

describe("Kiro structured-output payload", () => {
  test("a Responses json_schema turn is no longer refused and advertises only the structured tool", async () => {
    const parsed = structuredRequest();
    expect(parsed._structuredOutput).toBe(true);
    const { current, tools, names } = await payloadOf(parsed);
    // The structured tool REPLACES the completion tool: both would offer the model a prose exit.
    expect(names).toEqual([KIRO_STRUCTURED_OUTPUT_TOOL_NAME]);
    // Sanitized the way every Kiro tool schema is: additionalProperties is a validator reject.
    expect(tools[0].toolSpecification.inputSchema.json).toEqual({
      type: "object", properties: { title: { type: "string" } }, required: ["title"],
    });
    // ...so the caller's original constraints are restated verbatim in the prose contract.
    expect(current.content).toContain(`calling ${KIRO_STRUCTURED_OUTPUT_TOOL_NAME} exactly once`);
    expect(current.content).toContain(JSON.stringify(titleSchema));
    // A tool-free turn gets no work-tool catalog nudge and no completion contract.
    expect(current.content).not.toContain("Tool contract:");
    expect(current.content).not.toContain(KIRO_COMPLETION_TOOL_NAME);
  });

  test("ordinary client tools stay ahead of the structured tool, still without the completion tool", async () => {
    const { current, names } = await payloadOf(structuredRequest(undefined, [bash]));
    expect(names).toEqual(["bash", KIRO_STRUCTURED_OUTPUT_TOOL_NAME]);
    expect(current.content).toContain("Tool contract:");
    expect(current.content).toContain("Ordinary assistant text is mid-task commentary");
    expect(current.content).not.toContain(KIRO_COMPLETION_TOOL_NAME);
  });

  test("a non-object or composed root is wrapped under `value`, with definitions hoisted", async () => {
    const schema = {
      anyOf: [{ $ref: "#/$defs/item" }, { type: "array", items: { $ref: "#/$defs/item" } }],
      $defs: { item: { type: "string", maxLength: 10 } },
    };
    const { tools } = await payloadOf(structuredRequest({ type: "json_schema", name: "items", schema }));
    expect(tools[0].toolSpecification.inputSchema.json).toEqual({
      type: "object",
      properties: { value: { anyOf: [{ $ref: "#/$defs/item" }, { type: "array", items: { $ref: "#/$defs/item" } }] } },
      required: ["value"],
      $defs: { item: { type: "string" } },
    });
  });

  test("json_object asks for any JSON object", async () => {
    const { tools } = await payloadOf(structuredRequest({ type: "json_object" }));
    expect(tools.map(entry => entry.toolSpecification.inputSchema.json)).toEqual([{ type: "object" }]);
  });

  test("a plain-text format and an ordinary turn keep the completion tool contract", async () => {
    for (const parsed of [
      parseRequest({ model: "kiro/claude-opus-5.5", input: "hi", stream: true, text: { format: { type: "text" } }, tools: [bash] } as never),
      parseRequest({ model: "kiro/claude-opus-5.5", input: "hi", stream: true, tools: [bash] } as never),
    ]) {
      const { names } = await payloadOf(parsed);
      expect(names).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
    }
  });

  test("a client tool may not claim the structured-output name", async () => {
    const parsed = structuredRequest(undefined, [{ ...bash, name: KIRO_STRUCTURED_OUTPUT_TOOL_NAME }]);
    await expect(createKiroAdapter(provider).buildRequest(parsed)).rejects.toThrow("reserves the tool name");
  });
});

describe("Kiro structured-output stream", () => {
  for (const buffered of [false, true]) {
    test(`a structured tool call is relayed as the JSON answer, not as a tool call (buffered=${buffered})`, async () => {
      const { events, bodies, texts, terminal } = await runWith(
        structuredRequest(), buffered,
        [text("Here is a title."), ...structured({ title: "Fix Kiro structured output" })],
      );
      expect(texts).toEqual([{ type: "text_delta", text: '{"title":"Fix Kiro structured output"}', phase: "final_answer" }]);
      expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
      expect(terminal).toMatchObject({ type: "done", endTurn: true });
      expect(bodies).toHaveLength(1);
    });
  }

  test.each([
    ["bare JSON", '{"title":"Fix Kiro"}', '{"title":"Fix Kiro"}'],
    ["one whole fenced block", '```json\n{"title":"Fix Kiro"}\n```', '{"title":"Fix Kiro"}'],
  ])("a clean-stop text answer that IS the JSON is accepted without a retry (%s)", async (_label, answer, expected) => {
    const { bodies, texts, terminal } = await run(structuredRequest(), [text(answer), stop("END_TURN")]);
    expect(texts).toEqual([{ type: "text_delta", text: expected, phase: "final_answer" }]);
    expect(terminal).toMatchObject({ type: "done", endTurn: true });
    expect(bodies).toHaveLength(1);
  });

  test("prose earns one bounded retry; the prose itself never reaches the client", async () => {
    const { bodies, texts, terminal } = await run(
      structuredRequest(),
      [text("Sure! A good title would be: Fix Kiro."), stop("END_TURN")],
      structured({ title: "Fix Kiro" }),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("did not deliver the required structured output");
    expect(bodies[1]).toContain(KIRO_STRUCTURED_OUTPUT_TOOL_NAME);
    expect(texts).toEqual([{ type: "text_delta", text: '{"title":"Fix Kiro"}', phase: "final_answer" }]);
    expect(terminal).toMatchObject({ type: "done", endTurn: true });
  });

  test("a JSON text answer on the retry is accepted too", async () => {
    const { bodies, texts } = await run(structuredRequest(), [text("Thinking about it.")], [text('{"title":"Fix Kiro"}')]);
    expect(bodies).toHaveLength(2);
    expect(texts).toEqual([{ type: "text_delta", text: '{"title":"Fix Kiro"}', phase: "final_answer" }]);
  });

  test("prose twice is a clear non-retryable error with no text relayed", async () => {
    const { bodies, texts, terminal } = await run(
      structuredRequest(), [text("A title: Fix Kiro.")], [text("Fix Kiro structured output")],
    );
    expect(bodies).toHaveLength(2);
    expect(texts).toEqual([]);
    expect(terminal).toMatchObject({ type: "error", code: "invalid_kiro_structured_output", retryable: false, status: 502 });
  });

  test("a tool input missing a required key is retried once, then accepted", async () => {
    const { bodies, texts, terminal } = await run(
      structuredRequest(), structured({ name: "wrong key" }), structured({ title: "Fix Kiro" }),
    );
    expect(bodies).toHaveLength(2);
    expect(texts).toEqual([{ type: "text_delta", text: '{"title":"Fix Kiro"}', phase: "final_answer" }]);
    expect(terminal).toMatchObject({ type: "done", endTurn: true });
  });

  test("an invalid tool input on the retry fails the turn instead of relaying it", async () => {
    const { bodies, texts, terminal } = await run(
      structuredRequest(), structured({ name: "wrong" }), structured({ name: "still wrong" }),
    );
    expect(bodies).toHaveLength(2);
    expect(texts).toEqual([]);
    expect(terminal).toMatchObject({
      type: "error", code: "invalid_kiro_structured_output", message: expect.stringContaining('missing required property "title"'),
    });
  });

  test("a truncated text answer is not mistaken for JSON even when its prefix parses", async () => {
    const { bodies, texts, terminal } = await run(structuredRequest({ type: "json_object" }), [text("{}"), stop("MAX_TOKENS")]);
    expect(bodies).toHaveLength(1);
    expect(texts).toEqual([]);
    expect(terminal).toMatchObject({ type: "incomplete", reason: "max_output_tokens" });
  });

  test("the unadvertised completion tool is a protocol error, never a client tool call", async () => {
    const { events, terminal } = await run(structuredRequest(), tool(KIRO_COMPLETION_TOOL_NAME, { answer: "Fix Kiro" }));
    expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
    expect(terminal).toMatchObject({ type: "error", message: expect.stringContaining("did not advertise") });
  });

  test("an ordinary turn never treats the structured-output name as a client tool", async () => {
    const ordinary = parseRequest({ model: "kiro/claude-opus-5.5", input: "hi", stream: true, tools: [bash] } as never);
    const { events, terminal } = await run(ordinary, structured({ title: "x" }));
    expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
    expect(terminal).toMatchObject({ type: "error", message: expect.stringContaining("did not advertise") });
  });

  test("with client tools, a real tool call still continues the turn as before", async () => {
    const { events, terminal } = await run(
      structuredRequest(undefined, [bash]), [text("Checking first."), ...tool("bash", { command: "git log -1" })],
    );
    expect(events.filter(event => event.type !== "heartbeat").map(event => event.type))
      .toEqual(["text_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
    expect(terminal).toMatchObject({ type: "done", endTurn: false });
  });

  test("a wrapped answer is unwrapped from `value`", async () => {
    const schema = { type: "array", items: { type: "integer" } };
    const { texts } = await run(structuredRequest({ type: "json_schema", name: "ids", schema }), structured({ value: [1, 2] }));
    expect(texts).toEqual([{ type: "text_delta", text: "[1,2]", phase: "final_answer" }]);
  });
});

describe("Kiro structured-output text acceptance", () => {
  const spec = kiroStructuredOutputSpec(structuredRequest())!;
  test.each([
    ['{"title":"x"}', '{"title":"x"}'],
    ['  {"title":"x","extra":1}\n', '{"title":"x","extra":1}'],
    ['{"name":"x"}', undefined],
    ['["x"]', undefined],
    ['Title: {"title":"x"}', undefined],
    ['```json\n{"title":"x"}\n```\nHope that helps!', undefined],
    ["", undefined],
  ])("%j -> %j", (input, expected) => {
    expect(parseKiroStructuredText(spec, input)).toBe(expected);
  });
});

describe("Kiro structured-output composed roots", () => {
  const branches = (extra: Record<string, unknown>) => ({
    type: "json_schema",
    name: "response",
    schema: { anyOf: [{ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, extra] },
  });
  // A wrapped answer can come back JSON-encoded as a string inside `value`. That is only a valid
  // answer when a root branch admits strings; otherwise the root's branch types must reject it.
  test("a stringified answer is refused when no root branch admits a string", () => {
    const spec = kiroStructuredOutputSpec(structuredRequest(branches({ type: "array", items: { type: "boolean" } })))!;
    expect(spec.wrapped).toBe(true);
    expect(parseKiroStructuredToolInput(spec, '{"value":"{\\"ok\\": true}"}')).toEqual({
      error: "Kiro structured output did not match the requested format: expected a JSON object or array at the root",
    });
    expect(parseKiroStructuredToolInput(spec, '{"value":{"ok":true}}')).toEqual({ json: '{"ok":true}' });
  });

  test("a string answer stays valid when a root branch admits strings", () => {
    const spec = kiroStructuredOutputSpec(structuredRequest(branches({ type: "string" })))!;
    expect(parseKiroStructuredToolInput(spec, '{"value":"{\\"ok\\": true}"}')).toEqual({ json: '"{\\"ok\\": true}"' });
  });

  test("a branch without a declared type admits anything", () => {
    const spec = kiroStructuredOutputSpec(structuredRequest(branches({ $ref: "#/$defs/other" })))!;
    expect(parseKiroStructuredToolInput(spec, '{"value":"anything"}')).toEqual({ json: '"anything"' });
  });
});

describe("Kiro structured-output stop reasons", () => {
  // A failed structured answer under a stop that already ended the inference upstream would only
  // hit the same limit or verdict again, so it earns no retry and keeps that stop's own terminal.
  test("an invalid tool input under MAX_TOKENS is not retried", async () => {
    const { bodies, texts, terminal } = await run(
      structuredRequest(), [...structured({ name: "wrong key" }), stop("MAX_TOKENS")],
    );
    expect(bodies).toHaveLength(1);
    expect(texts).toEqual([]);
    expect(terminal).toMatchObject({ type: "incomplete", reason: "max_output_tokens" });
  });

  test("a retry whose JSON text was cut by MAX_TOKENS fails instead of being accepted", async () => {
    const { bodies, texts, terminal } = await run(
      structuredRequest(),
      [text("Sure! A good title would be: Fix Kiro."), stop("END_TURN")],
      [text('{"title":"Fix Kiro"}'), stop("MAX_TOKENS")],
    );
    expect(bodies).toHaveLength(2);
    expect(texts).toEqual([]);
    expect(terminal).toMatchObject({
      type: "error",
      code: "invalid_kiro_structured_output",
      retryable: false,
      message: expect.stringContaining("stopped with MAX_TOKENS"),
    });
  });

  test("a malformed structured tool input on the retry is non-retryable", async () => {
    const { bodies, texts, terminal } = await run(
      structuredRequest(), structured({ name: "wrong key" }), structured('{"title":'),
    );
    expect(bodies).toHaveLength(2);
    expect(texts).toEqual([]);
    expect(terminal).toMatchObject({ type: "error", code: "invalid_kiro_structured_output", retryable: false });
  });

  test("an empty retry ends the structured contract with a non-retryable failure", async () => {
    const { bodies, texts, terminal } = await run(
      structuredRequest(), structured({ name: "wrong key" }), [stop("END_TURN")],
    );
    expect(bodies).toHaveLength(2);
    expect(texts).toEqual([]);
    expect(terminal).toMatchObject({
      type: "error",
      code: "invalid_kiro_structured_output",
      retryable: false,
      message: expect.stringContaining("produced no answer"),
    });
  });
});
