import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
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

function runRequest(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  return msg.message.case === "runRequest" ? msg.message.value : undefined;
}

/** Model-visible text of every root prompt blob, in wire order. */
function rootTexts(bytes: Uint8Array): string[] {
  return (runRequest(bytes)?.conversationState?.rootPromptMessagesJson ?? []).map(blobId => {
    const parsed = JSON.parse(new TextDecoder().decode(blobData(blobId))) as {
      content?: string | [{ text?: string }];
    };
    const content = parsed.content;
    if (typeof content === "string") return content;
    return content?.[0]?.text ?? "";
  });
}

/** Assistant text of every conversation-turn step, in wire order. */
function turnStepTexts(bytes: Uint8Array): string[] {
  const texts: string[] = [];
  for (const turnId of runRequest(bytes)?.conversationState?.turns ?? []) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") continue;
    for (const stepId of turn.turn.value.steps) {
      const step = fromBinary(ConversationStepSchema, blobData(stepId));
      if (step.message.case === "assistantMessage") texts.push(step.message.value.text);
    }
  }
  return texts;
}

const CALL_ID = "call_echo_1";

function history(options: { resultCallId?: string } = {}): OcxMessage[] {
  return [
    { role: "user", content: "Run echo AAA.", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will run echo AAA." },
        { type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo AAA" } },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: options.resultCallId ?? CALL_ID,
      toolName: "exec_command",
      content: "AAA",
      isError: false,
      timestamp: 3,
    },
  ];
}

function encode(messages: OcxMessage[], modelId: string): Uint8Array {
  return encodeCursorRunRequest({
    modelId,
    conversationId: "c_pairing",
    system: [],
    messages: [],
    rawMessages: messages,
  });
}

function resultRoot(bytes: Uint8Array): string | undefined {
  return rootTexts(bytes).find(text => text.startsWith("[Tool Result]") || text.startsWith("[Tool Error]"));
}

/**
 * devlog 260829: a replayed tool result used to carry no record of the invocation that produced it,
 * so the model saw a `call_id` referring to nothing it could see. Live cursor/grok-4.6 turns then
 * re-ran commands that had already succeeded (exit 0) and narrated a phantom "was interrupted".
 *
 * The invocation is named INSIDE the result envelope rather than as a separate "[Tool Call]" entry:
 * the 363-B guard in cursor-tool-continuation.test.ts shows a standalone call marker gets
 * few-shot-mimicked, after which the model emits later tool calls as inert text. These assertions
 * decode the real wire payload, since roots are what Cursor builds the model prompt from.
 */
describe("cursor replayed tool results name their invocation", () => {
  test("the result envelope names the tool and arguments that produced it", () => {
    const root = resultRoot(encode(history(), "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain(`call_id: ${CALL_ID}`);
    expect(root).toContain("invoked: exec_command with");
    expect(root).toContain("echo AAA");
  });

  test("no standalone [Tool Call] entry is ever emitted (363-B mimicry guard)", () => {
    for (const modelId of ["grok-4.6-high", "composer-2.5", "composer-2.5-fast"]) {
      const bytes = encode(history(), modelId);
      expect(rootTexts(bytes).some(text => text.includes("[Tool Call]"))).toBe(false);
      expect(turnStepTexts(bytes).some(text => text.includes("[Tool Call]"))).toBe(false);
    }
  });

  test("the invocation line also reaches the conversation-turn step", () => {
    const step = turnStepTexts(encode(history(), "grok-4.6-high"))
      .find(text => text.startsWith("[Tool Result]"));
    expect(step).toBeDefined();
    expect(step).toContain("invoked: exec_command with");
  });

  // composer-2.5 (non-fast) is a NATIVE wire model that still routes through the external
  // tool-continuation path (discovery.ts cursorNeedsExternalToolContinuation), so it echoes results
  // into root as text and needs the invocation named too. Gating on `externalModel` would have
  // skipped exactly this model (audit 001 F2).
  test("composer-2.5 root replay names the invocation too", () => {
    const root = resultRoot(encode(history(), "composer-2.5"));
    expect(root).toBeDefined();
    expect(root).toContain("invoked: exec_command with");
  });

  test("a result whose call id matches nothing is still replayed, without an invocation line", () => {
    const root = resultRoot(encode(history({ resultCallId: "call_other" }), "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain("call_id: call_other");
    expect(root).not.toContain("invoked:");
  });

  test("native composer replay keeps results off the root prompt entirely", () => {
    const bytes = encode(history(), "composer-2.5-fast");
    expect(rootTexts(bytes).some(text => text.startsWith("[Tool Result]"))).toBe(false);
    expect(rootTexts(bytes).some(text => text.includes("invoked:"))).toBe(false);
  });

  test("unserializable arguments do not break request encoding", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const messages: OcxMessage[] = [
      { role: "user", content: "Run it.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: cyclic }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "ok", isError: false, timestamp: 3 },
    ];
    const root = resultRoot(encode(messages, "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain("[unserializable arguments]");
  });
});
