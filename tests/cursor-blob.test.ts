import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import { toBinary } from "@bufbuild/protobuf";
import {
  createCursorBlobRequestScope,
  cursorBlobMetrics,
  cursorBlobByteLength,
  cursorBlobRetainedStoreSnapshot,
  cursorBlobStoreDebugSnapshotForTests,
  CursorBlobAdmissionError,
  evictOldestCursorBlobForBudget,
  handleCursorNativeKv,
  releaseCursorBlobRequestScope,
  resetCursorBlobStateForTests,
  sealCursorBlobRequestScope,
  setCursorBlobLimitsForTests,
  storeCursorBlob,
  type CursorBlobRequestScopeToken,
} from "../src/adapters/cursor/native-exec";
import {
  clearCursorCheckpointsForTests,
  commitCursorCheckpoint,
  CURSOR_CHECKPOINT_TTL_MS,
  cursorCheckpointStoreMetricsForTests,
  installCursorCheckpointClockForTests,
  invalidateCursorCheckpoint,
} from "../src/adapters/cursor/checkpoint-store";
import {
  configureAppOwnedMemoryBudget,
  registerRetainedStore,
  resetAppOwnedMemoryForTests,
} from "../src/lib/app-owned-memory";
import { resetDebugSettingsForTests } from "../src/lib/debug-settings";
import {
  CURSOR_EXTERNAL_ROOT_BYTE_LIMIT,
  CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT,
  CURSOR_EXTERNAL_ROOT_BLOB_LIMIT,
  CURSOR_ROUTING_LEVEL_PARAMETER_ID,
  encodeCursorRunRequest,
  prepareCursorRunRequest,
} from "../src/adapters/cursor/protobuf-request";
import { estimateTokens } from "../src/lib/token-estimate";
import type { OcxAssistantContentPart } from "../src/types";
import { CursorRootEnvelopeLimitError } from "../src/adapters/cursor/cursor-errors";
import { isRetryableCursorError } from "../src/adapters/cursor/transport-retry";
import { encodeCursorCallId, resetCursorCallIdProvenanceForTests } from "../src/adapters/cursor/call-id";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  ConversationStateStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
  SetBlobArgsSchema,
  UserMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";

beforeEach(() => {
  resetCursorBlobStateForTests();
  resetAppOwnedMemoryForTests();
});
afterEach(() => {
  setCursorBlobLimitsForTests();
  resetAppOwnedMemoryForTests();
});

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  expect(reply.message.case).toBe("kvClientMessage");
  const kv = reply.message.value;
  expect(kv.message.case).toBe("getBlobResult");
  return kv.message.value.blobData;
}

function getBlobReply(blobId: Uint8Array, id = 1, scope?: CursorBlobRequestScopeToken) {
  return fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  }), scope));
}

function setBlobReply(blobId: Uint8Array, blobData: Uint8Array, id = 1, scope?: CursorBlobRequestScopeToken) {
  return fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id,
    message: { case: "setBlobArgs", value: create(SetBlobArgsSchema, { blobId, blobData }) },
  }), scope));
}

function hydrateBlob(blobId: Uint8Array, scope?: CursorBlobRequestScopeToken): Uint8Array {
  const reply = getBlobReply(blobId, 1, scope);
  expect(reply.message.case).toBe("kvClientMessage");
  if (reply.message.case !== "kvClientMessage") throw new Error("expected kvClientMessage");
  expect(reply.message.value.message.case).toBe("getBlobResult");
  if (reply.message.value.message.case !== "getBlobResult") throw new Error("expected getBlobResult");
  expect(reply.message.value.message.value.blobData).toBeDefined();
  return reply.message.value.message.value.blobData!;
}

function expectBlobHit(blobId: Uint8Array, expected: Uint8Array, scope?: CursorBlobRequestScopeToken): void {
  expect(Array.from(hydrateBlob(blobId, scope))).toEqual(Array.from(expected));
}

function expectBlobMiss(blobId: Uint8Array, id = 1, scope?: CursorBlobRequestScopeToken): void {
  const reply = getBlobReply(blobId, id, scope);
  expect(reply.message.case).toBe("kvClientMessage");
  if (reply.message.case !== "kvClientMessage") throw new Error("expected kvClientMessage");
  expect(reply.message.value.id).toBe(id);
  expect(reply.message.value.message.case).toBe("getBlobResult");
  if (reply.message.value.message.case !== "getBlobResult") throw new Error("expected getBlobResult");
  expect(reply.message.value.message.value.blobData).toBeUndefined();
}

function decodeRootMessages(bytes: Uint8Array): unknown[] {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  return (run?.conversationState?.rootPromptMessagesJson ?? [])
    .map(blobId => JSON.parse(new TextDecoder().decode(blobData(blobId))) as unknown);
}

function actionText(bytes: Uint8Array): string | undefined {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const action = run?.action?.action;
  return action?.case === "userMessageAction" ? action.value.userMessage?.text : undefined;
}

/** Minimal valid 1×1 PNG for SelectedImage fixtures (not signature-only). */
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function activeUserMessage(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const action = run?.action?.action;
  return action?.case === "userMessageAction" ? action.value.userMessage : undefined;
}

function activeSelectedImages(bytes: Uint8Array) {
  return activeUserMessage(bytes)?.selectedContext?.selectedImages;
}

function nativeTurnUserMessages(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  return (run?.conversationState?.turns ?? []).map(turnId => {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") return undefined;
    return fromBinary(UserMessageSchema, blobData(turn.turn.value.userMessage));
  }).filter((message): message is NonNullable<typeof message> => message !== undefined);
}

/** The `toolName`s advertised in the top-level AgentRunRequest.mcp_tools channel (undefined when unset). */
function mcpToolNames(bytes: Uint8Array): string[] | undefined {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  return run?.mcpTools?.mcpTools.map(def => def.toolName);
}

