import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import {
  CURSOR_EXTERNAL_ROOT_BYTE_LIMIT,
  encodeCursorRunRequest,
} from "../src/adapters/cursor/protobuf-request";
import {
  AgentClientMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage } from "../src/types";
import {
  compactComputerUsePayload,
  detectComputerUsePayload,
  formatToolResultToWireText,
  isNodeReplOrComputerUseTool,
  normalizeToolResultContent,
} from "../src/adapters/cursor/tool-result-compaction";

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

function decodeRoots(bytes: Uint8Array): unknown[] {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
  return roots.map(id => JSON.parse(new TextDecoder().decode(blobData(id))));
}

describe("Issue #1866: Cursor adapter tool-result replay for Computer Use / node_repl", () => {
  describe("1. Empty outer exec / node_repl output detection", () => {
    test("identifies node_repl and computer use tools", () => {
      expect(isNodeReplOrComputerUseTool("js", "mcp__node_repl")).toBe(true);
      expect(isNodeReplOrComputerUseTool("mcp__node_repl__js")).toBe(true);
      expect(isNodeReplOrComputerUseTool("get_app_state")).toBe(true);
      expect(isNodeReplOrComputerUseTool("click")).toBe(true);
      expect(isNodeReplOrComputerUseTool("read_file", "mcp__fs")).toBe(false);
    });

    test("converts empty string output from mcp__node_repl__js into a structured error", () => {
      const normalized = normalizeToolResultContent("", "mcp__node_repl", "js", false);
      expect(normalized.isError).toBe(true);
      expect(normalized.text).toContain("empty output: tool executed with no stdout or return value");
      expect(normalized.text).toContain("get_app_state");
    });

    test("converts whitespace-only output from node_repl into a structured error", () => {
      const normalized = normalizeToolResultContent("   \n\t  ", undefined, "mcp__node_repl__js", false);
      expect(normalized.isError).toBe(true);
      expect(normalized.text).toContain("empty output");
    });

    test("converts outer exec '<empty>' wrapper output into a structured error", () => {
      const outerExec = "Script completed Wall time 7.9 seconds\nOutput: <empty>";
      const normalized = normalizeToolResultContent(outerExec, "mcp__node_repl", "js", false);
      expect(normalized.isError).toBe(true);
      expect(normalized.text).toContain("empty output");
    });

    test("leaves ordinary empty output for non-computer-use tools unchanged when isError is false", () => {
      const normalized = normalizeToolResultContent("", "mcp__fs", "touch", false);
      expect(normalized.isError).toBe(false);
      expect(normalized.text).toBe("");
    });
  });

  describe("2. Oversized Computer Use payload compaction", () => {
    test("detects Computer Use payloads by content indicators", () => {
      expect(detectComputerUsePayload("const { sky } = require('@oai/sky');")).toBe(true);
      expect(detectComputerUsePayload("SkyComputerUseError: The user changed '/Applications/Google Chrome.app'")).toBe(true);
      expect(detectComputerUsePayload("Window AXTree: { title: 'GitHub' }")).toBe(true);
      expect(detectComputerUsePayload("plain text without keywords")).toBe(false);
    });

    test("compacts data:image base64 screenshots while keeping AX text", () => {
      const base64Fake = "A".repeat(5000);
      const payload = `AXTree dump:\nWindow title: Chrome - Issue #1866\nURL: https://github.com/lidge-jun/opencodex/issues/1866\nScreenshot: data:image/jpeg;base64,${base64Fake}\nButton: Submit`;
      const compacted = compactComputerUsePayload(payload);
      expect(compacted).not.toContain(base64Fake);
      expect(compacted).toContain("Screenshot image omitted for context budget");
      expect(compacted).toContain("Window title: Chrome - Issue #1866");
      expect(compacted).toContain("https://github.com/lidge-jun/opencodex/issues/1866");
      expect(compacted).toContain("Button: Submit");
    });

    test("compacts JSON screenshot fields with base64 data", () => {
      const base64Fake = "/9j/4AAQSkZJRg" + "A".repeat(10_000);
      const jsonPayload = JSON.stringify({
        app: "Google Chrome",
        url: "https://github.com",
        screenshot: base64Fake,
        elements: [{ role: "button", title: "Sign in" }],
      });
      const compacted = compactComputerUsePayload(jsonPayload);
      expect(compacted).not.toContain(base64Fake);
      expect(compacted).toContain("Screenshot base64 omitted for context budget");
      expect(compacted).toContain("Google Chrome");
      expect(compacted).toContain("Sign in");
    });

    test("structure-aware AX tree summarization preserves window title and URL when over byte budget", () => {
      const lines = [
        "AXTree:",
        "window: Google Chrome - Issue 1866",
        "url: https://github.com/lidge-jun/opencodex/issues/1866",
        ...Array.from({ length: 500 }, (_, i) => `  AXUIElement[${i}]: role=generic_container id=elem_${i} bounds=(0,0,100,20)`),
      ];
      const bigTree = lines.join("\n");
      const compacted = compactComputerUsePayload(bigTree, 2048);
      expect(new TextEncoder().encode(compacted).byteLength).toBeLessThanOrEqual(2048);
      expect(compacted).toContain("window: Google Chrome");
      expect(compacted).toContain("url: https://github.com");
      expect(compacted).toContain("AX tree summarized for Cursor context budget");
      expect(compacted).toContain("truncated for Cursor external replay budget");
    });
  });

  describe("3. SkyComputerUseError / Chrome state change recovery", () => {
    test("marks state change as isError and includes get_app_state instruction", () => {
      const err = "The user changed '/Applications/Google Chrome.app'.";
      const normalized = normalizeToolResultContent(err, "mcp__node_repl", "js", false);
      expect(normalized.isError).toBe(true);
      expect(normalized.text).toContain("SkyComputerUseError");
      expect(normalized.text).toContain("The user changed '/Applications/Google Chrome.app'");
      expect(normalized.text).toContain("Re-query the latest state with `get_app_state` before sending more actions.");
    });

    test("replays SkyComputerUseError in rootPromptMessages as [Tool Error]", () => {
      const rawMessages: OcxMessage[] = [
        { role: "user", content: "click button", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/grok-4.6",
          timestamp: 2,
          content: [{ type: "toolCall", id: "c1", name: "js", namespace: "mcp__node_repl", arguments: { script: "sky.click(1)" } }],
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "js",
          toolNamespace: "mcp__node_repl",
          content: "SkyComputerUseError: The user changed '/Applications/Google Chrome.app'.",
          isError: false,
          timestamp: 3,
        },
      ];

      const bytes = encodeCursorRunRequest({
        modelId: "grok-4.6",
        conversationId: "c_sky_err",
        system: ["system"],
        messages: [{ role: "tool", content: "ignored" }],
        rawMessages,
      });

      const roots = decodeRoots(bytes);
      const serialized = JSON.stringify(roots);
      expect(serialized).toContain("[Tool Error]");
      expect(serialized).toContain("SkyComputerUseError: The user changed '/Applications/Google Chrome.app'");
      expect(serialized).toContain("get_app_state");
    });
  });

  describe("4. node_repl declaration collisions and lost sky bindings", () => {
    test("normalizes Identifier collision error with block scope guidance", () => {
      const err = "Identifier 'state' has already been declared";
      const normalized = normalizeToolResultContent(err, "mcp__node_repl", "js", false);
      expect(normalized.isError).toBe(true);
      expect(normalized.text).toContain("Identifier 'state' has already been declared");
      expect(normalized.text).toContain("use var, reassign without let/const, or wrap the snippet in a block scope");
    });

    test("normalizes missing sky binding error with require('@oai/sky') hint", () => {
      const err = "ReferenceError: sky is not defined";
      const normalized = normalizeToolResultContent(err, "mcp__node_repl", "js", false);
      expect(normalized.isError).toBe(true);
      expect(normalized.text).toContain("sky is not defined");
      expect(normalized.text).toContain("const { sky } = require('@oai/sky');");
    });

    test("normalizes unsupported import in exec error with mcp__node_repl__js hint", () => {
      const err = "unsupported import in exec: @oai/sky";
      const normalized = normalizeToolResultContent(err, undefined, "exec_command", false);
      expect(normalized.isError).toBe(true);
      expect(normalized.text).toContain("unsupported import in exec");
      expect(normalized.text).toContain("use mcp__node_repl__js");
    });
  });

  describe("5. End-to-end Computer Use turn replay on cursor/grok-4.6", () => {
    test("replays oversized get_app_state AX tree + screenshot without exceeding budget and retaining window metadata", () => {
      const axLines = [
        "AXTree snapshot for /Applications/Google Chrome.app:",
        "window: Pull Requests · lidge-jun/opencodex",
        "url: https://github.com/lidge-jun/opencodex/pulls",
        "screenshot: data:image/jpeg;base64," + "B".repeat(200_000),
        ...Array.from({ length: 2000 }, (_, i) => `  AXNode[${i}]: link href="/pull/${i}" title="PR ${i}"`),
      ];
      const getAppStateOutput = axLines.join("\n");

      const rawMessages: OcxMessage[] = [
        { role: "user", content: "inspect open PRs in Chrome", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/grok-4.6",
          timestamp: 2,
          content: [{ type: "toolCall", id: "cu_1", name: "js", namespace: "mcp__node_repl", arguments: { script: "await sky.get_app_state()" } }],
        },
        {
          role: "toolResult",
          toolCallId: "cu_1",
          toolName: "js",
          toolNamespace: "mcp__node_repl",
          content: getAppStateOutput,
          isError: false,
          timestamp: 3,
        },
      ];

      const bytes = encodeCursorRunRequest({
        modelId: "grok-4.6",
        conversationId: "c_cu_full",
        system: ["You are a desktop automation assistant."],
        messages: [{ role: "tool", content: "ignored" }],
        rawMessages,
      });

      const roots = decodeRoots(bytes);
      const serialized = JSON.stringify(roots);

      // Verify budget is strictly honored
      const msg = fromBinary(AgentClientMessageSchema, bytes);
      const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
      const rootBytes = (run?.conversationState?.rootPromptMessagesJson ?? [])
        .reduce((sum, id) => sum + blobData(id).byteLength, 0);
      expect(rootBytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);

      // Verify essential information is preserved
      expect(serialized).toContain("Pull Requests · lidge-jun/opencodex");
      expect(serialized).toContain("https://github.com/lidge-jun/opencodex/pulls");
      expect(serialized).toContain("[Tool Result]");
      expect(serialized).toContain("Screenshot image omitted for context budget");
      expect(serialized).not.toContain("B".repeat(100)); // giant raw base64 stripped
    });

    test("empty outer-exec output after completed nested call surfaces structured error in rootPromptMessagesJson", () => {
      const rawMessages: OcxMessage[] = [
        { role: "user", content: "click submit", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/grok-4.6",
          timestamp: 2,
          content: [{ type: "toolCall", id: "cu_2", name: "js", namespace: "mcp__node_repl", arguments: { script: "await sky.click(14)" } }],
        },
        {
          role: "toolResult",
          toolCallId: "cu_2",
          toolName: "js",
          toolNamespace: "mcp__node_repl",
          content: "Script completed Wall time 7.9 seconds\nOutput: <empty>",
          isError: false,
          timestamp: 3,
        },
      ];

      const bytes = encodeCursorRunRequest({
        modelId: "grok-4.6",
        conversationId: "c_cu_empty",
        system: ["system"],
        messages: [{ role: "tool", content: "ignored" }],
        rawMessages,
      });

      const roots = decodeRoots(bytes);
      const serialized = JSON.stringify(roots);
      expect(serialized).toContain("[Tool Error]");
      expect(serialized).toContain("empty output: tool executed with no stdout or return value");
      expect(serialized).toContain("get_app_state");
    });
  });
});
