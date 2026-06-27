import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { createCursorProtobufEventState, mapCursorProtobufServerMessage } from "../src/adapters/cursor/protobuf-events";

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

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
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
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });
});
