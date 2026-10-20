import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
};

const AUDIO_WAV = { type: "audio" as const, data: "UklGRiQAAABXQVZF", format: "wav" as const, text: "[audio: wav]" };
const AUDIO_MP3 = { type: "audio" as const, data: "SUQzBAAAAA==", format: "mp3" as const, text: "[audio: mp3]" };

interface ChatPart {
  type: string;
  text?: string;
  input_audio?: { data: string; format: string };
  image_url?: { url: string };
}

interface ChatMsg {
  role: string;
  content?: string | ChatPart[];
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function wire(messages: OcxMessage[]): ChatMsg[] {
  const parsed: OcxParsedRequest = { modelId: "test-model", context: { messages }, stream: false, options: {} };
  const req = createOpenAIChatAdapter(provider).buildRequest(parsed) as { body: string };
  return (JSON.parse(req.body) as { messages: ChatMsg[] }).messages;
}

function user(content: string | OcxContentPart[]): OcxMessage {
  return { role: "user", content, timestamp: 0 };
}

function assistantWithCalls(calls: { id: string; name: string }[]): OcxMessage {
  return { role: "assistant", content: calls.map(c => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: {} })), timestamp: 0 };
}

function toolResult(callId: string, name: string, content: string | OcxContentPart[]): OcxMessage {
  return { role: "toolResult", toolCallId: callId, toolName: name, content, isError: false, timestamp: 0 };
}

function isAudioCarrier(msg: ChatMsg): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;
  const [head, ...rest] = msg.content;
  return head?.type === "text" && head.text === "[ocx] audio output from the preceding tool result(s):"
    && rest.length > 0 && rest.every(p => p.type === "input_audio");
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

test("user audio maps to a Chat input_audio content part", () => {
  const messages = wire([user([{ type: "text", text: "listen" }, AUDIO_WAV])]);
  expect(messages).toEqual([{
    role: "user",
    content: [
      { type: "text", text: "listen" },
      { type: "input_audio", input_audio: { data: AUDIO_WAV.data, format: "wav" } },
    ],
  }]);
});

test("tool-result audio rides a follow-up user message after the tool round", () => {
  const messages = wire([
    user("play the clip"),
    assistantWithCalls([{ id: "call_1", name: "exec" }]),
    toolResult("call_1", "exec", [
      { type: "text", text: "rendered" },
      AUDIO_MP3,
    ]),
  ]);

  assertRoundsUnbroken(messages);
  const tool = messages.find(m => m.role === "tool")!;
  expect(tool.content).toBe("rendered");
  const carrier = messages.find(isAudioCarrier)!;
  expect(carrier).toBeDefined();
  expect(messages.indexOf(carrier)).toBe(messages.indexOf(tool) + 1);
  expect((carrier.content as ChatPart[]).slice(1)).toEqual([
    { type: "input_audio", input_audio: { data: AUDIO_MP3.data, format: "mp3" } },
  ]);
});

test("audio from a multi-call round flushes once after the whole round closes", () => {
  const messages = wire([
    assistantWithCalls([{ id: "call_1", name: "clip" }, { id: "call_2", name: "list" }]),
    toolResult("call_1", "clip", [AUDIO_WAV]),
    toolResult("call_2", "list", "file.txt"),
  ]);

  assertRoundsUnbroken(messages);
  const toolIndices = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
  const carriers = messages.filter(isAudioCarrier);
  expect(carriers).toHaveLength(1);
  expect(messages.indexOf(carriers[0])).toBe(toolIndices[1] + 1);
});

test("an audio-only tool result keeps a text marker and carries the bytes separately", () => {
  const messages = wire([
    user("play"),
    assistantWithCalls([{ id: "call_1", name: "clip" }]),
    toolResult("call_1", "clip", [AUDIO_WAV]),
  ]);

  const tool = messages.find(m => m.role === "tool")!;
  expect(tool.content).toBe("[audio: wav]");
  expect(messages.find(isAudioCarrier)).toBeDefined();
});

test("an orphan tool result with audio still emits its carrier after the synthesized pair", () => {
  const messages = wire([
    user("hi"),
    toolResult("call_orphan", "clip", [AUDIO_WAV]),
  ]);

  assertRoundsUnbroken(messages);
  const carrier = messages.find(isAudioCarrier)!;
  expect(carrier).toBeDefined();
  expect(messages.indexOf(carrier)).toBe(messages.length - 1);
});
