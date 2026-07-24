import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ConversationTokenDetailsSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  PartialToolCallUpdateSchema,
  TokenDeltaUpdateSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import {
  createCursorContextUsageTracker,
  createCursorProtobufEventState,
  finalizeTurnEvents,
  mapCursorProtobufServerMessage,
} from "../src/adapters/cursor/protobuf-events";
import { estimateCursorInputTokens } from "../src/adapters/cursor/protobuf-request";

const encoder = new TextEncoder();

function interaction(message: Parameters<typeof create<typeof InteractionUpdateSchema>>[1]["message"]) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, { message }),
    },
  });
}

function mcpToolCall(toolName: string, args: Record<string, string>) {
  const encoded: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(args)) encoded[key] = encoder.encode(JSON.stringify(value));
  return create(ToolCallSchema, {
    tool: {
      case: "mcpToolCall",
      value: create(McpToolCallSchema, {
        args: create(McpArgsSchema, {
          name: toolName,
          toolName,
          toolCallId: "call_1",
          providerIdentifier: "opencodex-responses",
          args: encoded,
        }),
      }),
    },
  });
}

function checkpointUpdate(usedTokens: number) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "conversationCheckpointUpdate",
      value: create(ConversationStateStructureSchema, {
        tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens }),
      }),
    },
  });
}

function turnEndedFrame() {
  return create(AgentServerMessageSchema, {
    message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
      message: { case: "turnEnded", value: {} },
    }) },
  });
}