describe("Cursor blob handshake", () => {
  test("storeCursorBlob returns the SHA-256 blob id (32 bytes)", () => {
    const data = new TextEncoder().encode('{"role":"system","content":"hi"}');
    const id = storeCursorBlob(data);
    expect(id.length).toBe(32);
    expect(Array.from(id)).toEqual(Array.from(sha256(data)));
  });

  test("encodeCursorRunRequest attaches selectedContext with blobIdWithData image refs on the active user turn", () => {
    const imageBytes = PNG_1X1;
    const expectedBlobId = sha256(imageBytes);
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "see this" }],
      selectedImages: [{
        data: imageBytes,
        mimeType: "image/png",
        uuid: "img-uuid-1",
      }],
    });

    expect(actionText(bytes)).toBe("see this");
    const userMessage = activeUserMessage(bytes);
    expect(userMessage?.mode).toBe(1);
    expect(userMessage?.selectedContext).toBeDefined();
    const images = activeSelectedImages(bytes);
    expect(images?.length).toBe(1);
    expect(images?.[0]?.uuid).toBe("img-uuid-1");
    expect(images?.[0]?.mimeType).toBe("image/png");
    expect(images?.[0]?.path).toBe("attachment-img-uuid-1.png");
    expect(images?.[0]?.dataOrBlobId.case).toBe("blobIdWithData");
    const withData = images?.[0]?.dataOrBlobId.value as { blobId: Uint8Array; data: Uint8Array };
    expect(Array.from(withData.blobId)).toEqual(Array.from(expectedBlobId));
    expect(Array.from(withData.data)).toEqual(Array.from(imageBytes));
    expect(Array.from(blobData(expectedBlobId))).toEqual(Array.from(imageBytes));
  });

  test("encodeCursorRunRequest always sends empty selectedContext and mode=1 on text-only turns", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "hi" }],
    });

    const userMessage = activeUserMessage(bytes);
    expect(userMessage?.text).toBe("hi");
    expect(userMessage?.mode).toBe(1);
    expect(userMessage?.selectedContext).toBeDefined();
    expect(userMessage?.selectedContext?.selectedImages.length).toBe(0);
  });

  test("encodeCursorRunRequest keeps selectedContext only on the active user turn", () => {
    const activeImageBytes = PNG_1X1;
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "active turn" }],
      rawMessages: [
        {
          role: "user",
          content: [
            { type: "text", text: "old turn" },
            { type: "image", imageUrl: "data:image/png;base64,old", detail: "auto" },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          model: "cursor/composer-2.5",
          content: [{ type: "text", text: "ack" }],
          timestamp: 2,
        },
        { role: "user", content: "active turn", timestamp: 3 },
      ],
      selectedImages: [{
        data: activeImageBytes,
        mimeType: "image/png",
        uuid: "active-img",
      }],
    });

    const roots = decodeRootMessages(bytes) as Array<{ role?: string; selectedContext?: unknown }>;
    expect(roots.some(root => root.selectedContext !== undefined)).toBe(false);

    const historicalUser = nativeTurnUserMessages(bytes)[0];
    expect(historicalUser?.text).toBe("old turn\n[image attached]");
    expect(historicalUser?.mode).toBe(1);
    expect(historicalUser?.selectedContext).toBeDefined();
    expect(historicalUser?.selectedContext?.selectedImages.length).toBe(0);

    const activeMessage = activeUserMessage(bytes);
    expect(activeMessage?.mode).toBe(1);
    const images = activeSelectedImages(bytes);
    expect(images?.length).toBe(1);
    expect(images?.[0]?.uuid).toBe("active-img");
  });

  test("historical image-only turns replay a short text marker, not empty text", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "follow-up" }],
      rawMessages: [
        {
          role: "user",
          content: [{ type: "image", imageUrl: "data:image/png;base64,abc", detail: "auto" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          model: "cursor/composer-2.5",
          content: [{ type: "text", text: "ack" }],
          timestamp: 2,
        },
        { role: "user", content: "follow-up", timestamp: 3 },
      ],
    });
    const historicalUser = nativeTurnUserMessages(bytes)[0];
    expect(historicalUser?.text).toBe("[image attached]");
    expect(historicalUser?.selectedContext?.selectedImages.length).toBe(0);
  });

  test("external root-prompt replay keeps image-only history as the text marker", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "grok-4.5",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "follow-up" }],
      rawMessages: [
        {
          role: "user",
          content: [{ type: "image", imageUrl: "data:image/png;base64,abc", detail: "auto" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          model: "cursor/grok-4.5",
          content: [{ type: "text", text: "ack" }],
          timestamp: 2,
        },
        { role: "user", content: "follow-up", timestamp: 3 },
      ],
    });
    const roots = decodeRootMessages(bytes) as Array<{
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    const rootsJson = JSON.stringify(roots);
    expect(rootsJson).toContain("[image attached]");
    expect(rootsJson).not.toContain("data:image/png;base64,");
    expect(rootsJson).not.toContain("abc");
    expect(roots).toContainEqual({
      role: "user",
      content: [{ type: "text", text: "[image attached]" }],
    });
  });

  test("encodeCursorRunRequest uses userMessageAction for image-only turns with selectedImages", () => {
    const imageBytes = PNG_1X1;
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "" }],
      rawMessages: [{
        role: "user",
        content: [{ type: "image", imageUrl: "data:image/png;base64,abc", detail: "auto" }],
        timestamp: 1,
      }],
      selectedImages: [{
        data: imageBytes,
        mimeType: "image/png",
        uuid: "image-only",
      }],
    });

    expect(activeUserMessage(bytes)).toBeDefined();
    expect(actionText(bytes)).toBe("");
    expect(activeSelectedImages(bytes)?.length).toBe(1);
  });

  test("encodeCursorRunRequest uses userMessageAction for image-only turns after assistant reply", () => {
    const imageBytes = PNG_1X1;
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c1",
      system: [],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "" },
      ],
      rawMessages: [
        { role: "user", content: "first", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/composer-2.5",
          content: [{ type: "text", text: "ack" }],
          timestamp: 2,
        },
        {
          role: "user",
          content: [{ type: "image", imageUrl: "data:image/png;base64,abc", detail: "auto" }],
          timestamp: 3,
        },
      ],
      selectedImages: [{
        data: imageBytes,
        mimeType: "image/png",
        uuid: "follow-up-image",
      }],
    });

    expect(activeUserMessage(bytes)).toBeDefined();
    expect(actionText(bytes)).toBe("");
    expect(activeSelectedImages(bytes)?.length).toBe(1);
  });

  test("encodeCursorRunRequest sends rootPromptMessagesJson as blob IDs, not inline JSON", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} }],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];

    expect(roots.length).toBeGreaterThan(0);
    // Every entry must be a 32-byte SHA-256 blob id (the bug was sending inline JSON → "Blob not found").
    for (const entry of roots) expect(entry.length).toBe(32);
    // The first root is the blob id of the system-prompt JSON exactly.
    const sysJson = new TextEncoder().encode(JSON.stringify({ role: "system", content: "You are helpful." }));
    expect(Array.from(roots[0]!)).toEqual(Array.from(sha256(sysJson)));
    // Client Responses tools are mirrored into the top-level AgentRunRequest.mcp_tools payload
    // (McpTools wrapper) so cursor models register them as callable. Advertising only via native
    // exec RequestContext.tools left them unavailable to the model. The wrapper shape IS
    // wire-compatible (the earlier crash was a wrong-shape assignment, since corrected).
    expect(run?.mcpTools?.mcpTools.length).toBe(1);
    expect(run?.mcpTools?.mcpTools[0]?.toolName).toBe("mcp__fs__read_file");
  });

  test("caps external root replay while preserving system and newest history", () => {
    const rawMessages = Array.from({ length: 210 }, (_, index) =>
      index % 2 === 0
        ? { role: "user" as const, content: `user-${index}`, timestamp: index }
        : {
            role: "assistant" as const,
            model: "cursor/gpt-5.6-sol",
            content: [{ type: "text" as const, text: `assistant-${index}` }],
            timestamp: index,
          });
    rawMessages.push({ role: "user", content: "active-user", timestamp: 211 });
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c1",
      system: ["system-marker"],
      messages: [{ role: "user", content: "active-user" }],
      rawMessages,
    });

    const roots = decodeRootMessages(bytes);
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    expect(JSON.stringify(roots[0])).toContain("system-marker");
    expect((roots[1] as { role?: string }).role).toBe("user");
    expect(JSON.stringify(roots)).toContain("assistant-209");
    expect(JSON.stringify(roots)).not.toContain("user-0");
  }, { timeout: 30_000 });

  test("caps external root replay by serialized bytes", () => {
    const large = "x".repeat(40_000);
    const rawMessages = Array.from({ length: 12 }, (_, index) => [
      { role: "user" as const, content: `user-${index}:${large}`, timestamp: index * 2 + 1 },
      {
        role: "assistant" as const,
        model: "cursor/gpt-5.6-sol",
        content: [{ type: "text" as const, text: `assistant-${index}:${large}` }],
        timestamp: index * 2 + 2,
      },
    ]).flat();
    rawMessages.push({ role: "user", content: "current", timestamp: 100 });

    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-byte-cap",
      system: ["system"],
      messages: [{ role: "user", content: "current" }],
      rawMessages,
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    const rootBytes = roots.reduce((sum, id) => sum + blobData(id).byteLength, 0);
    const rootRoles = roots.map(id =>
      (JSON.parse(new TextDecoder().decode(blobData(id))) as { role?: string }).role
    );

    expect(rootBytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    expect(roots.length).toBeLessThan(rawMessages.length);
    expect(rootRoles.find(role => role !== "system")).toBe("user");
  });

  test("preserves oversized active tool result under external byte budget", () => {
    const huge = "y".repeat(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-tool-cap",
      system: ["system"],
      messages: [{ role: "tool", content: "ignored" }],
      rawMessages: [
        { role: "user", content: "read it", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/gpt-5.6-sol",
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: huge,
          isError: false,
          timestamp: 3,
        },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const roots = decodeRootMessages(bytes) as Array<{ role?: string; content?: unknown }>;
    const rootBytes = (run?.conversationState?.rootPromptMessagesJson ?? [])
      .reduce((sum, id) => sum + blobData(id).byteLength, 0);

    expect(run?.action?.action.case).toBe("userMessageAction");
    expect(rootBytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    expect(JSON.stringify(roots)).toContain("[Tool Result]");
    expect(JSON.stringify(roots)).toContain("truncated for Cursor external replay budget");
    // #1527: the result surviving is not enough. Byte pressure used to consume the whole budget
    // with this one result and drop the user turn that asked for it, and `conversationTurns()`
    // then discarded the result too for lack of a current turn. What went on the wire was system
    // roots plus a bare result marker and a generic Continue action — no instruction, which a
    // model answers in a handful of tokens. That is the reported symptom.
    //
    // Asserting the marker alone is what let it pass CI, so assert the instruction as well.
    expect(JSON.stringify(roots)).toContain("read it");
    expect(roots.find(root => root.role !== "system")?.role).toBe("user");
    expect(run?.conversationState?.turns.length).toBe(1);
  });

  test("truncates multi-byte tool results by UTF-8 byte budget", () => {
    const huge = "한".repeat(200_000); // 3 bytes per character
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-cjk-cap",
      system: ["system"],
      messages: [{ role: "tool", content: "ignored" }],
      rawMessages: [
        { role: "user", content: "read it", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/gpt-5.6-sol",
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: huge,
          isError: false,
          timestamp: 3,
        },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const rootBytes = (run?.conversationState?.rootPromptMessagesJson ?? [])
      .reduce((sum, id) => sum + blobData(id).byteLength, 0);
    expect(rootBytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    expect(JSON.stringify(decodeRootMessages(bytes))).toContain("truncated for Cursor external replay budget");
  });

  test("omits tool result when system leaves too little budget for the truncation marker", () => {
    // Leave ~40 bytes of history room — less than the JSON-wrapped truncation marker (~100 bytes).
    const overhead = new TextEncoder().encode(JSON.stringify({ role: "system", content: "" })).byteLength;
    const leave = 40;
    const system = "s".repeat(Math.max(0, CURSOR_EXTERNAL_ROOT_BYTE_LIMIT - leave - overhead));
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-system-cap",
      system: [system],
      messages: [{ role: "tool", content: "ignored" }],
      rawMessages: [
        { role: "user", content: "read it", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/gpt-5.6-sol",
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: "y".repeat(10_000),
          isError: false,
          timestamp: 3,
        },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const roots = decodeRootMessages(bytes) as Array<{ role?: string; content?: unknown }>;
    const rootBytes = (run?.conversationState?.rootPromptMessagesJson ?? [])
      .reduce((sum, id) => sum + blobData(id).byteLength, 0);

    expect(rootBytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    expect(JSON.stringify(roots)).not.toContain("truncated for Cursor external replay budget");
  });

  test("encodes Cursor Router levels through requested_model parameters", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "default",
      routingLevel: "cost",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "hi" }],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;

    expect(run?.modelDetails?.modelId).toBe("default");
    expect(run?.requestedModel).toMatchObject({
      modelId: "default",
      maxMode: false,
      parameters: [{ id: CURSOR_ROUTING_LEVEL_PARAMETER_ID, value: "cost" }],
    });
  });

  test("does not encode router-only requested_model for external Cursor models", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "hi" }],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;

    expect(run?.modelDetails?.modelId).toBe("gpt-5.6-sol-xhigh");
    expect(run?.requestedModel).toBeUndefined();
  });

  test("encodes Grok Fast through requested_model parameters without legacy model_details", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "grok-4.5",
      requestedModelParameters: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "hi" }],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;

    expect(run?.modelDetails).toBeUndefined();
    expect(run?.requestedModel).toMatchObject({
      modelId: "grok-4.5",
      maxMode: false,
      parameters: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
  });

  test("adds Cursor exact-tool guidance to system prompt blobs when tools are advertised", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "read a file" }],
      toolChoice: { mode: "required", allowedTools: ["read_file"] },
      tools: [
        { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
        { name: "write_file", namespace: "mcp__fs", description: "Write", parameters: {} },
      ],
    });

    const roots = JSON.stringify(decodeRootMessages(bytes));
    expect(roots).toContain("available tool names are exactly `mcp__fs__read_file`");
    expect(roots).not.toContain("`mcp__fs__write_file`");
    expect(roots).toContain("neighboring-agent tool names `Read`, `Grep`, `Glob`, `Bash`, `LS`");
    expect(roots).toContain("unless a tool result was actually returned");

  });

  test("keeps exec_command guidance in the system prompt without mutating the user request", () => {
    const prompt = "Run: echo OCX via your shell tool, report stdout.";
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: prompt }],
      tools: [{
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    });

    const roots = decodeRootMessages(bytes);
    expect(JSON.stringify(roots)).toContain("Shell commands use");
    expect(JSON.stringify(roots)).toContain("exec_command");
    expect(actionText(bytes)).toBe(prompt);
    expect(actionText(bytes)).not.toContain("Use the Codex shell bridge tool listed this turn");
  });

  test("adds generic exec_command guidance for active tool-count demo prompts", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "developer", content: "아무 tool 10개 써봐" }],
      tools: [
        {
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
        { name: "tool_search", description: "Discover tools", parameters: {} },
      ],
    });

    const text = actionText(bytes);
    expect(text).toContain("아무 tool 10개 써봐");
    expect(text).toContain("This turn requests 10 tool uses");
    expect(text).toContain("exactly 10 separate Codex shell bridge function calls/results");
    expect(text).toContain("One shell-bridge call containing chained commands counts as 1 tool call, not 10");
    expect(text).toContain("one parallel tool-call batch containing all 10");
    expect(text).toContain("repeated Codex shell bridge calls");
    expect(text).toContain("Codex Responses shell bridge");
    expect(text).toContain("external MCP server tool");
    expect(text).toContain("bridge may suspend");
    expect(text).toContain("Do not use `run_shell`");
    expect(text).toContain("Do not use `tool_search`, external MCP, or resource discovery just to pad the count");
    expect(text).toContain("neighboring-agent tools");
    expect(text).toContain("unless this turn's catalog lists those exact names");
    expect(text).not.toContain("Use the Codex shell bridge tool listed this turn");
    const roots = JSON.stringify(decodeRootMessages(bytes));
    expect(roots).toContain("available tool names are exactly `exec_command`");
    expect(roots).not.toContain("available tool names are exactly `exec_command`, `tool_search`");
  });

  test("keeps generic exec-only guidance on tool-result continuations", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: exec_command\nis_error: false\noutput:\ntool 1" }],
      rawMessages: [
        { role: "user", content: "tool use 10개해봐", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/composer-2.5",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: { cmd: "echo tool 1" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "tool 1", isError: false, timestamp: 3 },
      ],
      tools: [
        { name: "exec_command", description: "Run", parameters: {} },
        { name: "tool_search", description: "Discover", parameters: {} },
      ],
    });

    const roots = JSON.stringify(decodeRootMessages(bytes));
    expect(roots).toContain("available tool names are exactly `exec_command`");
    expect(roots).not.toContain("available tool names are exactly `exec_command`, `tool_search`");
  });

  test("does not add exec_command to non-command active user text", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "Tell me a short story about proxies." }],
      tools: [{
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    });

    expect(actionText(bytes)).toBe("Tell me a short story about proxies.");
  });

  test("encodeCursorRunRequest surfaces trailing tool result as current action text", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [
        { role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const action = run?.action?.action;

    expect(action?.case).toBe("userMessageAction");
    if (action?.case === "userMessageAction") {
      expect(action.value.userMessage?.text).toContain("[tool_result]");
      expect(action.value.userMessage?.text).toContain("call_id: call_1");
    }
  });

  test("native Cursor replay preserves tool calls with results in turn steps", () => {
    resetCursorCallIdProvenanceForTests();
    const local = encodeCursorCallId("ocxc1e_");
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/auto",
          timestamp: 2,
          content: [{ type: "toolCall", id: local, name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: local, toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const turnIds = run?.conversationState?.turns ?? [];
    expect(turnIds).toHaveLength(1);
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnIds[0]!));
    expect(turn.turn.case).toBe("agentConversationTurn");
    const steps = turn.turn.value.steps;
    expect(steps).toHaveLength(1);
    const step = fromBinary(ConversationStepSchema, blobData(steps[0]!));
    expect(step.message.case).toBe("toolCall");
    const tool = step.message.value.tool;
    expect(tool.case).toBe("mcpToolCall");
    if (tool.case === "mcpToolCall") {
      expect(tool.value.args?.toolCallId).toBe("ocxc1e_");
      expect(tool.value.result?.result.case).toBe("success");
      if (tool.value.result?.result.case === "success") {
        const content = tool.value.result.result.value.content[0]?.content;
        expect(content?.case).toBe("text");
        if (content?.case === "text") expect(content.value.text).toBe("contents");
      }
    }
    expect(run?.action?.action.case).toBe("userMessageAction");
    const value = run?.action?.action.case === "userMessageAction" ? run.action.action.value : undefined;
    expect(value?.userMessage?.text).toBe(CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT);
  });

  test("native protobuf replay leaves an opaque escape lookalike byte-identical", () => {
    resetCursorCallIdProvenanceForTests();
    const opaque = "ocxc1e_b2N4YzFf";
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c-opaque-call-id",
      system: [],
      messages: [{ role: "tool", content: "ignored" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/auto",
          timestamp: 2,
          content: [{ type: "toolCall", id: opaque, name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: opaque, toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(run!.conversationState!.turns[0]!));
    const step = fromBinary(ConversationStepSchema, blobData(turn.turn.value.steps[0]!));
    const tool = step.message.value.tool;

    expect(tool.value.args?.toolCallId).toBe(opaque);
  });

  test("composer-2.5 ordinary turns keep native replay semantics", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c-native-turn",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "follow up" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/composer-2.5",
          timestamp: 2,
          content: [
            { type: "thinking", thinking: "hidden reasoning" },
            { type: "text", text: "I'll read it" },
          ],
        },
        { role: "user", content: "follow up", timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(run?.conversationState?.turns[0] ?? new Uint8Array()));
    expect(turn.turn.case).toBe("agentConversationTurn");
    const steps = turn.turn.case === "agentConversationTurn" ? turn.turn.value.steps : [];
    expect(steps).toHaveLength(2);
    const firstStep = fromBinary(ConversationStepSchema, blobData(steps[0]!));
    const secondStep = fromBinary(ConversationStepSchema, blobData(steps[1]!));
    expect(firstStep.message.case).toBe("thinkingMessage");
    expect(secondStep.message.case).toBe("assistantMessage");
    expect(run?.action?.action.case).toBe("userMessageAction");
    const roots = decodeRootMessages(bytes) as Array<{ role?: string; content?: unknown }>;
    expect(JSON.stringify(roots)).toContain("hidden reasoning");
  });

  test("external Cursor replay uses text history instead of native tool/thinking structures", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/gpt-5.6-sol",
          timestamp: 2,
          content: [
            { type: "thinking", thinking: "hidden reasoning" },
            { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
          ],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(run?.conversationState?.turns[0] ?? new Uint8Array()));
    expect(turn.turn.case).toBe("agentConversationTurn");
    const steps = turn.turn.case === "agentConversationTurn" ? turn.turn.value.steps : [];
    expect(steps).toHaveLength(1);
    const roots = decodeRootMessages(bytes) as Array<{ role?: string; content?: unknown }>;
    const historicalUser = roots.find(root => root.role === "user");
    expect(historicalUser?.content).toEqual([{ type: "text", text: "read a file" }]);
    const toolResultRoot = roots.find(root => JSON.stringify(root).includes("[Tool Result]"));
    expect(toolResultRoot?.role).toBe("assistant");
    expect(run?.action?.action.case).toBe("userMessageAction");
    expect(JSON.stringify(roots)).toContain("contents");
    expect(JSON.stringify(roots)).not.toContain("hidden reasoning");
  });

  test("keeps ResumeAction for native-model tool-result continuations", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5-fast",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/composer-2.5-fast",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;

    expect(run?.action?.action.case).toBe("resumeAction");
    const roots = decodeRootMessages(bytes) as Array<{ role?: string; content?: unknown }>;
    const serialized = JSON.stringify(roots);
    expect(serialized).toContain("read a file");
    expect(serialized).not.toContain("[Tool Result]");
    expect(serialized).not.toContain("[tool_result]");
  });

  test("native Auto Intelligence omits assistant-role [Tool Result] root replay", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "auto-intelligence",
      conversationId: "c-auto-intel",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/auto-intelligence",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    expect(run?.action?.action.case).toBe("resumeAction");
    const roots = decodeRootMessages(bytes) as Array<{ role?: string; content?: unknown }>;
    const serialized = JSON.stringify(roots);
    expect(roots.some(root => root.role === "assistant")).toBe(false);
    expect(serialized).not.toContain("[Tool Result]");
    expect(serialized).not.toContain("[tool_result]");
    expect(serialized).toContain("read a file");
    const turnIds = run?.conversationState?.turns ?? [];
    expect(turnIds).toHaveLength(1);
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnIds[0]!));
    expect(turn.turn.case).toBe("agentConversationTurn");
    const steps = turn.turn.case === "agentConversationTurn" ? turn.turn.value.steps : [];
    expect(steps).toHaveLength(1);
    const step = fromBinary(ConversationStepSchema, blobData(steps[0]!));
    expect(step.message.case).toBe("toolCall");
  });

  test("drives composer-2.5 tool-result continuations as userMessageAction", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c-composer-cont",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/composer-2.5",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;

    expect(run?.action?.action.case).toBe("userMessageAction");
    const value = run?.action?.action.case === "userMessageAction" ? run.action.action.value : undefined;
    expect(value?.userMessage?.text).toBe(CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT);
    const roots = decodeRootMessages(bytes) as Array<{ role?: string }>;
    expect(JSON.stringify(roots)).toContain("contents");
  });

  test("drives external-model tool-result continuations as userMessageAction", () => {
    // External wire models encode tool-result hops as userMessageAction. Native
    // composer-2.5 uses the same path; other native composer ids keep resumeAction.
    const bytes = encodeCursorRunRequest({
      modelId: "claude-fable-5",
      conversationId: "c-ext-cont",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/claude-fable-5",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;

    expect(run?.action?.action.case).toBe("userMessageAction");
    const value = run?.action?.action.case === "userMessageAction" ? run.action.action.value : undefined;
    expect(value?.userMessage?.text).toBe(CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT);
    // Tool results are still replayed via history blobs.
    const roots = decodeRootMessages(bytes) as Array<{ role?: string }>;
    expect(JSON.stringify(roots)).toContain("contents");
  });
});

describe("Cursor AgentRunRequest.mcp_tools channel", () => {
  test("populates mcp_tools with the client tool defs for a normal prompt", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-luna-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "use node_repl to compute 1+1" }],
      tools: [{ name: "js", namespace: "mcp__node_repl", description: "Run JS", parameters: {} }],
    });
    expect(mcpToolNames(bytes)).toEqual(["mcp__node_repl__js"]);
  });

  test("mcp_tools respects the cursorToolsForActivePrompt filter (generic tool-count prompt -> exec only)", () => {
    // A generic tool-count-demo prompt narrows the visible client tools to bare exec_command.
    // mcp_tools MUST use the same filtered set as RequestContext.tools / the event-state names,
    // or a call to an extra advertised tool would be rejected as an unknown Responses tool.
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-luna-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "use any 3 tools" }],
      tools: [
        { name: "exec_command", description: "Run a command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
        { name: "js", namespace: "mcp__node_repl", description: "Run JS", parameters: {} },
      ],
    });
    expect(mcpToolNames(bytes)).toEqual(["exec_command"]);
  });

  test("mcp_tools keeps unified Desktop exec for a generic tool-use prompt", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-luna-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "use any 3 tools" }],
      tools: [
        {
          name: "exec",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
        { name: "wait", description: "Wait for a yielded cell", parameters: {} },
        { name: "js", namespace: "mcp__node_repl", description: "Run JS", parameters: {} },
      ],
    });
    expect(mcpToolNames(bytes)).toEqual(["exec"]);
  });

  test("leaves mcp_tools unset when tools are empty", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-luna-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(mcpToolNames(bytes)).toBeUndefined();
  });

  test("suppression flag serializes an explicitly empty mcp_tools wrapper", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-luna-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      suppressDefaultCursorToolCatalog: true,
    });
    expect(mcpToolNames(bytes)).toEqual([]);
  });

  test("leaves mcp_tools unset when toolChoice is none", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-luna-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "use node_repl" }],
      toolChoice: "none",
      tools: [{ name: "js", namespace: "mcp__node_repl", description: "Run JS", parameters: {} }],
    });
    expect(mcpToolNames(bytes)).toBeUndefined();
  });
});

