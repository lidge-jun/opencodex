import { expect, test } from "bun:test";
import { buildConversationInput, buildInputLines, formatMessageForHistory } from "../../src/adapters/coding-agent/protocol";
import type { OcxMessage, OcxParsedRequest } from "../../src/types";

const unsupported = { type: "image" as const, imageUrl: "ftp://example.test/image.png" };
const user: OcxMessage = { role: "user", content: [{ type: "text", text: "inspect" }, unsupported], timestamp: 0 };
const result: OcxMessage = { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "result" }, unsupported], timestamp: 1 };

test("non-Qoder single-message bytes retain the dev omission behavior", () => {
  expect(buildInputLines(user)).toEqual(['{"type":"user","message":{"role":"user","content":[{"type":"text","text":"inspect"}]}}']);
  expect(buildInputLines({ ...user, content: [unsupported] })).toEqual([]);
});

test("non-Qoder history bytes retain dev image markers", () => {
  expect(formatMessageForHistory(user)).toBe("USER:\ninspect\n[image]");
  expect(formatMessageForHistory(result)).toBe("TOOL RESULT (call_id: call_1):\nresult[image]");
  const parsed: OcxParsedRequest = { modelId: "model", stream: false, options: {}, context: { messages: [user, result, { role: "user", content: "next", timestamp: 2 }] } };
  const text = "Prior conversation context:\n\nUSER:\ninspect\n[image]\n\nTOOL RESULT (call_id: call_1):\nresult[image]\n\nCurrent user request:\n\nnext";
  expect(buildConversationInput(parsed)).toEqual([JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })]);
});

test("ordinary user, document, assistant, tool and supported-image history stays byte-identical", () => {
  expect(formatMessageForHistory({ role: "user", content: [{ type: "document", text: "document", mediaType: "text/plain", data: "ZG9jdW1lbnQ=" }, { type: "image", imageUrl: "data:image/png;base64,AA==" }], timestamp: 0 })).toBe("USER:\ndocument\n[image]");
  expect(formatMessageForHistory({ role: "assistant", content: [{ type: "text", text: " response " }, { type: "thinking", thinking: " reason " }, { type: "toolCall", id: "c", name: "echo", arguments: { x: 1 } }], timestamp: 0 })).toBe('ASSISTANT:\nresponse\n[Thinking: reason]\n[Tool call: echo (call_id: c) with args: {"x":1}]');
  expect(buildInputLines({ role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", imageUrl: "https://example.test/image.png" }], timestamp: 0 })).toEqual(['{"type":"user","message":{"role":"user","content":[{"type":"text","text":"inspect"},{"type":"image","source":{"type":"url","url":"https://example.test/image.png"}}]}}']);
});
