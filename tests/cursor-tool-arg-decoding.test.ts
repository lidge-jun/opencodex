import { create, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  ToolCallStartedUpdateSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import {
  createCursorProtobufEventState,
  mapCursorProtobufServerMessage,
  mapSyntheticMcpExecToToolEvents,
} from "../src/adapters/cursor/protobuf-events";

const encoder = new TextEncoder();

function completed(args: Record<string, Uint8Array>) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "toolCallCompleted",
          value: create(ToolCallCompletedUpdateSchema, {
            callId: "call_1",
            modelCallId: "model_1",
            toolCall: create(ToolCallSchema, {
              tool: {
                case: "mcpToolCall",
                value: create(McpToolCallSchema, {
                  args: create(McpArgsSchema, {
                    name: "mcp__fs__read_file",
                    toolName: "mcp__fs__read_file",
                    providerIdentifier: "opencodex-responses",
                    args,
                  }),
                }),
              },
            }),
          }),
        },
      }),
    },
  });
}

function started() {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "toolCallStarted",
          value: create(ToolCallStartedUpdateSchema, {
            callId: "call_1",
            modelCallId: "model_1",
            toolCall: create(ToolCallSchema, {
              tool: {
                case: "mcpToolCall",
                value: create(McpToolCallSchema, {
                  args: create(McpArgsSchema, {
                    name: "mcp__fs__read_file",
                    toolName: "mcp__fs__read_file",
                    providerIdentifier: "opencodex-responses",
                  }),
                }),
              },
            }),
          }),
        },
      }),
    },
  });
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function valueBytes(value: unknown): Uint8Array {
  return toBinary(ValueSchema, fromJson(ValueSchema, value));
}

