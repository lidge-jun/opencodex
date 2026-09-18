import { describe, expect, test } from "bun:test";
import { mapOcxMessagesToDevin } from "../../src/adapters/devin";
import { buildGetChatMessageRequestForTests } from "../../src/adapters/devin/cloud-direct/chat";
import type { OcxMessage, OcxParsedRequest } from "../../src/types";

const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";

function parsedWith(messages: OcxMessage[]): OcxParsedRequest {
  return {
    context: {
      provider: "devin",
      model: "swe-2",
      systemPrompt: [],
      tools: [],
      messages,
    },
    options: {},
  } as unknown as OcxParsedRequest;
}

describe("user image passthrough", () => {
  test("a data: URL image part becomes a wire image with mime and base64", () => {
    const items = mapOcxMessagesToDevin(parsedWith([{
      role: "user",
      content: [
        { type: "text", text: "이거 읽을수 있어?" },
        { type: "image", imageUrl: dataUrl },
      ],
    }]));
    const user = items.find(i => i.role === "user")!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "text", text: "이거 읽을수 있어?" });
    expect(parts[1]).toEqual({ type: "image", mimeType: "image/png", base64Data: "iVBORw0KGgoAAAANSUhEUg" });
  });

  test("an image-only user message is not dropped", () => {
    // This is the reported failure: a pasted screenshot with no caption killed
    // the turn at 0s because the text-only extraction produced an empty string
    // and the whole message was discarded.
    const items = mapOcxMessagesToDevin(parsedWith([{
      role: "user",
      content: [{ type: "image", imageUrl: dataUrl }],
    }]));
    expect(items.filter(i => i.role === "user")).toHaveLength(1);
  });

  test("a remote https image stays as an explicit text reference", () => {
    const items = mapOcxMessagesToDevin(parsedWith([{
      role: "user",
      content: [{ type: "image", imageUrl: "https://example.com/pic.png" }],
    }]));
    const user = items.find(i => i.role === "user")!;
    expect(user.content).toEqual([{ type: "text", text: "[image url: https://example.com/pic.png]" }]);
  });
});

describe("tool-result image passthrough", () => {
  test("a tool result carrying an image keeps it", () => {
    const items = mapOcxMessagesToDevin(parsedWith([{
      role: "toolResult",
      toolCallId: "call_1",
      content: [
        { type: "text", text: "screenshot captured" },
        { type: "image", imageUrl: dataUrl },
      ],
    } as unknown as OcxMessage]));
    const tool = items.find(i => i.role === "tool")!;
    const parts = tool.content as Array<Record<string, unknown>>;
    expect(parts.some(p => p.type === "image" && p.base64Data === "iVBORw0KGgoAAAANSUhEUg")).toBe(true);
  });

  test("an error tool result still carries the ERROR prefix alongside images", () => {
    const items = mapOcxMessagesToDevin(parsedWith([{
      role: "toolResult",
      toolCallId: "call_1",
      isError: true,
      content: [{ type: "image", imageUrl: dataUrl }],
    } as unknown as OcxMessage]));
    const tool = items.find(i => i.role === "tool")!;
    const parts = tool.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "text", text: "ERROR:" });
    expect(parts.some(p => p.type === "image")).toBe(true);
  });
});

describe("the wire encoder receives the image on field #10", () => {
  test("a user image produces an ImageData submessage in the request frame", () => {
    const items = mapOcxMessagesToDevin(parsedWith([{
      role: "user",
      content: [{ type: "image", imageUrl: dataUrl }],
    }]));
    const buf = buildGetChatMessageRequestForTests({
      apiKey: "k",
      modelUid: "swe-2-medium",
      messages: items,
      cascadeId: "c1",
      sessionId: "s1",
      requestId: 1n,
      triggerId: "t1",
    } as never);
    // ImageData: field 10 (tag 0x52), containing base64 (field 1, string)
    // and mime_type (field 2, string). The base64 payload is present.
    expect(buf.includes(Buffer.from("iVBORw0KGgoAAAANSUhEUg"))).toBe(true);
    expect(buf.includes(Buffer.from("image/png"))).toBe(true);
  });
});
