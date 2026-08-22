import { describe, expect, test } from "bun:test";
import { coerceIntegerToolArguments } from "../src/lib/tool-argument-integers";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

/** The exec_command / write_stdin shape from the #1611 report. */
const EXEC_SCHEMA = {
  type: "object",
  properties: {
    cmd: { type: "string" },
    yield_time_ms: { type: "integer" },
    max_output_tokens: { type: "integer" },
    session_id: { type: "integer" },
    temperature: { type: "number" },
  },
};

describe("integral-float tool argument repair (#1611)", () => {
  test("repairs the exact values Grok emitted in the report", () => {
    // failed to parse function arguments: invalid type: floating point `120000.0`, expected u64
    expect(coerceIntegerToolArguments('{"yield_time_ms":120000.0}', EXEC_SCHEMA))
      .toBe('{"yield_time_ms":120000}');
    // ... floating point `29356.0`, expected i32
    expect(coerceIntegerToolArguments('{"session_id":29356.0,"yield_time_ms":60000.0}', EXEC_SCHEMA))
      .toBe('{"session_id":29356,"yield_time_ms":60000}');
  });

  test("leaves a non-integral value for an integer field failing", () => {
    // 1.5 is a genuine disagreement with the schema, not a serialization artifact.
    // Truncating it would invent an intent the model never expressed.
    const out = coerceIntegerToolArguments('{"yield_time_ms":1.5}', EXEC_SCHEMA);
    expect(out).toBe('{"yield_time_ms":1.5}');
  });

  test("never touches number-typed fields", () => {
    const out = coerceIntegerToolArguments('{"temperature":1.0}', EXEC_SCHEMA);
    expect(JSON.parse(out).temperature).toBe(1);
    expect(out).toBe('{"temperature":1.0}');
  });

  test("leaves fields with no declared schema exactly as received", () => {
    const out = coerceIntegerToolArguments('{"undeclared":7.0}', EXEC_SCHEMA);
    expect(out).toBe('{"undeclared":7.0}');
  });

  test("returns the original bytes when nothing needs repair", () => {
    const clean = '{"cmd":"ls -la","yield_time_ms":120000}';
    expect(coerceIntegerToolArguments(clean, EXEC_SCHEMA)).toBe(clean);
  });

  test("preserves unrelated values and string content", () => {
    const out = coerceIntegerToolArguments(
      '{"cmd":"echo 1.5","yield_time_ms":120000.0,"temperature":0.7}',
      EXEC_SCHEMA,
    );
    const parsed = JSON.parse(out);
    expect(parsed.cmd).toBe("echo 1.5");
    expect(parsed.yield_time_ms).toBe(120000);
    expect(parsed.temperature).toBe(0.7);
    expect(out).toContain('"yield_time_ms":120000,');
  });

  test("accepts an integer|null union", () => {
    const schema = { type: "object", properties: { limit: { type: ["integer", "null"] } } };
    expect(coerceIntegerToolArguments('{"limit":10.0}', schema)).toBe('{"limit":10}');
  });

  test("walks nested objects and arrays", () => {
    const schema = {
      type: "object",
      properties: {
        page: {
          type: "object",
          properties: { size: { type: "integer" } },
        },
        ids: { type: "array", items: { type: "integer" } },
      },
    };
    expect(coerceIntegerToolArguments('{"page":{"size":50.0},"ids":[1.0,2.0]}', schema))
      .toBe('{"page":{"size":50},"ids":[1,2]}');
  });

  test("resolves a local $ref into $defs", () => {
    const schema = {
      type: "object",
      properties: { window: { $ref: "#/$defs/Window" } },
      $defs: { Window: { type: "object", properties: { ms: { type: "integer" } } } },
    };
    expect(coerceIntegerToolArguments('{"window":{"ms":5000.0}}', schema))
      .toBe('{"window":{"ms":5000}}');
  });

  test("survives a cyclic $ref instead of recursing forever", () => {
    const schema = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: { Node: { $ref: "#/$defs/Node" } },
    };
    expect(coerceIntegerToolArguments('{"node":{"x":1.0}}', schema)).toBe('{"node":{"x":1.0}}');
  });

  test("refuses to rewrite a value it cannot represent exactly", () => {
    // Beyond 2^53-1 a rewrite would emit a silently different number.
    const schema = { type: "object", properties: { big: { type: "integer" } } };
    const huge = '{"big":9007199254740993.0}';
    expect(coerceIntegerToolArguments(huge, schema)).toBe(huge);
  });

  test("is a no-op without a schema, on malformed JSON, and on empty input", () => {
    expect(coerceIntegerToolArguments('{"a":1.0}', undefined)).toBe('{"a":1.0}');
    expect(coerceIntegerToolArguments('{"a":1.0', EXEC_SCHEMA)).toBe('{"a":1.0');
    expect(coerceIntegerToolArguments("", EXEC_SCHEMA)).toBe("");
  });
});

