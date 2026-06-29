import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxParsedRequest } from "../src/types";

const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" };

function parsedWith(messages: unknown[], tools?: unknown[]): OcxParsedRequest {
  return { modelId: "gemini-3-pro", stream: false, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
}

function geminiContents(parsed: OcxParsedRequest): { role: string; parts: Record<string, unknown>[] }[] {
  const { body } = createGoogleAdapter(provider).buildRequest(parsed);
  return JSON.parse(body).contents;
}

describe("google adapter — tool result images", () => {
  test("tool-result screenshots ride along as inline_data beside the functionResponse", () => {
    const contents = geminiContents(parsedWith([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "get_app_state", namespace: "mcp__chrome", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "get_app_state",
        toolNamespace: "mcp__chrome",
        content: [
          { type: "text", text: "Looked at Google Chrome" },
          { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" },
        ],
        isError: false,
      },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    expect(toolTurn).toBeDefined();
    expect(toolTurn!.parts[0]).toEqual({
      functionResponse: { name: "mcp__chrome__get_app_state", response: { result: "Looked at Google Chrome[image]" } },
    });
    expect(toolTurn!.parts[1]).toEqual({ inline_data: { mime_type: "image/png", data: "aGVsbG8=" } });
  });

  test("text-only tool results emit a single functionResponse part", () => {
    const contents = geminiContents(parsedWith([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: "ok", isError: false },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    expect(toolTurn!.parts).toEqual([
      { functionResponse: { name: "bash", response: { result: "ok" } } },
    ]);
  });

  test("remote (non-data) tool-result image URLs are not inlined", () => {
    const contents = geminiContents(parsedWith([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "snap", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "snap",
        content: [{ type: "image", imageUrl: "https://example.test/shot.png" }],
        isError: false,
      },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    expect(toolTurn!.parts.some(p => "inline_data" in p)).toBe(false);
  });
});
