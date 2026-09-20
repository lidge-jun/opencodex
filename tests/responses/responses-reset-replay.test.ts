import { describe, expect, test } from "bun:test";
import {
  ambiguousResendAllowanceFor,
  selfContainedResponsesBody,
} from "../../src/server/responses/reset-replay";
import { authorizeResendForRecovery } from "../../src/lib/request-resend-gate";

const clientTurn = {
  store: false,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", name: "read", call_id: "c1", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ],
  tools: [{ type: "function", name: "read" }],
};

describe("selfContainedResponsesBody", () => {
  test("accepts a turn whose second send can only repeat the inference", () => {
    expect(selfContainedResponsesBody(clientTurn)).toBe(true);
    expect(selfContainedResponsesBody({ store: false, input: "plain prompt" })).toBe(true);
    expect(selfContainedResponsesBody({
      store: false,
      input: [{ role: "user", content: "hi" }],
    })).toBe(true);
  });

  test("refuses anything that leaves state behind or continues someone else's turn", () => {
    for (const override of [
      { store: true },
      { store: undefined },
      { background: true },
      { previous_response_id: "resp_1" },
      { conversation: "conv_1" },
      { stream_id: undefined },
      { input: undefined },
      { input: { not: "a list" } },
    ]) {
      expect(selfContainedResponsesBody({ ...clientTurn, ...override })).toBe(false);
    }
    expect(selfContainedResponsesBody(null)).toBe(false);
    expect(selfContainedResponsesBody([clientTurn])).toBe(false);
  });

  test("refuses a catalog carrying anything the origin would execute", () => {
    for (const tools of [
      [{ type: "web_search" }],
      [{ type: "function", name: "read" }, { type: "mcp", server_label: "s" }],
      [{ type: "tool_search", execution: "server" }],
      [{ type: "namespace", name: "ns", tools: [{ type: "code_interpreter" }] }],
      [{ type: "namespace" }],
      "not a list",
    ]) {
      expect(selfContainedResponsesBody({ ...clientTurn, tools })).toBe(false);
    }
    expect(selfContainedResponsesBody({
      ...clientTurn,
      tools: [{ type: "namespace", name: "ns", tools: [{ type: "function", name: "read" }] }],
    })).toBe(true);
  });

  test("a hosted tool cannot ride in through a deferred declaration", () => {
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [...clientTurn.input, { type: "additional_tools", tools: [{ type: "web_search" }] }],
    })).toBe(false);
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [...clientTurn.input, { type: "tool_search_output", tools: [{ type: "function", name: "read" }] }],
    })).toBe(true);
  });

  test("an input item type this proxy does not recognise is refused", () => {
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [{ type: "image_generation_call", id: "ig1" }],
    })).toBe(false);
  });
});

describe("ambiguousResendAllowanceFor", () => {
  test("absent or disabled policy grants nothing", () => {
    const claim = () => true;
    expect(ambiguousResendAllowanceFor({}, () => true, claim)).toBeUndefined();
    expect(ambiguousResendAllowanceFor({ retryOnReset: { enabled: false } }, () => true, claim)).toBeUndefined();
  });

  test("a bare opt-in spends one replacement for the whole request", () => {
    const limits: number[] = [];
    let left = 1;
    const grant = ambiguousResendAllowanceFor({ retryOnReset: {} }, () => true, limit => {
      limits.push(limit);
      return left-- > 0;
    })!;
    expect(grant.selfContained).toBe(true);
    expect(grant.claim()).toBe(true);
    expect(grant.claim()).toBe(false);
    // Both questions were asked at the same ceiling, against the one request-wide counter.
    expect(limits).toEqual([1, 1]);
  });

  test("the body judgment is lazy and reaches the gate as a refusal reason", () => {
    let judged = 0;
    const grant = ambiguousResendAllowanceFor({ retryOnReset: {} }, () => { judged += 1; return false; }, () => true)!;
    expect(judged).toBe(0);
    const decision = authorizeResendForRecovery("pre-header", "connection-reset", grant);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.refusal).toBe("ambiguous-request-not-replayable");
    expect(judged).toBe(1);
  });

  test("a provider that opted in still funds only what the operator asked for", () => {
    const seen: number[] = [];
    const grant = ambiguousResendAllowanceFor(
      { retryOnReset: { replacements: 2 } },
      () => true,
      limit => { seen.push(limit); return true; },
    )!;
    expect(grant.claim()).toBe(true);
    expect(seen).toEqual([2]);
  });
});
