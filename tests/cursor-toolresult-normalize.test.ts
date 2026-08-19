import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { normalizeCursorToolResultText } from "../src/adapters/cursor/tool-result-normalize";
import {
  AgentClientMessageSchema,
  ConversationTurnStructureSchema,
  ConversationStepSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage, OcxToolResultMessage } from "../src/types";

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage") throw new Error("not kv");
  const kv = reply.message.value;
  if (kv.message.case !== "getBlobResult") throw new Error("not blob result");
  return kv.message.value.blobData;
}

/** Decode the native-wire McpToolResult attached to the first tool call step. */
function decodedToolResult(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const turnIds = run?.conversationState?.turns ?? [];
  for (const turnId of turnIds) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") continue;
    for (const stepId of turn.turn.value.steps ?? []) {
      const step = fromBinary(ConversationStepSchema, blobData(stepId));
      if (step.message.case !== "toolCall") continue;
      const tool = step.message.value.tool;
      if (tool.case !== "mcpToolCall") continue;
      const result = tool.value.result;
      if (result?.result.case !== "success") continue;
      return result.result.value;
    }
  }
  return undefined;
}

function requestWith(
  resultContent: OcxToolResultMessage["content"],
  toolOverrides: Partial<{
    toolName: string;
    toolNamespace?: string;
    isError: boolean;
    containsEncryptedContent: boolean;
  }> = {},
) {
  const rawMessages: OcxMessage[] = [
    { role: "user", content: "run it", timestamp: 1 },
    {
      role: "assistant",
      model: "cursor/auto",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call_1", name: toolOverrides.toolName ?? "js", namespace: toolOverrides.toolNamespace ?? "mcp__node_repl", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: toolOverrides.toolName ?? "js",
      toolNamespace: "toolNamespace" in toolOverrides ? toolOverrides.toolNamespace : "mcp__node_repl",
      content: resultContent,
      isError: toolOverrides.isError ?? false,
      containsEncryptedContent: toolOverrides.containsEncryptedContent,
      timestamp: 3,
    },
  ];
  return encodeCursorRunRequest({
    modelId: "composer-2.5",
    conversationId: "cursor_normalize_test",
    system: ["You are helpful."],
    messages: [{ role: "tool", content: "[tool_result]" }],
    rawMessages,
  });
}

describe("normalizeCursorToolResultText (#1920/#1866 unit rows)", () => {
  test("blank node_repl output becomes an actionable error", () => {
    const out = normalizeCursorToolResultText("", { toolName: "js", toolNamespace: "mcp__node_repl" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("get_app_state");
  });

  test("empty exec wrapper (Script completed + <empty>) normalizes for node_repl", () => {
    const out = normalizeCursorToolResultText("Script completed\nOutput:\n<empty>", { toolName: "node_repl" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("[empty output");
  });

  test.each([
    ["SkyComputerUseError: focus lost", "get_app_state"],
    ["ReferenceError: sky is not defined", "privileged node_repl"],
    ["SyntaxError: Identifier 'x' has already been declared", "redeclaring"],
    ["unsupported import in exec", "injected globals"],
  ])("runtime failure %p is marked as error with guidance", (payload, hint) => {
    const out = normalizeCursorToolResultText(payload, { toolName: "js", toolNamespace: "mcp__node_repl" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(payload);
    expect(out.text).toContain(hint);
  });

  test("a non-computer-use tool with empty output stays byte-identical", () => {
    const out = normalizeCursorToolResultText("", { toolName: "read_file" });
    expect(out.changed).toBe(false);
    expect(out.text).toBe("");
    expect(out.isError).toBe(false);
  });

  test("ordinary non-empty output on node_repl stays byte-identical", () => {
    const out = normalizeCursorToolResultText("42", { toolName: "js", toolNamespace: "mcp__node_repl" });
    expect(out.changed).toBe(false);
    expect(out.text).toBe("42");
  });

  test("an already-error result is not double-annotated", () => {
    const out = normalizeCursorToolResultText("SkyComputerUseError: x", { toolName: "js", toolNamespace: "mcp__node_repl", isError: true });
    expect(out.changed).toBe(false);
    expect(out.isError).toBe(true);
  });
});

describe("native wire decode (#1920 disposition: formatted text at toolResultPart)", () => {
  test("an empty node_repl result decodes as normalized error text with isError=true on the wire", () => {
    const result = decodedToolResult(requestWith(""));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    const first = result!.content[0];
    expect(first.content.case).toBe("text");
    expect(first.content.case === "text" ? first.content.value.text : "").toContain("[empty output");
  });

  test("a failure-state node_repl result decodes with recovery guidance and isError=true", () => {
    const result = decodedToolResult(requestWith("ReferenceError: sky is not defined"));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toContain("recovery");
  });

  test("an empty text-part result receives the same normalization as an empty string", () => {
    const result = decodedToolResult(requestWith([{ type: "text", text: "" }]));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toContain("[empty output");
  });

  test("a failure-state text-part result receives recovery guidance and isError=true", () => {
    const result = decodedToolResult(requestWith([{ type: "text", text: "ReferenceError: sky is not defined" }]));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toContain("recovery");
  });

  test("image-bearing results keep their text and image parts without failure normalization", () => {
    const failureText = "ReferenceError: sky is not defined";
    const result = decodedToolResult(requestWith([
      { type: "text", text: failureText },
      { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
    ]));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    expect(result!.content).toHaveLength(2);
    expect(result!.content[0]?.content.case === "text" ? result!.content[0].content.value.text : "").toBe(failureText);
    expect(result!.content[1]?.content.case).toBe("image");
  });

  test("encrypted text-part results remain unmodified", () => {
    const failureText = "ReferenceError: sky is not defined";
    const result = decodedToolResult(requestWith(
      [{ type: "text", text: failureText }],
      { containsEncryptedContent: true },
    ));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toBe(failureText);
  });

  test("a normal tool result decodes byte-identical (no normalization side effects)", () => {
    const result = decodedToolResult(requestWith("plain output", { toolName: "read_file", toolNamespace: undefined }));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toBe("plain output");
  });
});
