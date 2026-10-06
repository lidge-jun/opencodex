import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  handleCursorNativeKv,
  resetCursorBlobStateForTests,
  setCursorBlobLimitsForTests,
} from "../../../src/adapters/cursor/native-exec";
import { resetAppOwnedMemoryForTests } from "../../../src/lib/app-owned-memory";
import { encodeCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
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
