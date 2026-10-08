import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  handleCursorNativeKv,
  resetCursorBlobStateForTests,
  setCursorBlobLimitsForTests,
} from "../../../src/adapters/cursor/native-exec";
import { resetAppOwnedMemoryForTests } from "../../../src/lib/app-owned-memory";
import { encodeCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
import { applyCursorToolBudget, createCursorRequest, CURSOR_TOOL_BYTES_LIMIT } from "../../../src/adapters/cursor/request-builder";
import { buildCursorToolDefinitions, cursorMcpToolEncodedSize, cursorMcpToolsEncodedSize } from "../../../src/adapters/cursor/tool-definitions";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxTool } from "../../../src/types";
import { resetCursorCallIdProvenanceForTests } from "../../../src/adapters/cursor/call-id";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";

beforeEach(() => {
  resetCursorBlobStateForTests();
  resetAppOwnedMemoryForTests();
});
afterEach(() => {
  setCursorBlobLimitsForTests();
  resetAppOwnedMemoryForTests();
});

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  expect(reply.message.case).toBe("kvClientMessage");
  const kv = reply.message.value;
  expect(kv.message.case).toBe("getBlobResult");
  return kv.message.value.blobData;
}


describe("Cursor blob handshake", () => {
  test("replays tool calls with catalog-aware wire names", () => {
    resetCursorCallIdProvenanceForTests();
    const local = "call_catalog_replay";
    // 1. When catalog has exec_command and Read, replayed call should use ocx_client_Read
    const withBridgeBytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c-bridge-replay",
      system: ["You are helpful."],
      tools: [{ name: "exec_command", parameters: {} }, { name: "Read", parameters: {} }],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: Read\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/auto",
          timestamp: 2,
          content: [{ type: "toolCall", id: local, name: "Read", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: local, toolName: "Read", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msgWithBridge = fromBinary(AgentClientMessageSchema, withBridgeBytes);
    const runWithBridge = msgWithBridge.message.case === "runRequest" ? msgWithBridge.message.value : undefined;
    const turnIdsWithBridge = runWithBridge?.conversationState?.turns ?? [];
    const turnWithBridge = fromBinary(ConversationTurnStructureSchema, blobData(turnIdsWithBridge[0]!));
    const stepWithBridge = fromBinary(ConversationStepSchema, blobData(turnWithBridge.turn.value?.steps[0]!));
    if (stepWithBridge.message.case === "toolCall" && stepWithBridge.message.value.tool.case === "mcpToolCall") {
      expect(stepWithBridge.message.value.tool.value.args?.toolName).toBe("ocx_client_Read");
    } else {
      throw new Error("Expected mcpToolCall");
    }

    // 2. When catalog has only Claude client tools (no shell bridge), replayed call preserves bare Read
    resetCursorCallIdProvenanceForTests();
    const noBridgeBytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c-nobridge-replay",
      system: ["You are helpful."],
      tools: [{ name: "Read", parameters: {} }],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: Read\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/auto",
          timestamp: 2,
          content: [{ type: "toolCall", id: local, name: "Read", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: local, toolName: "Read", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msgNoBridge = fromBinary(AgentClientMessageSchema, noBridgeBytes);
    const runNoBridge = msgNoBridge.message.case === "runRequest" ? msgNoBridge.message.value : undefined;
    const turnIdsNoBridge = runNoBridge?.conversationState?.turns ?? [];
    const turnNoBridge = fromBinary(ConversationTurnStructureSchema, blobData(turnIdsNoBridge[0]!));
    const stepNoBridge = fromBinary(ConversationStepSchema, blobData(turnNoBridge.turn.value?.steps[0]!));
    if (stepNoBridge.message.case === "toolCall" && stepNoBridge.message.value.tool.case === "mcpToolCall") {
      expect(stepNoBridge.message.value.tool.value.args?.toolName).toBe("Read");
    } else {
      throw new Error("Expected mcpToolCall");
    }
  });

});

describe("Cursor Claude client tool catalog budget", () => {
  test.each([
    { bridge: true, name: "Read", expected: ["Read"] },
    { bridge: true, name: "ocx_client_Read", expected: ["Read"] },
    { bridge: false, name: "Read", expected: ["Read"] },
    { bridge: false, name: "ocx_client_Read", expected: [] },
  ])("registers forced $name with bridge=$bridge after choice filtering", ({ bridge, name, expected }) => {
    const parsed = parseRequest({
      model: "cursor/auto", input: "read a file",
      tools: [...(bridge ? ["exec_command"] : []), "Read", "Write"].map(name => ({ type: "function", name, parameters: {} })),
      tool_choice: { type: "function", name },
    });
    const request = createCursorRequest(parsed);
    expect(buildCursorToolDefinitions(request.tools, request.toolChoice).map(tool => tool.toolName)).toEqual(expected);
  });

  test.each([
    { allowed: ["ocx_client_Read"], expected: ["Read"] },
    { allowed: ["exec_command", "ocx_client_Read"], expected: ["exec_command", "ocx_client_Read"] },
  ])("registers allowed aliases $allowed after choice filtering", ({ allowed, expected }) => {
    const parsed = parseRequest({
      model: "cursor/auto", input: "read a file",
      tools: ["exec_command", "Read", "Write"].map(name => ({ type: "function", name, parameters: {} })),
      tool_choice: { type: "allowed_tools", mode: "required", tools: allowed.map(name => ({ type: "function", name })) },
    });
    const request = createCursorRequest(parsed);
    expect(buildCursorToolDefinitions(request.tools, request.toolChoice).map(tool => tool.toolName)).toEqual(expected);
  });

  test.each(["function", "allowed_tools"])("keeps an aliased %s choice scoped to its original bare identity", type => {
    const parsed = parseRequest({
      model: "cursor/auto", input: "read a file",
      tools: [
        { type: "function", name: "exec_command", parameters: {} },
        { type: "function", name: "Read", parameters: {} },
        { type: "namespace", name: "mcp__remote", tools: [{ type: "function", name: "Read", parameters: {} }] },
      ],
      tool_choice: type === "function"
        ? { type, name: "ocx_client_Read" }
        : { type, mode: "required", tools: [{ type: "function", name: "ocx_client_Read" }] },
    });
    const request = createCursorRequest(parsed);
    expect(request.tools?.map(tool => [tool.namespace, tool.name])).toEqual([[undefined, "Read"]]);
    expect(buildCursorToolDefinitions(request.tools, request.toolChoice).map(tool => tool.toolName)).toEqual(["Read"]);
  });

  test("preserves both allowed semantic names when a literal name shadows a generated alias", () => {
    const parsed = parseRequest({
      model: "cursor/auto", input: "read a file",
      tools: ["exec_command", "Read", "ocx_client_Read"].map(name => ({ type: "function", name, parameters: {} })),
      tool_choice: { type: "allowed_tools", mode: "required", tools: ["Read", "ocx_client_Read"].map(name => ({ type: "function", name })) },
    });
    const request = createCursorRequest(parsed);
    expect(buildCursorToolDefinitions(request.tools, request.toolChoice).map(tool => tool.toolName))
      .toEqual(["Read", "ocx_client_ocx_client_Read"]);
  });

  test("individual sizes use catalog wire names and aliased tool choices", () => {
    const bridge: OcxTool = { name: "exec_command", parameters: {} };
    const read: OcxTool = { name: "Read", parameters: {} };
    const tools = [bridge, read];
    expect(tools.reduce((sum, tool) => sum + cursorMcpToolEncodedSize(tool, "auto", tools), 0))
      .toBe(cursorMcpToolsEncodedSize(tools, "auto"));
    const choice = { name: "ocx_client_Read" };
    expect(cursorMcpToolEncodedSize(read, choice, tools)).toBeGreaterThan(0);
    expect(cursorMcpToolEncodedSize(read, choice, tools)).toBe(cursorMcpToolsEncodedSize(tools, choice));
    expect(cursorMcpToolEncodedSize(bridge, choice, tools)).toBe(0);
  });

  test("omits a Claude tool when its mixed-catalog wire alias exceeds the byte limit", () => {
    const bridge: OcxTool = { name: "exec_command", parameters: {} };
    const read: OcxTool = { name: "Read", description: "x".repeat(118_450), parameters: {} };
    const tools = [bridge, read];
    expect(cursorMcpToolsEncodedSize([bridge]) + cursorMcpToolsEncodedSize([read]))
      .toBe(CURSOR_TOOL_BYTES_LIMIT);
    expect(cursorMcpToolsEncodedSize(tools)).toBe(CURSOR_TOOL_BYTES_LIMIT + 22);

    const budget = applyCursorToolBudget(tools, "auto");
    expect(cursorMcpToolsEncodedSize(budget.tools)).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
    expect(budget.tools).toEqual([bridge]);
    expect(budget.omitted).toEqual([read]);
    expect(applyCursorToolBudget([read], "auto").tools).toEqual([read]);
  });

  test.each(["exec_command", "shell_command"])(
    "retains a mixed catalog exactly at the byte limit with %s",
    (name) => {
      const bridge: OcxTool = { name, parameters: {} };
      const read: OcxTool = { name: "Read", description: "x".repeat(118_450), parameters: {} };
      const overhead = cursorMcpToolsEncodedSize([bridge, read]) - CURSOR_TOOL_BYTES_LIMIT;
      read.description = read.description!.slice(overhead);
      expect(cursorMcpToolsEncodedSize([bridge, read])).toBe(CURSOR_TOOL_BYTES_LIMIT);
      const budget = applyCursorToolBudget([bridge, read], "auto");
      expect(budget.tools).toEqual([bridge, read]);
      expect(budget.omitted).toEqual([]);
      expect(cursorMcpToolsEncodedSize(budget.tools)).toBe(CURSOR_TOOL_BYTES_LIMIT);

      const tooLarge = { ...read, description: read.description + "x" };
      const overflow = applyCursorToolBudget([bridge, tooLarge], "auto");
      expect(overflow.tools).toEqual([bridge]);
      expect(overflow.omitted).toEqual([tooLarge]);
      expect(cursorMcpToolsEncodedSize(overflow.tools)).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
    },
  );
});
