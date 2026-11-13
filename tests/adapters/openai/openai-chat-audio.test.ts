import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { parseRequest } from "../../../src/responses/parser";
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

test("developer inline audio retains the instruction slot and uses a user audio carrier", () => {
  const parsed = parseRequest({ model: "gpt-audio", instructions: "Base", input: [
    { role: "user", content: "First" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { role: "developer", content: [
      { type: "input_text", text: "Listen to the recording" },
      { type: "input_audio", audio_url: "data:audio/wav;base64,YXVkaW8=", format: "wav" },
    ] },
    { type: "function_call_output", call_id: "call_1", output: "result" },
    { role: "user", content: "Continue" },
  ] });
  const messages = JSON.parse(createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1" })
    .buildRequest(parsed).body).messages as Array<Record<string, unknown>>;
  expect(messages).toEqual([
    { role: "system", content: "Base" },
    { role: "user", content: "First" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
    { role: "system", content: [{ type: "text", text: "Listen to the recording" }] },
    { role: "user", content: [{ type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } }] },
    { role: "user", content: "Continue" },
  ]);
  expect(messages.some(message => (message.role === "system" || message.role === "developer")
    && JSON.stringify(message.content).includes("input_audio"))).toBe(false);
});

test("interleaved instructions and recordings preserve their adjacent groups", () => {
  const messages = wire([
    user("First"),
    assistantWithCalls([{ id: "call_1", name: "lookup" }]),
    { role: "developer", content: [
      { type: "text", text: "Translate the first recording" },
      { type: "audio", data: "YXVkaW8=", format: "wav", text: "[audio: wav]" },
      { type: "text", text: "Translate the second recording" },
      { type: "audio", data: "bW9yZQ==", format: "wav", text: "[audio: wav]" },
    ], timestamp: 0 },
    toolResult("call_1", "lookup", "result"),
    user("Continue"),
  ]);
  expect(messages).toEqual([
    { role: "user", content: "First" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
    { role: "system", content: [{ type: "text", text: "Translate the first recording" }] },
    { role: "user", content: [{ type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } }] },
    { role: "system", content: [{ type: "text", text: "Translate the second recording" }] },
    { role: "user", content: [{ type: "input_audio", input_audio: { data: "bW9yZQ==", format: "wav" } }] },
    { role: "user", content: "Continue" },
  ]);
});

test("a default-role developer image uses a user carrier after its instruction text", () => {
  const parsed = parseRequest({ model: "gpt-vision", instructions: "Base", input: [
    { role: "user", content: "First" },
    { role: "developer", content: [
      { type: "input_text", text: "Inspect this image" },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" },
    ] },
    { role: "user", content: "Continue" },
  ] });
  const messages = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body).messages;
  expect(messages).toEqual([
    { role: "system", content: "Base" },
    { role: "user", content: "First" },
    { role: "user", content: [
      { type: "text", text: "Inspect this image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "high" } },
    ] },
    { role: "user", content: "Continue" },
  ]);
});

test("a default-role developer document uses a user carrier after its instruction text", () => {
  const file = { type: "input_file", filename: "spec.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQ=" };
  const parsed = parseRequest({ model: "gpt-files", input: [{ role: "developer", content: [
    { type: "input_text", text: "Read this document" }, file,
  ] }] });
  const messages = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body).messages;
  expect(messages).toEqual([
    { role: "user", content: [
      { type: "text", text: "Read this document" },
      { type: "file", file: { filename: file.filename, file_data: file.file_data } },
    ] },
  ]);
});

test("single-leading instructions keep audio and image bytes in one ordered user carrier", () => {
  const parsed = parseRequest({ model: "gpt-audio", instructions: "Base", input: [
    { role: "user", content: "First" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { role: "developer", content: [
      { type: "input_text", text: "Listen and inspect" },
      { type: "input_audio", audio_url: "data:audio/wav;base64,YXVkaW8=", format: "wav" },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" },
    ] },
    { type: "function_call_output", call_id: "call_1", output: "result" },
    { role: "user", content: "Continue" },
  ] });
  const messages = JSON.parse(createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1",
    singleLeadingSystemMessage: true }).buildRequest(parsed).body).messages as Array<Record<string, unknown>>;
  expect(messages).toEqual([
    { role: "system", content: "Base\n\nListen and inspect" },
    { role: "user", content: "First" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
    { role: "user", content: [
      { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "high" } },
    ] },
    { role: "user", content: "Continue" },
  ]);
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
