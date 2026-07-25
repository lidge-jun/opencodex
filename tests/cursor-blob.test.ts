import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv, storeCursorBlob } from "../src/adapters/cursor/native-exec";
import {
  CURSOR_EXTERNAL_ROOT_BYTE_LIMIT,
  CURSOR_EXTERNAL_ROOT_BLOB_LIMIT,
  CURSOR_ROUTING_LEVEL_PARAMETER_ID,
  encodeCursorRunRequest,
} from "../src/adapters/cursor/protobuf-request";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";

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
  });

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

    expect(run?.action?.action.case).toBe("resumeAction");
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

  test("adds exec_command prompt hints for active shell requests when native exec is available", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "Run: echo OCX via your shell tool, report stdout." }],
      tools: [{
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    });

    const roots = decodeRootMessages(bytes);
    expect(JSON.stringify(roots)).toContain("Shell commands use");
    expect(JSON.stringify(roots)).toContain("exec_command");
    expect(actionText(bytes)).toContain("Run: echo OCX via your shell tool, report stdout.");
    expect(actionText(bytes)).toContain("Use the Codex shell bridge tool listed this turn");
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
    expect(run?.action?.action.case).toBe("resumeAction");
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
    expect(run?.action?.action.case).toBe("resumeAction");
    expect(JSON.stringify(roots)).toContain("contents");
    expect(JSON.stringify(roots)).not.toContain("hidden reasoning");
  });

  test("keeps ResumeAction for native-model tool-result continuations", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c1",
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

    expect(run?.action?.action.case).toBe("resumeAction");
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
