import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import { create } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage } from "../src/types";

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage" || reply.message.value.message.case !== "getBlobResult") {
    throw new Error("expected getBlobResult");
  }
  return reply.message.value.message.value.blobData!;
}

function rootTexts(bytes: Uint8Array): string[] {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  return (run?.conversationState?.rootPromptMessagesJson ?? []).map(blobId => {
    const parsed = JSON.parse(new TextDecoder().decode(blobData(blobId))) as { content?: [{ text?: string }] };
    return parsed.content?.[0]?.text ?? "";
  });
}

const REPEAT = "원격 ocx 상태를 다시 확인합니다.";

function repeatedHistory(times: number): OcxMessage[] {
  const messages: OcxMessage[] = [{ role: "user", content: "원격 ocx를 최신 버전으로 업데이트해봐", timestamp: 1 }];
  for (let i = 0; i < times; i++) {
    messages.push({ role: "assistant", content: REPEAT, timestamp: 2 + i } as OcxMessage);
  }
  messages.push({ role: "user", content: "계속", timestamp: 100 });
  return messages;
}

function repeatedToolHistory(times: number): OcxMessage[] {
  const messages: OcxMessage[] = [{ role: "user", content: "熟悉一下当前项目", timestamp: 1 }];
  for (let i = 0; i < times; i++) {
    const callId = `call_${i}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: REPEAT },
        { type: "toolCall", id: callId, name: "exec_command", arguments: { cmd: `echo ${i}` } },
      ],
      timestamp: 2 + i * 2,
    });
    messages.push({
      role: "toolResult",
      toolCallId: callId,
      toolName: "exec_command",
      content: `result ${i}`,
      isError: false,
      timestamp: 3 + i * 2,
    });
  }
  return messages;
}

function encode(messages: OcxMessage[], modelId = "grok-4.6-high") {
  return encodeCursorRunRequest({
    modelId,
    conversationId: "c_rep",
    system: [],
    messages: [],
    rawMessages: messages,
  });
}

describe("cursor external-replay repetition breaker (devlog 260826 gap-9)", () => {
  test("consecutive identical assistant entries collapse into one marked entry", () => {
    const texts = rootTexts(encode(repeatedHistory(5)));
    const repeats = texts.filter(text => text.startsWith(REPEAT));
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toContain("5 times in a row");
  });

  test("severe repetition appends exactly one strategy-change note", () => {
    const texts = rootTexts(encode(repeatedHistory(4)));
    const notes = texts.filter(text => text.includes("Take a DIFFERENT action now"));
    expect(notes).toHaveLength(1);
  });

  test("two repeats collapse but do not trigger the note", () => {
    const texts = rootTexts(encode(repeatedHistory(2)));
    expect(texts.filter(text => text.includes("2 times in a row"))).toHaveLength(1);
    expect(texts.filter(text => text.includes("Take a DIFFERENT action now"))).toHaveLength(0);
  });

  test("repeated assistant narration across tool-result cycles still trips the breaker", () => {
    const bytes = encode(repeatedToolHistory(4));
    const texts = rootTexts(bytes);
    const repeats = texts.filter(text => text.startsWith(REPEAT));
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toContain("4 times in a row");
    expect(texts.filter(text => text.startsWith("[Tool Result]"))).toHaveLength(4);
    expect(texts.filter(text => text.includes("Take a DIFFERENT action now"))).toHaveLength(1);
  });

  test("distinct assistant entries stay untouched", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "step one done", timestamp: 2 },
      { role: "assistant", content: "step two done", timestamp: 3 },
      { role: "user", content: "continue", timestamp: 4 },
    ] as OcxMessage[];
    const texts = rootTexts(encode(messages));
    expect(texts).toContain("step one done");
    expect(texts).toContain("step two done");
    expect(texts.some(text => text.includes("times in a row"))).toBe(false);
  });

  test("duplicates separated by a user message do not collapse", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: REPEAT, timestamp: 2 },
      { role: "user", content: "again", timestamp: 3 },
      { role: "assistant", content: REPEAT, timestamp: 4 },
      { role: "user", content: "final", timestamp: 5 },
    ] as OcxMessage[];
    const texts = rootTexts(encode(messages));
    expect(texts.filter(text => text === REPEAT)).toHaveLength(2);
  });

  test("empty user boundaries still reset repetition tracking", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: REPEAT, timestamp: 2 },
      { role: "user", content: "   ", timestamp: 3 },
      { role: "assistant", content: REPEAT, timestamp: 4 },
      { role: "user", content: "final", timestamp: 5 },
    ] as OcxMessage[];
    const texts = rootTexts(encode(messages));
    expect(texts.filter(text => text === REPEAT)).toHaveLength(2);
  });

  test("three identical tool calls with changing narration trigger a strategy change", () => {
    const messages: OcxMessage[] = [{ role: "user", content: "find the i18n bug", timestamp: 1 }];
    for (let i = 0; i < 3; i++) {
      const callId = `view_${i}`;
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `investigation step ${i}` },
          { type: "toolCall", id: callId, name: "view_image", arguments: { path: "C:\\tmp\\same.png" } },
        ],
        timestamp: 2 + i * 2,
      });
      messages.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: "view_image",
        content: `viewed image ${i}`,
        isError: false,
        timestamp: 3 + i * 2,
      });
    }

    const texts = rootTexts(encode(messages));
    expect(texts.filter(text => text.startsWith("investigation step"))).toHaveLength(3);
    expect(texts.filter(text => text.startsWith("[Tool Result]"))).toHaveLength(3);
    expect(texts.filter(text => text.includes("same tool call repeated 3 times"))).toHaveLength(1);
  });
});
