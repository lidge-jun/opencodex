import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema } from "../src/adapters/cursor/gen/agent_pb";
import {
  clearCursorCheckpointsForTests,
  commitCursorCheckpoint,
  getCursorCheckpoint,
} from "../src/adapters/cursor/checkpoint-store";
import {
  applyCursorToolBudget,
  createCursorRequest,
  cursorCoveredPrefixDigest,
  cursorInstructionDigest,
  CURSOR_TOOL_BYTES_LIMIT,
  CURSOR_TOOL_COUNT_LIMIT,
} from "../src/adapters/cursor/request-builder";
import { cursorCheckpointModelAffinityId } from "../src/adapters/cursor/discovery";
import { cursorMcpToolsEncodedSize } from "../src/adapters/cursor/tool-definitions";
import { parseRequest } from "../src/responses/parser";
import type { OcxParsedRequest } from "../src/types";

const base: OcxParsedRequest = {
  modelId: "cursor/auto",
  context: { messages: [] },
  stream: false,
  options: {},
};

describe("Cursor request builder", () => {
  test("normalizes cursor model prefix and never uses Responses response id as Cursor conversation id", () => {
    const request = createCursorRequest({ ...base, previousResponseId: "resp_123" });

    expect(request.modelId).toBe("default");
    // resp_* is an OpenAI Responses chain id, not a Cursor conversation id. Without a remembered
    // Cursor conversation (_cursorConversationId) we start a fresh one — never fall back to resp_*,
    // which would start an unrelated Cursor conversation and break tool-result continuation.
    expect(request.conversationId).not.toBe("resp_123");
    expect(request.conversationId.startsWith("cursor_")).toBe(true);
  });

  test("uses resolved Cursor conversation id ahead of Responses response id", () => {
    const request = createCursorRequest({
      ...base,
      previousResponseId: "resp_123",
      _cursorConversationId: "cursor_stable",
    });

    expect(request.conversationId).toBe("cursor_stable");
  });

  test("uses stable client thread identity for external store:false continuations", () => {
    const initial = createCursorRequest({
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "start", timestamp: 1 }] },
      _clientThreadId: "thread-a",
      options: { promptCacheKey: "shared-cache-key" },
    });
    const continuation = createCursorRequest({
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [{
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_file",
          content: "result",
          isError: false,
          timestamp: 2,
        }],
      },
      _clientThreadId: "thread-a",
      options: { promptCacheKey: "shared-cache-key" },
    });

    expect(continuation.conversationId).toBe(initial.conversationId);
  });

  test("prefix digests do not collide across delimiter boundaries", () => {
    const left = {
      ...base,
      context: {
        messages: [
          { role: "user" as const, content: "ab", timestamp: 1 },
          { role: "user" as const, content: "c", timestamp: 2 },
        ],
      },
    };
    const right = {
      ...base,
      context: {
        messages: [
          { role: "user" as const, content: "a", timestamp: 1 },
          { role: "user" as const, content: "bc", timestamp: 2 },
        ],
      },
    };
    expect(cursorCoveredPrefixDigest(left, 2)).not.toBe(cursorCoveredPrefixDigest(right, 2));
  });

  test("does not own a Cursor conversation from the first user message alone", () => {
    const first = createCursorRequest({
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "fix the tests", timestamp: 1 }] },
    });
    const second = createCursorRequest({
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "fix the tests", timestamp: 1 }] },
    });
    expect(second.conversationId).not.toBe(first.conversationId);
  });

  test("isolates client threads even when they share a prompt cache key", () => {
    const first = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      options: { promptCacheKey: "shared-cache-key" },
    });
    const second = createCursorRequest({
      ...base,
      _clientThreadId: "thread-b",
      options: { promptCacheKey: "shared-cache-key" },
    });

    expect(second.conversationId).not.toBe(first.conversationId);
  });

  test("native and external models do not pin conversation id from prompt_cache_key alone", () => {
    const nativeA = createCursorRequest({
      modelId: "cursor/composer-2.5",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      stream: false,
      options: { promptCacheKey: "shared-cache-key" },
    });
    const nativeB = createCursorRequest({
      modelId: "cursor/composer-2.5",
      context: { messages: [{ role: "user", content: "hi again", timestamp: 2 }] },
      stream: false,
      options: { promptCacheKey: "shared-cache-key" },
    });
    expect(nativeA.conversationId).not.toBe(nativeB.conversationId);

    const externalA = createCursorRequest({
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      stream: false,
      options: { promptCacheKey: "shared-cache-key" },
    });
    const externalB = createCursorRequest({
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "hi again", timestamp: 2 }] },
      stream: false,
      options: { promptCacheKey: "shared-cache-key" },
    });
    expect(externalA.conversationId).not.toBe(externalB.conversationId);
  });

  test("identity scope namespaces client thread conversation ids", () => {
    const a = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      _cursorIdentityScope: "account-1",
    });
    const b = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      _cursorIdentityScope: "account-2",
    });
    expect(a.conversationId).not.toBe(b.conversationId);
  });

  test("isolated helper turns mint a fresh conversation id", () => {
    const main = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
    });
    const helper = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      _cursorIsolateConversation: true,
    });
    expect(helper.conversationId).not.toBe(main.conversationId);
  });

  test("isolated helper turns keep their own cache and never reuse the parent checkpoint", () => {
    clearCursorCheckpointsForTests();
    const parentBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["parent-fixture"],
    }));
    const parentRef = commitCursorCheckpoint({
      conversationId: "cursor_parent_real",
      identityScope: "acct-1",
      modelId: "default",
      checkpointBytes: parentBytes,
      coveredMessageCount: 1,
    });
    expect(parentRef).toBeDefined();

    const helperPrompt = { role: "user" as const, content: "summarize this helper task", timestamp: 1 };
    const first = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_parent_real",
      _cursorIdentityScope: "acct-1",
      _cursorIsolateConversation: true,
      _clientThreadId: "thread-a",
      _providerContinuation: {
        cursor: { conversationId: "cursor_parent_real", checkpointUsable: true, checkpointRef: parentRef },
      },
      context: { messages: [helperPrompt] },
    });
    expect(first.conversationId).not.toBe("cursor_parent_real");
    expect(first.continuationMode).toBe("full-replay");
    expect(first.checkpointBytes).toBeUndefined();

    const helperBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["helper-fixture"],
    }));
    const helperParsed = { ...base, _cursorIdentityScope: "acct-1", context: { messages: [helperPrompt] } };
    const helperRef = commitCursorCheckpoint({
      conversationId: first.conversationId,
      identityScope: "acct-1",
      modelId: first.modelId,
      checkpointBytes: helperBytes,
      coveredMessageCount: 1,
      prefixDigest: cursorCoveredPrefixDigest(helperParsed, 1),
      systemDigest: cursorInstructionDigest(helperParsed),
    });
    expect(helperRef).toBeDefined();

    const second = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_parent_real",
      _cursorIdentityScope: "acct-1",
      _cursorIsolateConversation: true,
      _clientThreadId: "thread-a",
      _providerContinuation: {
        cursor: { conversationId: "cursor_parent_real", checkpointUsable: true, checkpointRef: parentRef },
      },
      context: {
        messages: [
          helperPrompt,
          { role: "assistant", content: [{ type: "text", text: "calling" }], timestamp: 2 },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read_file",
            content: "ok",
            isError: false,
            timestamp: 3,
          },
        ],
      },
    });
    expect(second.conversationId).not.toBe("cursor_parent_real");
    expect(second.continuationMode).toBe("checkpoint");
    expect(second.checkpointBytes?.byteLength).toBe(helperBytes.byteLength);
    expect(getCursorCheckpoint(parentRef)?.ref).toBe(parentRef);
    clearCursorCheckpointsForTests();
  });

  test("isolation wins over a remembered parent conversation id", () => {
    const helper = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      _cursorConversationId: "cursor_parent_remembered",
      _cursorIsolateConversation: true,
    });
    expect(helper.conversationId).not.toBe("cursor_parent_remembered");
    expect(helper.conversationId.startsWith("cursor_")).toBe(true);
  });

  test("marks Cursor context-usage boundaries for compaction epochs", () => {
    expect(createCursorRequest({ ...base, _contextCompactionBoundary: true }).contextUsageReset).toBe(true);

    const compactionRequest = createCursorRequest({ ...base, _compactionRequest: true });
    expect(compactionRequest.contextUsageReset).toBe(true);
    expect(compactionRequest.contextUsageStoreCheckpoints).toBe(false);
  });

  test("maps system, developer, user, assistant, and tool result text", () => {
    const request = createCursorRequest({
      ...base,
      context: {
        systemPrompt: ["system A", "system B"],
        messages: [
          { role: "developer", content: "dev", timestamp: 1 },
          { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 2 },
          { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 3 },
          { role: "toolResult", toolCallId: "call_1", toolName: "tool", content: "tool out", isError: false, timestamp: 4 },
        ],
      },
    });

    expect(request.system).toEqual(["system A", "system B"]);
    expect(request.messages).toEqual([
      { role: "developer", content: "dev" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", content: "[tool_result]\ncall_id: call_1\nname: tool\nis_error: false\noutput:\ntool out" },
    ]);
  });

  test("uses an explicit image placeholder for unsupported image parts", () => {
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see" },
              { type: "image", imageUrl: "data:image/png;base64,abc", detail: "high" },
            ],
            timestamp: 1,
          },
        ],
      },
    });

    expect(request.messages[0]?.content).toContain("see");
    // A USER-message image is still flattened here (this path builds the plain-text prompt).
    // The tool-result ENCODER does build real McpImageContent, so the placeholder no longer
    // claims the encoder as a whole is unable to send images. (Neither kind reaches Cursor in
    // production today: every Cursor model is in noVisionModels, so the vision sidecar runs
    // first — see devlog/_plan/260817_cursor_toolcall_decode/020_*.md.)
    expect(request.messages[0]?.content).toContain("image omitted from this Cursor text prompt");
    expect(request.messages[0]?.content).toContain("high");
  });

  test("preserves Responses tools and tool choice for Cursor request context", () => {
    const tool = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      namespace: "mcp__fs",
    };
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "use a tool", timestamp: 1 }], tools: [tool] },
      options: { toolChoice: "required" },
    });

    expect(request.tools).toEqual([tool]);
    expect(request.toolChoice).toBe("required");
  });

  test("serializes prior tool results without leaking assistant tool-call markers as text", () => {
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "file contents",
            isError: false,
            timestamp: 2,
          },
        ],
      },
      options: { parallelToolCalls: false },
    });

    expect(request.parallelToolCalls).toBe(false);
    expect(request.messages).toEqual([{
      role: "tool",
      content: "[tool_result]\ncall_id: call_1\nname: mcp__fs__read_file\nis_error: false\noutput:\nfile contents",
    }]);
  });

  test("preserves Responses allowed_tools and parallel_tool_calls controls from parser", () => {
    const parsed = parseRequest({
      model: "cursor/auto",
      input: "use one",
      tools: [
        { type: "function", name: "read_file", description: "Read", parameters: {} },
        { type: "function", name: "write_file", description: "Write", parameters: {} },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "read_file" }],
      },
      parallel_tool_calls: false,
    });
    const request = createCursorRequest(parsed);

    expect(request.toolChoice).toEqual({ mode: "required", allowedTools: ["read_file"] });
    expect(request.parallelToolCalls).toBe(false);
  });

  test("uses actual protobuf size and continues after an oversized definition", () => {
    const huge = {
      name: "huge",
      namespace: "mcp__huge",
      description: "x".repeat(CURSOR_TOOL_BYTES_LIMIT + 10_000),
      parameters: { type: "object", properties: {} },
    };
    const small = {
      name: "small",
      namespace: "mcp__small",
      description: "Small tool",
      parameters: { type: "object", properties: {} },
    };
    const budget = applyCursorToolBudget([huge, small], "auto");

    expect(budget.tools.map(tool => tool.name)).toEqual(["small"]);
    expect(budget.omitted.map(tool => tool.name)).toEqual(["huge"]);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("hard-caps the combined catalog and prioritizes tool_search-loaded tools", () => {
    const regular = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT + 5 }, (_, index) => ({
      name: `regular_${index}`,
      namespace: "mcp__regular",
      description: "Regular",
      parameters: {},
    }));
    const loaded = {
      name: "loaded_action",
      namespace: "mcp__loaded",
      description: "Loaded by tool_search",
      parameters: {},
      loadedFromToolSearch: true,
    };
    const budget = applyCursorToolBudget([...regular, loaded], "auto");

    expect(budget.tools.length).toBeLessThanOrEqual(CURSOR_TOOL_COUNT_LIMIT);
    expect(budget.tools).toContain(loaded);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("pins the Codex shell bridge and apply_patch through truncation", () => {
    const regular = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT + 20 }, (_, index) => ({
      name: `regular_${index}`,
      namespace: "mcp__regular",
      description: "Regular",
      parameters: {},
    }));
    const shell = { name: "shell_command", description: "Run", parameters: {} };
    const patch = { name: "apply_patch", description: "Patch", parameters: {}, freeform: true };
    const budget = applyCursorToolBudget([...regular, shell, patch], "auto");

    expect(budget.tools).toContain(shell);
    expect(budget.tools).toContain(patch);
    expect(budget.tools.length).toBeLessThanOrEqual(CURSOR_TOOL_COUNT_LIMIT);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("keeps the shell bridge when tool_choice names the exec_command alias", () => {
    const regular = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT + 20 }, (_, index) => ({
      name: `regular_${index}`,
      namespace: "mcp__regular",
      description: "Regular",
      parameters: {},
    }));
    const shell = { name: "shell_command", description: "Run", parameters: {} };
    const budget = applyCursorToolBudget([...regular, shell], { name: "exec_command" });

    expect(budget.tools).toEqual([shell]);
    expect(budget.omitted).toEqual([]);
  });

  test("keeps shell_command even when a large apply_patch would otherwise consume the byte budget first", () => {
    const hugePatch = {
      name: "apply_patch",
      description: "x".repeat(Math.floor(CURSOR_TOOL_BYTES_LIMIT * 0.7)),
      parameters: { type: "object", properties: {} },
      freeform: true,
    };
    const shell = { name: "shell_command", description: "Run", parameters: { type: "object", properties: { command: { type: "string" } } } };
    const filler = Array.from({ length: 40 }, (_, index) => ({
      name: `filler_${index}`,
      namespace: "mcp__filler",
      description: "y".repeat(2_000),
      parameters: { type: "object", properties: {} },
    }));
    const budget = applyCursorToolBudget([hugePatch, ...filler, shell], "auto");

    expect(budget.tools).toContain(shell);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("admits shell_command and apply_patch before filler when the byte budget is tight", () => {
    const patch = {
      name: "apply_patch",
      description: "p".repeat(Math.floor(CURSOR_TOOL_BYTES_LIMIT * 0.45)),
      parameters: { type: "object", properties: {} },
      freeform: true,
    };
    const shell = {
      name: "shell_command",
      description: "s".repeat(Math.floor(CURSOR_TOOL_BYTES_LIMIT * 0.45)),
      parameters: { type: "object", properties: { command: { type: "string" } } },
    };
    const filler = Array.from({ length: 30 }, (_, index) => ({
      name: `filler_${index}`,
      namespace: "mcp__filler",
      description: "f".repeat(Math.floor(CURSOR_TOOL_BYTES_LIMIT * 0.2)),
      parameters: { type: "object", properties: {} },
    }));
    const budget = applyCursorToolBudget([...filler, shell, patch], "auto");
    expect(budget.tools).toContain(shell);
    expect(budget.tools).toContain(patch);
    expect(budget.omitted.some(tool => tool.namespace === "mcp__filler")).toBe(true);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("allowed_tools keeps shell and apply_patch ahead of a near-limit unrelated selected tool", () => {
    const huge = {
      name: "huge_tool",
      namespace: "mcp__huge",
      description: "x".repeat(CURSOR_TOOL_BYTES_LIMIT - 2_000),
      parameters: { type: "object", properties: {} },
    };
    const shell = {
      name: "shell_command",
      description: "s".repeat(8_000),
      parameters: { type: "object", properties: { command: { type: "string" } } },
    };
    const patch = {
      name: "apply_patch",
      description: "p".repeat(8_000),
      parameters: { type: "object", properties: {} },
      freeform: true,
    };
    const choice = {
      mode: "required" as const,
      allowedTools: ["huge_tool", "shell_command", "apply_patch"],
    };
    // Combined catalog exceeds the byte budget; shell+patch alone must still fit.
    expect(cursorMcpToolsEncodedSize([huge, shell, patch], choice)).toBeGreaterThan(CURSOR_TOOL_BYTES_LIMIT);
    expect(cursorMcpToolsEncodedSize([shell, patch], choice)).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);

    const budget = applyCursorToolBudget([huge, shell, patch], choice);

    expect(budget.tools).toContain(shell);
    expect(budget.tools).toContain(patch);
    expect(budget.tools).not.toContain(huge);
    expect(cursorMcpToolsEncodedSize(budget.tools, choice)).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("allowed_tools keeps shell and apply_patch when count limit would otherwise drop later selected tools", () => {
    const regular = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT + 5 }, (_, index) => ({
      name: `regular_${index}`,
      namespace: "mcp__regular",
      description: "Regular",
      parameters: {},
    }));
    const shell = { name: "shell_command", description: "Run", parameters: {} };
    const patch = { name: "apply_patch", description: "Patch", parameters: {}, freeform: true };
    const allowedTools = [...regular.map(tool => tool.name), "shell_command", "apply_patch"];
    const choice = { mode: "required" as const, allowedTools };
    const budget = applyCursorToolBudget([...regular, shell, patch], choice);

    expect(budget.tools).toContain(shell);
    expect(budget.tools).toContain(patch);
    expect(budget.tools.length).toBeLessThanOrEqual(CURSOR_TOOL_COUNT_LIMIT);
  });

  test("pins Codex Desktop unified exec through count truncation", () => {
    const regular = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT + 20 }, (_, index) => ({
      name: `regular_${index}`,
      namespace: "mcp__regular",
      description: "Regular",
      parameters: {},
    }));
    const exec = { name: "exec", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } };
    const budget = applyCursorToolBudget([...regular, exec], "auto");

    expect(budget.tools).toContain(exec);
    expect(budget.omitted).not.toContain(exec);
    expect(budget.tools.length).toBeLessThanOrEqual(CURSOR_TOOL_COUNT_LIMIT);
  });


  test("a deferred Cursor catalog stays inside the wire budget while a nested one does not (#1830)", () => {
    // Why #1832 flips supports_search_tool for Cursor: with deferred discovery OFF, Codex
    // inlines the whole MCP catalog into `exec.description` instead of leaving it callable
    // through tool_search. This asserts the consequence in bytes, on the real serializer,
    // rather than trusting the flag alone.
    const nestedCatalogText = Array.from({ length: 120 }, (_, index) =>
      `mcp__server_${index}__tool: ${"d".repeat(1_200)}`).join("\n");

    const execDeferred = {
      name: "exec",
      namespace: "opencodex-responses",
      description: "Run JavaScript. Discover tools with tool_search.",
      parameters: { type: "object", properties: { input: { type: "string" } } },
      freeform: true,
    };
    const execInlined = { ...execDeferred, description: `${execDeferred.description}\n${nestedCatalogText}` };
    const wait = {
      name: "wait",
      namespace: "opencodex-responses",
      description: "Resume a running call",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    };

    // Deferred: the advertised catalog serializes well inside the cap and keeps both tools.
    expect(cursorMcpToolsEncodedSize([execDeferred, wait], "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
    const deferred = applyCursorToolBudget([execDeferred, wait], "auto");
    expect(deferred.tools).toContain(execDeferred);
    expect(deferred.tools).toContain(wait);
    expect(deferred.omitted).toHaveLength(0);

    // Inlined: the same two tools blow the cap purely because the catalog moved into exec.
    expect(cursorMcpToolsEncodedSize([execInlined, wait], "auto")).toBeGreaterThan(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("the Responses execution bridge survives the budget even when it must be trimmed (#1830)", () => {
    // #1830's symptom is a child whose advertised catalog has no Responses execution tool at
    // all. Whatever else the budget drops, exec and wait have to be what is left.
    const filler = Array.from({ length: 60 }, (_, index) => ({
      name: `mcp_tool_${index}`,
      namespace: `mcp__server_${index}`,
      description: "z".repeat(4_000),
      parameters: { type: "object", properties: {} },
    }));
    const exec = {
      name: "exec",
      namespace: "opencodex-responses",
      description: "Run JavaScript",
      parameters: { type: "object", properties: { input: { type: "string" } } },
      freeform: true,
    };
    const wait = {
      name: "wait",
      namespace: "opencodex-responses",
      description: "Resume",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    };

    const catalog = [...filler, exec, wait];
    expect(cursorMcpToolsEncodedSize(catalog, "auto")).toBeGreaterThan(CURSOR_TOOL_BYTES_LIMIT);

    const budget = applyCursorToolBudget(catalog, "auto");
    expect(budget.tools).toContain(exec);
    expect(budget.tools).toContain(wait);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
    expect(budget.omitted.length).toBeGreaterThan(0);
  });
  test("pins namespaced opencodex-responses exec ahead of filler", () => {
    const filler = Array.from({ length: 80 }, (_, index) => ({
      name: `filler_${index}`,
      namespace: "mcp__filler",
      description: "y".repeat(3_000),
      parameters: { type: "object", properties: {} },
    }));
    const exec = {
      name: "exec",
      namespace: "opencodex-responses",
      description: "Run",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    };
    const wait = {
      name: "wait",
      namespace: "opencodex-responses",
      description: "Resume",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    };
    const catalog = [...filler, wait, exec];
    expect(cursorMcpToolsEncodedSize(catalog, "auto")).toBeGreaterThan(CURSOR_TOOL_BYTES_LIMIT);
    const budget = applyCursorToolBudget(catalog, "auto");

    expect(budget.tools).toContain(exec);
    expect(budget.tools).toContain(wait);
    expect(budget.omitted.some(tool => tool.namespace === "mcp__filler")).toBe(true);
  });

  test("keeps unified exec when a large apply_patch would otherwise consume the byte budget first", () => {
    const hugePatch = {
      name: "apply_patch",
      description: "x".repeat(Math.floor(CURSOR_TOOL_BYTES_LIMIT * 0.7)),
      parameters: { type: "object", properties: {} },
      freeform: true,
    };
    const exec = {
      name: "exec",
      description: "Run",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    };
    const wait = {
      name: "wait",
      description: "Resume",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    };
    const filler = Array.from({ length: 40 }, (_, index) => ({
      name: `filler_${index}`,
      namespace: "mcp__filler",
      description: "y".repeat(2_000),
      parameters: { type: "object", properties: {} },
    }));
    const budget = applyCursorToolBudget([hugePatch, wait, ...filler, exec], "auto");

    expect(budget.tools).toContain(exec);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("omits wait when the execution path cannot fit in the Cursor byte budget", () => {
    const exec = {
      name: "exec",
      description: "x".repeat(CURSOR_TOOL_BYTES_LIMIT + 10_000),
      parameters: { type: "object", properties: {} },
    };
    const wait = {
      name: "wait",
      description: "Resume",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    };
    const budget = applyCursorToolBudget([wait, exec], "auto");

    expect(budget.tools).not.toContain(exec);
    expect(budget.tools).not.toContain(wait);
    expect(budget.omitted).toEqual(expect.arrayContaining([exec, wait]));
  });

  test("adds an honest recovery note only when tool_search survives", () => {
    const tools = [
      { name: "tool_search", description: "Discover", parameters: {}, toolSearch: true },
      {
        name: "huge", namespace: "mcp__huge", description: "x".repeat(CURSOR_TOOL_BYTES_LIMIT + 10_000),
        parameters: { type: "object", properties: {} },
      },
    ];
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "use tools", timestamp: 1 }], tools },
    });
    expect(request.system.join("\n")).toContain("Use tool_search");
    expect(request.system.join("\n")).toContain("prioritized on the next turn");

    const withoutSearch = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "use tools", timestamp: 1 }], tools: tools.slice(1) },
    });
    expect(withoutSearch.system.join("\n")).toContain("unavailable this turn");
    expect(withoutSearch.system.join("\n")).not.toContain("Use tool_search");
  });


  test("external Cursor tool-result continuation keeps the remembered conversation id", () => {
    const request = createCursorRequest({
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorConversationId: "cursor_old_external",
    });

    expect(request.modelId).toBe("gpt-5.6-sol-xhigh");
    expect(request.conversationId).toBe("cursor_old_external");
  });

  test("native Cursor tool-result continuation keeps the remembered conversation id", () => {
    const request = createCursorRequest({
      modelId: "cursor/composer-2.5",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/composer-2.5",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_native_stable",
    });

    expect(request.conversationId).toBe("cursor_native_stable");
  });

  test("forceFreshConversation always mints a new conversation id", () => {
    const request = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_force_me",
    }, { forceFreshConversation: true });

    expect(request.conversationId).not.toBe("cursor_force_me");
    expect(request.conversationId.startsWith("cursor_")).toBe(true);
  });

  test("reuses a validated checkpoint and ignores it for isolation or uncovered tool results", () => {
    clearCursorCheckpointsForTests();
    const covered = [
      { role: "user" as const, content: "read", timestamp: 1 },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "calling" }], timestamp: 2 },
    ];
    const coveredParsed = { ...base, _cursorIdentityScope: "acct-1", context: { messages: covered } };
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["builder-fixture"],
    }));
    const checkpointRef = commitCursorCheckpoint({
      conversationId: "cursor_stable",
      identityScope: "acct-1",
      modelId: "default",
      checkpointBytes,
      coveredMessageCount: 2,
      prefixDigest: cursorCoveredPrefixDigest(coveredParsed, 2),
      systemDigest: cursorInstructionDigest(coveredParsed),
    });
    expect(checkpointRef).toBeDefined();

    const reused = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef },
      },
      context: { messages: [...covered, { role: "user", content: "continue", timestamp: 3 }] },
    });
    expect(reused.continuationMode).toBe("checkpoint");
    expect(reused.checkpointBytes?.byteLength).toBe(checkpointBytes.byteLength);

    const isolated = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _cursorIsolateConversation: true,
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef },
      },
    });
    expect(isolated.conversationId).not.toBe("cursor_stable");
    expect(isolated.continuationMode).toBe("full-replay");
    expect(isolated.checkpointBytes).toBeUndefined();

    const toolResult = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: false, checkpointRef },
      },
      context: {
        messages: [
          { role: "user", content: "read", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "calling" }], timestamp: 2 },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read_file",
            content: "ok",
            isError: false,
            timestamp: 3,
          },
        ],
      },
    });
    expect(toolResult.continuationMode).toBe("checkpoint");
    expect(toolResult.checkpointSuffixStart).toBe(2);

    const uncovered = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: false, checkpointRef },
      },
      context: {
        messages: [{
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_file",
          content: "ok",
          isError: false,
          timestamp: 2,
        }],
      },
    });
    expect(uncovered.continuationMode).toBe("full-replay");
    expect(uncovered.checkpointInvalidationReason).toBe("lineage_mismatch");
    clearCursorCheckpointsForTests();
  });

  test("falls back to full replay when the checkpoint identity no longer matches", () => {
    clearCursorCheckpointsForTests();
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["identity-fixture"],
    }));
    const checkpointRef = commitCursorCheckpoint({
      conversationId: "cursor_stable",
      identityScope: "acct-1",
      modelId: "grok-4.6",
      checkpointBytes,
    });
    expect(checkpointRef).toBeDefined();

    const implied = createCursorRequest({
      ...base,
      modelId: "cursor/grok-4.6",
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
    });
    expect(implied.continuationMode).toBe("full-replay");
    expect(implied.checkpointInvalidationReason).toBe("missing_ref");

    const missing = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_unknown",
      _cursorIdentityScope: "acct-1",
    });
    expect(missing.continuationMode).toBe("full-replay");
    expect(missing.checkpointInvalidationReason).toBe("missing_ref");

    const expired = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef: "missing-ref" },
      },
    });
    expect(expired.continuationMode).toBe("full-replay");
    expect(expired.checkpointInvalidationReason).toBe("expired");

    const modelChanged = createCursorRequest({
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef },
      },
    });
    expect(modelChanged.continuationMode).toBe("full-replay");
    expect(modelChanged.checkpointInvalidationReason).toBe("model_changed");

    const identityChanged = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-2",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef },
      },
    });
    expect(identityChanged.continuationMode).toBe("full-replay");
    expect(identityChanged.checkpointInvalidationReason).toBe("identity_changed");

    const conversationChanged = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_other",
      _cursorIdentityScope: "acct-1",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef },
      },
    });
    expect(conversationChanged.continuationMode).toBe("full-replay");
    expect(conversationChanged.checkpointInvalidationReason).toBe("conversation_changed");

    const forceFresh = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef },
      },
    }, { forceFreshConversation: true });
    expect(forceFresh.continuationMode).toBe("full-replay");
    expect(forceFresh.checkpointInvalidationReason).toBe("force_fresh");

    const compaction = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _compactionRequest: true,
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef },
      },
    });
    expect(compaction.continuationMode).toBe("full-replay");
    expect(compaction.checkpointInvalidationReason).toBe("compaction");
    expect(compaction.checkpointBytes).toBeUndefined();
    expect(getCursorCheckpoint(checkpointRef)?.ref).toBe(checkpointRef);
    clearCursorCheckpointsForTests();
  });

  test("does not substitute another snapshot when an explicit checkpoint ref is missing", () => {
    clearCursorCheckpointsForTests();
    const parsed = {
      ...base,
      modelId: "cursor/grok-4.6",
      _cursorIdentityScope: "acct-1",
      context: { messages: [{ role: "user" as const, content: "same prompt", timestamp: 1 }] },
    };
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["other-snap"],
    }));
    const liveRef = commitCursorCheckpoint({
      conversationId: "cursor_stable",
      identityScope: "acct-1",
      modelId: "grok-4.6",
      checkpointBytes,
      coveredMessageCount: 1,
      prefixDigest: cursorCoveredPrefixDigest(parsed, 1),
      systemDigest: cursorInstructionDigest(parsed),
    });
    expect(liveRef).toBeDefined();
    const missed = createCursorRequest({
      ...parsed,
      _cursorConversationId: "cursor_stable",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef: "missing-ref" },
      },
    });
    expect(missed.continuationMode).toBe("full-replay");
    expect(missed.checkpointInvalidationReason).toBe("expired");
    expect(missed.checkpointBytes).toBeUndefined();

    const refLess = createCursorRequest({
      ...parsed,
      _cursorConversationId: "cursor_stable",
    });
    expect(refLess.continuationMode).toBe("checkpoint");
    expect(refLess.checkpointBytes).toEqual(checkpointBytes);
    clearCursorCheckpointsForTests();
  });

  test("does not share a checkpoint across two chats that start with the same user text", () => {
    clearCursorCheckpointsForTests();
    const firstTurn = {
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      _cursorIdentityScope: "acct-1",
      context: { messages: [{ role: "user" as const, content: "fix the tests", timestamp: 1 }] },
    };
    const bytesA = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["chat-a"],
    }));
    const bytesB = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["chat-b"],
    }));
    expect(commitCursorCheckpoint({
      conversationId: "cursor_a",
      identityScope: "acct-1",
      modelId: createCursorRequest(firstTurn).modelId,
      checkpointBytes: bytesA,
      coveredMessageCount: 1,
      prefixDigest: cursorCoveredPrefixDigest(firstTurn, 1),
      systemDigest: cursorInstructionDigest(firstTurn),
    })).toBeDefined();
    expect(commitCursorCheckpoint({
      conversationId: "cursor_b",
      identityScope: "acct-1",
      modelId: createCursorRequest(firstTurn).modelId,
      checkpointBytes: bytesB,
      coveredMessageCount: 1,
      prefixDigest: cursorCoveredPrefixDigest(firstTurn, 1),
      systemDigest: cursorInstructionDigest(firstTurn),
    })).toBeDefined();
    const followUp = createCursorRequest({
      ...firstTurn,
      context: {
        messages: [
          { role: "user", content: "fix the tests", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "A reply" }], timestamp: 2 },
          { role: "user", content: "now this file", timestamp: 3 },
        ],
      },
    });
    expect(followUp.continuationMode).toBe("full-replay");
    expect(followUp.checkpointInvalidationReason).toBe("missing_ref");
    clearCursorCheckpointsForTests();
  });

  test("rejects a divergent branch and a changed system prompt", () => {
    clearCursorCheckpointsForTests();
    const covered = [
      { role: "user" as const, content: "start here", timestamp: 1 },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 2 },
    ];
    const parsed = { ...base, _cursorIdentityScope: "acct-1", context: { messages: covered } };
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["branch"],
    }));
    const ref = commitCursorCheckpoint({
      conversationId: "cursor_stable",
      identityScope: "acct-1",
      modelId: "default",
      checkpointBytes,
      coveredMessageCount: 2,
      prefixDigest: cursorCoveredPrefixDigest(parsed, 2),
      systemDigest: cursorInstructionDigest(parsed),
    });
    expect(ref).toBeDefined();
    const branched = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef: ref },
      },
      context: {
        messages: [
          { role: "user", content: "start here", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "different reply" }], timestamp: 2 },
          { role: "user", content: "continue", timestamp: 3 },
        ],
      },
    });
    expect(branched.continuationMode).toBe("full-replay");
    expect(branched.checkpointInvalidationReason).toBe("lineage_mismatch");
    const systemChanged = createCursorRequest({
      ...parsed,
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-1",
      context: { systemPrompt: ["new system"], messages: covered },
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef: ref },
      },
    });
    expect(systemChanged.continuationMode).toBe("full-replay");
    expect(systemChanged.checkpointInvalidationReason).toBe("lineage_mismatch");
    clearCursorCheckpointsForTests();
  });

  test("reuses a unique covered prefix when chat omits the continuation ref", () => {
    clearCursorCheckpointsForTests();
    const firstTurn = {
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      _cursorIdentityScope: "acct-1",
      context: { messages: [{ role: "user" as const, content: "unique sol prompt 7f3c", timestamp: 1 }] },
    };
    const built = createCursorRequest(firstTurn);
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["unique-sol"],
    }));
    expect(commitCursorCheckpoint({
      conversationId: built.conversationId,
      identityScope: "acct-1",
      modelId: cursorCheckpointModelAffinityId(built.modelId),
      checkpointBytes,
      coveredMessageCount: 1,
      prefixDigest: cursorCoveredPrefixDigest(firstTurn, 1),
      systemDigest: cursorInstructionDigest(firstTurn),
    })).toBeDefined();
    const followUp = createCursorRequest({
      ...firstTurn,
      context: {
        messages: [
          { role: "user", content: "unique sol prompt 7f3c", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "ack" }], timestamp: 2 },
          { role: "user", content: "go on", timestamp: 3 },
        ],
      },
    });
    expect(followUp.continuationMode).toBe("checkpoint");
    expect(followUp.checkpointBytes?.byteLength).toBe(checkpointBytes.byteLength);
    clearCursorCheckpointsForTests();
  });
});
