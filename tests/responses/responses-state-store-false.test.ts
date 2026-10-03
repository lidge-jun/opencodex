import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { buildConversationInput } from "../../src/adapters/coding-agent/protocol";
import { buildResponseJSON } from "../../src/bridge";
import { parseRequest } from "../../src/responses/parser";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  evictOldestResponseContinuationForBudget,
  expandPreviousResponseInput,
  flushResponseState,
  rememberResponseState,
  responseStateMetrics,
  setResponseStateByteCapForTests,
} from "../../src/responses/state";

describe("Responses unforced store:false ephemeral function call state", () => {
  const priorHome = process.env["OPENCODEX_HOME"];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-store-false-test-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setPlatformForTests(null);
    setResponseStateByteCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test("retains a client-owned function call for store:false tool-result continuation", () => {
    const callId = "call_42cfba72566547bda98a74bc";
    const request = { model: "Qwen3.8-Flash", input: "use probe_echo", store: false };
    const response = buildResponseJSON([
      { type: "tool_call_start", id: callId, name: "probe_echo" },
      { type: "tool_call_delta", arguments: '{"value":"FACT1"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ], "Qwen3.8-Flash");
    rememberResponseState(request, response, undefined, { clientThreadId: "qoder-task" });
    const expanded = expandPreviousResponseInput({
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: callId, output: "PROBE_OK" }],
      store: false,
    }, "qoder-task");
    const parsed = parseRequest(expanded);
    expect(parsed.context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      toolName: "probe_echo",
      content: "PROBE_OK",
    });
    const projected = JSON.parse(buildConversationInput(parsed)[0]!);
    expect(projected.message.content[0].text).toContain(`TOOL RESULT (call_id: ${callId}):\nPROBE_OK`);
  });

  test("refuses flagged replay when new incoming input does not match pending function call", () => {
    const callId = "call_test_pending_1";
    const request = { model: "Qwen3.8-Flash", input: "run task", store: false };
    const response = buildResponseJSON([
      { type: "tool_call_start", id: callId, name: "probe_echo" },
      { type: "tool_call_delta", arguments: '{"value":"FACT1"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ], "Qwen3.8-Flash");
    rememberResponseState(request, response, undefined, { clientThreadId: "qoder-task" });

    // Client sends plain text instead of function_call_output
    const textRequest = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: "continue without output",
      store: false,
    };
    expect(expandPreviousResponseInput(textRequest, "qoder-task")).toEqual(textRequest);

    // Client sends output for an unrelated/mismatched call_id
    const mismatchedRequest = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: "call_different_999", output: "OTHER" }],
      store: false,
    };
    expect(expandPreviousResponseInput(mismatchedRequest, "qoder-task")).toEqual(mismatchedRequest);
  });

  test("unforced store:false without function_call is never stored", () => {
    const request = { model: "Qwen3.8-Flash", input: "hello world", store: false };
    const response = buildResponseJSON([
      { type: "text_delta", text: "hi there" },
      { type: "done" },
    ], "Qwen3.8-Flash");
    rememberResponseState(request, response, undefined, { clientThreadId: "qoder-task" });

    const followUp = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: "next turn",
      store: false,
    };
    expect(expandPreviousResponseInput(followUp, "qoder-task")).toEqual(followUp);
  });

  test("unflagged store:true and forced replay remain unchanged", () => {
    const request = { model: "gpt-5.5", input: "initial query", store: true };
    const response = buildResponseJSON([
      { type: "text_delta", text: "response text" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState(request, response, undefined, { clientThreadId: "task-normal" });

    const followUp = {
      model: "gpt-5.5",
      previous_response_id: response.id,
      input: "follow-up text",
      store: true,
    };
    const expanded = expandPreviousResponseInput(followUp, "task-normal") as { input: unknown[] };
    expect(Array.isArray(expanded.input)).toBe(true);
    expect(expanded.input.length).toBeGreaterThan(1);
  });

  test("preserves flagged unforcedStoreFalse provenance through snapshot flush and reload", async () => {
    const callId = "call_persisted_tool_1";
    const request = { model: "Qwen3.8-Flash", input: "use probe_echo", store: false };
    const response = buildResponseJSON([
      { type: "tool_call_start", id: callId, name: "probe_echo" },
      { type: "tool_call_delta", arguments: '{"value":"FACT1"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ], "Qwen3.8-Flash");
    rememberResponseState(request, response, undefined, { clientThreadId: "qoder-task" });
    await flushResponseState();

    // Simulate process restart
    clearResponseStateMemoryForTests();

    // Replay with matching output succeeds after reload
    const validFollowUp = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: callId, output: "RELOADED_OK" }],
      store: false,
    };
    const expanded = expandPreviousResponseInput(validFollowUp, "qoder-task");
    const parsed = parseRequest(expanded);
    expect(parsed.context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      content: "RELOADED_OK",
    });

    // Replay with text only still refused after reload
    const invalidFollowUp = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: "some text",
      store: false,
    };
    expect(expandPreviousResponseInput(invalidFollowUp, "qoder-task")).toEqual(invalidFollowUp);
  });

  test("carries flagged provenance through resident demotion, spill stub, and snapshot reload", async () => {
    const callId = "call_spilled_pending_1";
    const response = buildResponseJSON([
      { type: "tool_call_start", id: callId, name: "probe_echo" },
      { type: "tool_call_delta", arguments: '{}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ], "Qwen3.8-Flash");
    rememberResponseState({ input: "call probe_echo", store: false }, response, undefined, { clientThreadId: "qoder-task" });
    expect(responseStateMetrics().residentCount).toBe(1);
    evictOldestResponseContinuationForBudget();
    expect(responseStateMetrics().spillStubCount).toBe(1);
    await flushResponseState();
    const snapshot = readFileSync(join(home, "responses-state.json"), "utf8");
    expect(snapshot).toContain('"unforcedStoreFalse":true');
    clearResponseStateMemoryForTests();

    const invalid = { previous_response_id: response.id, input: "plain text", store: false };
    expect(expandPreviousResponseInput(invalid, "qoder-task")).toEqual(invalid);
    const valid = { previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: callId, output: "OK" }], store: false };
    expect(expandPreviousResponseInput(valid, "qoder-task")).not.toEqual(valid);
  });
});
