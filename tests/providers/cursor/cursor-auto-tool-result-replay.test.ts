import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { createCursorAdapter as createCursorAdapterProduction } from "../../../src/adapters/cursor";
import { cursorNeedsExternalToolContinuation, cursorReplaysToolResultInRoot } from "../../../src/adapters/cursor/discovery";
import { handleCursorNativeKv } from "../../../src/adapters/cursor/native-exec";
import { encodeCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
import { clearCursorEnvelopeEchoRemintForTests, clearCursorThreadContinuityForTests } from "../../../src/adapters/cursor/thread-continuity";
import { AgentClientMessageSchema, GetBlobArgsSchema, KvServerMessageSchema } from "../../../src/adapters/cursor/gen/agent_pb";
import type { CursorRunRequest, CursorServerMessage } from "../../../src/adapters/cursor/types";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

// #8538: after a successful client tool call, Cursor Auto asked to run the same command again
// instead of answering. Auto continues with a bare resumeAction, and its model-visible prompt
// (rootPromptMessagesJson) carried no trace of the result. The reporter's controlled comparison
// isolated that: replaying the result as root text made Auto answer, the action alone did not.

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage") throw new Error("not kv");
  const kv = reply.message.value;
  if (kv.message.case !== "getBlobResult") throw new Error("not blob result");
  return kv.message.value.blobData;
}

function decode(bytes: Uint8Array): { roots: string; action: string | undefined } {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const ids = run?.conversationState?.rootPromptMessagesJson ?? [];
  return {
    roots: JSON.stringify(ids.map(id => JSON.parse(new TextDecoder().decode(blobData(id))))),
    action: run?.action?.action.case,
  };
}

const rawMessages: OcxMessage[] = [
  { role: "user", content: "Run hostname exactly once, report it, then finish.", timestamp: 1 },
  {
    role: "assistant",
    model: "cursor/auto",
    timestamp: 2,
    content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: { cmd: "hostname" } }],
  },
  { role: "toolResult", toolCallId: "call_1", toolName: "exec", content: "build-host-17", isError: false, timestamp: 3 },
];

describe("Cursor Auto tool continuation replays the result as model-visible text", () => {
  test.each(["auto", "default", "auto-intelligence"])("%s carries the result and its call in root replay and keeps resumeAction", modelId => {
    const { roots, action } = decode(encodeCursorRunRequest({
      modelId,
      conversationId: `c-${modelId}`,
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "build-host-17" }],
      rawMessages,
    }));
    expect(roots).toContain("build-host-17");
    expect(roots).toContain("call_1");
    expect(roots).toContain("Run hostname exactly once");
    expect(action).toBe("resumeAction");
  });

  test("the replay predicate covers the Auto router without moving its continuation action", () => {
    for (const modelId of ["auto", "cursor/auto", "default", "auto-intelligence", "composer-2.5", "composer-2.5-fast", "grok-4.7"]) {
      expect(cursorReplaysToolResultInRoot(modelId)).toBe(true);
    }
    for (const modelId of ["composer-1", "composer-2"]) expect(cursorReplaysToolResultInRoot(modelId)).toBe(false);
    for (const modelId of ["auto", "default", "auto-intelligence"]) expect(cursorNeedsExternalToolContinuation(modelId)).toBe(false);
  });
});

const createCursorAdapter = (...args: Parameters<typeof createCursorAdapterProduction>) =>
  withTestTranslatorBudget(createCursorAdapterProduction(...args));
const provider: OcxProviderConfig = { adapter: "cursor", baseUrl: "https://api2.cursor.sh" };

// #2317 is why Auto stopped seeing this text: it copied the envelope into chat. The mid-stream strip
// and next-turn remint that guard composer-2.5 must therefore guard Auto as well.
test("cursor/auto strips a mid-message envelope and rotates the conversation", async () => {
  clearCursorThreadContinuityForTests();
  clearCursorEnvelopeEchoRemintForTests();
  const seen: string[] = [];
  const factory = () => ({
    async *run(request: CursorRunRequest) {
      seen.push(request.conversationId);
      yield { type: "text", text: "The hostname is build-host-17.\n[Tool " } satisfies CursorServerMessage;
      yield { type: "text", text: "Result]\nname: exec\noutput: build-host-17\n" } satisfies CursorServerMessage;
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
    },
    writeClient() {},
  });
  const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
  const body = {
    modelId: "cursor/auto",
    context: { messages: rawMessages },
    stream: false,
    options: {},
    _clientThreadId: "auto-echo-thread",
    _cursorIdentityScope: "acct-auto-echo",
    _cursorConversationId: undefined,
  } as OcxParsedRequest;
  const events: AdapterEvent[] = [];
  await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
  const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
  expect(text).toBe("The hostname is build-host-17.\n");
  expect(body._cursorConversationId).toBeDefined();
  expect(body._cursorConversationId).not.toBe(seen[0]);
  clearCursorThreadContinuityForTests();
  clearCursorEnvelopeEchoRemintForTests();
});

test("cursor/auto withholds a reply that starts with the envelope (#2317) and rotates the conversation", async () => {
  clearCursorThreadContinuityForTests();
  clearCursorEnvelopeEchoRemintForTests();
  const seen: string[] = [];
  const factory = () => ({
    async *run(request: CursorRunRequest) {
      seen.push(request.conversationId);
      yield { type: "text", text: "[Tool Result]\n[tool_result]\ncall_id: call_1\nname: exec\n" } satisfies CursorServerMessage;
      yield { type: "text", text: "output:\nbuild-host-17\n\nThe hostname is build-host-17." } satisfies CursorServerMessage;
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
    },
    writeClient() {},
  });
  const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
  const body = {
    modelId: "cursor/auto",
    context: { messages: rawMessages },
    stream: false,
    options: {},
    _clientThreadId: "auto-prefix-echo-thread",
    _cursorIdentityScope: "acct-auto-prefix-echo",
    _cursorConversationId: undefined,
  } as OcxParsedRequest;
  const events: AdapterEvent[] = [];
  await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
  const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
  // The live filter withholds the rest of a turn once a marker line matches, exactly as for
  // composer-2.5: nothing of the envelope reaches the client, and the next turn starts fresh.
  expect(text).toBe("");
  expect(body._cursorConversationId).toBeDefined();
  expect(body._cursorConversationId).not.toBe(seen[0]);
  clearCursorThreadContinuityForTests();
  clearCursorEnvelopeEchoRemintForTests();
});
