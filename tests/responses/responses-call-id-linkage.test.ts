import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";
describe("Issue #6469: Responses Request Parser & Serializer Offline Regression", () => {
  describe("B. Call ID preservation and linkage", () => {
    test("preserves call_id across serialization and links toolResult correctly", () => {
      const callId = "call_custom_unique_id_xyz";
      const events: AdapterEvent[] = [
        {
          type: "tool_call_start",
          id: callId,
          name: "fetch_record",
        },
        {
          type: "tool_call_delta",
          arguments: JSON.stringify({ record_id: "REC-42" }),
        },
        {
          type: "tool_call_end",
        },
        { type: "done" },
      ];

      const serialized = buildResponseJSON(events, "claude-3-7-sonnet");
      const output = serialized.output as Array<Record<string, unknown>>;
      expect(output[0].call_id).toBe(callId);
      expect(output[0].type).toBe("function_call");
      expect(output[0].name).toBe("fetch_record");

      // Inbound continuation with explicit input items
      const rawInbound = {
        model: "claude-3-7-sonnet",
        input: [
          { role: "user", content: "Fetch record 42" },
          {
            type: "function_call",
            call_id: callId,
            name: "fetch_record",
            arguments: JSON.stringify({ record_id: "REC-42" }),
          },
          {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({ title: "Annual Report" }),
          },
        ],
      };

      const parsed = parseRequest(rawInbound);
      const messages = parsed.context.messages;
      expect(messages.length).toBe(3);

      const assistantMsg = messages[1];
      expect(assistantMsg.role).toBe("assistant");
      const toolCallPart = (assistantMsg.content as Array<Record<string, unknown>>).find(p => p.type === "toolCall");
      expect(toolCallPart?.id).toBe(callId);
      expect(toolCallPart?.name).toBe("fetch_record");

      const toolResultMsg = messages[2] as { role: string; toolCallId: string; toolName: string; content: string };
      expect(toolResultMsg.role).toBe("toolResult");
      expect(toolResultMsg.toolCallId).toBe(callId);
      expect(toolResultMsg.toolName).toBe("fetch_record");
    });
  });

  describe("C. Invalid Call ID cases", () => {
    test("handles unknown call_id without throwing, defaulting toolName to empty", () => {
      const inbound = {
        model: "claude-3-7-sonnet",
        input: [
          { role: "user", content: "Previous question" },
          {
            type: "function_call_output",
            call_id: "call_non_existent_999",
            output: "some result",
          },
        ],
      };

      const parsed = parseRequest(inbound);
      const toolResult = parsed.context.messages.find(m => m.role === "toolResult") as {
        role: string;
        toolCallId: string;
        toolName: string;
        content: string;
      };
      expect(toolResult).toBeDefined();
      expect(toolResult.toolCallId).toBe("call_non_existent_999");
      expect(toolResult.toolName).toBe(""); // Unlinked call produces empty toolName
    });

    test("handles duplicate call IDs accurately across single-turn and multi-turn histories", () => {
      const duplicateId = "call_dup_777";

      // 1. Single assistant turn (consecutive function_calls):
      // findToolById walks backward over messages, but iterates forward across m.content parts,
      // so within the same assistant turn it binds to the first tool_call with that ID.
      const sameTurnInbound = {
        model: "claude-3-7-sonnet",
        input: [
          { role: "user", content: "Start" },
          {
            type: "function_call",
            call_id: duplicateId,
            name: "tool_v1",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: duplicateId,
            name: "tool_v2",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: duplicateId,
            output: "output for tool",
          },
        ],
      };

      const parsedSameTurn = parseRequest(sameTurnInbound);
      const sameTurnResult = parsedSameTurn.context.messages.find(m => m.role === "toolResult") as {
        role: string;
        toolCallId: string;
        toolName: string;
      };
      expect(sameTurnResult).toBeDefined();
      expect(sameTurnResult.toolCallId).toBe(duplicateId);
      expect(sameTurnResult.toolName).toBe("tool_v1"); // First part in m.content

      // 2. Multi-turn history (distinct assistant turns separated by user message):
      // findToolById walks backward over messages, so it binds to the most recent assistant turn's call.
      const multiTurnInbound = {
        model: "claude-3-7-sonnet",
        input: [
          { role: "user", content: "Start" },
          {
            type: "function_call",
            call_id: duplicateId,
            name: "tool_v1",
            arguments: "{}",
          },
          { role: "user", content: "Retry with newer tool" },
          {
            type: "function_call",
            call_id: duplicateId,
            name: "tool_v2",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: duplicateId,
            output: "output for tool",
          },
        ],
      };

      const parsedMultiTurn = parseRequest(multiTurnInbound);
      const multiTurnResult = parsedMultiTurn.context.messages.find(m => m.role === "toolResult") as {
        role: string;
        toolCallId: string;
        toolName: string;
      };
      expect(multiTurnResult).toBeDefined();
      expect(multiTurnResult.toolCallId).toBe(duplicateId);
      expect(multiTurnResult.toolName).toBe("tool_v2"); // Most recent assistant turn
    });

    test("tolerates missing call_id in function_call and function_call_output with undefined id", () => {
      // schema catch-all (z.object({ type: z.string() }).loose()) matches items with missing call_id,
      // so parseRequest does NOT throw; call_id simply resolves to undefined on the parsed part.
      const missingCallIdItem = {
        model: "claude-3-7-sonnet",
        input: [
          { role: "user", content: "Test" },
          {
            type: "function_call",
            name: "lookup_tool",
            arguments: "{}",
            // call_id omitted
          },
        ],
      };

      const parsed = parseRequest(missingCallIdItem);
      const assistantMsg = parsed.context.messages.find(m => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      const toolCallPart = (assistantMsg?.content as Array<Record<string, unknown>>).find(p => p.type === "toolCall");
      expect(toolCallPart?.id).toBeUndefined();

      // function_call_output without call_id likewise resolves to an undefined toolCallId.
      const missingCallIdOutput = {
        model: "claude-3-7-sonnet",
        input: [
          { role: "user", content: "Test" },
          {
            type: "function_call_output",
            output: "output without call_id",
          },
        ],
      };
      const parsedOutput = parseRequest(missingCallIdOutput);
      const toolResult = parsedOutput.context.messages.find(m => m.role === "toolResult") as {
        role: string;
        toolCallId?: string;
        toolName: string;
      };
      expect(toolResult).toBeDefined();
      expect(toolResult.toolCallId).toBeUndefined();
      expect(toolResult.toolName).toBe("");
    });

    test("handles mismatched call_id without corrupting sibling calls", () => {
      const inbound = {
        model: "claude-3-7-sonnet",
        input: [
          { role: "user", content: "Fetch" },
          {
            type: "function_call",
            call_id: "call_alpha",
            name: "alpha_tool",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_beta", // Mismatched
            output: "output for beta",
          },
        ],
      };

      const parsed = parseRequest(inbound);
      const messages = parsed.context.messages;
      const alphaPart = (messages[1].content as Array<Record<string, unknown>>).find(p => p.type === "toolCall");
      expect(alphaPart?.id).toBe("call_alpha");
      expect(alphaPart?.name).toBe("alpha_tool");

      const betaResult = messages[2] as { role: string; toolCallId: string; toolName: string };
      expect(betaResult.toolCallId).toBe("call_beta");
      expect(betaResult.toolName).toBe("");
    });
  });
});
