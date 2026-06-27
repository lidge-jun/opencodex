import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv, storeCursorBlob } from "../src/adapters/cursor/native-exec";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

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
  test("storeCursorBlob returns the SHA-256 blob id (32 bytes)", () => {
    const data = new TextEncoder().encode('{"role":"system","content":"hi"}');
    const id = storeCursorBlob(data);
    expect(id.length).toBe(32);
    expect(Array.from(id)).toEqual(Array.from(sha256(data)));
  });

  test("encodeCursorRunRequest sends rootPromptMessagesJson as blob IDs, not inline JSON", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} }],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];

    expect(roots.length).toBeGreaterThan(0);
    // Every entry must be a 32-byte SHA-256 blob id (the bug was sending inline JSON → "Blob not found").
    for (const entry of roots) expect(entry.length).toBe(32);
    // The first root is the blob id of the system-prompt JSON exactly.
    const sysJson = new TextEncoder().encode(JSON.stringify({ role: "system", content: "You are helpful." }));
    expect(Array.from(roots[0]!)).toEqual(Array.from(sha256(sysJson)));
    // Client Responses tools are intentionally advertised via native exec RequestContext.tools,
    // not mirrored into the initial AgentRunRequest.mcp_tools payload. The top-level field is
    // not wire-compatible with the live Cursor Connect parser for this client path.
    expect(run?.mcpTools).toBeUndefined();
  });

  test("encodeCursorRunRequest surfaces trailing tool result as current action text", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [
        { role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const action = run?.action?.action;

    expect(action?.case).toBe("userMessageAction");
    if (action?.case === "userMessageAction") {
      expect(action.value.userMessage?.text).toContain("[tool_result]");
      expect(action.value.userMessage?.text).toContain("call_id: call_1");
    }
  });

  test("encodeCursorRunRequest preserves prior assistant tool calls with tool results in turn steps", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/auto",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const turnIds = run?.conversationState?.turns ?? [];
    expect(turnIds).toHaveLength(1);
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnIds[0]!));
    expect(turn.turn.case).toBe("agentConversationTurn");
    const steps = turn.turn.value.steps;
    expect(steps).toHaveLength(1);
    const step = fromBinary(ConversationStepSchema, blobData(steps[0]!));
    expect(step.message.case).toBe("toolCall");
    const tool = step.message.value.tool;
    expect(tool.case).toBe("mcpToolCall");
    if (tool.case === "mcpToolCall") {
      expect(tool.value.args?.toolCallId).toBe("call_1");
      expect(tool.value.result?.result.case).toBe("success");
      if (tool.value.result?.result.case === "success") {
        const content = tool.value.result.result.value.content[0]?.content;
        expect(content?.case).toBe("text");
        if (content?.case === "text") expect(content.value.text).toBe("contents");
      }
    }
    expect(run?.action?.action.case).toBe("userMessageAction");
  });
});
