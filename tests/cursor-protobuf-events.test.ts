import { create } from "@bufbuild/protobuf";
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
} from "../src/adapters/cursor/gen/agent_pb";
import { createCursorProtobufEventState, mapCursorProtobufServerMessage } from "../src/adapters/cursor/protobuf-events";

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

describe("Cursor protobuf tool-call events", () => {
  test("maps MCP tool-call updates to Cursor tool call messages", () => {
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([{ type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" }]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\":\"a.txt\"}" }),
    }), state)).toEqual([{ type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" }]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([{ type: "tool_call_end", id: "call_1" }]);
  });

  test("treats partial tool-call args as aggregated text", () => {
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\"" }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\"" },
    ]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\":\"a.txt\"}" }),
    }), state)).toEqual([{ type: "tool_call_delta", arguments: ":\"a.txt\"}" }]);
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
});
