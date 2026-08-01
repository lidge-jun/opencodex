import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BULK_DURABLE_IO_BUDGET_MS } from "./helpers/test-budget";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  evictOldestResponseContinuationForBudget,
  expandPreviousResponseInput,
  flushResponseState,
  previousResponseConversationId,
  previousResponseProviderState,
  previousResponseReplayFailure,
  previousResponseReplayPrefixLength,
  recoverStaleResponseStateTemps,
  rememberResponseState,
  responseStateMetrics,
  responseStatePersistPendingForTests,
  responseContinuationRetainedStoreSnapshot,
  runPendingResponseStatePersistForTests,
  setResponseStateByteCapForTests,
  setResponseStatePersistAttemptHookForTests,
  getStoredResponseBytesForTests,
} from "../src/responses/state";
import {
  readResponseSpill,
  deleteResponseSpill,
  recoverOrphanedResponseSpills,
  responseSpillDirectory,
  setSpillIoForTest,
  writeResponseSpillDurably,
} from "../src/responses/spill-store";
import { adapterNeedsForcedContinuation, injectDeveloperMessage } from "../src/server/responses";
import {
  hardenSecretPath,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";

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

function fixedResponse(id: string, output: unknown[]): { id: string; output: unknown[]; status: string } {
  return { id, output, status: "completed" };
}

function spillFileNames(home: string): string[] {
  const dir = responseSpillDirectory(home);
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".spill.json")) : [];
}