// --- #373: the estimate must be derived from the payload that is actually sent,
// not from the original request — that was the defect that blocked PR #376. -------
describe("prepared request estimate (#373)", () => {
  const baseRequest = (overrides: Record<string, unknown> = {}) => ({
    modelId: "gpt-5.6-sol-xhigh",
    conversationId: "c-373",
    system: ["system prompt"],
    messages: [{ role: "user" as const, content: "current turn" }],
    rawMessages: [{ role: "user" as const, content: "current turn", timestamp: 1 }],
    ...overrides,
  });

  test("the estimate matches a recomputation from the bytes actually sent", () => {
    const prepared = prepareCursorRunRequest(baseRequest(), { estimateInputTokens: true });
    expect(prepared.estimatedInputTokens).toBeGreaterThan(0);

    // Re-derive from the wire: decoded root blobs + the action text the model sees.
    const roots = decodeRootMessages(prepared.bytes).map(root => JSON.stringify(root));
    const text = actionText(prepared.bytes) ?? "";
    const recomputed = estimateTokens([...roots, text].join("\n"), "gpt-5.6-sol-xhigh");

    expect(prepared.estimatedInputTokens).toBe(recomputed);
  });

  test("history dropped by the pruner does not inflate the estimate", () => {
    // Enough history that the oldest entries fall outside the root blob budget. Only
    // the very first pair is bloated, so anything that survives pruning is identical
    // between the two requests.
    const tail = Array.from({ length: 400 }, (_, i) => ([
      { role: "user" as const, content: `turn ${i} ${"x".repeat(400)}`, timestamp: i + 1 },
      { role: "assistant" as const, content: `reply ${i}`, timestamp: i + 1 },
    ])).flat();
    const withOldest = (oldest: string) => prepareCursorRunRequest(
      baseRequest({
        rawMessages: [
          { role: "user", content: oldest, timestamp: 0 },
          ...tail,
          { role: "user", content: "current turn", timestamp: 999 },
        ],
      }),
      { estimateInputTokens: true },
    );

    const small = withOldest("oldest entry");
    const bloated = withOldest(`oldest entry ${"z".repeat(50_000)}`);

    // The bloated entry is pruned away, so it must not move the estimate — the exact
    // failure mode that blocked PR #376 (estimating from the pre-pruning request).
    expect(decodeRootMessages(bloated.bytes).length).toBe(decodeRootMessages(small.bytes).length);
    expect(JSON.stringify(decodeRootMessages(bloated.bytes))).not.toContain("zzzz");
    expect(bloated.estimatedInputTokens).toBe(small.estimatedInputTokens);
  });

  test("no estimate is computed unless the caller asks for one", () => {
    expect(prepareCursorRunRequest(baseRequest()).estimatedInputTokens).toBeUndefined();
  });

  test("the estimate honors the shared CJK ratio clamp", () => {
    const korean = "한국어로 작성된 아주 긴 대화 내용입니다. ".repeat(60);
    const prepared = prepareCursorRunRequest(
      baseRequest({
        messages: [{ role: "user", content: korean }],
        rawMessages: [{ role: "user", content: korean, timestamp: 1 }],
      }),
      { estimateInputTokens: true },
    );

    const roots = decodeRootMessages(prepared.bytes).map(root => JSON.stringify(root));
    const text = actionText(prepared.bytes) ?? "";
    // A Cursor-local ratio override would diverge here and under-count Korean prompts.
    expect(prepared.estimatedInputTokens).toBe(
      estimateTokens([...roots, text].join("\n"), "gpt-5.6-sol-xhigh"),
    );
  });
});

describe("Cursor bounded blob store", () => {
  const bytes = (value: string) => new TextEncoder().encode(value);

  test("admits a local blob exactly at the per-blob byte boundary", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 4, maxTotalBytes: 8, maxEntries: 2 });
    const first = storeCursorBlob(bytes("1234"));
    const second = storeCursorBlob(bytes("5678"));
    expectBlobHit(first, bytes("1234"));
    expectBlobHit(second, bytes("5678"));
    expect(cursorBlobRetainedStoreSnapshot()).toMatchObject({ count: 2, bytes: 8 + 2 * 66 });
  });

  test("request construction one byte above the per-blob boundary fails before writing a request and returns no unstored hash", () => {
    const serialized = bytes(JSON.stringify({ role: "system", content: "x" }));
    setCursorBlobLimitsForTests({ maxEntryBytes: serialized.byteLength - 1, maxTotalBytes: 256 });
    expect(() => prepareCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "oversized",
      system: ["x"],
      messages: [{ role: "user", content: "hi" }],
    })).toThrow(CursorBlobAdmissionError);
    expect(cursorBlobRetainedStoreSnapshot()).toEqual({ count: 0, bytes: 0, evictableBytes: 0, pinnedBytes: 0, oldestAt: null });
  });

  test("request-scope pins preserve every advertised root turn and step until each distinct getBlob hydration completes", () => {
    const prepared = prepareCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "pins",
      system: ["system"],
      messages: [{ role: "user", content: "current" }],
      rawMessages: [
        { role: "user", content: "prior", timestamp: 1 },
        { role: "assistant", model: "cursor/composer-2.5", content: [{ type: "text", text: "answer" }], timestamp: 2 },
        { role: "user", content: "current", timestamp: 3 },
      ],
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    if (message.message.case !== "runRequest") throw new Error("expected runRequest");
    const roots = message.message.value.conversationState?.rootPromptMessagesJson ?? [];
    const turns = message.message.value.conversationState?.turns ?? [];
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBeGreaterThan(0);

    for (const root of roots) hydrateBlob(root, prepared.blobRequestScope);
    for (const turnId of turns) {
      const turn = fromBinary(ConversationTurnStructureSchema, hydrateBlob(turnId, prepared.blobRequestScope));
      if (turn.turn.case !== "agentConversationTurn") throw new Error("expected agent turn");
      hydrateBlob(turn.turn.value.userMessage, prepared.blobRequestScope);
      for (const step of turn.turn.value.steps) hydrateBlob(step, prepared.blobRequestScope);
    }
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(0);
  });

  test("two concurrent streams sharing one blob id release only their own request pin", () => {
    const data = bytes("shared");
    const firstScope = createCursorBlobRequestScope();
    const secondScope = createCursorBlobRequestScope();
    const id = storeCursorBlob(data, firstScope);
    storeCursorBlob(data, secondScope);
    sealCursorBlobRequestScope(firstScope);
    sealCursorBlobRequestScope(secondScope);
    expect(cursorBlobStoreDebugSnapshotForTests()[0]?.requestPins).toBe(2);
    expectBlobHit(id, data, firstScope);
    expect(cursorBlobStoreDebugSnapshotForTests()[0]?.requestPins).toBe(1);
    expectBlobHit(id, data, secondScope);
    expect(cursorBlobStoreDebugSnapshotForTests()[0]?.requestPins).toBe(0);
  });

  test("stream close error and abort release every remaining request-scope pin", () => {
    const scope = createCursorBlobRequestScope();
    storeCursorBlob(bytes("a"), scope);
    storeCursorBlob(bytes("b"), scope);
    sealCursorBlobRequestScope(scope);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(2 + 2 * 66);
    releaseCursorBlobRequestScope(scope);
    releaseCursorBlobRequestScope(scope);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(0);
  });

  test("external root pruning stores and pins only selected candidates and cannot fail from discarded history bytes", () => {
    const rawMessages = Array.from({ length: 210 }, (_, index) => index % 2 === 0
      ? { role: "user" as const, content: `user-${index}`, timestamp: index }
      : { role: "assistant" as const, model: "cursor/gpt-5.6-sol", content: [{ type: "text" as const, text: `assistant-${index}` }], timestamp: index });
    rawMessages.push({ role: "user", content: "active", timestamp: 999 });
    const discarded = bytes(JSON.stringify({ role: "user", content: [{ type: "text", text: "user-0" }] }));
    const discardedId = sha256(discarded);
    const prepared = prepareCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "selected-only",
      system: ["system"],
      messages: [{ role: "user", content: "active" }],
      rawMessages,
    });
    expectBlobMiss(discardedId);
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    if (message.message.case !== "runRequest") throw new Error("expected runRequest");
    const selected = message.message.value.conversationState?.rootPromptMessagesJson ?? [];
    expect(selected.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBeGreaterThan(0);
    // Payload-only counter: the snapshot's bytes include retained key strings,
    // but maxTotalBytes is a payload cap — using snapshot bytes here would hand
    // the repeated request unintended headroom.
    const selectedBytes = cursorBlobMetrics().totalBytes;
    releaseCursorBlobRequestScope(prepared.blobRequestScope);
    setCursorBlobLimitsForTests({ maxTotalBytes: selectedBytes, maxEntryBytes: 1024 * 1024 });
    expect(() => prepareCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "selected-only-repeat",
      system: ["system"],
      messages: [{ role: "user", content: "active" }],
      rawMessages,
    })).not.toThrow();
  });

  test("replacement subtracts old bytes and refreshes local LRU", () => {
    setCursorBlobLimitsForTests({ maxEntries: 2, maxEntryBytes: 8, maxTotalBytes: 8 });
    const a = storeCursorBlob(bytes("aaa"));
    const b = storeCursorBlob(bytes("bbb"));
    storeCursorBlob(bytes("aaa"));
    const c = storeCursorBlob(bytes("cccc"));
    expectBlobHit(a, bytes("aaa"));
    expectBlobMiss(b);
    expectBlobHit(c, bytes("cccc"));
    expect(cursorBlobRetainedStoreSnapshot().bytes).toBe(7 + 2 * 66);
  });

  test("aggregate admission evicts oldest local-regenerated blobs first", () => {
    setCursorBlobLimitsForTests({ maxEntries: 3, maxEntryBytes: 4, maxTotalBytes: 8 });
    const first = storeCursorBlob(bytes("1111"));
    const second = storeCursorBlob(bytes("2222"));
    const third = storeCursorBlob(bytes("3333"));
    expectBlobMiss(first);
    expectBlobHit(second, bytes("2222"));
    expectBlobHit(third, bytes("3333"));
    expect(cursorBlobRetainedStoreSnapshot().bytes).toBe(8 + 2 * 66);
  });

  test("remote setBlobArgs remains pinned within TTL while local blobs are evicted", () => {
    setCursorBlobLimitsForTests({ maxEntries: 3, maxEntryBytes: 3, maxTotalBytes: 6 });
    const remoteId = sha256(bytes("rem"));
    setBlobReply(remoteId, bytes("rem"));
    const local = storeCursorBlob(bytes("loc"));
    const newest = storeCursorBlob(bytes("new"));
    expectBlobHit(remoteId, bytes("rem"));
    expectBlobMiss(local);
    expectBlobHit(newest, bytes("new"));
  });

  test("expired remote setBlobArgs becomes evictable before aggregate admission", () => {
    setCursorBlobLimitsForTests({ ttlMs: 0, maxEntryBytes: 3, maxTotalBytes: 3 });
    const remoteId = sha256(bytes("rem"));
    setBlobReply(remoteId, bytes("rem"));
    storeCursorBlob(bytes("loc"));
    expectBlobMiss(remoteId);
    expect(cursorBlobRetainedStoreSnapshot()).toMatchObject({ count: 1, bytes: 3 + 66, evictableBytes: 3 + 66 });
    expect(cursorBlobStoreDebugSnapshotForTests()[0]?.provenance).toBe("local-regenerated");
  });

  test("expired remote setBlobArgs is the reported oldestAt victim and budget eviction removes it before a younger local row", () => {
    const originalNow = Date.now;
    let now = 100;
    Date.now = () => now;
    try {
      setCursorBlobLimitsForTests({ ttlMs: 10, maxEntryBytes: 3, maxTotalBytes: 6 });
      const scope = createCursorBlobRequestScope();
      const remoteId = sha256(bytes("rem"));
      setBlobReply(remoteId, bytes("rem"), 1, scope);
      sealCursorBlobRequestScope(scope);
      now = 111;
      const localId = storeCursorBlob(bytes("loc"));
      now = 112;
      releaseCursorBlobRequestScope(scope);
      const snapshot = cursorBlobRetainedStoreSnapshot();
      expect(snapshot).toMatchObject({ bytes: 6 + 2 * 66, evictableBytes: 6 + 2 * 66, pinnedBytes: 0, oldestAt: 100 });
      expect(evictOldestCursorBlobForBudget()).toBe(3 + 66);
      expectBlobMiss(remoteId);
      expectBlobHit(localId, bytes("loc"));
    } finally {
      Date.now = originalNow;
    }
  });

  test("pin release and remote TTL expiry trigger enforcement after class reconciliation", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    registerRetainedStore({
      id: "cursor_blobs",
      category: "blobs",
      snapshot: cursorBlobRetainedStoreSnapshot,
      evictOldest: evictOldestCursorBlobForBudget,
    });
    configureAppOwnedMemoryBudget(0);

    const hydratedScope = createCursorBlobRequestScope();
    const hydrated = storeCursorBlob(bytes("hydrate"), hydratedScope);
    sealCursorBlobRequestScope(hydratedScope);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(7 + 66);
    hydrateBlob(hydrated, hydratedScope);
    expect(cursorBlobRetainedStoreSnapshot().count).toBe(0);

    const releasedScope = createCursorBlobRequestScope();
    storeCursorBlob(bytes("release"), releasedScope);
    sealCursorBlobRequestScope(releasedScope);
    releaseCursorBlobRequestScope(releasedScope);
    expect(cursorBlobRetainedStoreSnapshot().count).toBe(0);

    const originalNow = Date.now;
    const timers: Array<() => void> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      timers.push(callback);
      return { unref() {} };
    }) as typeof setTimeout);
    Date.now = () => 100;
    try {
      setCursorBlobLimitsForTests({ ttlMs: 10 });
      setBlobReply(sha256(bytes("remote")), bytes("remote"));
      expect(cursorBlobRetainedStoreSnapshot()).toMatchObject({ count: 1, pinnedBytes: 6 + 66 });
      Date.now = () => 111;
      timers.at(-1)!();
      expect(cursorBlobRetainedStoreSnapshot().count).toBe(0);
    } finally {
      Date.now = originalNow;
      setTimeoutSpy.mockRestore();
      warning.mockRestore();
    }
  });

  test("pinned saturation returns typed SetBlobResult.error without exceeding aggregate bytes", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 3, maxTotalBytes: 3 });
    const scope = createCursorBlobRequestScope();
    storeCursorBlob(bytes("pin"), scope);
    sealCursorBlobRequestScope(scope);
    const rejectedId = sha256(bytes("new"));
    const reply = setBlobReply(rejectedId, bytes("new"), 77);
    expect(reply.message.case).toBe("kvClientMessage");
    if (reply.message.case !== "kvClientMessage") throw new Error("expected kvClientMessage");
    expect(reply.message.value.id).toBe(77);
    expect(reply.message.value.message.case).toBe("setBlobResult");
    if (reply.message.value.message.case !== "setBlobResult") throw new Error("expected setBlobResult");
    expect(reply.message.value.message.value.error?.message).toContain("capacity");
    expectBlobMiss(rejectedId, 78);
    expect(cursorBlobRetainedStoreSnapshot()).toMatchObject({ count: 1, bytes: 3 + 66, pinnedBytes: 3 + 66 });
  });

  test("getBlob hit preserves the request id includes blobData and releases that key's request pin", () => {
    const scope = createCursorBlobRequestScope();
    const id = storeCursorBlob(bytes("hit"), scope);
    sealCursorBlobRequestScope(scope);
    const hit = getBlobReply(id, 42, scope);
    expect(hit.message.case).toBe("kvClientMessage");
    if (hit.message.case !== "kvClientMessage") throw new Error("expected kvClientMessage");
    expect(hit.message.value.id).toBe(42);
    expect(hit.message.value.message.case).toBe("getBlobResult");
    if (hit.message.value.message.case !== "getBlobResult") throw new Error("expected getBlobResult");
    expect(hit.message.value.message.value.blobData).toBeDefined();
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(0);
  });

  test("getBlob miss preserves the request id and emits getBlobResult with blobData omitted", () => {
    expectBlobMiss(sha256(bytes("absent")), 43);
  });

  test("pinned-saturation get after rejected set uses the same omitted-blobData miss shape", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 3, maxTotalBytes: 3 });
    const scope = createCursorBlobRequestScope();
    storeCursorBlob(bytes("pin"), scope);
    sealCursorBlobRequestScope(scope);
    const rejectedId = sha256(bytes("new"));
    const setReply = setBlobReply(rejectedId, bytes("new"), 77);
    if (setReply.message.case !== "kvClientMessage" || setReply.message.value.message.case !== "setBlobResult") {
      throw new Error("expected setBlobResult");
    }
    expect(setReply.message.value.message.value.error).toBeDefined();
    expectBlobMiss(rejectedId, 78);
  });

  test("rejected same-key replacement preserves the admitted predecessor", () => {
    const scope = createCursorBlobRequestScope();
    const oldData = bytes("old");
    const id = storeCursorBlob(oldData, scope);
    sealCursorBlobRequestScope(scope);
    const before = cursorBlobStoreDebugSnapshotForTests();
    const rejected = setBlobReply(id, bytes("new"));
    if (rejected.message.case !== "kvClientMessage" || rejected.message.value.message.case !== "setBlobResult") throw new Error("expected set result");
    expect(rejected.message.value.message.value.error).toBeDefined();
    expect(cursorBlobStoreDebugSnapshotForTests()).toEqual(before);
    expectBlobHit(id, oldData, scope);
  });

  test("atomic pinned-saturation rejection preserves unrelated TTL candidates local victims recency pins counters and same-key predecessor byte-for-byte", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 9, maxTotalBytes: 12 });
    const scope = createCursorBlobRequestScope();
    const pinned = storeCursorBlob(bytes("pin!"), scope); // 4 bytes, request-pinned
    sealCursorBlobRequestScope(scope);
    const remote = sha256(bytes("rm"));
    setBlobReply(remote, bytes("rm")); // 2 bytes, live remote — 6/12 so far
    const localVictim = storeCursorBlob(bytes("lv!")); // 3 bytes, live UNPINNED local (LRU victim class)
    // Review C1-2: the rejected transaction must genuinely BUILD its victim
    // view — an expired TTL candidate, a live local-LRU victim, AND a growing
    // same-key predecessor —
    // and then roll back completely. The expired row is inserted LAST: any
    // successful insert commits its logical TTL removals, so an earlier
    // expired insert would already be gone before the probed rejection.
    const realNow = Date.now;
    let expired: Uint8Array;
    try {
      Date.now = () => realNow() - 20 * 60_000;
      expired = storeCursorBlob(bytes("exp")); // 3 bytes, expired under real clock
    } finally {
      Date.now = realNow;
    }
    const beforeRows = cursorBlobStoreDebugSnapshotForTests();
    const beforeStore = cursorBlobRetainedStoreSnapshot();
    const beforeMetrics = cursorBlobMetrics();
    // Growing same-key replacement (2 → 9 bytes, in-range per-entry): the
    // logical victim view must select the expired row (3) AND the live local
    // victim (3): 12-3-3-2+9 = 13 > 12 with only pinned mass left —
    // pinned_saturation, typed wire error, and BOTH selected victims plus the
    // predecessor must survive the rollback untouched.
    const rejected = setBlobReply(remote, bytes("remremrem"));
    if (rejected.message.case !== "kvClientMessage" || rejected.message.value.message.case !== "setBlobResult") {
      throw new Error("expected set result");
    }
    expect(rejected.message.value.message.value.error).toBeDefined();
    const afterRows = cursorBlobStoreDebugSnapshotForTests();
    const afterStore = cursorBlobRetainedStoreSnapshot();
    const afterMetrics = cursorBlobMetrics();
    // Complete deep comparison: content digests, exact pin identity (unique
    // per-scope tokens), provenance, sizes, recency — byte-for-byte identical,
    // including the expired TTL candidate (NOT committed-removed) and the
    // same-key predecessor (2-byte original preserved).
    expect(afterRows).toEqual(beforeRows);
    expect(afterStore).toEqual(beforeStore);
    // The ONLY permitted delta is the intentional rejection counter.
    expect(afterMetrics).toEqual({
      ...beforeMetrics,
      rejectedPinnedSaturation: beforeMetrics.rejectedPinnedSaturation + 1,
    });
    expectBlobHit(pinned, bytes("pin!"), scope);
    expectBlobHit(remote, bytes("rm"));
    expectBlobHit(localVictim, bytes("lv!"));
    const expiredKey = `h:${Buffer.from(expired).toString("hex")}`;
    expect(cursorBlobStoreDebugSnapshotForTests().some(row => row.key === expiredKey)).toBe(true);
  });

  test("pinned-saturation rejection with an in-range entry preserves complete state including the expired candidate", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 4, maxTotalBytes: 9 });
    const scope = createCursorBlobRequestScope();
    storeCursorBlob(bytes("pin"), scope);
    sealCursorBlobRequestScope(scope);
    // Fill remaining budget with pinned rows so saturation is provable even
    // after logical TTL removal of the expired row.
    const scope2 = createCursorBlobRequestScope();
    storeCursorBlob(bytes("pn2"), scope2);
    sealCursorBlobRequestScope(scope2);
    // Insert the expired candidate LAST: any successful insert commits its
    // logical TTL removals, so an earlier-inserted expired row would already
    // be gone before the rejected transaction we are probing.
    const realNow = Date.now;
    let expired: Uint8Array;
    try {
      Date.now = () => realNow() - 20 * 60_000;
      expired = storeCursorBlob(bytes("exp"));
    } finally {
      Date.now = realNow;
    }
    const beforeRows = cursorBlobStoreDebugSnapshotForTests();
    const beforeMetrics = cursorBlobMetrics();
    // 4-byte insert: even after logical TTL removal of the 3-byte expired row,
    // pinned rows (3+3) + 4 = 10 > 9 — pinned saturation with the expired
    // candidate genuinely in the victim view.
    expect(() => storeCursorBlob(bytes("nw44"))).toThrow(CursorBlobAdmissionError);
    expect(cursorBlobStoreDebugSnapshotForTests()).toEqual(beforeRows);
    expect(cursorBlobMetrics()).toEqual({
      ...beforeMetrics,
      rejectedPinnedSaturation: beforeMetrics.rejectedPinnedSaturation + 1,
    });
    // The expired row was in the LOGICAL victim view but must not have been
    // committed-removed by the failed transaction.
    const expiredKey = `h:${Buffer.from(expired).toString("hex")}`;
    expect(cursorBlobStoreDebugSnapshotForTests().some(row => row.key === expiredKey)).toBe(true);
  });

  test("a released scope token attached after final hydration cannot create a permanent pin", () => {
    // Review C1-1: after the last advertised blob hydrates, the sealed scope's
    // state is deleted; a late setBlobArgs carrying that stale token must not
    // attach an untracked pin that survives terminal release.
    const scope = createCursorBlobRequestScope();
    const advertised = storeCursorBlob(bytes("adv"), scope);
    sealCursorBlobRequestScope(scope);
    // Hydrate the only advertised key — the scope auto-releases.
    getBlobReply(advertised, 1, scope);
    // Late remote set carrying the stale token.
    const late = sha256(bytes("lat"));
    setBlobReply(late, bytes("lat"), 1, scope);
    const lateKey = `h:${Buffer.from(late).toString("hex")}`;
    const rows = cursorBlobStoreDebugSnapshotForTests();
    const lateRow = rows.find(row => row.key === lateKey);
    expect(lateRow).toBeDefined();
    expect(lateRow!.requestPins).toBe(0);
    // Terminal release is a no-op; the blob must remain TTL/budget-evictable.
    releaseCursorBlobRequestScope(scope);
    expect(cursorBlobStoreDebugSnapshotForTests().find(row => row.key === lateKey)!.requestPins).toBe(0);
  });

  test("one request whose construction crosses the aggregate cap fails coherently instead of emitting IDs evicted earlier in that request", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 1_024, maxTotalBytes: 150 });
    expect(() => prepareCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "aggregate-request",
      system: ["a".repeat(40), "b".repeat(40), "c".repeat(40)],
      messages: [{ role: "user", content: "hi" }],
    })).toThrow(CursorBlobAdmissionError);
    const snapshot = cursorBlobRetainedStoreSnapshot();
    // The payload cap is what the admission contract bounds; the framework-
    // facing snapshot bytes additionally include the fixed key strings.
    expect(cursorBlobMetrics().totalBytes).toBeLessThanOrEqual(150);
    expect(snapshot.pinnedBytes).toBe(0);
  });

  test("cross-provenance refresh keeps or upgrades remote protection", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 3, maxTotalBytes: 6 });
    const remoteData = bytes("rem");
    const remoteId = sha256(remoteData);
    setBlobReply(remoteId, remoteData);
    storeCursorBlob(remoteData); // remote -> local refresh must not downgrade
    const localVictim = storeCursorBlob(bytes("loc"));
    storeCursorBlob(bytes("new"));
    expectBlobHit(remoteId, remoteData);
    expectBlobMiss(localVictim);

    setCursorBlobLimitsForTests({ maxEntryBytes: 3, maxTotalBytes: 6 });
    const upgradedData = bytes("upg");
    const upgradedId = storeCursorBlob(upgradedData);
    setBlobReply(upgradedId, upgradedData); // local -> remote upgrade
    const secondVictim = storeCursorBlob(bytes("old"));
    storeCursorBlob(bytes("new"));
    expectBlobHit(upgradedId, upgradedData);
    expectBlobMiss(secondVictim);
  });

  test("remote-to-local same-key refresh keeps remote provenance and its TTL clock", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      setCursorBlobLimitsForTests({ ttlMs: 10, maxEntryBytes: 3, maxTotalBytes: 6 });
      const data = bytes("rem");
      const id = sha256(data);
      setBlobReply(id, data);
      now = 1_005;
      storeCursorBlob(data);
      expect(cursorBlobStoreDebugSnapshotForTests()[0]).toMatchObject({
        provenance: "remote-setBlobArgs",
        storedAt: 1_000,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("local-to-remote same-key refresh upgrades to the stronger remote provenance", () => {
    const data = bytes("upg");
    const id = storeCursorBlob(data);
    setBlobReply(id, data);
    expect(cursorBlobStoreDebugSnapshotForTests()[0]?.provenance).toBe("remote-setBlobArgs");
  });

  test("blob metrics remain observe-only and exact after reset replacement and eviction", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 8, maxTotalBytes: 16 });
    const first = storeCursorBlob(bytes("one"));
    storeCursorBlob(bytes("two2"));
    storeCursorBlob(bytes("one"));
    const before = cursorBlobRetainedStoreSnapshot();
    expect(cursorBlobRetainedStoreSnapshot()).toEqual(before);
    expect(cursorBlobMetrics()).toMatchObject({ count: 2, totalBytes: 7, localBytes: 7, pinnedBytes: 0 });
    const released = evictOldestCursorBlobForBudget();
    expect(released).toBe(4 + 66);
    expectBlobHit(first, bytes("one"));
    expect(cursorBlobRetainedStoreSnapshot().bytes).toBe(3 + 66);
    resetCursorBlobStateForTests();
    expect(cursorBlobMetrics()).toMatchObject({ count: 0, totalBytes: 0, localBytes: 0, pinnedBytes: 0 });
  });
});

