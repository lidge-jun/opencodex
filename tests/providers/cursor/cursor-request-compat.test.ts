import { beforeEach, describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { cursorBlobMetrics, cursorBlobTextForEstimate, resetCursorBlobStateForTests, storeCursorBlob } from "../../../src/adapters/cursor/native-exec";
import { CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT, encodeCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
import { AgentClientMessageSchema } from "../../../src/adapters/cursor/gen/agent_pb";

beforeEach(() => resetCursorBlobStateForTests());

describe("cursorBlobTextForEstimate", () => {
  test("unreadable UTF-8 cannot become replacement-character estimate text", () => {
    const id = storeCursorBlob(Uint8Array.of(0xc3, 0x28));
    const before = cursorBlobMetrics();
    expect(cursorBlobTextForEstimate(id)).toBeNull();
    expect(cursorBlobMetrics()).toEqual(before);
  });

  test("returns stored utf-8 text", () => {
    const id = storeCursorBlob(new TextEncoder().encode("hello estimate"));
    expect(cursorBlobTextForEstimate(id)).toBe("hello estimate");
  });
  test("returns null for a missing blob, empty id, or non-bytes input", () => {
    expect(cursorBlobTextForEstimate(new Uint8Array(32))).toBeNull();
    expect(cursorBlobTextForEstimate(new Uint8Array())).toBeNull();
    expect(cursorBlobTextForEstimate(null as unknown as Uint8Array)).toBeNull();
  });
});

describe("external current request guidance", () => {
  test("skips current-request guidance when the latest user text is empty", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-fable-5",
      conversationId: "c-empty-user",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "contents" }],
      rawMessages: [
        { role: "user", content: "   ", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/claude-fable-5",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const value = run?.action?.action.case === "userMessageAction" ? run.action.action.value : undefined;
    expect(value?.userMessage?.text).toBe(CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT);
    expect(value?.userMessage?.text).not.toContain("[Current user request]");
  });
});


test("continuation uses only the latest user scope and preserves its exact text", () => {
  const latest = "  Inspect only.\nDo not modify any files.  ";
  const bytes = encodeCursorRunRequest({
    modelId: "cursor-grok-4.6-high", conversationId: "latest-user-scope",
    system: ["Follow the current user request."],
    messages: [{ role: "tool", content: "inspection complete" }],
    rawMessages: [
      { role: "user", content: "Rewrite all files in the repository.", timestamp: 1 },
      { role: "user", content: latest, timestamp: 2 },
      { role: "assistant", model: "cursor/grok-4.6", timestamp: 3,
        content: [{ type: "toolCall", id: "inspect", name: "read_file", arguments: { path: "fixture" } }] },
      { role: "toolResult", toolCallId: "inspect", toolName: "read_file", content: "inspection complete", isError: false, timestamp: 4 },
    ],
  });
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  if (msg.message.case !== "runRequest" || msg.message.value.action?.action.case !== "userMessageAction") {
    throw new Error("Expected a user continuation action");
  }
  const text = msg.message.value.action.action.value.userMessage?.text;
  expect(text).toContain(`[Current user request]\n${latest}`);
  expect(text).not.toContain("Rewrite all files");
});
