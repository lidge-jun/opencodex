import { describe, expect, test } from "bun:test";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import type { OcxParsedRequest } from "../src/types";

const base: OcxParsedRequest = {
  modelId: "cursor/auto",
  context: { messages: [] },
  stream: false,
  options: {},
};

describe("Cursor request builder", () => {
  test("normalizes cursor model prefix and preserves previous response id", () => {
    const request = createCursorRequest({ ...base, previousResponseId: "resp_123" });

    expect(request.modelId).toBe("auto");
    expect(request.conversationId).toBe("resp_123");
  });

  test("maps system, developer, user, assistant, and tool result text", () => {
    const request = createCursorRequest({
      ...base,
      context: {
        systemPrompt: ["system A", "system B"],
        messages: [
          { role: "developer", content: "dev", timestamp: 1 },
          { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 2 },
          { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 3 },
          { role: "toolResult", toolCallId: "call_1", toolName: "tool", content: "tool out", isError: false, timestamp: 4 },
        ],
      },
    });

    expect(request.system).toEqual(["system A", "system B"]);
    expect(request.messages).toEqual([
      { role: "developer", content: "dev" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", content: "tool out" },
    ]);
  });

  test("uses an explicit image placeholder for unsupported image parts", () => {
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see" },
              { type: "image", imageUrl: "data:image/png;base64,abc", detail: "high" },
            ],
            timestamp: 1,
          },
        ],
      },
    });

    expect(request.messages[0]?.content).toContain("see");
    expect(request.messages[0]?.content).toContain("image input unsupported");
    expect(request.messages[0]?.content).toContain("high");
  });

  test("preserves Responses tools and tool choice for Cursor request context", () => {
    const tool = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      namespace: "mcp__fs",
    };
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "use a tool", timestamp: 1 }], tools: [tool] },
      options: { toolChoice: "required" },
    });

    expect(request.tools).toEqual([tool]);
    expect(request.toolChoice).toBe("required");
  });
});