describe("Cursor blob ID key channel bounds", () => {
  test("conforming 32-byte IDs keep their hex passthrough", () => {
    const blobId = sha256(new TextEncoder().encode("payload"));
    setBlobReply(blobId, new TextEncoder().encode("payload"));
    const keys = cursorBlobStoreDebugSnapshotForTests().map(entry => entry.key);
    expect(keys).toEqual([`h:${Buffer.from(blobId).toString("hex")}`]);
    expect(cursorBlobMetrics().keyBytes).toBe(66);
  });

  test("a multi-MiB remote ID becomes a fixed-size digest key and still round-trips", () => {
    const hugeId = new Uint8Array(1024 * 1024).fill(7);
    hugeId[0] = 1;
    const data = new TextEncoder().encode("blob-content");
    setBlobReply(hugeId, data);
    const snapshot = cursorBlobStoreDebugSnapshotForTests();
    expect(snapshot).toHaveLength(1);
    // Fixed digest key — the raw 1 MiB ID is never retained as a key.
    expect(snapshot[0]!.key).toMatch(/^d:[0-9a-f]{64}$/);
    expect(cursorBlobMetrics().keyBytes).toBe(66);
    // Symmetric derivation: the same huge ID fetches the data back.
    expect([...blobData(hugeId)]).toEqual([...data]);
  });

  test("the passthrough/digest boundary sits at 64 raw bytes", () => {
    const id64 = new Uint8Array(64).fill(3);
    const id65 = new Uint8Array(65).fill(4);
    setBlobReply(id64, new TextEncoder().encode("a"));
    setBlobReply(id65, new TextEncoder().encode("b"));
    const keys = cursorBlobStoreDebugSnapshotForTests().map(entry => entry.key).sort();
    expect(keys).toContain(`h:${Buffer.from(id64).toString("hex")}`);
    expect(keys).toContain(`d:${Buffer.from(sha256(id65)).toString("hex")}`);
    expect([...blobData(id64)]).toEqual([...new TextEncoder().encode("a")]);
    expect([...blobData(id65)]).toEqual([...new TextEncoder().encode("b")]);
  });

  test("aggregate key bytes stay bounded across oversized-ID admissions", () => {
    for (let index = 0; index < 32; index++) {
      const hugeId = new Uint8Array(256 * 1024).fill(index + 1);
      setBlobReply(hugeId, new TextEncoder().encode(`blob-${index}`));
    }
    const metrics = cursorBlobMetrics();
    expect(metrics.count).toBe(32);
    // 32 entries x fixed 66-char digest keys — never 32 x 512 KiB of hex.
    expect(metrics.keyBytes).toBe(32 * 66);
    // Payload accounting is untouched by the key channel.
    expect(metrics.totalBytes).toBeGreaterThan(0);
  });

  test("a digested long ID never collides with a raw ID equal to that digest", () => {
    const longId = new Uint8Array(256).fill(9);
    const digestAsRawId = sha256(longId); // 32 bytes — a conforming raw ID
    setBlobReply(longId, new TextEncoder().encode("long-payload"));
    setBlobReply(digestAsRawId, new TextEncoder().encode("raw32-payload"));
    // Domain-separated keys: two DISTINCT entries, no silent replacement.
    expect(cursorBlobMetrics().count).toBe(2);
    expect([...blobData(longId)]).toEqual([...new TextEncoder().encode("long-payload")]);
    expect([...blobData(digestAsRawId)]).toEqual([...new TextEncoder().encode("raw32-payload")]);
  });

  test("key bytes pair with entry deletion on replacement, eviction, and reset", () => {
    // Local-regenerated entries are budget-evictable; remote ones are TTL-protected.
    const id = storeCursorBlob(new TextEncoder().encode("one"));
    expect(cursorBlobMetrics().keyBytes).toBe(66);
    // Same-content re-store replaces in place: still exactly one key's worth.
    storeCursorBlob(new TextEncoder().encode("one"));
    expect(cursorBlobMetrics().keyBytes).toBe(66);
    // Budget eviction removes the entry AND its key bytes.
    expect(evictOldestCursorBlobForBudget()).toBe(3 + 66);
    expect(cursorBlobMetrics().keyBytes).toBe(0);
    storeCursorBlob(new TextEncoder().encode("three"));
    resetCursorBlobStateForTests();
    expect(cursorBlobMetrics().keyBytes).toBe(0);
  });

  test("key bytes stay bounded at the 4096-entry ceiling", () => {
    for (let index = 0; index < 4096; index++) {
      const id = new Uint8Array(65);
      new DataView(id.buffer).setUint32(61, index, false);
      setBlobReply(id, new TextEncoder().encode("v"));
    }
    const metrics = cursorBlobMetrics();
    expect(metrics.count).toBe(4096);
    // Fixed digest keys at full capacity: 4096 x 66 = 270,336 — never GiBs of hex.
    expect(metrics.keyBytes).toBe(4096 * 66);
    // Entry 4097 must be rejected typed, leaving count and keys unchanged.
    const extraId = new Uint8Array(65).fill(0xaa);
    const reply = setBlobReply(extraId, new TextEncoder().encode("overflow"));
    const kv = reply.message.value;
    expect(kv.message.case).toBe("setBlobResult");
    const result = kv.message.value as { error?: { message?: string } };
    expect(result.error?.message).toBeDefined();
    expect(cursorBlobMetrics().count).toBe(4096);
    expect(cursorBlobMetrics().keyBytes).toBe(4096 * 66);
  }, { timeout: 30_000 });

  test("a zero-payload blob stays evictable through its key bytes", () => {
    storeCursorBlob(new Uint8Array());
    const snapshot = cursorBlobRetainedStoreSnapshot();
    expect(snapshot.bytes).toBe(66);
    // The budget can SELECT the reclaimable entry: its key classifies with it.
    expect(snapshot.evictableBytes).toBe(66);
    expect(snapshot.pinnedBytes).toBe(0);
    expect(evictOldestCursorBlobForBudget()).toBe(66);
    expect(cursorBlobRetainedStoreSnapshot().bytes).toBe(0);
  });
});

