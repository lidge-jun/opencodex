import { create, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  PartialToolCallUpdateSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import { canonicalCursorFreeformArgs } from "../../../src/adapters/cursor/freeform-args";
import {
  createCursorProtobufEventState,
  mapCursorProtobufServerMessage,
  mapSyntheticMcpExecToToolEvents,
} from "../../../src/adapters/cursor/protobuf-events";

// #7049: Cursor Opus code-mode `exec` calls were dropped before host execution because the
// pre-emission gate accepted only `{input:string}`, while the shared Responses repair downstream
// already reads the one faithful alternate field. These cases pin the shared reading at the gate.

const encoder = new TextEncoder();

function interaction(message: Parameters<typeof create<typeof InteractionUpdateSchema>>[1]["message"]) {
  return create(AgentServerMessageSchema, {
    message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
  });
}

function stringValueBytes(value: string): Uint8Array {
  return toBinary(ValueSchema, create(ValueSchema, { kind: { case: "stringValue", value } }));
}

function execArgs(callId: string, args: Record<string, Uint8Array>) {
  return create(McpArgsSchema, {
    name: "exec",
    toolName: "exec",
    toolCallId: callId,
    providerIdentifier: "opencodex-responses",
    args,
  });
}

function execToolCall(callId: string, args: Record<string, Uint8Array>) {
  return create(ToolCallSchema, {
    tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args: execArgs(callId, args) }) },
  });
}

function codeModeState() {
  return createCursorProtobufEventState({
    clientToolNames: ["exec", "wait"],
    freeformToolNames: ["exec"],
    cursorToolNameMap: new Map([["exec", "exec"], ["wait", "wait"]]),
  });
}

describe("Cursor freeform argument gate (#7049)", () => {
  test("keeps a canonical wrapper byte-identical", () => {
    const args = '{ "input" : "text(1)" }';
    expect(canonicalCursorFreeformArgs(args, "exec")).toEqual({ ok: true, args });
  });

  test("re-emits one recognized exec fallback field as the canonical wrapper", () => {
    const code = "const r = await tools.exec_command({cmd: \"ls\"});\ntext(r.output);";
    expect(canonicalCursorFreeformArgs(JSON.stringify({ code }), "exec"))
      .toEqual({ ok: true, args: JSON.stringify({ input: code }) });
    expect(canonicalCursorFreeformArgs(JSON.stringify({ patch: "*** Begin Patch\n*** End Patch" }), "apply_patch"))
      .toEqual({ ok: true, args: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) });
  });

  test("stays closed for ambiguous, non-string, foreign, and unparseable shapes", () => {
    expect(canonicalCursorFreeformArgs(JSON.stringify({ code: "a", script: "b" }), "exec"))
      .toEqual({ ok: false, reason: "received keys [code:string, script:string]" });
    expect(canonicalCursorFreeformArgs(JSON.stringify({ input: { code: "a" } }), "exec"))
      .toEqual({ ok: false, reason: "input was object" });
    // Fallback keys belong to Codex's own exec/apply_patch grammars, not to any freeform tool.
    expect(canonicalCursorFreeformArgs(JSON.stringify({ code: "a" }), "mcp__x__exec"))
      .toEqual({ ok: false, reason: "received keys [code:string]" });
    expect(canonicalCursorFreeformArgs("text(1)", "exec"))
      .toEqual({ ok: false, reason: "received arguments that are not JSON" });
    expect(canonicalCursorFreeformArgs("", "exec")).toEqual({ ok: false, reason: "received no arguments" });
  });

  test("diagnostics name only allowlisted keys and count the rest", () => {
    // Identifier-shaped keys can still be request content (an account id, a token), and the
    // error is persisted to request logs, so nothing outside the fixed allowlist is printed.
    const result = canonicalCursorFreeformArgs(
      JSON.stringify({ "text(secret body)": 1, acct_123456: "x", source: "y" }),
      "exec",
    );
    expect(result).toEqual({ ok: false, reason: "received keys [source:string, +2 other]" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("acct_123456");
  });

  test("commits a completed Opus exec call that names its body `code`", () => {
    const state = codeModeState();
    const toolCall = execToolCall("call_code", { code: stringValueBytes("text(await tools.exec_command({cmd: 'ls'}))") });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_code", modelCallId: "m", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_code", name: "exec" },
      { type: "tool_call_delta", arguments: JSON.stringify({ input: "text(await tools.exec_command({cmd: 'ls'}))" }) },
      { type: "tool_call_end", id: "call_code" },
    ]);
  });

  test("commits a streamed `code` wrapper on a compact completion instead of waiting for native args", () => {
    const state = codeModeState();
    const toolCall = execToolCall("call_stream", {});
    mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_stream", modelCallId: "m", toolCall }),
    }), state);
    mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, {
        callId: "call_stream", modelCallId: "m", toolCall, argsTextDelta: '{"code":"text(1)"}',
      }),
    }), state);
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_stream", modelCallId: "m" }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_stream", name: "exec" },
      { type: "tool_call_delta", arguments: '{"input":"text(1)"}' },
      { type: "tool_call_end", id: "call_stream" },
    ]);
  });

  test("keeps a freeform body that is itself valid JSON as a string on the native mcpArgs path", () => {
    for (const [callId, body, bytes] of [
      ["call_value", "{}", stringValueBytes("{}")],
      ["call_number", "42", stringValueBytes("42")],
      ["call_raw_quoted", "null", encoder.encode(JSON.stringify("null"))],
    ] as const) {
      const state = codeModeState();
      expect(mapSyntheticMcpExecToToolEvents(execArgs(callId, { input: bytes }), "fallback", { state })).toEqual([
        { type: "tool_call_start", id: callId, name: "exec" },
        { type: "tool_call_delta", arguments: JSON.stringify({ input: body }) },
        { type: "tool_call_end", id: callId },
      ]);
    }
  });

  test("still rejects an unrecognized wrapper with its shape in the error", () => {
    const state = codeModeState();
    expect(mapSyntheticMcpExecToToolEvents(
      execArgs("call_bad", { program: stringValueBytes("text(1)"), acct_9: stringValueBytes("x") }),
      "fallback",
      { state },
    )).toEqual([
      { type: "error", message: "exec call had invalid freeform arguments; expected {input:string} (received keys [program:string, +1 other])" },
    ]);
    expect(state.completedToolCalls.has("call_bad")).toBe(true);
  });
});