describe("Cursor Responses tool argument decoding", () => {
  test("decodes JSON scalar, array, object, empty, and invalid JSON safely", () => {
    const events = mapCursorProtobufServerMessage(completed({
      text: jsonBytes("hello"),
      number: jsonBytes(3),
      bool: jsonBytes(true),
      arr: jsonBytes([1, "x"]),
      obj: jsonBytes({ path: "a.txt" }),
      invalid: encoder.encode("{not json"),
    }), createCursorProtobufEventState());

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" });
    expect(JSON.parse(events[1]?.type === "tool_call_delta" ? events[1].arguments : "{}")).toEqual({
      text: "hello",
      number: 3,
      bool: true,
      arr: [1, "x"],
      obj: { path: "a.txt" },
      invalid: "{not json",
    });
    expect(events[2]).toEqual({ type: "tool_call_end", id: "call_1" });
  });

  test("empty arg map emits an empty JSON object", () => {
    const events = mapCursorProtobufServerMessage(completed({}), createCursorProtobufEventState());
    expect(events).toEqual([]);
  });

  test("empty completed update after a start waits for native exec args", () => {
    const state = createCursorProtobufEventState();
    // Start is recorded but not emitted (deferred). An empty completion then waits for native exec.
    expect(mapCursorProtobufServerMessage(started(), state)).toEqual([]);
    expect(mapCursorProtobufServerMessage(completed({}), state)).toEqual([]);
    // The call stays open so a later native-exec args frame (or turnEnded) can resolve it.
    expect(state.openToolCalls.has("call_1")).toBe(true);
  });

  test("decodes protobuf Value arg bytes from native exec channel", () => {
    const args = create(McpArgsSchema, {
      name: "ping",
      toolName: "ping",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { value: valueBytes("hello"), count: valueBytes(2) },
    });

    expect(mapSyntheticMcpExecToToolEvents(args)).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"hello\",\"count\":2}" },
      { type: "tool_call_end", id: "toolu_1" },
    ]);
  });

  test("synthetic native mcp exec args are surfaced as client tool-call events", () => {
    const args = create(McpArgsSchema, {
      name: "ping",
      toolName: "ping",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { value: jsonBytes("hello") },
    });

    expect(mapSyntheticMcpExecToToolEvents(args)).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"hello\"}" },
      { type: "tool_call_end", id: "toolu_1" },
    ]);
  });

  test("stateless synthetic native mcp exec preserves run_shell without request alias state", () => {
    const args = create(McpArgsSchema, {
      name: "run_shell",
      toolName: "run_shell",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { cmd: jsonBytes("echo hi") },
    });

    expect(mapSyntheticMcpExecToToolEvents(args)).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "run_shell" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"echo hi\"}" },
      { type: "tool_call_end", id: "toolu_1" },
    ]);
  });

  test("stateful synthetic native mcp exec accepts advertised run_shell and emits exec_command", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: ["run_shell"],
      cursorToolNameMap: new Map([["run_shell", "exec_command"]]),
    });
    const args = create(McpArgsSchema, {
      name: "run_shell",
      toolName: "run_shell",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { cmd: jsonBytes("echo hi") },
    });

    expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: false, state })).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "exec_command" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"echo hi\"}" },
      { type: "tool_call_end", id: "toolu_1" },
    ]);
  });

  test("stateful synthetic native mcp exec preserves genuine run_shell mapping", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: ["run_shell"],
      cursorToolNameMap: new Map([["run_shell", "run_shell"]]),
    });
    const args = create(McpArgsSchema, {
      name: "run_shell",
      toolName: "run_shell",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { cmd: jsonBytes("echo hi") },
    });

    expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: false, state })).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "run_shell" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"echo hi\"}" },
      { type: "tool_call_end", id: "toolu_1" },
    ]);
  });

  test("live bridge can ignore empty synthetic native mcp exec prelude", () => {
    const args = create(McpArgsSchema, {
      name: "ping",
      toolName: "ping",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: {},
    });

    expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: false })).toEqual([]);
  });

  test("native exec surfaces an advertised no-arg tool call when empty args are allowed", () => {
    // Mirrors live-transport's allowEmptyArgs:true branch: a no-arg Responses tool must surface as a
    // real tool call (start+end) instead of being suppressed and rejected by native-exec.ts.
    const state = createCursorProtobufEventState({ clientToolNames: ["ping"] });
    const args = create(McpArgsSchema, {
      name: "ping",
      toolName: "ping",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: {},
    });

    expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true, state })).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "ping" },
      { type: "tool_call_end", id: "toolu_1" },
    ]);
  });

  describe("shell bridge rejects empty or malformed command args", () => {
    const dropped = (tool: string) =>
      `Cursor emitted ${tool} without a non-empty command; the tool call was dropped.`;

    function shellBridgeArgs(
      toolName: "exec_command" | "shell_command",
      args: Record<string, Uint8Array>,
      callId: string,
    ) {
      return create(McpArgsSchema, {
        name: toolName,
        toolName: toolName,
        toolCallId: callId,
        providerIdentifier: "opencodex-responses",
        args,
      });
    }

    function expectDropped(state: CursorProtobufEventState, callId: string, toolName: string) {
      expect(state.openToolCalls.has(callId)).toBe(false);
      expect(state.completedToolCalls.has(callId)).toBe(true);
      expect(dropped(toolName)).toContain(toolName);
    }

    test.each([
      ["exec_command", "cmd", "echo hi"] as const,
      ["shell_command", "command", "echo hi"] as const,
    ])("%s accepts a valid %s payload", (toolName, field, command) => {
      const state = createCursorProtobufEventState({ clientToolNames: [toolName] });
      const args = shellBridgeArgs(toolName, { [field]: jsonBytes(command) }, `toolu_valid_${toolName}`);
      expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true, state })).toEqual([
        { type: "tool_call_start", id: `toolu_valid_${toolName}`, name: toolName },
        { type: "tool_call_delta", arguments: expect.stringContaining(command) },
        { type: "tool_call_end", id: `toolu_valid_${toolName}` },
      ]);
    });

    test.each([
      ["exec_command", "cmd"] as const,
      ["shell_command", "command"] as const,
    ])("%s rejects missing args", (toolName, field) => {
      void field;
      const callId = `toolu_empty_${toolName}`;
      const state = createCursorProtobufEventState({ clientToolNames: [toolName] });
      const args = shellBridgeArgs(toolName, {}, callId);
      expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true, state })).toEqual([
        { type: "error", message: dropped(toolName) },
      ]);
      expectDropped(state, callId, toolName);
    });

    test.each([
      ["exec_command", "cmd"] as const,
      ["shell_command", "command"] as const,
    ])("%s rejects whitespace-only %s", (toolName, field) => {
      const callId = `toolu_blank_${toolName}`;
      const state = createCursorProtobufEventState({ clientToolNames: [toolName] });
      const args = shellBridgeArgs(toolName, { [field]: jsonBytes("   ") }, callId);
      expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true, state })).toEqual([
        { type: "error", message: dropped(toolName) },
      ]);
      expectDropped(state, callId, toolName);
    });

    test.each([
      ["exec_command", "cmd", 42] as const,
      ["exec_command", "cmd", {}] as const,
      ["exec_command", "cmd", ""] as const,
      ["shell_command", "command", 42] as const,
      ["shell_command", "command", {}] as const,
      ["shell_command", "command", ""] as const,
    ])("%s rejects invalid %s=%s", (toolName, field, value) => {
      const callId = `toolu_bad_${toolName}_${field}_${String(value)}`;
      const state = createCursorProtobufEventState({ clientToolNames: [toolName] });
      const args = shellBridgeArgs(toolName, { [field]: jsonBytes(value) }, callId);
      expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true, state })).toEqual([
        { type: "error", message: dropped(toolName) },
      ]);
      expectDropped(state, callId, toolName);
    });

    test("exec_command accepts command-only payload as a sibling to cmd", () => {
      const callId = "toolu_command_only";
      const state = createCursorProtobufEventState({ clientToolNames: ["exec_command"] });
      const args = shellBridgeArgs("exec_command", { command: jsonBytes("echo hi") }, callId);
      expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true, state })).toEqual([
        { type: "tool_call_start", id: callId, name: "exec_command" },
        { type: "tool_call_delta", arguments: "{\"command\":\"echo hi\"}" },
        { type: "tool_call_end", id: callId },
      ]);
    });

    test("exec_command accepts sibling command when cmd is blank", () => {
      const callId = "toolu_blank_cmd_with_command";
      const state = createCursorProtobufEventState({ clientToolNames: ["exec_command"] });
      const args = shellBridgeArgs("exec_command", {
        cmd: jsonBytes(""),
        command: jsonBytes("echo hi"),
      }, callId);
      expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true, state })).toEqual([
        { type: "tool_call_start", id: callId, name: "exec_command" },
        { type: "tool_call_delta", arguments: expect.stringContaining("\"command\":\"echo hi\"") },
        { type: "tool_call_end", id: callId },
      ]);
    });

    test("stateless exec_command rejects empty args when allowEmptyArgs is enabled", () => {
      const args = shellBridgeArgs("exec_command", {}, "toolu_stateless_empty");
      expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true })).toEqual([
        { type: "error", message: dropped("exec_command") },
      ]);
    });

    test("stateless shell_command accepts cmd that normalizes to command", () => {
      const args = shellBridgeArgs("shell_command", { cmd: jsonBytes("echo hi") }, "toolu_stateless_cmd");
      expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: true })).toEqual([
        { type: "tool_call_start", id: "toolu_stateless_cmd", name: "shell_command" },
        { type: "tool_call_delta", arguments: "{\"command\":\"echo hi\"}" },
        { type: "tool_call_end", id: "toolu_stateless_cmd" },
      ]);
    });
  });

  test("synthetic native mcp exec emits a self-contained atomic tool call", () => {
    // Native-exec delivers the whole call at once. With deferred-start emission the synthetic mapper
    // always emits its own start -> delta -> end unit (the old suppressStart option is gone).
    const args = create(McpArgsSchema, {
      name: "ping",
      toolName: "ping",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { value: valueBytes("hello") },
    });

    expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: false })).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"hello\"}" },
      { type: "tool_call_end", id: "toolu_1" },
    ]);
  });

  test("synthetic native mcp exec enforces advertised client tool names", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["allowed"] });
    const args = create(McpArgsSchema, {
      name: "blocked",
      toolName: "blocked",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { value: valueBytes("hello") },
    });

    expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: false, state })).toEqual([
      { type: "error", message: "Cursor requested unknown Responses tool: blocked" },
    ]);
  });

  test("synthetic native mcp exec serializes multiple calls even when parallel_tool_calls is false", () => {
    // parallel_tool_calls=false no longer aborts: each native-exec call is emitted as its own atomic
    // start -> delta -> end unit, so several can be serialized through the single-current-call bridge.
    const state = createCursorProtobufEventState({ clientToolNames: ["ping"], parallelToolCalls: false });
    const first = create(McpArgsSchema, {
      name: "ping",
      toolName: "ping",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { value: valueBytes("one") },
    });
    const second = create(McpArgsSchema, {
      name: "ping",
      toolName: "ping",
      toolCallId: "toolu_2",
      providerIdentifier: "opencodex-responses",
      args: { value: valueBytes("two") },
    });

    expect(mapSyntheticMcpExecToToolEvents(first, "fallback", { allowEmptyArgs: false, state })).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"one\"}" },
      { type: "tool_call_end", id: "toolu_1" },
    ]);
    expect(mapSyntheticMcpExecToToolEvents(second, "fallback", { allowEmptyArgs: false, state })).toEqual([
      { type: "tool_call_start", id: "toolu_2", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"two\"}" },
      { type: "tool_call_end", id: "toolu_2" },
    ]);
  });

  test("duplicate synthetic native mcp exec after completed update is ignored by call id", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    const wireArgs = { value: valueBytes("hello") };
    const completedMessage = completed(wireArgs);
    const syntheticArgs = create(McpArgsSchema, {
      name: "mcp__fs__read_file",
      toolName: "mcp__fs__read_file",
      toolCallId: "call_1",
      providerIdentifier: "opencodex-responses",
      args: wireArgs,
    });

    expect(mapCursorProtobufServerMessage(completedMessage, state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"value\":\"hello\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
    expect(mapSyntheticMcpExecToToolEvents(syntheticArgs, "fallback", { allowEmptyArgs: false, state })).toEqual([]);
  });
});