describe("Cursor checkpoint request construction", () => {
  test("uses decoded ConversationStateStructure and skips historical root replay", () => {
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [new Uint8Array(32).fill(7)],
      turns: [new Uint8Array(32).fill(8)],
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt",
      system: ["You are helpful."],
      messages: [
        { role: "user", content: "old user" },
        { role: "assistant", content: "old assistant" },
        { role: "user", content: "new user" },
      ],
      rawMessages: [
        { role: "user", content: "old user", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }], timestamp: 2 },
        { role: "user", content: "new user", timestamp: 3 },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    expect(Array.from(run?.conversationState?.rootPromptMessagesJson[0] ?? [])).toEqual(Array.from({ length: 32 }, () => 7));
    expect(Array.from(run?.conversationState?.turns[0] ?? [])).toEqual(Array.from({ length: 32 }, () => 8));
    expect(run?.action?.action.case).toBe("userMessageAction");
  });

  test("invalid checkpoint bytes fall back to full replay", () => {
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "hello" }],
      rawMessages: [{ role: "user", content: "hello", timestamp: 1 }],
      checkpointBytes: new Uint8Array([1, 2, 3, 4]),
    });
    const roots = decodeRootMessages(prepared.bytes);
    const fullReplay = decodeRootMessages(prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "hello" }],
      rawMessages: [{ role: "user", content: "hello", timestamp: 1 }],
    }).bytes);
    expect(roots).toEqual(fullReplay);
  });

  test("checkpoint suffix replay appends only uncovered history", () => {
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [new Uint8Array(32).fill(7)],
      turns: [new Uint8Array(32).fill(8)],
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages: [
        { role: "user", content: "old user", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }], timestamp: 2 },
        { role: "user", content: "please read", timestamp: 3 },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: "FILE CONTENTS HERE",
          isError: false,
          timestamp: 4,
        },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 2,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    expect(Array.from(roots[0] ?? [])).toEqual(Array.from({ length: 32 }, () => 7));
    expect(roots.length).toBeGreaterThan(1);
    const suffix = roots.slice(1).map(id => JSON.parse(new TextDecoder().decode(blobData(id))) as { content?: unknown });
    const serialized = JSON.stringify(suffix);
    expect(serialized).toContain("FILE CONTENTS HERE");
    expect(serialized).not.toContain("old user");
  });

  /**
   * The blocker-8 regression guard. Full replay must never emit a tool result without the turn
   * that caused it, but a CHECKPOINT suffix legitimately can: `checkpointSuffixStart` is the
   * count of messages the checkpoint already carries, so the initiating turn is inside it.
   *
   * Slicing at 3 makes the suffix exactly `[toolResult]`. Applying the full-replay rule here
   * would pull the covered user turn back in and replay it twice.
   */
  test("a checkpoint suffix may legitimately begin with a tool result", () => {
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [new Uint8Array(32).fill(7)],
      turns: [new Uint8Array(32).fill(8)],
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt_result_only",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages: [
        { role: "user", content: "old user", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }], timestamp: 2 },
        { role: "user", content: "please read the file", timestamp: 3 },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: "SUFFIX ONLY CONTENTS",
          isError: false,
          timestamp: 4,
        },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 3,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];

    // The checkpoint's own root is preserved and the suffix is appended after it.
    expect(Array.from(roots[0] ?? [])).toEqual(Array.from({ length: 32 }, () => 7));
    const suffix = roots.slice(1).map(id => new TextDecoder().decode(blobData(id)));
    const serialized = JSON.stringify(suffix);
    expect(serialized).toContain("SUFFIX ONLY CONTENTS");

    // The covered turn stays covered: pulling it back in would replay it a second time.
    expect(serialized).not.toContain("please read the file");
    // And no synthetic system root is re-appended on top of the checkpoint's own.
    expect(suffix.some(root => root.includes('"role":"system"'))).toBe(false);
  });

  test("active checkpoint lease keeps referenced blobs after request pin release", () => {
    clearCursorCheckpointsForTests();
    const data = new TextEncoder().encode('{"role":"system","content":"lease-me"}');
    const scope = createCursorBlobRequestScope();
    const blobId = storeCursorBlob(data, scope);
    sealCursorBlobRequestScope(scope);
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [blobId],
    }));
    const ref = commitCursorCheckpoint({
      conversationId: "cursor_lease",
      identityScope: "acct",
      modelId: "grok-4.6",
      checkpointBytes,
    });
    expect(ref).toBeDefined();
    releaseCursorBlobRequestScope(scope);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBeGreaterThan(0);
    expect(evictOldestCursorBlobForBudget()).toBe(0);
    expectBlobHit(blobId, data);
    invalidateCursorCheckpoint(ref);
    expect(evictOldestCursorBlobForBudget()).toBeGreaterThan(0);
    clearCursorCheckpointsForTests();
  });

  test("missing checkpoint blobs fail closed instead of committing a lease", () => {
    clearCursorCheckpointsForTests();
    const missingId = new Uint8Array(32).fill(11);
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [missingId],
    }));
    const ref = commitCursorCheckpoint({
      conversationId: "cursor_missing_blob",
      identityScope: "acct",
      modelId: "grok-4.6",
      checkpointBytes,
    });
    expect(ref).toBeUndefined();
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(0);
    clearCursorCheckpointsForTests();
  });

  test("getBlob hydration does not release an active checkpoint lease", () => {
    clearCursorCheckpointsForTests();
    const data = new TextEncoder().encode('{"role":"system","content":"keep-me"}');
    const requestScope = createCursorBlobRequestScope();
    const blobId = storeCursorBlob(data, requestScope);
    sealCursorBlobRequestScope(requestScope);
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [blobId],
    }));
    const ref = commitCursorCheckpoint({
      conversationId: "cursor_hydrate",
      identityScope: "acct",
      modelId: "grok-4.6",
      checkpointBytes,
    });
    expect(ref).toBeDefined();
    releaseCursorBlobRequestScope(requestScope);
    const hydrateScope = createCursorBlobRequestScope();
    expectBlobHit(blobId, data, hydrateScope);
    releaseCursorBlobRequestScope(hydrateScope);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBeGreaterThan(0);
    expect(evictOldestCursorBlobForBudget()).toBe(0);
    invalidateCursorCheckpoint(ref);
    clearCursorCheckpointsForTests();
  });

  test("checkpoint suffix replay does not re-append the system prompt", () => {
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [new Uint8Array(32).fill(7)],
      turns: [new Uint8Array(32).fill(8)],
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages: [
        { role: "user", content: "old user", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }], timestamp: 2 },
        { role: "user", content: "please read", timestamp: 3 },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: "FILE CONTENTS HERE",
          isError: false,
          timestamp: 4,
        },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 2,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    const suffix = roots.slice(1).map(id => JSON.parse(new TextDecoder().decode(blobData(id))) as { content?: unknown });
    const serialized = JSON.stringify(suffix);
    expect(serialized).not.toContain("You are helpful.");
    expect(serialized).toContain("FILE CONTENTS HERE");
  });
});

describe("Cursor checkpoint idle TTL", () => {
  afterEach(() => {
    clearCursorCheckpointsForTests();
    resetCursorBlobStateForTests();
  });

  test("releases expired checkpoint leases without another request", () => {
    let now = 1_000;
    let scheduled: (() => void) | undefined;
    installCursorCheckpointClockForTests({
      now: () => now,
      schedule: fn => {
        scheduled = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear: () => {
        scheduled = undefined;
      },
    });
    const requestScope = createCursorBlobRequestScope();
    const data = new TextEncoder().encode('{"role":"system","content":"ttl-lease"}');
    const blobId = storeCursorBlob(data, requestScope);
    sealCursorBlobRequestScope(requestScope);
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [blobId],
    }));
    expect(commitCursorCheckpoint({
      conversationId: "cursor_ttl",
      identityScope: "acct-1",
      modelId: "grok-4.6",
      checkpointBytes,
    })).toBeDefined();
    releaseCursorBlobRequestScope(requestScope);
    expect(cursorCheckpointStoreMetricsForTests().count).toBe(1);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBeGreaterThan(0);
    expect(scheduled).toBeTypeOf("function");
    now += CURSOR_CHECKPOINT_TTL_MS + 1;
    scheduled?.();
    expect(cursorCheckpointStoreMetricsForTests().count).toBe(0);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(0);
  });
});

/**
 * #1527 envelope enforcement. The 192-root / 512-KiB limits existed but were applied to the
 * pruned history only, so three shapes escaped them entirely. Each of these reproduced a real
 * over-envelope request before the guard moved to the final assembled root set.
 */
