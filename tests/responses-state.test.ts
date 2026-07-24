import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { createCursorContextUsageTracker } from "../src/adapters/cursor/protobuf-events";
import { parseRequest } from "../src/responses/parser";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  previousResponseConversationId,
  previousResponseProviderState,
  rememberResponseState,
  responseStateMetrics,
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

  test("force records Kiro provider continuation despite store:false", () => {
    const firstBody = { model: "kiro/gpt-5.6-sol", input: "hello", store: false };
    const first = buildResponseJSON([
      { type: "text_delta", text: "done", phase: "final_answer" },
      { type: "done", endTurn: true },
    ], "kiro/gpt-5.6-sol");
    rememberResponseState(firstBody, first, { kiro: { conversationId: "kiro-conv-1" } }, { force: true });

    expect(previousResponseProviderState(first.id as string)).toEqual({
      kiro: { conversationId: "kiro-conv-1" },
    });
    const expanded = expandPreviousResponseInput({
      model: "kiro/gpt-5.6-sol",
      previous_response_id: first.id,
      input: "next",
      store: false,
    }) as { input: unknown[] };
    expect(expanded.input).toHaveLength(3);
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

  test("v1 Cursor snapshot migrates to versioned provider state", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "responses-state.json"), JSON.stringify({
      version: 1,
      states: [["resp_v1", {
        createdAt: Date.now(),
        items: [{ role: "user", content: "old" }],
        conversationId: "cursor_v1",
        cursorCheckpointUsable: false,
      }]],
    }));

    expect(previousResponseProviderState("resp_v1")).toEqual({
      cursor: { conversationId: "cursor_v1", checkpointUsable: false },
    });
    expect(previousResponseConversationId("resp_v1")).toBe("cursor_v1");
  });

  test("persists provider-keyed Cursor and Kiro continuation state across restart", () => {
    const first = buildResponseJSON([
      { type: "text_delta", text: "answer", phase: "final_answer" },
      { type: "done", endTurn: true },
    ], "kiro/gpt-5.6-sol");
    rememberResponseState(
      { model: "kiro/gpt-5.6-sol", input: "hello" },
      first,
      {
        cursor: { conversationId: "cursor_conv_2" },
        kiro: { conversationId: "kiro_conv_2" },
      },
    );
    flushResponseState();
    clearResponseStateMemoryForTests();

    expect(previousResponseProviderState(first.id as string)).toEqual({
      cursor: { conversationId: "cursor_conv_2", checkpointUsable: true },
      kiro: { conversationId: "kiro_conv_2" },
    });
    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as { version: number };
    expect(snapshot.version).toBe(2);
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

  test("replayed compaction marker preserves post-compaction Cursor usage while a new marker resets it", () => {
    const conversationId = "cursor_conversation_1";
    const firstBody = {
      model: "cursor/auto",
      input: [
        { type: "context_compaction" },
        { type: "message", role: "user", content: "post-compaction turn" },
      ],
    };
    const first = buildResponseJSON([
      { type: "text_delta", text: "post-compaction answer" },
      { type: "done" },
    ], "cursor/auto");
    rememberResponseState(firstBody, first, conversationId);

    const tracker = createCursorContextUsageTracker();
    tracker.record(conversationId, 5_000);

    const replayed = parseRequest(expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: first.id,
      input: [{ type: "message", role: "user", content: "next turn" }],
    }));
    const replayedRequest = createCursorRequest({ ...replayed, _cursorConversationId: conversationId });
    expect(replayed._contextCompactionBoundary).toBeUndefined();
    expect(replayedRequest.contextUsageReset).toBeUndefined();
    expect(tracker.controlsForConversation(conversationId, {
      clearPrior: replayedRequest.contextUsageReset === true,
    }).carryForwardTokens).toBe(5_000);

    const newlyCompacted = parseRequest(expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: first.id,
      input: [
        { type: "context_compaction" },
        { type: "message", role: "user", content: "new compacted epoch" },
      ],
    }));
    const newlyCompactedRequest = createCursorRequest({ ...newlyCompacted, _cursorConversationId: conversationId });
    expect(newlyCompacted._contextCompactionBoundary).toBe(true);
    expect(newlyCompactedRequest.contextUsageReset).toBe(true);
    expect(tracker.controlsForConversation(conversationId, {
      clearPrior: newlyCompactedRequest.contextUsageReset === true,
    }).carryForwardTokens).toBeUndefined();
  });

  test("responseStateMetrics reports an empty store as zeroed", () => {
    expect(responseStateMetrics()).toEqual({
      count: 0,
      totalBytes: 0,
      largestBytes: 0,
      oldestAgeMs: 0,
    });
  });

  test("responseStateMetrics counts entries and tracks the largest by serialized bytes", () => {
    const small = buildResponseJSON([{ type: "text_delta", text: "hi" }, { type: "done" }], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "small" }, small);

    const bigText = "y".repeat(200 * 1024);
    const big = buildResponseJSON([{ type: "text_delta", text: bigText }, { type: "done" }], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "big" }, big);

    const metrics = responseStateMetrics();
    expect(metrics.count).toBe(2);
    expect(metrics.largestBytes).toBeGreaterThan(200 * 1024);
    expect(metrics.totalBytes).toBeGreaterThanOrEqual(metrics.largestBytes);
    expect(metrics.oldestAgeMs).toBeGreaterThanOrEqual(0);
  });

  test("responseStateMetrics is side-effect free (does not lazy-load the disk snapshot)", () => {
    // Seed a snapshot on disk, then wipe memory. A pure metrics read must NOT resurrect it: it
    // reflects live RAM only, so a diagnostics probe never perturbs the store or triggers a load.
    const first = buildResponseJSON([{ type: "text_delta", text: "persisted" }, { type: "done" }], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "hi" }, first);
    flushResponseState();
    clearResponseStateMemoryForTests();

    expect(responseStateMetrics().count).toBe(0);

    // A real read path still loads it, proving the snapshot was intact and metrics simply abstained.
    expect((expandPreviousResponseInput({
      model: "gpt-5.5", previous_response_id: first.id, input: "next",
    }) as { input: unknown[] }).input).toHaveLength(3);
    expect(responseStateMetrics().count).toBe(1);
  });
});
