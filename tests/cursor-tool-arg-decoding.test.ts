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
    expect(mapCursorProtobufServerMessage(started(), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
    ]);
    expect(mapCursorProtobufServerMessage(completed({}), state)).toEqual([]);
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

  test("synthetic native mcp exec can append to an already-started tool call", () => {
    const args = create(McpArgsSchema, {
      name: "ping",
      toolName: "ping",
      toolCallId: "toolu_1",
      providerIdentifier: "opencodex-responses",
      args: { value: valueBytes("hello") },
    });

    expect(mapSyntheticMcpExecToToolEvents(args, "fallback", { allowEmptyArgs: false, suppressStart: true })).toEqual([
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

  test("synthetic native mcp exec honors parallel_tool_calls false", () => {
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
      { type: "error", message: "Cursor requested multiple parallel Responses tool calls but parallel_tool_calls is false" },
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
