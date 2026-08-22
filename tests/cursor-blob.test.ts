import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import { toBinary } from "@bufbuild/protobuf";
import {
  createCursorBlobRequestScope,
  cursorBlobMetrics,
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
import {
  CURSOR_EXTERNAL_ROOT_BYTE_LIMIT,
  CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT,
  CURSOR_EXTERNAL_ROOT_BLOB_LIMIT,
  CURSOR_ROUTING_LEVEL_PARAMETER_ID,
  encodeCursorRunRequest,
  prepareCursorRunRequest,
} from "../src/adapters/cursor/protobuf-request";
import { estimateTokens } from "../src/lib/token-estimate";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  ConversationStateStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
  SetBlobArgsSchema,
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
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
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
      expect(tool.value.args?.toolCallId).toBe("call_1");
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
