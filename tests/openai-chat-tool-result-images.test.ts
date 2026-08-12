import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

// Issue #888: role:"tool" content is text-only on chat-completions providers, so images inside a
// tool result ride in a follow-up user vision message released when the tool round closes. When
// text is present, the tool row carries that literal text plus fallback markers only for images
// that cannot be transported in the follow-up carrier.

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
};

const IMAGE_URL = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";

interface ChatPart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
}

interface ChatMsg {
  role: string;
  content?: string | ChatPart[];
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function wire(messages: OcxMessage[]): ChatMsg[] {
  const parsed: OcxParsedRequest = {
    modelId: "test-model",
    context: { messages },
    stream: false,
    options: {},
  };
  const req = createOpenAIChatAdapter(provider).buildRequest(parsed) as { body: string };
  return (JSON.parse(req.body) as { messages: ChatMsg[] }).messages;
}

function user(text: string): OcxMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistantWithCalls(calls: { id: string; name: string }[]): OcxMessage {
  return {
    role: "assistant",
    content: calls.map(c => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: {} })),
    timestamp: 0,
  };
}

function toolResult(callId: string, name: string, content: string | OcxContentPart[]): OcxMessage {
  return { role: "toolResult", toolCallId: callId, toolName: name, content, isError: false, timestamp: 0 };
}

function isImageCarrier(msg: ChatMsg): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;
  const [head, ...rest] = msg.content;
  return head?.type === "text" && typeof head.text === "string" && head.text.startsWith("[ocx]")
    && rest.length > 0 && rest.every(p => p.type === "image_url");
}

function assertRoundsUnbroken(messages: ChatMsg[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    let j = i - 1;
    while (j >= 0 && messages[j].role === "tool") j--;
    expect(j).toBeGreaterThanOrEqual(0);
    expect(messages[j].role).toBe("assistant");
    expect((messages[j].tool_calls ?? []).map(tc => tc.id)).toContain(m.tool_call_id);
  }
}

test("tool-result images ride a follow-up user message; text, detail, and https URLs survive", () => {
  const messages = wire([
    user("read the screenshot"),
    assistantWithCalls([{ id: "call_1", name: "Read" }]),
    toolResult("call_1", "Read", [
      { type: "text", text: "1 match found" },
      { type: "image", imageUrl: IMAGE_URL, detail: "high" },
      { type: "image", imageUrl: "https://example.test/shot.png" },
      { type: "image", imageUrl: "" },
    ]),
  ]);
  assertRoundsUnbroken(messages);
  const tool = messages.find(m => m.role === "tool")!;
  expect(tool.content).toBe("1 match found[image]");
  const carrier = messages.find(isImageCarrier)!;
  expect(carrier).toBeDefined();
  expect(messages.indexOf(carrier)).toBe(messages.indexOf(tool) + 1);
  const parts = (carrier.content as ChatPart[]).filter(p => p.type === "image_url");
  expect(parts.map(p => p.image_url)).toEqual([
    { url: IMAGE_URL, detail: "high" },
    { url: "https://example.test/shot.png" },
  ]);
});

test("images from a multi-call round flush once, only after the whole round closes", () => {
  const messages = wire([
    assistantWithCalls([{ id: "call_1", name: "shot" }, { id: "call_2", name: "list" }]),
    toolResult("call_1", "shot", [{ type: "image", imageUrl: IMAGE_URL }]),
    toolResult("call_2", "list", "file1.txt"),
  ]);
  assertRoundsUnbroken(messages);
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
  expect(toolIdx).toEqual([toolIdx[0], toolIdx[0] + 1]);
  const carriers = messages.filter(isImageCarrier);
  expect(carriers.length).toBe(1);
  expect(messages.indexOf(carriers[0])).toBe(toolIdx[1] + 1);
});

test("orphan tool result with an image still emits the carrier after its synthesized pair", () => {
  const messages = wire([
    user("hi"),
    toolResult("call_orphan", "shot", [{ type: "image", imageUrl: IMAGE_URL }]),
  ]);
  assertRoundsUnbroken(messages);
  const tool = messages.find(m => m.role === "tool")!;
  expect(tool.content).toBe("[image]");
  const carrier = messages.find(isImageCarrier)!;
  expect(messages.indexOf(carrier)).toBe(messages.indexOf(tool) + 1);
});

test("interrupted round: the synthetic closure still flushes collected images", () => {
  const messages = wire([
    assistantWithCalls([{ id: "call_1", name: "shot" }, { id: "call_2", name: "list" }]),
    toolResult("call_1", "shot", [{ type: "image", imageUrl: IMAGE_URL }]),
  ]);
  assertRoundsUnbroken(messages);
  const carrier = messages.find(isImageCarrier)!;
  expect(carrier).toBeDefined();
  expect(messages.indexOf(carrier)).toBe(messages.length - 1);
});

test("image-free tool results emit no carrier and an unchanged wire", () => {
  const messages = wire([
    user("hi"),
    assistantWithCalls([{ id: "call_1", name: "list" }]),
    toolResult("call_1", "list", "file1.txt"),
    user("thanks"),
  ]);
  expect(messages.some(isImageCarrier)).toBe(false);
  expect(messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "user"]);
});