describe("Cursor protobuf tool-call events", () => {
  test("maps MCP tool-call updates to Cursor tool call messages", () => {
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    // Start is recorded but NOT emitted (deferred to completion for atomic, serialized emission).
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([]);

    // Partial args are buffered silently (no delta) until completion.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\":\"a.txt\"}" }),
    }), state)).toEqual([]);

    // Completion emits the deferred start, the full args once, then end (one atomic unit).
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("maps Cursor run_shell calls back to Responses exec_command events", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: ["run_shell"],
      toolSchemas: new Map([[
        "run_shell",
        { type: "object", properties: { cmd: { type: "string" }, workdir: { type: "string" } }, required: ["cmd"] },
      ]]),
      cursorToolNameMap: new Map([["run_shell", "exec_command"]]),
    });
    const toolCall = mcpToolCall("run_shell", { cmd: "echo hi" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"echo hi\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("keeps genuine run_shell tool name when no exec_command alias was advertised", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: ["run_shell"],
      cursorToolNameMap: new Map([["run_shell", "run_shell"]]),
    });
    const toolCall = mcpToolCall("run_shell", { cmd: "echo hi" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "run_shell" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"echo hi\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("buffers partial tool-call args silently and emits once at completion", () => {
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    // First partial: opens the call, buffers args, emits nothing (start deferred).
    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\"" }),
    }), state)).toEqual([]);

    // Second partial: more cumulative text buffered, still no delta.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\":\"a.txt\"}" }),
    }), state)).toEqual([]);

    // Completion (no map bytes here) emits the deferred start + buffered complete JSON once.
    const noBytes = mcpToolCall("mcp__fs__read_file", {});
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: noBytes }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("ignores local MCP tool-call updates and rejects unknown synthetic tools", () => {
    const local = createCursorProtobufEventState();
    const localCall = create(ToolCallSchema, {
      tool: {
        case: "mcpToolCall",
        value: create(McpToolCallSchema, {
          args: create(McpArgsSchema, {
            name: "local",
            toolName: "local",
            toolCallId: "call_local",
            providerIdentifier: "opencodex",
          }),
        }),
      },
    });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_local", modelCallId: "model_1", toolCall: localCall }),
    }), local)).toEqual([]);

    const guarded = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_2", modelCallId: "model_1", toolCall: mcpToolCall("mcp__fs__write_file", {}) }),
    }), guarded)).toEqual([{ type: "error", message: "Cursor requested unknown Responses tool: mcp__fs__write_file" }]);
  });

  test("serializes overlapping/parallel tool calls into atomic units (no fail-closed)", () => {
    // Cursor may open several client tool calls before any completes (the model requested many tools
    // at once). Deferred-start emission means each call surfaces as one self-contained
    // start -> delta -> end unit at completion, so they never cross-wire the single-current-call
    // bridge. parallel_tool_calls=false must NOT abort the turn.
    const state = createCursorProtobufEventState({
      clientToolNames: ["mcp__fs__read_file", "mcp__fs__write_file"],
      parallelToolCalls: false,
    });

    const read = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });
    const write = mcpToolCall("mcp__fs__write_file", { path: "b.txt" });

    // call_1 starts (recorded, no emit).
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: read }),
    }), state)).toEqual([]);

    // call_2 opens WHILE call_1 is still open (overlap) — still recorded, no error, no emit.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_2", modelCallId: "model_2", toolCall: write }),
    }), state)).toEqual([]);

    // call_1 completes as a whole atomic unit.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: read }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);

    // call_2 then completes as its own atomic unit.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_2", modelCallId: "model_2", toolCall: write }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_2", name: "mcp__fs__write_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"b.txt\"}" },
      { type: "tool_call_end", id: "call_2" },
    ]);
  });

  test("uses completed MCP args when no partial args arrived", () => {
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("trusts already-streamed JSON args and ignores the redundant completed map", () => {
    // Cursor streams the model's raw cumulative JSON text (with spaces), then redelivers the same
    // args as a structured map on completion. Partial args are buffered silently; completion emits
    // the canonical map once. The streamed-with-spaces text never reaches the bridge raw.
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    // Start recorded, not emitted (deferred to completion).
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([]);

    // Partial buffered silently (no delta).
    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\": \"a.txt\"}" }),
    }), state)).toEqual([]);

    // Completion carries the canonical map; emit deferred start + canonical args once + end.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("falls back to the completed map when the streamed args never completed", () => {
    // A partial stream that stops mid-JSON (never a complete document) is repaired from the
    // authoritative completed map at completion (buffered text is discarded when incomplete).
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state);
    // Incomplete partial buffered silently.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\":" }),
    }), state)).toEqual([]);

    const completedEvents = mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state);
    // No error is emitted, and the call ends.
    expect(completedEvents.find(e => e.type === "error")).toBeUndefined();
    expect(completedEvents.at(-1)).toEqual({ type: "tool_call_end", id: "call_1" });
    // The single emitted delta parses to the authoritative args from the completed map.
    const delta = completedEvents.find(e => e.type === "tool_call_delta");
    expect(delta && delta.type === "tool_call_delta" ? JSON.parse(delta.arguments) : null).toEqual({ path: "a.txt" });
  });

  test("commits an advertised no-arg tool call instead of dropping it", () => {
    // A completed client tool call with no args and no streamed text must still reach Codex when the
    // tool is advertised (e.g. a no-arg list/status tool). The bridge serializes empty args as "{}".
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__list_roots"] });
    const toolCall = mcpToolCall("mcp__fs__list_roots", {});
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__list_roots" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("does not commit a no-arg completion for an unadvertised tool (prelude noise)", () => {
    // Without an advertised client-tool list we cannot distinguish a real no-arg call from a Cursor
    // prelude, so an empty completion stays dropped.
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__list_roots", {});
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([]);
  });

  test("records overlapping opens without emitting (deferred start, no fail-closed)", () => {
    // call_1 is started and still open when call_2 starts. Under deferred-start emission both are
    // merely recorded (no outward event), so there is no cross-wiring and no error: completion emits
    // each call as its own atomic unit (see the serialization test above).
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file", "mcp__fs__write_file"] });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: mcpToolCall("mcp__fs__read_file", {}) }),
    }), state)).toEqual([]);
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_2", modelCallId: "model_2", toolCall: mcpToolCall("mcp__fs__write_file", {}) }),
    }), state)).toEqual([]);
    // Both calls remain open and recorded, ready to be committed atomically on completion.
    expect(state.openToolCalls.has("call_1")).toBe(true);
    expect(state.openToolCalls.has("call_2")).toBe(true);
  });

  test("allows sequential tool calls (no false-positive overlap)", () => {
    // call_1 completes before call_2 starts -> not an overlap. Both must succeed.
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file", "mcp__fs__write_file"] });
    const first = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: first }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
    const second = mcpToolCall("mcp__fs__write_file", { path: "b.txt" });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_2", modelCallId: "model_2", toolCall: second }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_2", name: "mcp__fs__write_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"b.txt\"}" },
      { type: "tool_call_end", id: "call_2" },
    ]);
  });

  test("turnEnded with an open tool call emits truncation error instead of done (fail-closed)", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    // Start a tool call but never complete it.
    mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: mcpToolCall("mcp__fs__read_file", {}) }),
    }), state);
    // Now the turn ends while the tool call is still open.
    const turnEnd = create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }) },
    });
    const events = mapCursorProtobufServerMessage(turnEnd, state);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("incomplete tool call");
    expect((events[0] as { message: string }).message).toContain("call_1");
  });

  test("turnEnded without open tool calls emits done normally", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });
    // Complete the tool call first.
    mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state);
    // Turn ends cleanly.
    const turnEnd = create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }) },
    });
    const events = mapCursorProtobufServerMessage(turnEnd, state);
    expect(events).toEqual([{ type: "done", usage: { inputTokens: 0, outputTokens: 0, estimated: true } }]);
  });

  test("uses a request-local input estimate when no checkpoint or carry-forward context exists", () => {
    const estimatedInputTokens = estimateCursorInputTokens({
      modelId: "grok-4.5",
      conversationId: "restart-without-checkpoint",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "Explain this JSON: {\\\"path\\\":\\\"src/app.ts\\\"}" }],
    });
    const state = createCursorProtobufEventState({ estimatedInputTokens });
    state.usage.outputTokens = 7;

    expect(finalizeTurnEvents(state)).toEqual([
      { type: "done", usage: { inputTokens: estimatedInputTokens, outputTokens: 7, totalTokens: estimatedInputTokens + 7, estimated: true } },
    ]);
  });

  test("normalizes a mis-keyed completed tool-call arg against the advertised schema", () => {
    // The model called the right tool but used `filepath` instead of the schema's `path`.
    const toolSchemas = new Map<string, unknown>([
      ["mcp__fs__read_file", { type: "object", properties: { path: { type: "string" } } }],
    ]);
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"], toolSchemas });
    const toolCall = mcpToolCall("mcp__fs__read_file", { filepath: "a.txt" });
    const events = mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state);
    const delta = events.find(e => e.type === "tool_call_delta");
    expect(delta && delta.type === "tool_call_delta" ? JSON.parse(delta.arguments) : null).toEqual({ path: "a.txt" });
  });

  test("normalizes mis-keyed args that arrived only via streamed text (no completed map)", () => {
    // The P1 audit case: model streamed `{"filepath":"a.txt"}` complete and the completion has no
    // map bytes. Buffered text must still be schema-normalized to `path` before reaching Codex.
    const toolSchemas = new Map<string, unknown>([
      ["mcp__fs__read_file", { type: "object", properties: { path: { type: "string" } } }],
    ]);
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"], toolSchemas });
    const withArgs = mcpToolCall("mcp__fs__read_file", {});
    mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: withArgs }),
    }), state);
    mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: withArgs, argsTextDelta: "{\"filepath\": \"a.txt\"}" }),
    }), state);
    const events = mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: withArgs }),
    }), state);
    const delta = events.find(e => e.type === "tool_call_delta");
    expect(delta && delta.type === "tool_call_delta" ? JSON.parse(delta.arguments) : null).toEqual({ path: "a.txt" });
  });

  test("checkpoint usedTokens becomes absolute totalTokens, not additive output (no double-count)", () => {
    // Regression for the 10000-then-10300-shows-as-20300 bug. Cursor's checkpoint usedTokens is the
    // ABSOLUTE conversation context size; tokenDelta is additive per-turn output. They must land in
    // separate fields: totalTokens (absolute) vs outputTokens (additive), mirroring the Kiro SOT fix.
    const state = createCursorProtobufEventState({ estimatedInputTokens: 1_200 });

    const checkpoint = (usedTokens: number) => create(AgentServerMessageSchema, {
      message: {
        case: "conversationCheckpointUpdate",
        value: create(ConversationStateStructureSchema, {
          tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens }),
        }),
      },
    });

    // Two checkpoints (absolute, monotonic) + some streamed output tokens.
    expect(mapCursorProtobufServerMessage(checkpoint(10_000), state)).toEqual([]);
    mapCursorProtobufServerMessage(interaction({ case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 42 }) }), state);
    expect(mapCursorProtobufServerMessage(checkpoint(10_300), state)).toEqual([]);

    const turnEnd = create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }) },
    });
    // totalTokens reflects the latest absolute checkpoint (10300), NOT 10000+10300 and NOT folded
    // into outputTokens (which carries only the additive per-turn output delta). inputTokens is the
    // inferred active context before the streamed output so Codex's visible input+output counter
    // matches totalTokens instead of showing only 42.
    expect(mapCursorProtobufServerMessage(turnEnd, state)).toEqual([
      { type: "done", usage: { inputTokens: 10_258, outputTokens: 42, totalTokens: 10_300, estimated: true } },
    ]);
    // After the terminal done, state is marked terminated so post-terminal progress frames stay inert.
    expect(state.terminated).toBe(true);
  });

  test("checkpoint usage clamps inferred input when output delta exceeds context", () => {
    const state = createCursorProtobufEventState();
    const checkpoint = create(AgentServerMessageSchema, {
      message: {
        case: "conversationCheckpointUpdate",
        value: create(ConversationStateStructureSchema, {
          tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 10 }),
        }),
      },
    });
    const turnEnd = create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }) },
    });

    expect(mapCursorProtobufServerMessage(checkpoint, state)).toEqual([]);
    mapCursorProtobufServerMessage(interaction({ case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 42 }) }), state);

    expect(mapCursorProtobufServerMessage(turnEnd, state)).toEqual([
      { type: "done", usage: { inputTokens: 0, outputTokens: 42, totalTokens: 10, estimated: true } },
    ]);
  });

  test("ordinary checkpoints update the per-conversation carry-forward for later no-checkpoint turns", () => {
    const tracker = createCursorContextUsageTracker();
    const first = createCursorProtobufEventState({
      contextUsage: tracker.controlsForConversation("cursor_conv_1"),
    });
    first.usage.outputTokens = 42;

    expect(mapCursorProtobufServerMessage(checkpointUpdate(10_300), first)).toEqual([]);
    expect(mapCursorProtobufServerMessage(turnEndedFrame(), first)).toEqual([
      { type: "done", usage: { inputTokens: 10_258, outputTokens: 42, totalTokens: 10_300, estimated: true } },
    ]);
    expect(tracker.get("cursor_conv_1")).toBe(10_300);

    const next = createCursorProtobufEventState({
      contextUsage: tracker.controlsForConversation("cursor_conv_1"),
    });
    next.usage.outputTokens = 7;
    expect(finalizeTurnEvents(next)).toEqual([
      { type: "done", usage: { inputTokens: 10_293, outputTokens: 7, totalTokens: 10_300, estimated: true } },
    ]);
  });

  test("same-session checkpoints cannot regress below a carried context total", () => {
    const tracker = createCursorContextUsageTracker();
    tracker.record("cursor_conv_1", 10_300);
    const state = createCursorProtobufEventState({
      contextUsage: tracker.controlsForConversation("cursor_conv_1"),
    });
    state.usage.outputTokens = 20;

    expect(mapCursorProtobufServerMessage(checkpointUpdate(9_900), state)).toEqual([]);
    expect(mapCursorProtobufServerMessage(turnEndedFrame(), state)).toEqual([
      { type: "done", usage: { inputTokens: 10_280, outputTokens: 20, totalTokens: 10_300, estimated: true } },
    ]);
    expect(tracker.get("cursor_conv_1")).toBe(10_300);
  });

  test("late checkpoint after terminal done is inert and does not seed carry-forward", () => {
    const tracker = createCursorContextUsageTracker();
    const state = createCursorProtobufEventState({
      contextUsage: tracker.controlsForConversation("cursor_conv_1"),
    });
    state.usage.outputTokens = 5;

    expect(finalizeTurnEvents(state)).toEqual([
      { type: "done", usage: { inputTokens: 0, outputTokens: 5, estimated: true } },
    ]);
    expect(mapCursorProtobufServerMessage(checkpointUpdate(12_000), state)).toEqual([]);
    expect(state.contextTokens).toBeUndefined();
    expect(tracker.get("cursor_conv_1")).toBeUndefined();
  });

  test("compaction boundary controls clear stale carry and can suppress checkpoint persistence", () => {
    const tracker = createCursorContextUsageTracker();
    tracker.record("cursor_conv_1", 80_000);

    const postCompaction = createCursorProtobufEventState({
      contextUsage: tracker.controlsForConversation("cursor_conv_1", { clearPrior: true }),
    });
    postCompaction.usage.outputTokens = 6;
    expect(finalizeTurnEvents(postCompaction)).toEqual([
      { type: "done", usage: { inputTokens: 0, outputTokens: 6, estimated: true } },
    ]);
    expect(tracker.get("cursor_conv_1")).toBeUndefined();

    const summarizer = createCursorProtobufEventState({
      contextUsage: tracker.controlsForConversation("cursor_conv_1", {
        clearPrior: true,
        storeCheckpoints: false,
      }),
    });
    expect(mapCursorProtobufServerMessage(checkpointUpdate(90_000), summarizer)).toEqual([]);
    expect(mapCursorProtobufServerMessage(turnEndedFrame(), summarizer)).toEqual([
      { type: "done", usage: { inputTokens: 90_000, outputTokens: 0, totalTokens: 90_000, estimated: true } },
    ]);
    expect(tracker.get("cursor_conv_1")).toBeUndefined();
  });

  test("rekey copies carry-forward totals onto a rotated conversation id", () => {
    const tracker = createCursorContextUsageTracker();
    tracker.record("cursor_old", 12_500);
    tracker.rekey("cursor_old", "cursor_new");

    expect(tracker.get("cursor_old")).toBeUndefined();
    expect(tracker.get("cursor_new")).toBe(12_500);
    expect(tracker.controlsForConversation("cursor_new").carryForwardTokens).toBe(12_500);
  });
});

describe("Cursor MCP display-name alias", () => {
  test("mcp_opencodex-responses_ prefixed calls resolve to the advertised tool", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec_command"] });
    const toolCall = mcpToolCall("mcp_opencodex-responses_exec_command", { cmd: "echo ok" });

    // The prefixed display name must NOT be rejected as an unknown Responses tool.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_a1", modelCallId: "m1", toolCall }),
    }), state)).toEqual([]);

    const events = mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_a1", modelCallId: "m1", toolCall }),
    }), state);
    const start = events.find(e => e.type === "tool_call_start");
    expect(start && start.type === "tool_call_start" ? start.name : undefined).toBe("exec_command");
  });

  test("unknown tools are still rejected after normalization", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec_command"] });
    const toolCall = mcpToolCall("mcp_opencodex-responses_made_up_tool", { x: "1" });
    const events = mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_a2", modelCallId: "m2", toolCall }),
    }), state);
    expect(events.some(e => e.type === "error")).toBe(true);
  });
});