describe("Cursor external replay envelope", () => {
  test("system roots alone cannot exceed the root count limit", () => {
    // 193 system prompts: the history budget is zero, so the pruning branch had nothing to
    // trim and emitted every system root.
    const system = Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT + 1 }, (_, i) => `system-${i}`);

    let thrown: unknown;
    try {
      encodeCursorRunRequest({
        modelId: "gpt-5.6-sol-xhigh",
        conversationId: "c-sys-count",
        system,
        messages: [{ role: "user", content: "hi" }],
        rawMessages: [{ role: "user", content: "hi", timestamp: 1 }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CursorRootEnvelopeLimitError);
    const limit = thrown as CursorRootEnvelopeLimitError;
    expect(limit.name).toBe("CursorRootEnvelopeLimitError");
    expect(limit.code).toBe("cursor_root_envelope_limit");
    expect(limit.status).toBe(400);
    expect(limit.rootCount).toBeGreaterThan(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    expect(limit.maxRootCount).toBe(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    expect(limit.maxRootBytes).toBe(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    // A local, deterministic rejection: replaying it reproduces it.
    expect(isRetryableCursorError(limit)).toBe(false);
  });

  test("a single oversized system root cannot exceed the byte limit", () => {
    const oversized = "s".repeat(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT + 100_000);

    let thrown: unknown;
    try {
      encodeCursorRunRequest({
        modelId: "gpt-5.6-sol-xhigh",
        conversationId: "c-sys-bytes",
        system: [oversized],
        messages: [{ role: "user", content: "hi" }],
        rawMessages: [{ role: "user", content: "hi", timestamp: 1 }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CursorRootEnvelopeLimitError);
    expect((thrown as CursorRootEnvelopeLimitError).rootBytes).toBeGreaterThan(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
  });

  // The early return at the top of `rootPromptMessages` skips the pruning branch entirely when
  // there is no history, so a guard placed inside that branch never saw this shape.
  test("the empty-history path is bounded too", () => {
    const system = Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT + 1 }, (_, i) => `only-system-${i}`);

    expect(() => encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-no-history",
      system,
      messages: [{ role: "user", content: "hi" }],
      rawMessages: [],
    })).toThrow(CursorRootEnvelopeLimitError);
  });

  // Contiguous trailing results were byte-pruned but never count-pruned, so 193 small results
  // sailed past the history limit that only checked `keptPrior`.
  test("a long contiguous tool-result block cannot exceed the root count limit", () => {
    const results = Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT + 1 }, (_, i) => ({
      role: "toolResult" as const,
      toolCallId: `call_${i}`,
      toolName: "read_file",
      content: `r${i}`,
      isError: false,
      timestamp: i + 2,
    }));

    let thrown: unknown;
    try {
      encodeCursorRunRequest({
        modelId: "gpt-5.6-sol-xhigh",
        conversationId: "c-many-results",
        system: ["system"],
        messages: [{ role: "tool", content: "ignored" }],
        rawMessages: [{ role: "user", content: "go", timestamp: 1 }, ...results],
      });
    } catch (error) {
      thrown = error;
    }

    // Either bounded within the envelope, or rejected — never silently shortened past the cap.
    if (thrown) {
      expect(thrown).toBeInstanceOf(CursorRootEnvelopeLimitError);
    } else {
      const bytes = encodeCursorRunRequest({
        modelId: "gpt-5.6-sol-xhigh",
        conversationId: "c-many-results-2",
        system: ["system"],
        messages: [{ role: "tool", content: "ignored" }],
        rawMessages: [{ role: "user", content: "go", timestamp: 1 }, ...results],
      });
      expect(decodeRootMessages(bytes).length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    }
  });

  test("a native model is not subject to the external envelope", () => {
    const system = Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT + 1 }, (_, i) => `system-${i}`);

    expect(() => encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c-native",
      system,
      messages: [{ role: "user", content: "hi" }],
      rawMessages: [{ role: "user", content: "hi", timestamp: 1 }],
    })).not.toThrow();
  });

  // Review probe: 191 small trailing results plus one system root already fill the count limit, so
  // the initiator did not fit and the earlier single-result-only recovery branch never ran. The
  // request then went out as bare results with nothing asking for them — and at exactly 192 roots
  // the envelope guard could not catch it either. Recovery must make room, not give up.
  test("a multi-result orphan block still recovers its initiating turn", () => {
    const results = Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 1 }, (_, i) => ({
      role: "toolResult" as const,
      toolCallId: `call_${i}`,
      toolName: "read_file",
      content: `r${i}`,
      isError: false,
      timestamp: i + 2,
    }));

    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-orphan-multi",
      system: ["system"],
      messages: [{ role: "tool", content: "ignored" }],
      rawMessages: [{ role: "user", content: "please read the files", timestamp: 1 }, ...results],
    });

    const roots = decodeRootMessages(bytes);
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    // The initiating instruction must survive: a model handed only tool results has nothing to do.
    const serialized = JSON.stringify(roots);
    expect(serialized).toContain("please read the files");
    // And it must come first, so the results read as answers to it rather than as an orphan block.
    const nonSystem = roots.slice(1);
    expect(JSON.stringify(nonSystem[0])).toContain("please read the files");
  });

  // Review probe, reproduced: three ~220 KB results used to emit only the last two — `call_0`
  // disappeared while its tool call stayed in the transcript, which is exactly the pairing break
  // #1527 describes. Every result must survive in some form, even a truncated one.
  test("oversized parallel tool results are all retained, truncated rather than deleted", () => {
    const results = [0, 1, 2].map(i => ({
      role: "toolResult" as const,
      toolCallId: `call_${i}`,
      toolName: "read_file",
      content: `UNIQUE_MARKER_${i} ` + "x".repeat(220_000),
      isError: false,
      timestamp: i + 3,
    }));

    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-parallel-results",
      system: ["system"],
      messages: [{ role: "tool", content: "ignored" }],
      rawMessages: [
        { role: "user", content: "read all three", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/gpt-5.6-sol",
          content: [0, 1, 2].map(i => ({
            type: "toolCall" as const,
            id: `call_${i}`,
            name: "read_file",
            arguments: { path: `f${i}.txt` },
          })),
          timestamp: 2,
        },
        ...results,
      ],
    });

    const serialized = JSON.stringify(decodeRootMessages(bytes));
    // Each result is present, identifiable by its own marker. None was silently deleted.
    expect(serialized).toContain("UNIQUE_MARKER_0");
    expect(serialized).toContain("UNIQUE_MARKER_1");
    expect(serialized).toContain("UNIQUE_MARKER_2");
    // And the whole set still fits the envelope, so retention did not come at the cost of the bound.
    expect(serialized).toContain("truncated for Cursor external replay budget");
  });

  // The shape the guard was moved for. Review noted that every other new fixture here is an
  // oversized full replay, so a guard that measured only the suffix (or only
  // `rootPromptMessagesState`) would still satisfy them. These two do not: the suffix is tiny and
  // legal on its own, and only the checkpoint plus the suffix crosses a limit.
  //
  // These two asserted a THROW until devlog 260829 070 (audit r8 finding 3). The throw was reachable
  // because suffix pruning measured only its own slice, so it happily produced a suffix that was
  // individually legal and cumulatively fatal — a non-retryable 400 on a long conversation. Pruning now
  // subtracts the checkpoint's own roots, and a checkpoint with no room left for the suffix is abandoned
  // for a full replay. The invariant is what matters and it is now stronger: the assembled request stays
  // inside the envelope. Asserting the throw would pin the old mechanism, so these assert the bound.
  test("a checkpoint plus a legal suffix stays inside the root count limit cumulatively", () => {
    const checkpointRoots = Array.from(
      { length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT },
      (_, i) => new Uint8Array(32).fill(i % 251),
    );
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: checkpointRoots,
      turns: [new Uint8Array(32).fill(8)],
    });

    const prepared = prepareCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-ckpt-cumulative",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "next" }],
      rawMessages: [
        { role: "user", content: "old user", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }], timestamp: 2 },
        { role: "user", content: "mid user", timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "mid assistant" }], timestamp: 4 },
        { role: "user", content: "next", timestamp: 5 },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      checkpointSuffixStart: 2,
      continuationMode: "checkpoint",
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    // Abandoned rather than pruned-to-fit: a full replay carries the whole conversation, so the
    // uncovered messages are present instead of silently dropped.
    const serialized = JSON.stringify(roots.map(id => JSON.parse(new TextDecoder().decode(blobData(id)))));
    expect(serialized).toContain("mid user");
  });

  test("a checkpoint plus a legal suffix stays inside the byte limit cumulatively", () => {
    // Roots the local store actually holds, so their bytes are measurable: a suffix-only or
    // `rootPromptMessagesState`-only measurement reports far less than the assembled total.
    const big = new Uint8Array(200_000).fill(65);
    const checkpointRoots = [storeCursorBlob(big), storeCursorBlob(new Uint8Array(200_000).fill(66)), storeCursorBlob(new Uint8Array(200_000).fill(67))];
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: checkpointRoots,
      turns: [new Uint8Array(32).fill(8)],
    });

    const prepared = prepareCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c-ckpt-bytes",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "next" }],
      rawMessages: [
        { role: "user", content: "old user", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }], timestamp: 2 },
        { role: "user", content: "mid user", timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "mid assistant" }], timestamp: 4 },
        { role: "user", content: "next", timestamp: 5 },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      checkpointSuffixStart: 2,
      continuationMode: "checkpoint",
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    const measured = roots.reduce((sum, id) => sum + (cursorBlobByteLength(id) ?? 0), 0);
    expect(measured).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    // The 600 KB of checkpoint roots is gone, not merely trimmed: an exhausted checkpoint is dropped.
    expect(roots.length).toBeLessThan(checkpointRoots.length + 5);
  });

  // The diagnostic used to read `rootPromptMessagesState?.byteLength`, which is undefined for a
  // pure checkpoint continuation — so an operator sizing a conversation that was about to be
  // rejected saw rootBytes=0. The guard and the telemetry now read the same measurement, and a
  // root the local store never held is disclosed as `unmeasuredRoots` rather than silently
  // making the total look small.
  /**
   * Audit r8 re-review finding D. The two rewritten envelope tests above both exit through the ABANDON
   * branch — the count case uses unmeasurable checkpoint roots, the byte case a checkpoint large enough to
   * trip abandonment — so neither exercises the `carriedRoots` subtraction that pruning depends on.
   * Deleting that subtraction reintroduced every throw the fix removed while the whole suite stayed green.
   *
   * This case is built to discriminate: MEASURABLE checkpoint roots, a count just under the limit so
   * abandonment does not fire, and a suffix that only fits if pruning knows what the checkpoint spends.
   */
  test("suffix pruning respects the roots the checkpoint already spends", () => {
    const carried = CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 3;
    const checkpointRoots = Array.from(
      { length: carried },
      (_, i) => storeCursorBlob(new TextEncoder().encode(JSON.stringify({ role: "user", content: [{ type: "text", text: `covered ${i}` }] }))),
    );
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: checkpointRoots,
      turns: [new Uint8Array(32).fill(8)],
    });
    const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
      { role: "user", content: "Run each step once.", timestamp: 1 },
    ];
    let timestamp = 2;
    for (let n = 1; n <= 6; n++) {
      rawMessages!.push({
        role: "assistant",
        content: [
          { type: "text", text: `Running STEP${n}.` },
          { type: "toolCall", id: `call_${n}`, name: "exec_command", arguments: { cmd: `echo STEP${n}` } },
        ],
        timestamp: timestamp++,
      });
      rawMessages!.push({
        role: "toolResult",
        toolCallId: `call_${n}`,
        toolName: "exec_command",
        content: `STEP${n}`,
        isError: false,
        timestamp: timestamp++,
      });
    }
    // Without the subtraction this throws CursorRootEnvelopeLimitError: the suffix is legal on its own and
    // fatal once assembled. The assertion is that it does not throw AND stays inside the bound.
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt_carried_measurable",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages,
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    // The checkpoint was kept, not abandoned: this is the pruning path, not the fallback path.
    expect(roots.length).toBeGreaterThan(carried);
  });

  /**
   * Audit r9. The case above and the byte-pressure cases cross COUNT pressure with a SEQUENTIAL suffix
   * only, where the trailing tool-result run is always length 1 — the single width at which the abandon
   * test's `carriedRoots.count + suffixSystemCount` happens to predict the suffix exactly. A parallel
   * tool-call batch makes that run wider than 1, and nothing bounded it: `historyLimit` was consulted by
   * the prior-history loop alone, and `truncateToolResultBlob` shrinks a result without ever freeing a
   * root slot. Measured at the head this test was added to: 190 carried roots plus a 3-result batch
   * assembled 193 roots, 188 carried plus 8 assembled 196, and each threw a NON-RETRYABLE 400 — the exact
   * failure this unit exists to remove, and reachable by ordinary conversation growth rather than a
   * crafted fixture. All 188 tests passed with and without the production fix before this case existed.
   */
  test.each([
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 2, 3],
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 4, 8],
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 22, 25],
  ])("a count-pressured parallel result batch stays inside the envelope (carried=%i, results=%i)", (carried, batch) => {
    const checkpointRoots = Array.from(
      { length: carried },
      (_, i) => storeCursorBlob(new TextEncoder().encode(JSON.stringify({ role: "user", content: [{ type: "text", text: `covered ${i}` }] }))),
    );
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: checkpointRoots,
      turns: [new Uint8Array(32).fill(8)],
    });
    const calls: OcxAssistantContentPart[] = Array.from({ length: batch }, (_, i) => ({
      type: "toolCall",
      id: `call_par_${i}`,
      name: "exec_command",
      arguments: { cmd: `echo P${i}` },
    }));
    const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
      { role: "user", content: "Run every step once.", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Running every step." }, ...calls], timestamp: 2 },
    ];
    for (let i = 0; i < batch; i++) {
      rawMessages!.push({
        role: "toolResult",
        toolCallId: `call_par_${i}`,
        toolName: "exec_command",
        content: `PARALLEL_OUT_${i}`,
        isError: false,
        timestamp: 3 + i,
      });
    }
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: `cursor_ckpt_count_parallel_${carried}_${batch}`,
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages,
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    // The envelope bound is the whole point: over it, Cursor answers 400 and the retry path fails closed.
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    // And the newest result still has to reach the model, whether the checkpoint was kept or abandoned —
    // staying inside the envelope by sending nothing useful is the other half of this defect.
    const texts = roots.map(id => {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(blobData(id))) as { content?: string | [{ text?: string }] };
        const content = parsed.content;
        return typeof content === "string" ? content : (content?.[0]?.text ?? "");
      } catch {
        return "";
      }
    });
    expect(texts.some(text => text.includes(`PARALLEL_OUT_${batch - 1}`))).toBe(true);
  });

  /**
   * Audit r10. The count bound added for r9 acts in ROOT space; the abandon check derived its trailing run
   * from `rawMessages`. The two disagree exactly when an assistant message emits no root — a bare tool call
   * with no narration, which is the most common assistant shape in this file's own fixtures. Two
   * sequentially-executed results then sit adjacent as roots, both enter the trailing run, the count bound
   * drops the older one, and a raw-space scan that sees a run of one never notices: the request went out
   * with a tool call answered by nothing, checkpoint retained, no throw, no diagnostic. Measured at 190
   * carried roots with bare-call pairs, the first answer vanished from the wire entirely — not in a root, not
   * in `turns[]`.
   *
   * Two defects, and this case covers both. The drop was also UNNECESSARY: `historyLimit` subtracted
   * `systemEntryCount` on a path where the caller appends only history roots and the checkpoint's own
   * system roots are already inside `carriedRoots`, so the limit came out 1 where 2 results fit.
   */
  test.each([
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 2, 2],
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 2, 4],
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 3, 3],
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 6, 8],
  ])("a bare-tool-call continuation never answers a call with nothing (carried=%i, pairs=%i)", (carried, pairs) => {
    const checkpointRoots = Array.from(
      { length: carried },
      (_, i) => storeCursorBlob(new TextEncoder().encode(JSON.stringify({ role: "user", content: [{ type: "text", text: `covered ${i}` }] }))),
    );
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: checkpointRoots,
      turns: [new Uint8Array(32).fill(8)],
    });
    const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
      { role: "user", content: "Read each file once.", timestamp: 1 },
    ];
    let timestamp = 2;
    for (let n = 0; n < pairs; n++) {
      // No text part: this assistant message emits no root, which is what puts the two results next to
      // each other in root space while raw space still separates them.
      rawMessages!.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call_bare_${n}`, name: "read_file", arguments: { path: `f${n}.txt` } }],
        timestamp: timestamp++,
      });
      rawMessages!.push({
        role: "toolResult",
        toolCallId: `call_bare_${n}`,
        toolName: "read_file",
        content: `BARE_ANSWER_${n}`,
        isError: false,
        timestamp: timestamp++,
      });
    }
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: `cursor_ckpt_bare_call_${carried}_${pairs}`,
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages,
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    const texts = roots.map(id => {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(blobData(id))) as { content?: string | [{ text?: string }] };
        const content = parsed.content;
        return typeof content === "string" ? content : (content?.[0]?.text ?? "");
      } catch {
        return "";
      }
    });
    // Either the checkpoint was abandoned and the full replay carries every answer, or it was kept and every
    // replayed call still has its own. What must never happen is a kept checkpoint missing an answer: the
    // model then sees a call with no result and re-issues it, which is the defect this whole unit exists to
    // remove. A per-pair assertion states that without having to know which branch was taken.
    for (let n = 0; n < pairs; n++) {
      expect(texts.some(text => text.includes(`BARE_ANSWER_${n}`))).toBe(true);
    }
  });

  /**
   * Audit r10, second half. The silent-loss assertion above passes either way — with the double charge the
   * checkpoint is abandoned and the full replay carries every answer, which is correct output reached
   * wastefully. This case pins the arithmetic instead: with exactly as many free slots as results, the
   * checkpoint must be KEPT and every slot used. `historyLimit` subtracted `systemEntryCount` on a path
   * where the caller appends only `ids.slice(suffixSystemCount)` and the checkpoint's own system roots are
   * already inside `carriedRoots.count`, so one genuinely free slot was paid for twice: the limit came out 1
   * where 2 results fit, and a fully answerable continuation was thrown away.
   */
  test("a checkpoint continuation uses every root slot the envelope actually leaves free", () => {
    const carried = CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 2;
    const checkpointRoots = Array.from(
      { length: carried },
      (_, i) => storeCursorBlob(new TextEncoder().encode(JSON.stringify({ role: "user", content: [{ type: "text", text: `covered ${i}` }] }))),
    );
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: checkpointRoots,
      turns: [new Uint8Array(32).fill(8)],
    });
    const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
      { role: "user", content: "Read each file once.", timestamp: 1 },
    ];
    let timestamp = 2;
    for (let n = 0; n < 2; n++) {
      rawMessages!.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call_fit_${n}`, name: "read_file", arguments: { path: `fit${n}.txt` } }],
        timestamp: timestamp++,
      });
      rawMessages!.push({
        role: "toolResult",
        toolCallId: `call_fit_${n}`,
        toolName: "read_file",
        content: `FIT_ANSWER_${n}`,
        isError: false,
        timestamp: timestamp++,
      });
    }
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt_exact_fit",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages,
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    // Two results, two free slots, and the checkpoint retained: exactly the envelope, not one short of it.
    expect(roots.length).toBe(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    expect(roots.length).toBeGreaterThan(carried);
  });

  /**
   * Audit r11. The repetition breaker appends a synthetic `[context note]` user root AFTER the transcript,
   * standing for no message and therefore carrying no `messageIndex`. The trailing-result walk tested only
   * for `role === "toolResult"`, so it stopped dead on that note: the trailing run came out EMPTY, the
   * results lost their trailing-run status entirely and were pruned as ordinary history with no "keep at
   * least one" floor, and the empty `activeMessageIndexes` sent the abandon check back to the raw-message
   * scan that r10 exists to avoid. Measured: at 186 carried roots the note-armed shape was RETAINED while
   * the identical shape without the note correctly abandoned.
   *
   * The note arms on three consecutive identical assistant narrations — the runaway-repetition shape this
   * whole unit exists to end — so the input most likely to trigger it is the one the fix is for.
   *
   * Asserted as an A/B against the same pressure, because the defect is a DIVERGENCE: whatever the no-note
   * shape does, the note must not change whether a call keeps its answer, and the note itself must survive.
   */
  test("a repetition note does not cost the trailing results their answers", () => {
    const carried = CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 6;
    const pairs = 8;
    const build = (withNote: boolean) => {
      const checkpointRoots = Array.from(
        { length: carried },
        (_, i) => storeCursorBlob(new TextEncoder().encode(JSON.stringify({ role: "user", content: [{ type: "text", text: `covered ${i}` }] }))),
      );
      const checkpoint = create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: checkpointRoots,
        turns: [new Uint8Array(32).fill(8)],
      });
      const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
        { role: "user", content: "Work through the plan.", timestamp: 1 },
      ];
      let timestamp = 2;
      if (withNote) {
        // Three consecutive identical narrations with no root between them: this is what arms the breaker.
        for (let r = 0; r < 4; r++) {
          rawMessages!.push({ role: "assistant", content: [{ type: "text", text: "Still working on it." }], timestamp: timestamp++ });
        }
      }
      for (let n = 0; n < pairs; n++) {
        rawMessages!.push({
          role: "assistant",
          content: [{ type: "toolCall", id: `call_note_${n}`, name: "exec_command", arguments: { cmd: `echo N${n}` } }],
          timestamp: timestamp++,
        });
        rawMessages!.push({
          role: "toolResult",
          toolCallId: `call_note_${n}`,
          toolName: "exec_command",
          content: `NOTE_OUT_${String(n).padStart(3, "0")}`,
          isError: false,
          timestamp: timestamp++,
        });
      }
      const prepared = prepareCursorRunRequest({
        modelId: "grok-4.6",
        conversationId: `cursor_ckpt_repetition_note_${withNote}`,
        system: ["You are helpful."],
        messages: [{ role: "tool", content: "result" }],
        rawMessages,
        checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
        continuationMode: "checkpoint",
        checkpointSuffixStart: 1,
      });
      const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
      const run = message.message.case === "runRequest" ? message.message.value : undefined;
      const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
      const texts = roots.map(id => {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(blobData(id))) as { content?: string | [{ text?: string }] };
          const content = parsed.content;
          return typeof content === "string" ? content : (content?.[0]?.text ?? "");
        } catch {
          return "";
        }
      });
      const blob = texts.join("\n");
      return {
        roots: roots.length,
        kept: roots.length > carried,
        note: blob.includes("[context note]"),
        answered: Array.from({ length: pairs }, (_, n) => blob.includes(`NOTE_OUT_${String(n).padStart(3, "0")}`)),
      };
    };
    const plain = build(false);
    const noted = build(true);
    expect(noted.roots).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    // The note reached the model: excluding it from the trailing-result walk must not drop it.
    expect(noted.note).toBe(true);
    // Every replayed call still has its answer, and the note did not change which calls those are.
    expect(noted.answered).toEqual(plain.answered);
    expect(noted.answered.every(Boolean)).toBe(true);
    // And the note did not flip a coherent full replay into a retained checkpoint.
    expect(noted.kept).toBe(plain.kept);
  });

  /**
   * Audit r11, second half. Excluding the repetition note from the trailing-result walk means it is
   * re-appended after pruning, so its root slot has to be PAID FOR during pruning — the same mistake the
   * count budget already made once, one root further along. Left uncharged, a note-armed continuation under
   * count pressure assembles past the envelope and throws the non-retryable 400: measured at 188-190 carried
   * roots for sequential and parallel suffixes alike.
   *
   * The note-armed A/B case above cannot catch this — it uses byte-free small results and lands below the
   * count cliff — which is why the charge needs its own case at the boundary.
   */
  test.each([
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 4, 3, false],
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 3, 2, false],
    [CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 4, 4, true],
  ])("a repetition note is paid for out of the envelope, not added to it (carried=%i, results=%i, parallel=%s)", (carried, results, parallel) => {
    const checkpointRoots = Array.from(
      { length: carried },
      (_, i) => storeCursorBlob(new TextEncoder().encode(JSON.stringify({ role: "user", content: [{ type: "text", text: `covered ${i}` }] }))),
    );
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: checkpointRoots,
      turns: [new Uint8Array(32).fill(8)],
    });
    const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
      { role: "user", content: "Work through the plan.", timestamp: 1 },
    ];
    let timestamp = 2;
    for (let r = 0; r < 4; r++) {
      rawMessages!.push({ role: "assistant", content: [{ type: "text", text: "Same line again." }], timestamp: timestamp++ });
    }
    if (parallel) {
      const calls: OcxAssistantContentPart[] = Array.from({ length: results }, (_, i) => ({
        type: "toolCall",
        id: `call_np_${i}`,
        name: "exec_command",
        arguments: { cmd: `echo NP${i}` },
      }));
      rawMessages!.push({ role: "assistant", content: calls, timestamp: timestamp++ });
      for (let i = 0; i < results; i++) {
        rawMessages!.push({ role: "toolResult", toolCallId: `call_np_${i}`, toolName: "exec_command", content: `NP_OUT_${i}`, isError: false, timestamp: timestamp++ });
      }
    } else {
      for (let i = 0; i < results; i++) {
        rawMessages!.push({
          role: "assistant",
          content: [{ type: "toolCall", id: `call_ns_${i}`, name: "exec_command", arguments: { cmd: `echo NS${i}` } }],
          timestamp: timestamp++,
        });
        rawMessages!.push({ role: "toolResult", toolCallId: `call_ns_${i}`, toolName: "exec_command", content: `NS_OUT_${i}`, isError: false, timestamp: timestamp++ });
      }
    }
    // Throwing here is the failure: the envelope error is a non-retryable 400 at the provider.
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: `cursor_ckpt_note_budget_${carried}_${results}_${parallel}`,
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages,
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
  });

  /**
   * Audit r12. The note's BYTE reservation had no coverage at all: neutralizing every byte charge in one
   * edit left the whole suite green, while a sweep against that same mutation produced 148
   * `CursorRootEnvelopeLimitError` throws. Two distinct failures live here, and this case is built to
   * catch both.
   *
   * The reservation must exist: the note is appended after pruning, so a budget that does not deduct it
   * assembles past `CURSOR_EXTERNAL_ROOT_BYTE_LIMIT` and 400s non-retryably.
   *
   * And it must be deducted BEFORE the equal-share division, not after. Dividing the gross budget by
   * `active.length` produces shares summing to the whole budget, so adding the note back always exceeds
   * it: the shrink-toward-equal-share pass becomes structurally unfittable and control falls through to
   * the loop that deletes a whole result. 246 bytes of note cost an entire 200 KB answer that way, and
   * with a single large result the recovery block dropped it outright — the model received a 193-byte
   * instruction to change strategy and no tool output whatsoever, which is precisely the re-execution
   * loop this unit exists to end.
   *
   * Asserted as an A/B on the note alone, because the defect is a divergence: arming it must not cost an
   * answer, and must not push the request out of the envelope.
   */
  test.each([
    [1, 600_000],
    [3, 200_000],
    [4, 130_000],
  ])("an armed repetition note costs no answer and no envelope room (results=%i, bytes=%i)", (results, resultBytes) => {
    const build = (armed: boolean) => {
      const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
        { role: "user", content: "Run the plan and report.", timestamp: 1 },
      ];
      let timestamp = 2;
      // Three consecutive identical narrations arm the breaker; two do not. Nothing else differs.
      for (let r = 0; r < (armed ? 3 : 2); r++) {
        rawMessages!.push({ role: "assistant", content: [{ type: "text", text: "Same line." }], timestamp: timestamp++ });
      }
      for (let i = 0; i < results; i++) {
        rawMessages!.push({
          role: "assistant",
          content: [{ type: "toolCall", id: `call_byte_${i}`, name: "exec_command", arguments: { cmd: `echo B${i}` } }],
          timestamp: timestamp++,
        });
        rawMessages!.push({
          role: "toolResult",
          toolCallId: `call_byte_${i}`,
          toolName: "exec_command",
          content: `BYTE_OUT_${i}_` + "y".repeat(resultBytes),
          isError: false,
          timestamp: timestamp++,
        });
      }
      const prepared = prepareCursorRunRequest({
        modelId: "grok-4.6",
        conversationId: `cursor_note_bytes_${results}_${resultBytes}_${armed}`,
        system: ["You are helpful."],
        messages: [{ role: "tool", content: "result" }],
        rawMessages,
      });
      const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
      const run = message.message.case === "runRequest" ? message.message.value : undefined;
      const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
      let bytes = 0;
      const texts = roots.map(id => {
        const data = blobData(id);
        bytes += data.byteLength;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(data)) as { content?: string | [{ text?: string }] };
          const content = parsed.content;
          return typeof content === "string" ? content : (content?.[0]?.text ?? "");
        } catch {
          return "";
        }
      });
      const blob = texts.join("\n");
      return {
        bytes,
        note: blob.includes("[context note]"),
        answered: Array.from({ length: results }, (_, i) => blob.includes(`BYTE_OUT_${i}_`)),
      };
    };
    const plain = build(false);
    const armed = build(true);
    // The note reached the model, and paid for itself: still inside the byte envelope.
    expect(armed.note).toBe(true);
    expect(plain.note).toBe(false);
    expect(armed.bytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    // Every answer the un-armed request carried is still there. A truncated answer counts; a deleted one
    // does not, which is the distinction the equal-share pass exists to make.
    expect(armed.answered).toEqual(plain.answered);
    expect(armed.answered.every(Boolean)).toBe(true);
  });

  /**
   * Audit r13. The note's reservation is a subtraction clamped at zero, so it cannot represent a DEFICIT:
   * when the note costs more than the budget has left, `Math.max(0, …)` reported "the note costs nothing"
   * and the tail was appended anyway. An envelope with 26 bytes free emitted a 246-byte note and overran
   * by 220, throwing the non-retryable 400 this unit exists to remove.
   *
   * Every fixture in this file is a tool continuation, and a trailing tool result HIDES this: the abandon
   * check's survival disjuncts rescue that shape. The exposed shape is a turn that does not end in a
   * result — an ordinary user interjection after a repetitive stretch — where nothing else bounds the
   * tail. Measured 13 of 42 carried-byte positions throwing with the note armed and none without it.
   *
   * The note is dropped when it cannot be paid for, which is this unit's priority order: a missing
   * instruction is recoverable, a missing tool result restarts the loop.
   */
  test.each([0, 100, 220, 400])("an unaffordable repetition note is dropped, not sent past the envelope (deficit=%i)", deficit => {
    const build = (armed: boolean) => {
      const checkpoint = create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [storeCursorBlob(new Uint8Array(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT - deficit).fill(65))],
        turns: [new Uint8Array(32).fill(8)],
      });
      const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
        { role: "user", content: "Go.", timestamp: 1 },
      ];
      let timestamp = 2;
      for (let r = 0; r < (armed ? 4 : 2); r++) {
        rawMessages!.push({ role: "assistant", content: [{ type: "text", text: "Same." }], timestamp: timestamp++ });
      }
      rawMessages!.push({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_deficit", name: "exec_command", arguments: { cmd: "echo D" } }],
        timestamp: timestamp++,
      });
      rawMessages!.push({
        role: "toolResult",
        toolCallId: "call_deficit",
        toolName: "exec_command",
        content: "DEFICIT_OUT",
        isError: false,
        timestamp: timestamp++,
      });
      // The shape the suite never had: the turn ends with a plain user message, so the abandon check's
      // result-survival disjuncts cannot fire and nothing else bounds the appended note.
      rawMessages!.push({ role: "user", content: "Actually, try something else.", timestamp: timestamp++ });
      const prepared = prepareCursorRunRequest({
        modelId: "grok-4.6",
        conversationId: `cursor_note_deficit_${deficit}_${armed}`,
        system: ["Be brief."],
        messages: [{ role: "user", content: "next" }],
        rawMessages,
        checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
        continuationMode: "checkpoint",
        checkpointSuffixStart: 1,
      });
      const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
      const run = message.message.case === "runRequest" ? message.message.value : undefined;
      const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
      const bytes = roots.reduce((sum, id) => sum + blobData(id).byteLength, 0);
      return { roots: roots.length, bytes };
    };
    // Arming the note must not push the request past the envelope, and must not throw at all: the guard
    // raises a 400 the caller cannot retry.
    const armed = build(true);
    expect(armed.bytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    expect(armed.roots).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    // And the un-armed request is unaffected, so the bound is the note's cost rather than a blanket cut.
    const plain = build(false);
    expect(plain.bytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
  });

  /**
   * Audit r14. Two things the deficit case above cannot see, both proven by mutation to be real.
   *
   * The count axis. Affordability was briefly decided on bytes alone, on the reasoning that the count bound
   * always leaves a slot free — wrong at exactly `historyLimit === 1`, where the one free slot is the one
   * the surviving result takes. The note was then appended anyway and full replay assembled 193 roots: an
   * armed-only non-retryable 400 where the same request without the note sent 192 and succeeded. Reached by
   * full replay with many system prompts, which has no abandon branch to rescue it — not by carried roots,
   * which is why a checkpoint-path sweep missed it.
   *
   * And the reservation itself, as distinct from the append. Neutralizing `syntheticCount`/`syntheticBytes`
   * while leaving the append gated left the whole suite green, because asserting on the assembled payload
   * cannot distinguish "the deficit was charged" from "the tail was simply not appended". Asserting the
   * exact root count at the boundary does: with the reservation the result is admitted and the note is
   * dropped, giving 192; without it the reservation is a no-op and pruning admits one root too few.
   */
  test.each([
    ["result" as const, 1],
    ["result" as const, 3],
    ["user" as const, 1],
    ["user" as const, 3],
  ])("an armed note never spends a root slot it was not given (tail=%s, results=%i)", (tail, results) => {
    // 191 system roots leaves exactly one free slot out of 192: the result takes it, so the note cannot fit.
    const systemCount = CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 1;
    const build = (armed: boolean) => {
      const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
        { role: "user", content: "Go.", timestamp: 1 },
      ];
      let timestamp = 2;
      for (let r = 0; r < (armed ? 4 : 2); r++) {
        rawMessages!.push({ role: "assistant", content: [{ type: "text", text: "Same." }], timestamp: timestamp++ });
      }
      const calls: OcxAssistantContentPart[] = Array.from({ length: results }, (_, i) => ({
        type: "toolCall",
        id: `call_slot_${i}`,
        name: "exec_command",
        arguments: { cmd: `echo S${i}` },
      }));
      rawMessages!.push({ role: "assistant", content: calls, timestamp: timestamp++ });
      for (let i = 0; i < results; i++) {
        rawMessages!.push({ role: "toolResult", toolCallId: `call_slot_${i}`, toolName: "exec_command", content: `SLOT_OUT_${i}`, isError: false, timestamp: timestamp++ });
      }
      if (tail === "user") rawMessages!.push({ role: "user", content: "Try something else.", timestamp: timestamp++ });
      // Full replay on purpose: there is no abandon branch here, so nothing rescues an overrun.
      const prepared = prepareCursorRunRequest({
        modelId: "grok-4.6",
        conversationId: `cursor_note_slot_${tail}_${results}_${armed}`,
        system: Array.from({ length: systemCount }, (_, i) => `S${i}`),
        messages: [{ role: tail === "user" ? "user" : "tool", content: "result" }],
        rawMessages,
      });
      const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
      const run = message.message.case === "runRequest" ? message.message.value : undefined;
      return (run?.conversationState?.rootPromptMessagesJson ?? []).length;
    };
    // Arming the note must not throw and must not cost a slot: exactly the envelope, same as un-armed.
    expect(build(true)).toBe(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    expect(build(false)).toBe(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
  });

  /**
   * Audit r15. The case above pins the affordability threshold from the loose side only: relaxing it
   * reddens, but TIGHTENING `historyLimit - syntheticCountRaw >= 1` to `>= 2` left all 212 tests green.
   * Over-conservative is safer than over-eager, but this unit has already dropped a guard as inert and had
   * to restore it, so a suite that cannot tell a correct bound from an unnecessarily strict one is exactly
   * the gap that cost round 14.
   *
   * Two free slots is the tight case: the result takes one, the note takes the other, and both must arrive.
   */
  test("a note that exactly fits the last free slot is kept, not dropped", () => {
    // 190 system roots leaves two free slots out of 192: one for the result, one for the note.
    const systemCount = CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 2;
    const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
      { role: "user", content: "Go.", timestamp: 1 },
    ];
    let timestamp = 2;
    for (let r = 0; r < 4; r++) {
      rawMessages!.push({ role: "assistant", content: [{ type: "text", text: "Same." }], timestamp: timestamp++ });
    }
    rawMessages!.push({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_exact", name: "exec_command", arguments: { cmd: "echo E" } }],
      timestamp: timestamp++,
    });
    rawMessages!.push({
      role: "toolResult",
      toolCallId: "call_exact",
      toolName: "exec_command",
      content: "EXACT_FIT_OUT",
      isError: false,
      timestamp: timestamp++,
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_note_exact_fit",
      system: Array.from({ length: systemCount }, (_, i) => `S${i}`),
      messages: [{ role: "tool", content: "result" }],
      rawMessages,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    const blob = roots.map(id => {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(blobData(id))) as { content?: string | [{ text?: string }] };
        const content = parsed.content;
        return typeof content === "string" ? content : (content?.[0]?.text ?? "");
      } catch {
        return "";
      }
    }).join("\n");
    expect(roots.length).toBe(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    // Both arrive. Dropping either one at an exact fit is a defect in a different direction.
    expect(blob).toContain("EXACT_FIT_OUT");
    expect(blob).toContain("[context note]");
  });

  /**
   * Audit r10 finding 2. `outputElided` on the marker-only return had no coverage: removing the flag left
   * all 191 tests green, and `tests/` is not typechecked (`tsconfig` include is `["src"]`), so nothing would
   * have caught its removal. A result reduced to the truncation marker answers its call with nothing, which
   * is why the abandon decision reads the flag — so assert the abandonment, not the flag.
   */
  test("a result truncated to the bare marker abandons the checkpoint instead of answering with nothing", () => {
    // A checkpoint that consumes nearly the whole byte budget leaves room for a marker and no output.
    const carriedBytes = CURSOR_EXTERNAL_ROOT_BYTE_LIMIT - 400;
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [storeCursorBlob(new Uint8Array(carriedBytes).fill(65))],
      turns: [new Uint8Array(32).fill(8)],
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt_marker_only",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages: [
        { role: "user", content: "Read the file.", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_marker", name: "read_file", arguments: { path: "big.txt" } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_marker",
          toolName: "read_file",
          content: "MARKER_ONLY_PAYLOAD".repeat(4096),
          isError: false,
          timestamp: 3,
        },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    // Abandoned: the oversized carried root is gone, so the reply is a self-contained full replay.
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    const texts = roots.map(id => {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(blobData(id))) as { content?: string | [{ text?: string }] };
        const content = parsed.content;
        return typeof content === "string" ? content : (content?.[0]?.text ?? "");
      } catch {
        return "";
      }
    });
    // The replay carries the call's own output, not a marker standing in for it.
    expect(texts.some(text => text.includes("MARKER_ONLY_PAYLOAD"))).toBe(true);
  });

  /**
   * Audit r8 re-review finding B. The abandon test compared `carriedRoots.byteLength` against the raw byte
   * limit while pruning subtracts the system prompt too, so a ~128-byte band just under the limit kept the
   * checkpoint, gave the suffix a zero budget, and dropped the tool result the model was waiting for —
   * silently, where the old code at least threw.
   */
  test("a checkpoint just under the byte limit still lets the latest result through", () => {
    const systemPrompt = "You are helpful.";
    // Land inside the old gap: below the limit, but not far enough below to leave the suffix any room once
    // the system prompt is paid for.
    const carriedBytes = CURSOR_EXTERNAL_ROOT_BYTE_LIMIT - 200;
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [storeCursorBlob(new Uint8Array(carriedBytes).fill(65))],
      turns: [new Uint8Array(32).fill(8)],
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt_byte_band",
      system: [systemPrompt],
      messages: [{ role: "tool", content: "result" }],
      rawMessages: [
        { role: "user", content: "Run it.", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running." },
            { type: "toolCall", id: "call_band", name: "exec_command", arguments: { cmd: "echo BAND" } },
          ],
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "call_band", toolName: "exec_command", content: "BAND-OUTPUT", isError: false, timestamp: 3 },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    const serialized = JSON.stringify(roots.map(id => {
      const data = cursorBlobByteLength(id) === null ? undefined : blobData(id);
      return data ? JSON.parse(new TextDecoder().decode(data)) : null;
    }));
    // The whole point: whatever the pruning decides, the result the model is waiting on must be visible.
    expect(serialized).toContain("BAND-OUTPUT");
    const measured = roots.reduce((sum, id) => sum + (cursorBlobByteLength(id) ?? 0), 0);
    expect(measured).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
  });

  /**
   * Audit r8 round 3, BLOCKER. The result-survival check asks whether the replayed result root survived
   * pruning. A native resume model never HAS one: its result travels in server-side turn state, so
   * `echoToolResultInRoot` is false and `rootPromptMessages` skips the root entirely. Unguarded, the check
   * answered "no" on every native continuation and discarded the checkpoint 100% of the time — including
   * `cursor/auto`, the default id.
   *
   * That is not cosmetic. `pendingToolCalls`, `readPaths` and `previousWorkspaceUris` exist only inside the
   * checkpoint, and a full replay does not rebuild them, so the accumulated state was simply lost.
   */
  test("a native model keeps its checkpoint through a tool continuation", () => {
    // Model class CROSSED with narration shape. Round 3 fixed the narrated shape and round 4 found the
    // silent one still broken, because a bare tool call produces no assistant root either — so the suffix
    // has zero history roots and a different disjunct of the same condition fired. Testing one shape per
    // model class is what let the second path hide; the cross product is the point of this loop.
    const assistantShapes: Array<{ label: string; content: OcxAssistantContentPart[] }> = [
      { label: "narrated", content: [{ type: "text", text: "Reading." }, { type: "toolCall", id: "n1", name: "read_file", arguments: { path: "a.txt" } }] },
      { label: "silent", content: [{ type: "toolCall", id: "n1", name: "read_file", arguments: { path: "a.txt" } }] },
      { label: "empty-text", content: [{ type: "text", text: "" }, { type: "toolCall", id: "n1", name: "read_file", arguments: { path: "a.txt" } }] },
      { label: "whitespace-text", content: [{ type: "text", text: "   " }, { type: "toolCall", id: "n1", name: "read_file", arguments: { path: "a.txt" } }] },
    ];
    for (const modelId of ["cursor/auto", "cursor/composer-1", "cursor/composer-2.5-fast", "cursor/composer-3"]) {
    for (const shape of assistantShapes) {
      const carriedRoot = storeCursorBlob(new TextEncoder().encode(JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "covered by checkpoint" }],
      })));
      const checkpoint = create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [carriedRoot],
        turns: [new Uint8Array(32).fill(8)],
        readPaths: ["a.txt", "b.txt"],
      });
      const prepared = prepareCursorRunRequest({
        modelId,
        conversationId: `cursor_native_ckpt_${modelId}_${shape.label}`,
        system: ["You are helpful."],
        messages: [{ role: "tool", content: "FILE-CONTENTS" }],
        rawMessages: [
          { role: "user", content: "Read the file.", timestamp: 1 },
          { role: "assistant", content: shape.content, timestamp: 2 },
          { role: "toolResult", toolCallId: "n1", toolName: "read_file", content: "FILE-CONTENTS", isError: false, timestamp: 3 },
        ],
        checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
        continuationMode: "checkpoint",
        checkpointSuffixStart: 1,
      });
      const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
      const run = message.message.case === "runRequest" ? message.message.value : undefined;
      const state = run?.conversationState;
      // readPaths only ever comes from the decoded checkpoint, so it is the load-bearing assertion:
      // it is empty exactly when the checkpoint was thrown away.
      expect(state?.readPaths ?? []).toEqual(["a.txt", "b.txt"]);
      const roots = state?.rootPromptMessagesJson ?? [];
      expect(roots.some(id => Array.from(id).join(",") === Array.from(carriedRoot).join(","))).toBe(true);
    }
    }
  });

  /**
   * Audit r8 round 3, MAJOR. The survival check read only the LAST replayed message. Parallel tool calls
   * land as a run of results, and under byte pressure the older ones were the ones being emptied — measured
   * a prompt carrying three calls and one answer. `historyOutputElided` already recorded them; only one
   * index was consulted. The whole trailing run is checked now.
   */
  /**
   * An exhausted checkpoint must still produce a usable request: the assembled roots stay inside the
   * envelope and the conversation continues by full replay.
   *
   * It does NOT assert that the checkpoint store hears about it. Audit round 3 asked for that and round 4
   * measured why it cannot be done here: `live-transport.ts` prepares a spread copy of the request, so a
   * field written on the argument never reaches the caller that would invalidate the stored checkpoint.
   * Asserting on the argument would have passed while proving nothing about the real path.
   */
  test("an exhausted checkpoint still assembles a legal full-replay request", () => {
    const request = {
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt_exhausted_reason",
      system: ["You are helpful."],
      messages: [{ role: "tool" as const, content: "x" }],
      rawMessages: [
        { role: "user" as const, content: "Run it.", timestamp: 1 },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "Running." },
            { type: "toolCall" as const, id: "p1", name: "exec_command", arguments: { cmd: "echo X" } },
          ],
          timestamp: 2,
        },
        { role: "toolResult" as const, toolCallId: "p1", toolName: "exec_command", content: "OUT", isError: false, timestamp: 3 },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
        // A checkpoint that fills the root budget on its own: nothing is left for the suffix.
        rootPromptMessagesJson: Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT }, (_, i) => new Uint8Array(32).fill(i % 251)),
      })),
      continuationMode: "checkpoint" as const,
      checkpointSuffixStart: 1,
    };
    const prepared = prepareCursorRunRequest(request);
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    // The oversized checkpoint is gone rather than pruned to fit, so the replay carries its own history.
    const serialized = JSON.stringify(roots.map(id => (cursorBlobByteLength(id) === null ? null : JSON.parse(new TextDecoder().decode(blobData(id))))));
    expect(serialized).toContain("OUT");
  });

  test("parallel results are never delivered as a partial answer set", () => {
    const filler = "Q".repeat(40 * 1024);
    // 375 bytes below the limit is where a last-index-only check leaves exactly one answer standing: any
    // further down and pruning keeps all three, any further up and it keeps none. Derived by sweeping 628
    // (delta, payload) positions against the last-index-only implementation, not guessed.
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [storeCursorBlob(new Uint8Array(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT - 375).fill(65))],
      turns: [new Uint8Array(32).fill(8)],
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt_parallel_partial",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "x" }],
      rawMessages: [
        { role: "user", content: "Run three at once.", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running three." },
            { type: "toolCall", id: "r1", name: "exec_command", arguments: { cmd: "echo A" } },
            { type: "toolCall", id: "r2", name: "exec_command", arguments: { cmd: "echo B" } },
            { type: "toolCall", id: "r3", name: "exec_command", arguments: { cmd: "echo C" } },
          ],
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "r1", toolName: "exec_command", content: `SENTINEL-ONE${filler}`, isError: false, timestamp: 3 },
        { role: "toolResult", toolCallId: "r2", toolName: "exec_command", content: `SENTINEL-TWO${filler}`, isError: false, timestamp: 4 },
        { role: "toolResult", toolCallId: "r3", toolName: "exec_command", content: `SENTINEL-THREE${filler}`, isError: false, timestamp: 5 },
      ],
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    const serialized = roots
      .map(id => (cursorBlobByteLength(id) === null ? "" : new TextDecoder().decode(blobData(id))))
      .join("||");
    const present = ["SENTINEL-ONE", "SENTINEL-TWO", "SENTINEL-THREE"].filter(s => serialized.includes(s));
    // All three or none — a subset is a prompt with three calls and fewer answers.
    expect(present.length === 0 || present.length === 3).toBe(true);
  });

  test("the run-request diagnostic reports the measured envelope, not zero", () => {
    const previousDebug = process.env.OCX_DEBUG;
    process.env.OCX_DEBUG = "1";
    resetDebugSettingsForTests();
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (line: unknown) => { lines.push(String(line)); };
    try {
      // A PURE checkpoint continuation: no suffix, so `rootPromptMessagesState` is undefined and
      // the old expression had nothing to read. One root is in the local store (measurable) and
      // one was minted by Cursor (not), which is the mix a resumed conversation actually carries.
      const storedRoot = storeCursorBlob(new TextEncoder().encode("root-payload-in-store"));
      const checkpoint = create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [storedRoot, new Uint8Array(32).fill(7)],
        turns: [new Uint8Array(32).fill(8)],
      });
      prepareCursorRunRequest({
        modelId: "grok-4.6",
        conversationId: "cursor_telemetry",
        system: ["You are helpful."],
        messages: [{ role: "user", content: "new user" }],
        rawMessages: [
          { role: "user", content: "old user", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "old assistant" }], timestamp: 2 },
          { role: "user", content: "new user", timestamp: 3 },
        ],
        checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
        continuationMode: "checkpoint",
      });
      const runLine = lines.find(line => line.includes("[ocx:cursor:run-request]"));
      expect(runLine).toBeDefined();
      const payload = JSON.parse(runLine!.slice(runLine!.indexOf("{"))) as {
        rootBlobs: number;
        rootBytes: number;
        unmeasuredRoots?: number;
      };
      expect(payload.rootBlobs).toBe(2);
      // The load-bearing assertion: with no suffix state to read, the old expression reported 0.
      expect(payload.rootBytes).toBeGreaterThan(0);
      // Exactly the one root that came from the checkpoint and was never in the local store, so
      // the reader knows rootBytes is a floor.
      expect(payload.unmeasuredRoots).toBe(1);
    } finally {
      console.error = originalError;
      if (previousDebug === undefined) delete process.env.OCX_DEBUG;
      else process.env.OCX_DEBUG = previousDebug;
      resetDebugSettingsForTests();
    }
  });
});