// End-to-end through the real bridge: the unit tests above prove the coercion, these
// prove it is actually WIRED into the paths that emit tool calls to Codex.
describe("#1611 wiring: bridge emits repaired arguments", () => {
  const schemas = new Map<string, Record<string, unknown>>([
    ["exec_command", {
      type: "object",
      properties: { cmd: { type: "string" }, yield_time_ms: { type: "integer" } },
    }],
  ]);

  test("streaming path repairs the arguments Codex would have rejected", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_delta", arguments: '{"cmd":"ls","yield_time_ms":120000.0}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ]), "grok-4.5", undefined, undefined, undefined, undefined, 2_000, { toolParameterSchemas: schemas }));

    const done = frames.find(f => f.event === "response.function_call_arguments.done");
    expect(done?.data.arguments).toBe('{"cmd":"ls","yield_time_ms":120000}');

    // output_item.added emits the call with empty arguments; the completed item is
    // the one Codex actually parses.
    const item = frames
      .filter(f => f.event === "response.output_item.done")
      .map(f => f.data.item as Record<string, unknown> | undefined)
      .find(i => i?.type === "function_call");
    expect(item?.arguments).toBe('{"cmd":"ls","yield_time_ms":120000}');
  });

  test("non-streaming path repairs the same call", () => {
    const body = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_delta", arguments: '{"yield_time_ms":120000.0}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "grok-4.5", { toolParameterSchemas: schemas }) as Record<string, unknown>;

    const output = body.output as Record<string, unknown>[];
    const call = output.find(item => item.type === "function_call");
    expect(call?.arguments).toBe('{"yield_time_ms":120000}');
  });

  test("a tool with no declared schema passes through untouched", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_2", name: "unknown_tool" },
      { type: "tool_call_delta", arguments: '{"n":7.0}' },
      { type: "tool_call_end", id: "call_2" },
      { type: "done" },
    ]), "grok-4.5", undefined, undefined, undefined, undefined, 2_000, { toolParameterSchemas: schemas }));
    const done = frames.find(f => f.event === "response.function_call_arguments.done");
    expect(done?.data.arguments).toBe('{"n":7.0}');
  });
});

/** The code-mode wait shape from the #1938 report: cell_id declared string. */
const WAIT_SCHEMA = {
  type: "object",
  properties: {
    cell_id: { type: "string" },
    yield_time_ms: { type: "integer" },
    max_tokens: { type: "integer" },
    label: { type: ["string", "null"] },
    loose: { type: ["integer", "string"] },
  },
};

describe("bare-integer-for-string tool argument repair (#1938)", () => {
  test("repairs the exact call cursor/gpt-5.6-sol emitted in the report", () => {
    // invalid type: integer `4`, expected a string — 19/19 wait calls rejected
    expect(coerceIntegerToolArguments('{"cell_id":4,"yield_time_ms":10000}', WAIT_SCHEMA))
      .toBe('{"cell_id":"4","yield_time_ms":10000}');
  });

  test("repairs a string-or-null union field", () => {
    expect(coerceIntegerToolArguments('{"label":12}', WAIT_SCHEMA))
      .toBe('{"label":"12"}');
  });

  test("a union that also accepts a numeric type keeps the number", () => {
    const clean = '{"loose":4}';
    expect(coerceIntegerToolArguments(clean, WAIT_SCHEMA)).toBe(clean);
  });

  test("a non-integral number in a string field is not manufactured into a string", () => {
    const clean = '{"cell_id":4.5}';
    expect(coerceIntegerToolArguments(clean, WAIT_SCHEMA)).toBe(clean);
  });

  test("a value beyond 2^53-1 keeps its original bytes", () => {
    const clean = '{"cell_id":18446744073709551615}';
    expect(coerceIntegerToolArguments(clean, WAIT_SCHEMA)).toBe(clean);
  });

  test("a real string stays untouched and bytes are preserved", () => {
    const clean = '{"cell_id":"4","yield_time_ms":10000}';
    expect(coerceIntegerToolArguments(clean, WAIT_SCHEMA)).toBe(clean);
  });

  test("both repairs compose in one payload", () => {
    expect(coerceIntegerToolArguments('{"cell_id":4,"yield_time_ms":120000.0}', WAIT_SCHEMA))
      .toBe('{"cell_id":"4","yield_time_ms":120000}');
  });

  test("nested objects and arrays repair against their declared schemas", () => {
    const schema = {
      type: "object",
      properties: {
        page: { type: "object", properties: { id: { type: "string" } } },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    expect(coerceIntegerToolArguments('{"page":{"id":7},"tags":[1,2]}', schema))
      .toBe('{"page":{"id":"7"},"tags":["1","2"]}');
  });

  test("an integer field arriving as an integer is never stringified", () => {
    const clean = '{"yield_time_ms":10000}';
    expect(coerceIntegerToolArguments(clean, WAIT_SCHEMA)).toBe(clean);
  });
});

