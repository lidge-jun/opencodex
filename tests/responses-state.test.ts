import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  previousResponseConversationId,
  previousResponseCursorContextTokens,
  rememberResponseState,
} from "../src/responses/state";

describe("Responses previous_response_id state", () => {
  // Sandbox OPENCODEX_HOME: the state store now snapshots to disk, and these tests must never
  // touch the real ~/.opencodex.
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-test-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
  });

  afterEach(() => {
    clearResponseStateForTests();
    rmSync(home, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

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

  test("force records despite store:false (passthrough continuation cache)", () => {
    const firstBody = { model: "gpt-5.5", input: "hello", store: false };
    const first = buildResponseJSON([
      { type: "text_delta", text: "hi there" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState(firstBody, first, undefined, { force: true });

    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: first.id,
      input: [{ role: "user", content: "next" }],
    }) as { input: unknown[] };

    expect(expanded.input).toEqual([
      { role: "user", content: "hello" },
      (first.output as unknown[])[0],
      { role: "user", content: "next" },
    ]);
  });

  test("snapshot survives a simulated restart (memory clear + disk load)", () => {
    const firstBody = { model: "gpt-5.5", input: "hello" };
    const first = buildResponseJSON([
      { type: "text_delta", text: "hi" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState(firstBody, first, "cursor_conv_9");
    flushResponseState();

    // Simulate restart: wipe memory, keep the snapshot file.
    clearResponseStateMemoryForTests();

    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: first.id,
      input: [{ role: "user", content: "next" }],
    }) as { input: unknown[] };

    expect(expanded.input).toEqual([
      { role: "user", content: "hello" },
      (first.output as unknown[])[0],
      { role: "user", content: "next" },
    ]);
    expect(previousResponseConversationId(first.id as string)).toBe("cursor_conv_9");
  });

  test("stale snapshot entries are pruned on load", () => {
    const first = buildResponseJSON([
      { type: "text_delta", text: "old" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "old turn" }, first);
    flushResponseState();
    clearResponseStateMemoryForTests();

    // Rewrite the snapshot with an expired createdAt (2h ago > 1h TTL).
    const path = join(home, "responses-state.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8")) as {
      states: [string, { createdAt: number }][];
    };
    for (const [, state] of snapshot.states) state.createdAt = Date.now() - 2 * 60 * 60 * 1_000;
    writeFileSync(path, JSON.stringify(snapshot));

    const second = {
      model: "gpt-5.5",
      previous_response_id: first.id,
      input: "next",
    };
    expect(expandPreviousResponseInput(second)).toEqual(second);
  });

  test("corrupt snapshot file is ignored", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "responses-state.json"), "{not json!!");

    const second = {
      model: "gpt-5.5",
      previous_response_id: "resp_nope",
      input: "next",
    };
    expect(expandPreviousResponseInput(second)).toEqual(second);

    // Store still functions after the failed load.
    const first = buildResponseJSON([
      { type: "text_delta", text: "fresh" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "hi" }, first);
    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: first.id,
      input: "next",
    }) as { input: unknown[] };
    expect(expanded.input).toHaveLength(3);
  });

  test("oversized entries stay in memory but are skipped on disk", () => {
    const big = "x".repeat(3 * 1024 * 1024); // > 2MiB per-entry cap
    const first = buildResponseJSON([
      { type: "text_delta", text: big },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "big turn" }, first);

    const small = buildResponseJSON([
      { type: "text_delta", text: "small" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "small turn" }, small);
    flushResponseState();

    // In-memory: both expand.
    expect((expandPreviousResponseInput({
      model: "gpt-5.5", previous_response_id: first.id, input: "n",
    }) as { input: unknown[] }).input).toHaveLength(3);

    // After restart: only the small entry survived on disk.
    clearResponseStateMemoryForTests();
    const bigMiss = { model: "gpt-5.5", previous_response_id: first.id, input: "n" };
    expect(expandPreviousResponseInput(bigMiss)).toEqual(bigMiss);
    expect((expandPreviousResponseInput({
      model: "gpt-5.5", previous_response_id: small.id, input: "n",
    }) as { input: unknown[] }).input).toHaveLength(3);
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

  test("stores the last reported Cursor context total alongside the Responses chain", () => {
    const first = buildResponseJSON([
      { type: "text_delta", text: "done" },
      { type: "done", usage: { inputTokens: 119_900, outputTokens: 100, totalTokens: 120_000, estimated: true } },
    ], "cursor/grok-4.5");

    rememberResponseState({ model: "cursor/grok-4.5", input: "work" }, first, "cursor_conversation_1");
    flushResponseState();
    clearResponseStateMemoryForTests();

    expect(previousResponseCursorContextTokens(first.id as string)).toBe(120_000);
  });

  test("preserves provider conversation id after a client tool-call response (multi-turn continuation)", () => {
    const firstBody = { model: "cursor/auto", input: "use ping" };
    const first = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "ping" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "cursor/auto");

    rememberResponseState(firstBody, first, "cursor_conversation_1");

    // The conversation id MUST survive a tool-call response so the following tool-result turn
    // continues the SAME Cursor conversation. The Cursor checkpoint is not reusable (the agent turn
    // was suspended without a real mcpResult), but the conversation id string itself is preserved.
    expect(previousResponseConversationId(first.id as string)).toBe("cursor_conversation_1");
  });
});
