import { afterEach, describe, expect, test } from "bun:test";
import { buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import {
  clearResponseStateForTests,
  expandPreviousResponseInput,
  previousResponseConversationId,
  rememberResponseState,
} from "../src/responses/state";

describe("Responses previous_response_id state", () => {
  afterEach(() => clearResponseStateForTests());

  test("expands later input with stored prior input and output", () => {
    const firstBody = { model: "cursor/auto", input: "use ping", store: true };
    const first = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"v1\"}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "cursor/auto");
    rememberResponseState(firstBody, first);

    const expanded = expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    }) as { input: unknown[] };

    expect(expanded.input).toEqual([
      { role: "user", content: "use ping" },
      (first.output as unknown[])[0],
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
  });

  test("expanded function_call_output can be parsed with its prior tool metadata", () => {
    const firstBody = { model: "cursor/auto", input: "use ping" };
    const first = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"v1\"}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "cursor/auto");
    rememberResponseState(firstBody, first);

    const parsed = parseRequest(expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    }));

    expect(parsed.context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "ping",
      content: "ok",
    });
  });

  test("store false prevents later expansion", () => {
    const firstBody = { model: "cursor/auto", input: "use ping", store: false };
    const first = buildResponseJSON([
      { type: "text_delta", text: "no store" },
      { type: "done" },
    ], "cursor/auto");
    rememberResponseState(firstBody, first);

    const second = {
      model: "cursor/auto",
      previous_response_id: first.id,
      input: "next",
    };

    expect(expandPreviousResponseInput(second)).toEqual(second);
  });

  test("stores provider conversation id alongside Responses output state", () => {
    const firstBody = { model: "cursor/auto", input: "use ping" };
    const first = buildResponseJSON([
      { type: "text_delta", text: "hello" },
      { type: "done" },
    ], "cursor/auto");

    rememberResponseState(firstBody, first, "cursor_conversation_1");

    expect(previousResponseConversationId(first.id as string)).toBe("cursor_conversation_1");
  });

  test("does not reuse provider conversation id after a client tool-call response", () => {
    const firstBody = { model: "cursor/auto", input: "use ping" };
    const first = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "ping" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "cursor/auto");

    rememberResponseState(firstBody, first, "cursor_conversation_1");

    expect(previousResponseConversationId(first.id as string)).toBeUndefined();
  });
});