/**
 * devlog 260829 070. The orphan-strip guard in `rootPromptMessages` assumed the replayed history
 * starts where the CONVERSATION starts, which holds only for a full replay. A checkpoint suffix starts
 * at `checkpointSuffixStart`, so its first entry is routinely the assistant message whose initiating
 * user turn lives inside the checkpoint — and the loop stripped pair after pair until only the trailing
 * active result survived, because its `break` fires only once the survivors ARE the active block.
 *
 * The consequence was not a cosmetic omission. Measured live against `cursor/grok-4.6`, three
 * sequential commands produced 14 tool executions — STEP1 and STEP2 seven times each, STEP3 never —
 * with six "was interrupted" narrations and no terminal answer. Each turn replayed the same collapsed
 * payload, so the model never saw the output of the command it had just run.
 *
 * These assert the property the collapse violated: the replayed suffix grows with the history.
 */
describe("Cursor checkpoint suffix keeps its completed pairs", () => {
  afterEach(() => {
    clearCursorCheckpointsForTests();
    resetCursorBlobStateForTests();
  });

  /** One covered opening user message, then `pairs` completed call/result exchanges. */
  function growingHistory(pairs: number) {
    const messages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
      { role: "user", content: "Run each step once.", timestamp: 1 },
    ];
    let timestamp = 2;
    for (let n = 1; n <= pairs; n++) {
      messages!.push({
        role: "assistant",
        content: [
          { type: "text", text: `Running STEP${n}.` },
          { type: "toolCall", id: `call_${n}`, name: "exec_command", arguments: { cmd: `echo STEP${n}` } },
        ],
        timestamp: timestamp++,
      });
      messages!.push({
        role: "toolResult",
        toolCallId: `call_${n}`,
        toolName: "exec_command",
        content: `STEP${n}`,
        isError: false,
        timestamp: timestamp++,
      });
    }
    return messages;
  }

  /** Replayed root texts, minus the checkpoint-carried root this process cannot read back. */
  function suffixTexts(pairs: number): string[] {
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [new Uint8Array(32).fill(7)],
      turns: [new Uint8Array(32).fill(8)],
    });
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: `cursor_ckpt_pairs_${pairs}`,
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages: growingHistory(pairs),
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      // Only the opening user message is covered; every pair below it must be replayed.
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    return roots.slice(1).map(id => {
      const parsed = JSON.parse(new TextDecoder().decode(blobData(id))) as { content?: string | [{ text?: string }] };
      const content = parsed.content;
      return typeof content === "string" ? content : (content?.[0]?.text ?? "");
    });
  }

  test("every completed pair in the uncovered suffix reaches the model", () => {
    const texts = suffixTexts(3);
    // Before the fix this was a single entry: the STEP3 result, with STEP1 and STEP2 discarded.
    for (const step of ["STEP1", "STEP2", "STEP3"]) {
      expect(texts.some(text => text.includes(`echo ${step}`))).toBe(true);
      expect(texts.some(text => text.startsWith("[Tool Result]") && text.includes(step))).toBe(true);
    }
  });

  test("the replayed suffix grows with the history instead of collapsing to a constant", () => {
    // Exact counts are an implementation detail; a payload that does not grow at all is the defect.
    const counts = [1, 2, 3, 4].map(pairs => suffixTexts(pairs).length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBeGreaterThan(1);
    expect(counts.at(-1)!).toBeGreaterThan(counts[0]!);
  });

  /**
   * Audit r8 finding 2: the orphan-guard fix alone was INERT under byte pressure, and measurably so —
   * 8 pairs of 64 KiB results still emitted 2 roots. The `keptPrior` loop admits COMPLETE TURNS, and a
   * turn starts at a user root; a checkpoint suffix has no user root at all, so `turnStart` walked to 0,
   * the whole prior block became one all-or-nothing pseudo-turn, and the first budget overrun dropped
   * every entry — leaving the orphan guard nothing to strip and the model nothing to read.
   *
   * Root replay is the only channel carrying suffix history (`conversationTurns` never opens a turn for a
   * suffix with no user message), so this was a total loss of that history, not a partial one.
   */
  test("byte pressure prunes a checkpoint suffix incrementally instead of dropping all of it", () => {
    const checkpoint = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [new Uint8Array(32).fill(7)],
      turns: [new Uint8Array(32).fill(8)],
    });
    // Eight pairs whose results together far exceed CURSOR_EXTERNAL_ROOT_BYTE_LIMIT, so pruning must run.
    const bulky = "X".repeat(64 * 1024);
    const rawMessages: Parameters<typeof prepareCursorRunRequest>[0]["rawMessages"] = [
      { role: "user", content: "Run each step once.", timestamp: 1 },
    ];
    let timestamp = 2;
    for (let n = 1; n <= 8; n++) {
      rawMessages!.push({
        role: "assistant",
        content: [
          { type: "text", text: `Running STEP${n}.` },
          { type: "toolCall", id: `call_${n}`, name: "exec_command", arguments: { cmd: `echo STEP${n}` } },
        ],
        timestamp: timestamp++,
      });
      rawMessages!.push({
        role: "toolResult",
        toolCallId: `call_${n}`,
        toolName: "exec_command",
        content: bulky,
        isError: false,
        timestamp: timestamp++,
      });
    }
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_ckpt_byte_pressure",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages,
      checkpointBytes: toBinary(ConversationStateStructureSchema, checkpoint),
      continuationMode: "checkpoint",
      checkpointSuffixStart: 1,
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    // Two roots (checkpoint seed + one active result) is the defect. More than a handful survive now.
    expect(roots.length).toBeGreaterThan(4);
    // And the bound still holds: retention did not come at the cost of the envelope.
    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    const measured = roots.reduce((sum, id) => sum + (cursorBlobByteLength(id) ?? 0), 0);
    expect(measured).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
  });

  test("a full replay still strips a genuinely orphaned leading entry", () => {
    // The guard's reason to exist (#1527). With no checkpoint there is no covered turn, so a leading
    // assistant entry IS orphaned and must not survive — this is what keeps the fix narrow.
    const prepared = prepareCursorRunRequest({
      modelId: "grok-4.6",
      conversationId: "cursor_full_replay_orphan",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "result" }],
      rawMessages: [
        { role: "assistant", content: [{ type: "text", text: "ORPHAN LEADING ASSISTANT" }], timestamp: 1 },
        { role: "user", content: "please read", timestamp: 2 },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "FILE", isError: false, timestamp: 3 },
      ],
    });
    const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
    const run = message.message.case === "runRequest" ? message.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
    const serialized = JSON.stringify(roots.map(id => JSON.parse(new TextDecoder().decode(blobData(id)))));
    expect(serialized).not.toContain("ORPHAN LEADING ASSISTANT");
    expect(serialized).toContain("FILE");
  });
});
