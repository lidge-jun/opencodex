import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { createCursorContextUsageTracker } from "../src/adapters/cursor/protobuf-events";
import { parseRequest } from "../src/responses/parser";
import { createSseInspector } from "../src/server/relay";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  previousResponseConversationId,
  previousResponseProviderState,
  rememberResponseState,
  setResponseStateByteCapForTests,
  getStoredResponseBytesForTests,
} from "../src/responses/state";
import { adapterNeedsForcedContinuation, injectDeveloperMessage } from "../src/server/responses";

function feedInspector(
  inspector: ReturnType<typeof createSseInspector>,
  events: Array<Record<string, unknown> | "[DONE]">,
): void {
  const encoder = new TextEncoder();
  for (const event of events) {
    const payload = typeof event === "string" ? event : JSON.stringify(event);
    inspector.feed(encoder.encode(`data: ${payload}\n\n`));
  }
  inspector.finish();
}

function isExactGuidanceItem(item: unknown, text: string): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  if (record.type !== "message" || record.role !== "developer" || !Array.isArray(record.content)) return false;
  if (record.content.length !== 1) return false;
  const part = record.content[0];
  return !!part && typeof part === "object" && !Array.isArray(part)
    && (part as Record<string, unknown>).type === "input_text"
    && (part as Record<string, unknown>).text === text;
}

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

  test("SSE inspector backfills empty completed output before passthrough persistence (#334)", () => {
    const requestBody = {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "start" }] }],
    };
    const reasoning = { type: "reasoning", id: "rs_334", summary: [{ type: "summary_text", text: "think" }] };
    const message = {
      type: "message",
      id: "msg_334",
      role: "assistant",
      content: [{ type: "output_text", text: "working" }],
    };
    const call = {
      type: "function_call",
      id: "fc_334",
      call_id: "call_334",
      name: "lookup",
      arguments: "{}",
    };
    let callbacks = 0;
    const inspector = createSseInspector({
      onCompletedResponse: response => {
        callbacks += 1;
        rememberResponseState(requestBody, response, undefined, { force: true });
      },
    });

    feedInspector(inspector, [
      { type: "response.output_item.done", output_index: 2, item: call },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 1, item: message },
      { type: "response.completed", response: { id: "resp_334_inspection", status: "completed", output: [] } },
      "[DONE]",
    ]);

    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: "resp_334_inspection",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
    }) as { input: Array<{ type?: string }> };
    expect(callbacks).toBe(1);
    expect(expanded.input.slice(1, -1).map(item => item.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
  });

  test("non-empty completed output remains authoritative over accumulated done items (#334)", () => {
    const requestBody = { model: "gpt-5.5", input: "start" };
    const accumulated = {
      type: "function_call",
      call_id: "call_accumulated",
      name: "must_not_replay",
      arguments: "{}",
    };
    const terminalOutput = [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "terminal wins" }],
    }];
    let captured: { output?: unknown } | undefined;
    const inspector = createSseInspector({
      onCompletedResponse: response => {
        captured = response;
        rememberResponseState(requestBody, response, undefined, { force: true });
      },
    });

    feedInspector(inspector, [
      { type: "response.output_item.done", output_index: 0, item: accumulated },
      { type: "response.completed", response: { id: "resp_334_authoritative", status: "completed", output: terminalOutput } },
    ]);

    expect(captured?.output).toEqual(terminalOutput);
    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: "resp_334_authoritative",
      input: "next",
    }) as { input: Array<Record<string, unknown>> };
    expect(expanded.input.some(item => item.type === "message" && item.role === "assistant")).toBe(true);
    expect(expanded.input.some(item => item.type === "function_call" && item.name === "must_not_replay")).toBe(false);
  });

  test("two previous_response_id continuations keep one replayed guidance item (#326)", () => {
    const guidance = "Use the delegated agent workflow.";
    const countRawGuidance = (body: unknown): number => {
      const input = (body as { input?: unknown }).input;
      return Array.isArray(input) ? input.filter(item => isExactGuidanceItem(item, guidance)).length : 0;
    };
    const countParsedGuidance = (parsed: ReturnType<typeof parseRequest>): number => parsed.context.messages
      .filter(message => message.role === "developer" && message.content === guidance).length;

    const request1 = { model: "gpt-5.5", input: [{ type: "message", role: "user", content: "start" }] };
    const parsed1 = parseRequest(request1);
    injectDeveloperMessage(parsed1, guidance);
    expect(countRawGuidance(request1)).toBe(1);
    const response1 = {
      id: "resp_326_1",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_326", name: "lookup", arguments: "{}" }],
    };
    rememberResponseState(request1, response1, undefined, { force: true });

    const request2 = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: response1.id,
      input: [{ type: "function_call_output", call_id: "call_326", output: "ok" }],
    });
    const parsed2 = parseRequest(request2);
    expect(parsed2._replayPrefixLen).toBe(3);
    const request2Input = (request2 as { input: Array<Record<string, unknown>> }).input;
    expect(request2Input[1]).toMatchObject({ role: "developer" });
    expect(request2Input[2]).toMatchObject({ type: "function_call" });
    injectDeveloperMessage(parsed2, guidance);
    expect(countRawGuidance(request2)).toBe(1);
    expect(countParsedGuidance(parsed2)).toBe(1);
    const response2 = {
      id: "resp_326_2",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
    };
    rememberResponseState(request2, response2, undefined, { force: true });

    const request3 = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: response2.id,
      input: [{ type: "message", role: "user", content: "again" }],
    });
    const parsed3 = parseRequest(request3);
    injectDeveloperMessage(parsed3, guidance);
    expect(countRawGuidance(request3)).toBe(1);
    expect(countParsedGuidance(parsed3)).toBe(1);
    const response3 = {
      id: "resp_326_3",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "finished" }] }],
    };
    rememberResponseState(request3, response3, undefined, { force: true });

    const audit = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: response3.id,
      input: [{ type: "message", role: "user", content: "audit" }],
    });
    expect(countRawGuidance(audit)).toBe(1);
  });

  test("duplicate output_index keeps only the final done item (#334)", () => {
    const requestBody = { model: "gpt-5.5", input: "start" };
    const inspector = createSseInspector({
      onCompletedResponse: response => rememberResponseState(requestBody, response, undefined, { force: true }),
    });
    feedInspector(inspector, [
      {
        type: "response.output_item.done",
        output_index: 2,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "stale sentinel" }] },
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: { type: "function_call", call_id: "call_final", name: "final_lookup", arguments: "{}" },
      },
      { type: "response.completed", response: { id: "resp_334_duplicate", status: "completed", output: [] } },
    ]);

    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: "resp_334_duplicate",
      input: "next",
    }) as { input: Array<Record<string, unknown>> };
    const calls = expanded.input.filter(item => item.type === "function_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call_id: "call_final", name: "final_lookup" });
    expect(JSON.stringify(expanded.input)).not.toContain("stale sentinel");
  });

  test("malformed output_item.done events do not enter reconstructed output (#334)", () => {
    const requestBody = { model: "gpt-5.5", input: "start" };
    let callbacks = 0;
    let captured: unknown;
    const inspector = createSseInspector({
      onCompletedResponse: response => {
        callbacks += 1;
        captured = response.output;
        rememberResponseState(requestBody, response, undefined, { force: true });
      },
    });
    const valid = { type: "message", role: "assistant", content: [{ type: "output_text", text: "valid" }] };
    feedInspector(inspector, [
      { type: "response.output_item.done", output_index: 0, item: valid },
      { type: "response.output_item.done", item: valid },
      { type: "response.output_item.done", output_index: -1, item: valid },
      { type: "response.output_item.done", output_index: 1.5, item: valid },
      { type: "response.output_item.done", output_index: "1", item: valid },
      { type: "response.output_item.done", output_index: 1 },
      { type: "response.output_item.done", output_index: 1, item: null },
      { type: "response.output_item.done", output_index: 1, item: "text" },
      { type: "response.output_item.done", output_index: 1, item: 42 },
      { type: "response.output_item.done", output_index: 1, item: [] },
      { type: "response.output_item.done", output_index: 1, item: {} },
      { type: "response.output_item.done", output_index: 1, item: { type: 42 } },
      { type: "response.completed", response: { id: "resp_334_malformed_done", status: "completed", output: [] } },
    ]);

    expect(callbacks).toBe(1);
    expect(captured).toEqual([valid]);
    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: "resp_334_malformed_done",
      input: "next",
    }) as { input: Array<Record<string, unknown>> };
    expect(expanded.input.filter(item => item.role === "assistant")).toHaveLength(1);
  });

  test("malformed SSE payload is skipped before a valid completed response (#334)", () => {
    const requestBody = { model: "gpt-5.5", input: "start" };
    let callbacks = 0;
    const inspector = createSseInspector({
      onCompletedResponse: response => {
        callbacks += 1;
        rememberResponseState(requestBody, response, undefined, { force: true });
      },
    });
    inspector.feed(new TextEncoder().encode("data: {not-json}\n\n"));
    feedInspector(inspector, [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "survived" }] },
      },
      { type: "response.completed", response: { id: "resp_334_malformed_sse", status: "completed", output: [] } },
    ]);

    expect(callbacks).toBe(1);
    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: "resp_334_malformed_sse",
      input: "next",
    }) as { input: Array<Record<string, unknown>> };
    expect(expanded.input.some(item => item.role === "assistant")).toBe(true);
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

  test("force records Cursor provider continuation despite store:false", () => {
    const firstBody = { model: "cursor/grok-4.5", input: "hello", store: false };
    const first = buildResponseJSON([
      { type: "text_delta", text: "hi" },
      { type: "done" },
    ], "cursor/grok-4.5");
    rememberResponseState(firstBody, first, { cursor: { conversationId: "cursor_conv_force_1" } }, { force: true });

    expect(previousResponseProviderState(first.id as string)?.cursor?.conversationId)
      .toBe("cursor_conv_force_1");
  });

  test("adapterNeedsForcedContinuation covers exactly kiro and cursor", () => {
    expect(adapterNeedsForcedContinuation("kiro")).toBe(true);
    expect(adapterNeedsForcedContinuation("cursor")).toBe(true);
    expect(adapterNeedsForcedContinuation("openai")).toBe(false);
    expect(adapterNeedsForcedContinuation("claude")).toBe(false);
    expect(adapterNeedsForcedContinuation("")).toBe(false);
  });

  test("byte cap evicts oldest entries while the newest chain link survives", () => {
    setResponseStateByteCapForTests(4_000);
    try {
      const bulk = "x".repeat(1_500);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const body = { model: "cursor/grok-4.5", input: `${bulk}-${i}`, store: false };
        const json = buildResponseJSON([
          { type: "text_delta", text: "ok" },
          { type: "done" },
        ], "cursor/grok-4.5");
        rememberResponseState(body, json, { cursor: { conversationId: `conv_${i}` } }, { force: true });
        ids.push(json.id as string);
      }
      // Oldest entries were evicted by the byte high-water; the newest survives.
      expect(previousResponseProviderState(ids[0])).toBeUndefined();
      expect(previousResponseProviderState(ids[3])?.cursor?.conversationId).toBe("conv_3");
    } finally {
      setResponseStateByteCapForTests(null);
    }
  });

  test("byte accounting survives restart (sizes recomputed on load)", () => {
    setResponseStateByteCapForTests(4_000);
    try {
      const bulk = "y".repeat(1_500);
      const bodyA = { model: "cursor/grok-4.5", input: `${bulk}-a`, store: false };
      const jsonA = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
      rememberResponseState(bodyA, jsonA, { cursor: { conversationId: "conv_a" } }, { force: true });
      flushResponseState();

      // Simulated restart: memory wiped, snapshot reloaded lazily.
      clearResponseStateMemoryForTests();
      expect(previousResponseProviderState(jsonA.id as string)?.cursor?.conversationId).toBe("conv_a");

      // Post-restart stores still enforce the cap against recomputed sizes.
      const bodyB = { model: "cursor/grok-4.5", input: `${bulk}-b1`, store: false };
      const jsonB = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
      rememberResponseState(bodyB, jsonB, { cursor: { conversationId: "conv_b1" } }, { force: true });
      const bodyC = { model: "cursor/grok-4.5", input: `${bulk}-b2`, store: false };
      const jsonC = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
      rememberResponseState(bodyC, jsonC, { cursor: { conversationId: "conv_b2" } }, { force: true });

      expect(previousResponseProviderState(jsonA.id as string)).toBeUndefined();
      expect(previousResponseProviderState(jsonC.id as string)?.cursor?.conversationId).toBe("conv_b2");
    } finally {
      setResponseStateByteCapForTests(null);
    }
  });

  test("re-remembering the same response id does not double-count bytes", () => {
    setResponseStateByteCapForTests(10_000);
    try {
      const bulk = "z".repeat(2_000);
      const body = { model: "cursor/grok-4.5", input: bulk, store: false };
      const json = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
      // Same id stored repeatedly: without replacement dedup this would trip the cap.
      for (let i = 0; i < 4; i++) {
        rememberResponseState(body, json, { cursor: { conversationId: `conv_r${i}` } }, { force: true });
      }
      expect(previousResponseProviderState(json.id as string)?.cursor?.conversationId).toBe("conv_r3");
    } finally {
      setResponseStateByteCapForTests(null);
    }
  });

  test("count-prune eviction releases byte accounting (no phantom debt)", () => {
    // Cap far above total volume so ONLY count pruning (MAX_STORED_RESPONSES=1000)
    // evicts; the byte pruner never fires and cannot mask a leaked decrement.
    setResponseStateByteCapForTests(1_000_000_000);
    try {
      const bulk = "c".repeat(2_000);
      let lastId = "";
      let perEntryBytes = 0;
      for (let i = 0; i < 1_050; i++) {
        const body = { model: "cursor/grok-4.5", input: `${bulk}-000${String(i % 10)}`, store: false };
        const json = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
        rememberResponseState(body, json, { cursor: { conversationId: `conv_c${i}` } }, { force: true });
        lastId = json.id as string;
        if (perEntryBytes === 0) perEntryBytes = getStoredResponseBytesForTests();
      }
      expect(previousResponseProviderState(lastId)?.cursor?.conversationId).toBe("conv_c1049");
      // Direct accounting proof: 1050 stores with 50 count-prune evictions must
      // leave exactly ~1000 entries' worth of bytes. Fixed-width inputs keep every
      // entry the same size, so leaked decrements would show up as >1000x.
      const total = getStoredResponseBytesForTests();
      expect(perEntryBytes).toBeGreaterThan(2_000);
      expect(total).toBeLessThanOrEqual(perEntryBytes * 1_000);
      expect(total).toBeGreaterThanOrEqual(perEntryBytes * 999);
    } finally {
      setResponseStateByteCapForTests(null);
    }
  });

  test("TTL-prune eviction releases byte accounting", () => {
    setResponseStateByteCapForTests(10_000);
    try {
      const realNow = Date.now;
      try {
        // Store an old heavy entry, then advance time past the 1h TTL.
        Date.now = () => realNow() - 2 * 60 * 60 * 1_000;
        const oldBody = { model: "cursor/grok-4.5", input: "o".repeat(6_000), store: false };
        const oldJson = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
        rememberResponseState(oldBody, oldJson, { cursor: { conversationId: "conv_old" } }, { force: true });

        Date.now = realNow;
        // TTL prune removes the old entry; if its ~6KB were leaked as phantom debt,
        // this fresh ~3KB entry would immediately trip the 10KB cap and be evicted.
        const newBody = { model: "cursor/grok-4.5", input: "n".repeat(3_000), store: false };
        const newJson = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
        rememberResponseState(newBody, newJson, { cursor: { conversationId: "conv_new" } }, { force: true });

        expect(previousResponseProviderState(oldJson.id as string)).toBeUndefined();
        expect(previousResponseProviderState(newJson.id as string)?.cursor?.conversationId).toBe("conv_new");
        // Direct accounting proof: only the fresh entry's bytes remain (~3KB < 6KB old entry).
        expect(getStoredResponseBytesForTests()).toBeLessThan(6_000);
        expect(getStoredResponseBytesForTests()).toBeGreaterThan(0);
      } finally {
        Date.now = realNow;
      }
    } finally {
      setResponseStateByteCapForTests(null);
    }
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
});