function rememberLarge(id: string, text: string, providers?: Parameters<typeof rememberResponseState>[2]): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    fixedResponse(id, [{ type: "message", role: "assistant", content: text }]),
    providers,
    { force: true },
  );
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
    setSpillIoForTest(null);
    setIcaclsRunnerForTests(null);
    setPlatformForTests(null);
    resetHardenedStateForTests();
    setResponseStateByteCapForTests(null);
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

  test("stores incomplete partial output for previous_response_id replay", () => {
    const partial = {
      type: "message",
      id: "msg_incomplete",
      role: "assistant",
      content: [{ type: "output_text", text: "partial answer" }],
    };
    rememberResponseState(
      { model: "cursor/auto", input: "start" },
      {
        id: "resp_incomplete",
        status: "incomplete",
        output: [partial],
        incomplete_details: { reason: "max_output_tokens" },
      },
    );

    const expanded = expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: "resp_incomplete",
      input: "continue",
    }) as { input: unknown[] };

    expect(expanded.input).toEqual([
      { role: "user", content: "start" },
      partial,
      { role: "user", content: "continue" },
    ]);
  });

  test("does not store content-filtered incomplete output for previous_response_id replay", () => {
    const next = {
      model: "cursor/auto",
      previous_response_id: "resp_content_filter",
      input: "continue safely",
    };
    rememberResponseState(
      { model: "cursor/auto", input: "start" },
      {
        id: "resp_content_filter",
        status: "incomplete",
        output: [{ type: "message", role: "assistant", content: "filtered partial" }],
        incomplete_details: { reason: "content_filter" },
      },
    );

    expect(expandPreviousResponseInput(next)).toEqual(next);
  });

  test("does not store failed partial output for previous_response_id replay", () => {
    const next = {
      model: "cursor/auto",
      previous_response_id: "resp_failed",
      input: "retry",
    };
    rememberResponseState(
      { model: "cursor/auto", input: "start" },
      {
        id: "resp_failed",
        status: "failed",
        output: [{ type: "message", role: "assistant", content: "do not replay" }],
      },
    );

    expect(expandPreviousResponseInput(next)).toEqual(next);
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

  test("tainted inspector reconstruction never persists a truncated replay", () => {
    const requestBody = { model: "gpt-5.5", input: "start" };
    let callbacks = 0;
    const inspector = createSseInspector({
      onCompletedResponse: response => {
        callbacks += 1;
        rememberResponseState(requestBody, response, undefined, { force: true });
      },
    });
    const events: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 257; index += 1) {
      events.push({
        type: "response.output_item.done",
        output_index: index,
        item: { type: "message", id: `tainted-${index}`, role: "assistant", content: [] },
      });
    }
    events.push({
      type: "response.completed",
      response: { id: "resp_tainted_reconstruction", status: "completed", output: [] },
    });
    feedInspector(inspector, events);

    const next = {
      model: "gpt-5.5",
      previous_response_id: "resp_tainted_reconstruction",
      input: "continue",
    };
    expect(callbacks).toBe(0);
    expect(expandPreviousResponseInput(next)).toEqual(next);
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

  test("spills the only oversized continuation and leaves resident bytes at or below cap", () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_only_oversized", "x".repeat(8_000));
    const metrics = responseStateMetrics();
    expect(metrics).toMatchObject({ count: 1, residentCount: 0, spillStubCount: 1 });
    expect(metrics.totalBytes).toBeLessThanOrEqual(1_024);
    expect((expandPreviousResponseInput({
      previous_response_id: "resp_only_oversized", input: "next",
    }) as { input: unknown[] }).input).toHaveLength(3);
  });

  test("does not swap a resident row to a stub before fsync and no-replace publication succeed", () => {
    const events: string[] = [];
    setSpillIoForTest({ record: event => events.push(event) });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_durable_order", "x".repeat(8_000));
    expect(events).toEqual(["write", "fsync", "close", "harden", "publish", "dir-fsync", "stub-swap"]);
  });

  test("directory fsync follows spill unlink", () => {
    const ref = writeResponseSpillDurably("resp_unlink_order", { createdAt: Date.now(), items: ["x"] });
    const events: string[] = [];
    setSpillIoForTest({ record: event => events.push(event) });
    deleteResponseSpill(ref);
    expect(events).toEqual(["dir-fsync"]);
  });

  test("spill temp cleanup forgets successful ACL memos and retains failed removals", () => {
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    const seedTempMemo = (event: string): void => {
      if (event !== "harden") return;
      const tempName = readdirSync(responseSpillDirectory(home)).find(name => name.endsWith(".tmp"));
      expect(tempName).toBeTruthy();
      hardenSecretPath(join(responseSpillDirectory(home), tempName!), { required: true });
    };
    try {
      setSpillIoForTest({ record: seedTempMemo });
      writeResponseSpillDurably("resp_acl_success", { createdAt: Date.now(), items: ["success"] });
      expect(hardenedSecretPathCountForTests()).toBe(0);

      setSpillIoForTest({
        record: seedTempMemo,
        unlink: () => { throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" }); },
      });
      expect(() => writeResponseSpillDurably("resp_acl_failure", {
        createdAt: Date.now(),
        items: ["failure"],
      })).toThrow("Response spill write failed");
      expect(hardenedSecretPathCountForTests()).toBe(1);
    } finally {
      setSpillIoForTest(null);
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("replays provider metadata and function_call_output history through a spill stub", () => {
    setResponseStateByteCapForTests(1_024);
    rememberResponseState(
      { input: "x".repeat(8_000), store: false },
      fixedResponse("resp_spill_tool", [{ type: "function_call", call_id: "call_1", name: "ping", arguments: "{}" }]),
      { cursor: { conversationId: "cursor-spill" } },
      { force: true },
    );
    const expanded = expandPreviousResponseInput({
      previous_response_id: "resp_spill_tool",
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    }) as { input: unknown[] };
    expect(previousResponseProviderState("resp_spill_tool")?.cursor?.conversationId).toBe("cursor-spill");
    expect(expanded.input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
  });

  test("replays a durable spill after simulated process restart", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_spill_restart", "r".repeat(8_000));
    await flushResponseState();
    clearResponseStateMemoryForTests();
    setResponseStateByteCapForTests(1_024);
    const expanded = expandPreviousResponseInput({ previous_response_id: "resp_spill_restart", input: "next" });
    expect((expanded as { input: unknown[] }).input).toHaveLength(3);
    expect(responseStateMetrics().spillStubCount).toBe(1);
  });

  test("spill references bind the expected response id and use the locked digest basename", () => {
    const ref = writeResponseSpillDurably("resp_identity", {
      createdAt: Date.now(),
      items: ["payload"],
    });
    expect(ref.fileName).toMatch(/\.[0-9a-f]{12}\.[0-9a-f]{24}\.\d+\.\d+\.spill\.json$/);
    expect(readResponseSpill("resp_identity", ref).ok).toBe(true);
    expect(readResponseSpill("resp_other", ref)).toEqual({ ok: false, reason: "corrupt" });
  });

  test("returns previous_response_not_found for a missing spill file without forwarding delta", () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_missing_spill", "m".repeat(8_000));
    const file = spillFileNames(home)[0]!;
    unlinkSync(join(responseSpillDirectory(home), file));
    const body = { previous_response_id: "resp_missing_spill", input: "delta" };
    expect(expandPreviousResponseInput(body)).toBe(body);
    expect(previousResponseReplayFailure(body)).toEqual({
      code: "previous_response_not_found", reason: "spill_missing",
    });
    expect(responseStateMetrics()).toMatchObject({ spillStubCount: 0, tombstoneCount: 1, spillReadFailures: 1 });
  });

  test("returns previous_response_not_found for a corrupt or digest-mismatched spill", () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_corrupt_spill", "c".repeat(8_000));
    const path = join(responseSpillDirectory(home), spillFileNames(home)[0]!);
    const size = readFileSync(path).byteLength;
    writeFileSync(path, "z".repeat(size));
    const body = { previous_response_id: "resp_corrupt_spill", input: "delta" };
    expect(expandPreviousResponseInput(body)).toBe(body);
    expect(previousResponseReplayFailure(body)?.reason).toBe("spill_corrupt");
  });

  test("spill write failure evicts resident bytes and records one bounded tombstone", () => {
    setSpillIoForTest({ write: () => { throw new Error("injected write failure"); } });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_write_failure", "w".repeat(8_000));
    const metrics = responseStateMetrics();
    expect(metrics).toMatchObject({ count: 1, residentCount: 0, tombstoneCount: 1, spillWriteFailures: 1 });
    expect(metrics.totalBytes).toBeLessThanOrEqual(1_024);
  });

  test("disk permission failure increments spillWriteFailures without retaining payload", () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    setSpillIoForTest({ write: () => { throw denied; } });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_permission_failure", "p".repeat(8_000));
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, tombstoneCount: 1, spillWriteFailures: 1 });
  });

  test("replacing a response id deletes its previous dedicated spill file after the snapshot flush", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_replace_spill", "a".repeat(8_000));
    const old = spillFileNames(home)[0]!;
    rememberLarge("resp_replace_spill", "b".repeat(8_000));
    // The superseded generation survives until the debounced snapshot is
    // durable (crash safety: a pre-flush reload must find the OLD file).
    expect(existsSync(join(responseSpillDirectory(home), old))).toBe(true);
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), old))).toBe(false);
    expect(spillFileNames(home)).toHaveLength(1);
  });

  test("TTL and count eviction delete dedicated spill files and release stub bytes", () => {
    const realNow = Date.now;
    setResponseStateByteCapForTests(1_024);
    try {
      Date.now = () => realNow() - 2 * 60 * 60 * 1_000;
      rememberLarge("resp_ttl_spill", "t".repeat(8_000));
      const ttlFile = spillFileNames(home)[0]!;
      Date.now = realNow;
      rememberLarge("resp_after_ttl", "u".repeat(8_000));
      expect(existsSync(join(responseSpillDirectory(home), ttlFile))).toBe(false);

      clearResponseStateForTests();
      setResponseStateByteCapForTests(1_024);
      rememberLarge("resp_count_spill", "v".repeat(8_000));
      const countFile = spillFileNames(home)[0]!;
      setResponseStateByteCapForTests(1_000_000_000);
      for (let i = 0; i < 1_000; i++) rememberLarge(`resp_count_${i}`, "x");
      expect(existsSync(join(responseSpillDirectory(home), countFile))).toBe(false);
      expect(responseStateMetrics().count).toBe(1_000);
    } finally {
      Date.now = realNow;
    }
  });

  test("startup orphan cleanup removes only old unreferenced regular spill files", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_live_orphan_gc", "l".repeat(8_000));
    await flushResponseState();
    const live = spillFileNames(home)[0]!;
    const orphanRef = writeResponseSpillDurably("resp_orphan_gc", {
      createdAt: Date.now(), items: ["orphan"],
    });
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(join(responseSpillDirectory(home), orphanRef.fileName), old, old);
    clearResponseStateMemoryForTests();
    expandPreviousResponseInput({ previous_response_id: "resp_live_orphan_gc", input: "next" });
    expect(existsSync(join(responseSpillDirectory(home), live))).toBe(true);
    expect(existsSync(join(responseSpillDirectory(home), orphanRef.fileName))).toBe(false);
  });

  test("startup orphan cleanup preserves referenced young live and unrelated files", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_gc_preserve", "g".repeat(8_000));
    await flushResponseState();
    const live = spillFileNames(home)[0]!;
    const young = writeResponseSpillDurably("resp_young", { createdAt: Date.now(), items: ["young"] });
    const unrelated = join(responseSpillDirectory(home), "unrelated.txt");
    writeFileSync(unrelated, "keep");
    clearResponseStateMemoryForTests();
    expandPreviousResponseInput({ previous_response_id: "resp_gc_preserve", input: "next" });
    expect(existsSync(join(responseSpillDirectory(home), live))).toBe(true);
    expect(existsSync(join(responseSpillDirectory(home), young.fileName))).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test("concurrent flush and synchronous demotion cannot inline or lose the spill stub", async () => {
    rememberLarge("resp_before_flush", "small");
    const flushing = flushResponseState();
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_during_flush", "d".repeat(8_000));
    await flushing;
    await flushResponseState();
    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as { states: [string, Record<string, unknown>][] };
    const row = snapshot.states.find(([id]) => id === "resp_during_flush")?.[1];
    expect(row).toMatchObject({ kind: "spill" });
    expect(row?.items).toBeUndefined();
  });

  test("small entries retain the legacy v2 debounced snapshot representation", async () => {
    rememberLarge("resp_legacy_small", "small");
    await flushResponseState();
    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as { version: number; states: [string, Record<string, unknown>][] };
    expect(snapshot.version).toBe(2);
    const row = snapshot.states.find(([id]) => id === "resp_legacy_small")?.[1];
    expect(row).toMatchObject({ items: expect.any(Array) });
    expect(row?.kind).toBeUndefined();
    expect(row?.sizeBytes).toBeUndefined();
  });

  test("same-id spill replacement keeps the old row replay-addressable until atomic stub swap", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_atomic_replace", "old".repeat(3_000));
    const oldFile = spillFileNames(home)[0]!;
    let observedOld = false;
    setSpillIoForTest({
      record(event) {
        if (event !== "publish") return;
        const replay = expandPreviousResponseInput({ previous_response_id: "resp_atomic_replace", input: "delta" });
        observedOld = JSON.stringify(replay).includes("oldoldold");
        expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
      },
    });
    rememberLarge("resp_atomic_replace", "new".repeat(3_000));
    expect(observedOld).toBe(true);
    expect(JSON.stringify(expandPreviousResponseInput({ previous_response_id: "resp_atomic_replace", input: "delta" })))
      .toContain("newnewnew");
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(false);
  });

  test("existing spill replacement stays a direct stub-to-stub swap even when the candidate fits RAM", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_direct_b2", "old".repeat(3_000));
    const oldFile = spillFileNames(home)[0]!;
    const events: string[] = [];
    setSpillIoForTest({ record: event => events.push(event) });
    setResponseStateByteCapForTests(1_000_000);

    rememberLarge("resp_direct_b2", "small replacement");

    expect(events).toContain("publish");
    expect(events).toContain("stub-swap");
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, spillStubCount: 1 });
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(false);
    expect(JSON.stringify(expandPreviousResponseInput({ previous_response_id: "resp_direct_b2", input: "delta" })))
      .toContain("small replacement");
  });

  test("crash between new-generation publication and stub swap preserves the old row and reclaims the new orphan", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_crash_window", "old".repeat(3_000));
    await flushResponseState();
    const oldFile = spillFileNames(home)[0]!;
    const orphan = writeResponseSpillDurably("resp_crash_window", {
      createdAt: Date.now(), items: ["new".repeat(3_000)],
    });
    const oldTime = new Date(Date.now() - 20 * 60_000);
    utimesSync(join(responseSpillDirectory(home), orphan.fileName), oldTime, oldTime);
    clearResponseStateMemoryForTests();
    setResponseStateByteCapForTests(1_024);
    expect(JSON.stringify(expandPreviousResponseInput({ previous_response_id: "resp_crash_window", input: "delta" })))
      .toContain("oldoldold");
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
    expect(existsSync(join(responseSpillDirectory(home), orphan.fileName))).toBe(false);
  });

  test("same response id and equal-size replacement use distinct basenames and unlink old only after stub swap", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_equal_size", "a".repeat(8_000));
    const old = spillFileNames(home)[0]!;
    let published: string[] = [];
    setSpillIoForTest({ record: event => { if (event === "publish") published = spillFileNames(home); } });
    rememberLarge("resp_equal_size", "b".repeat(8_000));
    expect(published).toHaveLength(2);
    expect(new Set(published).size).toBe(2);
    await flushResponseState();
    expect(spillFileNames(home)).toHaveLength(1);
    expect(existsSync(join(responseSpillDirectory(home), old))).toBe(false);
  });

  test("identical-content re-spill still allocates a generation-unique basename", () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_identical", "i".repeat(8_000));
    const old = spillFileNames(home)[0]!;
    let duringPublish: string[] = [];
    setSpillIoForTest({ record: event => { if (event === "publish") duringPublish = spillFileNames(home); } });
    rememberLarge("resp_identical", "i".repeat(8_000));
    expect(duringPublish).toHaveLength(2);
    expect(duringPublish.some(name => name !== old)).toBe(true);
  });

  test("spill-failed tombstone survives simulated process restart and returns the canonical failure", async () => {
    setSpillIoForTest({ write: () => { throw new Error("fail"); } });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_failed_restart", "f".repeat(8_000));
    setSpillIoForTest(null);
    await flushResponseState();
    clearResponseStateMemoryForTests();
    const body = { previous_response_id: "resp_failed_restart", input: "delta" };
    expect(expandPreviousResponseInput(body)).toBe(body);
    expect(previousResponseReplayFailure(body)).toEqual({
      code: "previous_response_not_found", reason: "spill_failed",
    });
  });

  test("spill replay preserves replay-prefix provenance and compaction-marker acknowledgement", () => {
    setResponseStateByteCapForTests(1_024);
    rememberResponseState(
      { input: [{ type: "context_compaction" }, { role: "user", content: "x".repeat(8_000) }] },
      fixedResponse("resp_spill_provenance", [{ role: "assistant", content: "done" }]),
    );
    const expanded = expandPreviousResponseInput({
      model: "test/model", previous_response_id: "resp_spill_provenance", input: "next",
    });
    expect(previousResponseReplayPrefixLength(expanded)).toBe(3);
    expect(parseRequest(expanded)._contextCompactionBoundary).toBeUndefined();
  });

  test("multibyte resident payload accounting uses complete UTF-8 bytes including provider metadata", () => {
    const realNow = Date.now;
    const at = 1_900_000_000_000;
    Date.now = () => at;
    try {
      const output = [{ role: "assistant", content: "🙂" }];
      const providers = { kiro: { conversationId: "대화🙂" } };
      rememberResponseState(
        { input: "한글🙂" },
        fixedResponse("resp_다국어", output),
        providers,
      );
      const items = [{ role: "user", content: "한글🙂" }, ...output];
      const expected = Buffer.byteLength(JSON.stringify({
        responseId: "resp_다국어", createdAt: at, items, providers,
      }), "utf8");
      expect(getStoredResponseBytesForTests()).toBe(expected);
    } finally {
      Date.now = realNow;
    }
  });

  test("serialization failure rejects the candidate and records a bounded tombstone", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    rememberResponseState({ input: "safe" }, fixedResponse("resp_circular", [circular]));
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, tombstoneCount: 1 });
    const body = { previous_response_id: "resp_circular", input: "delta" };
    expandPreviousResponseInput(body);
    expect(previousResponseReplayFailure(body)?.reason).toBe("spill_failed");

    clearResponseStateForTests();
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_circular_replace", "old".repeat(3_000));
    const oldFile = spillFileNames(home)[0]!;
    rememberResponseState({ input: "replacement" }, fixedResponse("resp_circular_replace", [circular]));
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, spillStubCount: 0, tombstoneCount: 1 });
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(false);
  });

  test("serialization-failure tombstone still submits to the hard cap (C2-1)", () => {
    // Cap below tombstone size: the tombstone must be pruned away, not stay
    // resident above the cap because the failure path skipped pruning.
    setResponseStateByteCapForTests(1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    rememberResponseState({ input: "safe" }, fixedResponse("resp_tiny_cap_circular", [circular]));
    const metrics = responseStateMetrics();
    expect(metrics.totalBytes).toBeLessThanOrEqual(1);
    expect(metrics.tombstoneCount).toBe(0);
  });

  test("pending spill-unlink deferral is bounded at 128 superseded generations (C2-2)", () => {
    // Persistently failing snapshot writes mean persistNow() never drains the
    // deferral queue. 140 same-id replacements must leave at most current +
    // 128 pending files on disk — the overflow unlinks oldest-first instead
    // of growing without limit.
    setSpillIoForTest({ write: undefined }); // default write; only block snapshots below
    setResponseStateByteCapForTests(1_024);
    const dir = responseSpillDirectory(home);
    for (let i = 0; i < 140; i++) {
      rememberLarge("resp_unlink_bound", `payload-${i}-${"x".repeat(4_000)}`);
    }
    const files = spillFileNames(home);
    // 1 current generation + at most 128 deferred superseded generations.
    expect(files.length).toBeLessThanOrEqual(129);
    expect(files.length).toBeGreaterThan(1); // deferral is real, not immediate unlink
    void dir;
  }, BULK_DURABLE_IO_BUDGET_MS); // 140 fsync'd durable writes ARE the assertion; Windows CI measured ~18s.

  test("persistNow settles within the bounded rewrite attempts under revision churn", async () => {
    rememberLarge("resp_churn_seed", "seed");
    let attempts = 0;
    setResponseStatePersistAttemptHookForTests(() => {
      attempts += 1;
      rememberLarge(`resp_churn_${attempts}`, `churn-${attempts}`);
    });
    await flushResponseState();
    expect(attempts).toBe(8); // four attempts plus one awaited four-attempt shutdown follow-up
    setResponseStatePersistAttemptHookForTests(null);
    await flushResponseState();
  });

  test("persistent snapshot I/O failure does not schedule background retry passes", async () => {
    const blockedHome = join(home, "not-a-directory");
    writeFileSync(blockedHome, "file blocks config directory creation");
    process.env["OPENCODEX_HOME"] = blockedHome;
    rememberLarge("resp_persist_failure", "payload");
    expect(responseStatePersistPendingForTests()).toBe(true);

    await runPendingResponseStatePersistForTests();

    expect(responseStatePersistPendingForTests()).toBe(false);
  });

  test("background revision churn schedules exactly one follow-up pass", async () => {
    rememberLarge("resp_background_churn_seed", "seed");
    let attempts = 0;
    setResponseStatePersistAttemptHookForTests(() => {
      attempts += 1;
      rememberLarge(`resp_background_churn_${attempts}`, `churn-${attempts}`);
    });

    await runPendingResponseStatePersistForTests();

    expect(attempts).toBe(4);
    expect(responseStatePersistPendingForTests()).toBe(true);
    setResponseStatePersistAttemptHookForTests(null);
    await runPendingResponseStatePersistForTests();
    expect(responseStatePersistPendingForTests()).toBe(false);
  });

  test("unstable final snapshot defers spill unlinks until a stable snapshot", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_unstable_unlink", "old".repeat(3_000));
    await flushResponseState();
    const oldFile = spillFileNames(home)[0]!;
    rememberLarge("resp_unstable_unlink", "new".repeat(3_000));
    expect(spillFileNames(home)).toHaveLength(2);
    let attempts = 0;
    setResponseStatePersistAttemptHookForTests(() => {
      attempts += 1;
      rememberLarge(`resp_unstable_revision_${attempts}`, `r-${attempts}`);
    });
    await flushResponseState();
    expect(attempts).toBe(8);
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
    setResponseStatePersistAttemptHookForTests(null);
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(false);
  });

  test("RAM cap demotes the oldest resident before deleting any older spill stub", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_older_stub", "old".repeat(3_000));
    await flushResponseState();
    const oldFile = spillFileNames(home)[0]!;
    setResponseStateByteCapForTests(1_000_000);
    rememberLarge("resp_newer_resident", "new".repeat(1_000));
    expect(responseStateMetrics()).toMatchObject({ residentCount: 1, spillStubCount: 1 });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_prune_trigger", "trigger");
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
    expect(responseStateMetrics().spillStubCount).toBeGreaterThanOrEqual(2);
  });

  test("continuation demotion releases resident bytes minus retained replacement stub bytes", () => {
    setResponseStateByteCapForTests(1_000_000);
    rememberLarge("resp_budget_net_release", "resident".repeat(1_000));
    const before = responseContinuationRetainedStoreSnapshot();

    const released = evictOldestResponseContinuationForBudget();
    const after = responseContinuationRetainedStoreSnapshot();

    expect(after.pinnedBytes).toBeGreaterThan(0);
    expect(released).toBe(before.bytes - after.bytes);
    expect(released).toBeGreaterThan(0);
  });

  test("stub-only over-cap state still deletes bounded metadata oldest-first", () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_stub_oldest", "a".repeat(4_000));
    rememberLarge("resp_stub_newer", "b".repeat(4_000));
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, spillStubCount: 2 });
    setResponseStateByteCapForTests(1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    rememberResponseState({ input: "trigger" }, fixedResponse("resp_stub_prune", [circular]));
    expect(responseStateMetrics()).toMatchObject({ count: 0, residentCount: 0, spillStubCount: 0, tombstoneCount: 0 });
    expect(spillFileNames(home)).toEqual([]);
  });

  test("write fsync or publication failure cleans its temp and preserves no unmeasured resident payload", () => {
    const failures = [
      { write: () => { throw new Error("write"); } },
      { fsync: () => { throw new Error("fsync"); } },
      { link: () => { throw Object.assign(new Error("publish"), { code: "EIO" }); } },
    ];
    for (const [index, io] of failures.entries()) {
      clearResponseStateForTests();
      setSpillIoForTest(io);
      setResponseStateByteCapForTests(1_024);
      rememberLarge(`resp_io_failure_${index}`, "x".repeat(8_000));
      expect(responseStateMetrics()).toMatchObject({ residentCount: 0, tombstoneCount: 1, spillWriteFailures: 1 });
      const dir = responseSpillDirectory(home);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }
  });

  test("EEXIST publication loss advances the generation and retries within the bound", () => {
    let links = 0;
    setSpillIoForTest({
      link(temp, destination) {
        links += 1;
        if (links === 1) throw Object.assign(new Error("lost generation"), { code: "EEXIST" });
        linkSync(temp, destination);
      },
    });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_eexist", "e".repeat(8_000));
    expect(links).toBe(2);
    expect(responseStateMetrics()).toMatchObject({ spillStubCount: 1, spillWriteFailures: 0 });
  });

  test("orphan cleanup obeys scan and cleanup caps rejects symlinks and counts failed unlink", () => {
    const dir = responseSpillDirectory(home);
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 20 * 60_000);
    const target = join(dir, "target.txt");
    writeFileSync(target, "target");
    const symlinkRef = writeResponseSpillDurably("symlink", { createdAt: Date.now(), items: ["target"] });
    const symlinkName = symlinkRef.fileName;
    unlinkSync(join(dir, symlinkName));
    symlinkSync(target, join(dir, symlinkName));
    for (let i = 0; i < 520; i++) {
      const ref = writeResponseSpillDurably(`orphan-${i}`, { createdAt: Date.now(), items: [i] });
      const path = join(dir, ref.fileName);
      utimesSync(path, old, old);
    }
    let failedOnce = false;
    setSpillIoForTest({ unlink(path) {
      if (!failedOnce) { failedOnce = true; throw new Error("locked"); }
      unlinkSync(path);
    } });
    const result = recoverOrphanedResponseSpills(new Set(), dir);
    // 521 orphan candidates exist (520 aged + 1 symlink); the CLEANUP cap
    // (512) must bind strictly below the candidate count, proving the cap is
    // live rather than vacuously larger than the workload (review C1-3).
    expect(result.removed + result.failed).toBe(512);
    expect(result.scanned).toBeLessThanOrEqual(4_096);
    expect(result.failed).toBe(1);
    expect(existsSync(join(dir, symlinkName))).toBe(true);
  }, BULK_DURABLE_IO_BUDGET_MS); // 521 fsync'd spill writes build the workload; Windows CI measured ~34s.

  test("orphan scan cap stops enumeration at the limit with an injected directory", () => {
    // Prove RESPONSE_SPILL_SCAN_MAX itself binds: enumerate more entries than
    // the cap via the injected readdir seam and assert the scan stops exactly
    // at the limit without touching the excess (review C1-3 — a sub-cap
    // workload cannot distinguish capped from uncapped scanning).
    const dir = responseSpillDirectory(home);
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 20 * 60_000);
    const seed = writeResponseSpillDurably("scan-seed", { createdAt: Date.now(), items: ["s"] });
    utimesSync(join(dir, seed.fileName), old, old);
    let served = 0;
    setSpillIoForTest({
      readdirEntry() {
        served += 1;
        // Serve the one real file first, then virtual entries that are
        // filtered by the owned-file regex (name mismatch) — enumeration
        // cost still counts toward the scan cap.
        return served === 1 ? seed.fileName : `not-owned-${served}.txt`;
      },
    });
    const result = recoverOrphanedResponseSpills(new Set(), dir);
    expect(result.scanned).toBe(4_096);
    expect(served).toBe(4_096);
  });

  test("response-state management metrics keep every added field finite scalar and privacy-safe", () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_private_metric_id", "secret-content".repeat(1_000));
    const metrics = responseStateMetrics();
    expect(Object.values(metrics).every(value => typeof value === "number" && Number.isFinite(value))).toBe(true);
    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toContain("resp_private_metric_id");
    expect(serialized).not.toContain("secret-content");
    expect(serialized).not.toContain(responseSpillDirectory(home));
  });

  test("byte cap spills over-cap rows instead of evicting prior continuation ids", () => {
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
        json.id = `resp_cap_${i}`;
        rememberResponseState(body, json, { cursor: { conversationId: `conv_${i}` } }, { force: true });
        ids.push(json.id as string);
      }
      expect(previousResponseProviderState(ids[0])?.cursor?.conversationId).toBe("conv_0");
      expect(previousResponseProviderState(ids[3])?.cursor?.conversationId).toBe("conv_3");
      expect(responseStateMetrics().spillStubCount).toBeGreaterThan(0);
      expect(getStoredResponseBytesForTests()).toBeLessThanOrEqual(4_000);
    } finally {
      setResponseStateByteCapForTests(null);
    }
  });

  test("byte accounting across restart preserves spilled ids and recomputes resident and stub bytes", async () => {
    setResponseStateByteCapForTests(4_000);
    try {
      const bulk = "y".repeat(1_500);
      const bodyA = { model: "cursor/grok-4.5", input: `${bulk}-a`, store: false };
      const jsonA = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
      jsonA.id = "resp_restart_a";
      rememberResponseState(bodyA, jsonA, { cursor: { conversationId: "conv_a" } }, { force: true });
      await flushResponseState();

      // Simulated restart: memory wiped, snapshot reloaded lazily.
      clearResponseStateMemoryForTests();
      expect(previousResponseProviderState(jsonA.id as string)?.cursor?.conversationId).toBe("conv_a");

      // Post-restart stores still enforce the cap against recomputed sizes.
      const bodyB = { model: "cursor/grok-4.5", input: `${bulk}-b1`, store: false };
      const jsonB = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
      jsonB.id = "resp_restart_b";
      rememberResponseState(bodyB, jsonB, { cursor: { conversationId: "conv_b1" } }, { force: true });
      const bodyC = { model: "cursor/grok-4.5", input: `${bulk}-b2`, store: false };
      const jsonC = buildResponseJSON([{ type: "text_delta", text: "ok" }, { type: "done" }], "cursor/grok-4.5");
      jsonC.id = "resp_restart_c";
      rememberResponseState(bodyC, jsonC, { cursor: { conversationId: "conv_b2" } }, { force: true });

      expect(previousResponseProviderState(jsonA.id as string)?.cursor?.conversationId).toBe("conv_a");
      expect(previousResponseProviderState(jsonC.id as string)?.cursor?.conversationId).toBe("conv_b2");
      expect(getStoredResponseBytesForTests()).toBeLessThanOrEqual(4_000);
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
      expect(responseStateMetrics().count).toBe(1_000);
      expect(total).toBeLessThanOrEqual((perEntryBytes + 4) * 1_000);
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

  test("snapshot survives a simulated restart (memory clear + disk load)", async () => {
    const firstBody = { model: "gpt-5.5", input: "hello" };
    const first = buildResponseJSON([
      { type: "text_delta", text: "hi" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState(firstBody, first, "cursor_conv_9");
    await flushResponseState();

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

  test("recovers only old response-state temps owned by dead processes", () => {
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    const deadPid = process.pid === 4242 ? 4243 : 4242;
    const stale = join(home, `responses-state.json.ocx.${deadPid}.1.tmp`);
    const live = join(home, "responses-state.json.ocx.5252.2.tmp");
    const current = join(home, `responses-state.json.ocx.${process.pid}.3.tmp`);
    const young = join(home, "responses-state.json.ocx.6262.4.tmp");
    const unrelated = join(home, "responses-state.json.ocx.7272.tmp");
    const directory = join(home, "responses-state.json.ocx.8282.5.tmp");
    for (const path of [stale, live, current, young, unrelated]) writeFileSync(path, "private state");
    mkdirSync(directory);
    for (const path of [stale, live, current, unrelated, directory]) utimesSync(path, old, old);

    const result = recoverStaleResponseStateTemps(home, {
      isProcessAlive: pid => pid === 5252,
    });

    expect(result).toMatchObject({ matched: 5, removed: 1, failed: 0 });
    expect(result.bytesRemoved).toBe("private state".length);
    expect(existsSync(stale)).toBe(false);
    for (const path of [live, current, young, unrelated, directory]) expect(existsSync(path)).toBe(true);
  });

  test("stale temp recovery is best-effort when unlink fails", () => {
    const deadPid = process.pid === 4242 ? 4243 : 4242;
    const path = join(home, `responses-state.json.ocx.${deadPid}.1.tmp`);
    writeFileSync(path, "private state");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(path, old, old);

    const result = recoverStaleResponseStateTemps(home, {
      isProcessAlive: () => false,
      unlink: () => { throw new Error("locked"); },
    });

    expect(result).toMatchObject({ matched: 1, removed: 0, failed: 1, bytesRemoved: 0 });
    expect(readFileSync(path, "utf-8")).toBe("private state");
  });

  test("stale temp recovery stops at injectable enumeration and cleanup caps", () => {
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    const first = "responses-state.json.ocx.7001.1.tmp";
    const second = "responses-state.json.ocx.7002.2.tmp";
    for (const name of [first, second]) {
      const path = join(home, name);
      writeFileSync(path, "private state");
      utimesSync(path, old, old);
    }

    const enumerationBound = recoverStaleResponseStateTemps(home, {
      list: () => ["unrelated.txt", second],
      isProcessAlive: () => false,
      maxEntries: 1,
    });
    expect(enumerationBound).toMatchObject({ matched: 0, removed: 0, failed: 0 });
    expect(existsSync(join(home, second))).toBe(true);

    const cleanupBound = recoverStaleResponseStateTemps(home, {
      list: () => [first, second],
      isProcessAlive: () => false,
      maxCleanups: 1,
    });
    expect(cleanupBound).toMatchObject({ matched: 1, removed: 1, failed: 0 });
    expect(existsSync(join(home, first))).toBe(false);
    expect(existsSync(join(home, second))).toBe(true);
  });

  test("stale temp recovery remains best-effort when enumeration fails", () => {
    const result = recoverStaleResponseStateTemps(home, {
      list: function* () {
        yield "unrelated.txt";
        throw new Error("directory read failed");
      },
    });

    expect(result).toEqual({ matched: 0, removed: 0, failed: 0, bytesRemoved: 0 });
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

  test("persists provider-keyed Cursor and Kiro continuation state across restart", async () => {
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
    await flushResponseState();
    clearResponseStateMemoryForTests();

    expect(previousResponseProviderState(first.id as string)).toEqual({
      cursor: { conversationId: "cursor_conv_2", checkpointUsable: true },
      kiro: { conversationId: "kiro_conv_2" },
    });
    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as { version: number };
    expect(snapshot.version).toBe(2);
  });

  test("stale snapshot entries are pruned on load", async () => {
    const first = buildResponseJSON([
      { type: "text_delta", text: "old" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "old turn" }, first);
    await flushResponseState();
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

  test("oversized entries replay from dedicated spill across restart while small entries use snapshot", async () => {
    setResponseStateByteCapForTests(128 * 1024);
    try {
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
    await flushResponseState();

    // In-memory: both expand, with the oversized entry represented by a stub.
    expect((expandPreviousResponseInput({
      model: "gpt-5.5", previous_response_id: first.id, input: "n",
    }) as { input: unknown[] }).input).toHaveLength(3);

    expect(responseStateMetrics().spillStubCount).toBe(1);
    clearResponseStateMemoryForTests();
    expect((expandPreviousResponseInput({
      model: "gpt-5.5", previous_response_id: first.id, input: "n",
    }) as { input: unknown[] }).input).toHaveLength(3);
    expect((expandPreviousResponseInput({
      model: "gpt-5.5", previous_response_id: small.id, input: "n",
    }) as { input: unknown[] }).input).toHaveLength(3);
    } finally {
      setResponseStateByteCapForTests(null);
    }
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

  describe("responseStateMetrics (observe-only snapshot)", () => {
    test("empty store reports every resident spill tombstone and counter metric as zero", () => {
      const metrics = responseStateMetrics();
      expect(metrics).toEqual({
        count: 0,
        residentCount: 0,
        spillStubCount: 0,
        tombstoneCount: 0,
        totalBytes: 0,
        spillPayloadBytes: 0,
        largestBytes: 0,
        oldestAgeMs: 0,
        spillWrites: 0,
        spillWriteFailures: 0,
        spillReadFailures: 0,
      });
    });

    test("largest entry over 200KB is reflected, and total is >= largest", () => {
      const small = buildResponseJSON([{ type: "text_delta", text: "tiny" }, { type: "done" }], "gpt-5.5");
      rememberResponseState({ model: "gpt-5.5", input: "small" }, small);
      const bigText = "x".repeat(250 * 1024); // > 200KB
      const big = buildResponseJSON([{ type: "text_delta", text: bigText }, { type: "done" }], "gpt-5.5");
      rememberResponseState({ model: "gpt-5.5", input: "big" }, big);

      const metrics = responseStateMetrics();
      expect(metrics.count).toBe(2);
      expect(metrics.largestBytes).toBeGreaterThan(200 * 1024);
      // totalBytes re-counts every entry, so it can never be under the single largest one.
      expect(metrics.totalBytes).toBeGreaterThanOrEqual(metrics.largestBytes);
      // totalBytes equals the running byte accounting the store maintains.
      expect(metrics.totalBytes).toBe(getStoredResponseBytesForTests());
    });

    test("oldestAgeMs grows with the oldest entry's age", () => {
      const realNow = Date.now;
      try {
        Date.now = () => realNow() - 5_000; // oldest entry created 5s ago
        const old = buildResponseJSON([{ type: "text_delta", text: "old" }, { type: "done" }], "gpt-5.5");
        rememberResponseState({ model: "gpt-5.5", input: "old" }, old);
        Date.now = realNow;
        const fresh = buildResponseJSON([{ type: "text_delta", text: "fresh" }, { type: "done" }], "gpt-5.5");
        rememberResponseState({ model: "gpt-5.5", input: "fresh" }, fresh);

        const metrics = responseStateMetrics();
        expect(metrics.count).toBe(2);
        expect(metrics.oldestAgeMs).toBeGreaterThanOrEqual(5_000);
      } finally {
        Date.now = realNow;
      }
    });

    test("metrics remain side-effect free with the complete additive metric shape", async () => {
      const first = buildResponseJSON([{ type: "text_delta", text: "persisted" }, { type: "done" }], "gpt-5.5");
      rememberResponseState({ model: "gpt-5.5", input: "persisted turn" }, first);
      await flushResponseState();
      // Simulated restart: memory wiped, snapshot on disk, `loaded` reset to false.
      clearResponseStateMemoryForTests();

      // A probe must NOT trigger the lazy disk load — the store still reads empty.
      expect(responseStateMetrics()).toEqual({
        count: 0,
        residentCount: 0,
        spillStubCount: 0,
        tombstoneCount: 0,
        totalBytes: 0,
        spillPayloadBytes: 0,
        largestBytes: 0,
        oldestAgeMs: 0,
        spillWrites: 0,
        spillWriteFailures: 0,
        spillReadFailures: 0,
      });

      // The real request path DOES load; the probe then reflects the loaded entry.
      expandPreviousResponseInput({ model: "gpt-5.5", previous_response_id: first.id, input: "next" });
      const metrics = responseStateMetrics();
      expect(metrics.count).toBe(1);
      expect(metrics.totalBytes).toBeGreaterThan(0);
    });
  });
});
