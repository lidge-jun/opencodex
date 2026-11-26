import { describe, expect, test } from "bun:test";
import { markUndeclaredToolCallRefusalResponse } from "../../src/lib/errors";
import {
  comboFailureCooldownScope,
  comboFailureDecision,
} from "../../src/combos/failover";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import {
  UNDECLARED_TOOL_CALL_ERROR_CODE,
  undeclaredToolCallMessage,
} from "../../src/server/responses-undeclared-tool-guard";
import {
  comboStreamPayloadCommitsOutput,
  preflightComboStreamResponse,
  retryableZeroOutputTerminal,
} from "../../src/server/responses/combo-stream-preflight";
import type { RequestLogContext } from "../../src/server/request-log";

const sse = (...payloads: unknown[]): Response => new Response(
  payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);

const logCtx = (): RequestLogContext => ({ model: "combo/test", provider: "combo" });

const catalog = {
  declared: new Set(["exec"]),
  declaredNamelessClientCallTypes: new Set<string>(),
  providerExecutedCallTypes: new Set(),
};

const callAdded = (name: string): unknown => ({
  type: "response.output_item.added",
  output_index: 0,
  item: { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "{}" },
});

describe("undeclared-tool guard refusal", () => {
  test("a committed call item is exactly what the commit classifier says", () => {
    // The guard-refused frame never reaches the client, but the preflight's conservative
    // classifier treats any output_item.added as committing. The carve-out must live beside
    // the commit decision, not behind a caller flag alone.
    expect(comboStreamPayloadCommitsOutput(callAdded("exec"))).toBe(true);
    expect(comboStreamPayloadCommitsOutput({ type: "response.created", response: { id: "r1" } })).toBe(false);
  });

  test("an undeclared call frame alone stays replayable zero-output", async () => {
    const result = await preflightComboStreamResponse(
      sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        callAdded("code_runner/bash"),
      ),
      logCtx(),
      undefined,
      { declaredWireTools: catalog },
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.response.status).toBe(502);
    const body = JSON.parse(await result.response.text()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(body.error?.message).toBe(undeclaredToolCallMessage());
  });

  test("a declared call frame is not refusal evidence", async () => {
    const result = await preflightComboStreamResponse(
      sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        callAdded("exec"),
      ),
      logCtx(),
      undefined,
      { declaredWireTools: catalog },
    );
    // A declared call commits the child: the caller can execute it, so replay would duplicate it.
    expect(result.kind).toBe("accepted");
  });

  test("a relayed text delta before the offending frame still commits the child", async () => {
    const result = await preflightComboStreamResponse(
      sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        { type: "response.output_text.delta", delta: "partial answer the client saw" },
        callAdded("code_runner/bash"),
      ),
      logCtx(),
      undefined,
      { declaredWireTools: catalog },
    );
    expect(result.kind).toBe("accepted");
  });

  test("without the catalog option the frame commits as before", async () => {
    const result = await preflightComboStreamResponse(
      sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        callAdded("code_runner/bash"),
      ),
      logCtx(),
      undefined,
      {},
    );
    expect(result.kind).toBe("accepted");
  });

  test("the synthesized refusal classifies as replayable zero-output", () => {
    // The exact terminal the guard synthesizes, projected by the preflight as hop evidence.
    const terminal = {
      type: "response.failed",
      response: {
        status: "failed",
        output: [],
        error: { type: "upstream_error", code: UNDECLARED_TOOL_CALL_ERROR_CODE, message: undeclaredToolCallMessage(), retryable: true },
      },
    };
    // What makes the combo able to advance: the zero-output terminal is replayable, so the
    // preflight's own default retryable-terminal classifier accepts the projected evidence.
    expect(retryableZeroOutputTerminal(terminal)).toBe(true);
    expect(comboFailureDecision(502, undeclaredToolCallMessage(), {
      code: UNDECLARED_TOOL_CALL_ERROR_CODE,
      undeclaredToolCallRefusal: true,
    })).toBe("hop");
    expect(comboFailureCooldownScope(502, undeclaredToolCallMessage(), {
      code: UNDECLARED_TOOL_CALL_ERROR_CODE,
      undeclaredToolCallRefusal: true,
    })).toBe("none");
  });

  test("the bare refusal words alone stay terminal", () => {
    // Reflected prose — a validation message quoting the refusal, an envelope without the
    // caller-supplied provenance — must never hop (#8563's reflected-text discipline).
    // At 502 a bare status hops on its own generic 5xx rule, so the provenance gate is
    // asserted at a request-validation status, where the words alone have no hop arm.
    expect(comboFailureDecision(400, undeclaredToolCallMessage())).toBe("stop");
    expect(comboFailureDecision(400, undeclaredToolCallMessage(), {
      code: UNDECLARED_TOOL_CALL_ERROR_CODE,
    })).toBe("stop");
    expect(comboFailureCooldownScope(400, undeclaredToolCallMessage())).toBe("target");
  });

  test("a declared call frame after the offending one still commits the child", async () => {
    // The guard's rewrite drops everything after its trip, so a declared call the stream
    // carries after an undeclared one is evidence the caller could have executed. Committing
    // here vetoes the hop — fail-safe, and pinned so the veto stays deliberate.
    const result = await preflightComboStreamResponse(
      sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        callAdded("code_runner/bash"),
        callAdded("exec"),
      ),
      logCtx(),
      undefined,
      { declaredWireTools: catalog },
    );
    expect(result.kind).toBe("accepted");
  });

  test("an undeclared call and a later declared call in SEPARATE chunks commits the child", async () => {
    // The undeclared call arrives in one SSE chunk and the declared call in the next. The
    // refusal must be decided at the stream's end, never at a chunk boundary: hopping after
    // the first chunk would duplicate the declared call on the next target (#9163).
    const twoChunks = new Response(
      `data: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress" } })}\n\n`
      + `data: ${JSON.stringify(callAdded("code_runner/bash"))}\n\n`
      + `data: ${JSON.stringify(callAdded("exec"))}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await preflightComboStreamResponse(twoChunks, logCtx(), undefined, {
      declaredWireTools: catalog,
    });
    expect(result.kind).toBe("accepted");
  });

  test("an undeclared call whose terminal arrives in a LATER chunk still hops", async () => {
    // The terminal event lands after the offending call, in its own chunk: the refusal is
    // proven at the stream's decision point, and the hop goes out with the projected
    // terminal as evidence (#9163).
    const terminalLater = new Response(
      `data: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress" } })}\n\n`
      + `data: ${JSON.stringify(callAdded("code_runner/bash"))}\n\n`
      + `data: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [] } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await preflightComboStreamResponse(terminalLater, logCtx(), undefined, {
      declaredWireTools: catalog,
    });
    expect(result.kind).toBe("failed");
  });

  test("consumeComboFailure carries the code through unchanged", async () => {
    const body = JSON.stringify({
      error: { message: undeclaredToolCallMessage(), type: "upstream_error", code: UNDECLARED_TOOL_CALL_ERROR_CODE },
    });
    const failure = await consumeComboFailure(
      new Response(body, { status: 502, headers: { "content-type": "application/json" } }),
      undefined,
      Date.now(),
    );
    expect(failure.upstreamCode).toBe(UNDECLARED_TOOL_CALL_ERROR_CODE);
    // The bare code in an unmarked body is not provenance: no hop grant travels with it.
    expect(failure.undeclaredToolCallRefusal).toBeUndefined();
  });

  test("the guard's own terminal with last_error still reads as replayable", () => {
    // The guard repeats the refusal in `last_error`; that duplication is its shape, not the
    // competing-carrier evidence the required-tool sibling treats as disqualifying.
    expect(retryableZeroOutputTerminal({
      type: "response.failed",
      last_error: { type: "upstream_error", code: UNDECLARED_TOOL_CALL_ERROR_CODE, message: undeclaredToolCallMessage() },
      response: { status: "failed", output: [], error: { type: "upstream_error", code: UNDECLARED_TOOL_CALL_ERROR_CODE, message: undeclaredToolCallMessage() } },
    })).toBe(true);
  });

  test("a marked refusal grants the hop and no cooldown through the consumed failure", async () => {
    const body = JSON.stringify({
      error: { message: undeclaredToolCallMessage(), type: "upstream_error", code: UNDECLARED_TOOL_CALL_ERROR_CODE },
    });
    const response = new Response(body, { status: 502, headers: { "content-type": "application/json" } });
    markUndeclaredToolCallRefusalResponse(response);
    const failure = await consumeComboFailure(response, undefined, Date.now());
    expect(failure.undeclaredToolCallRefusal).toBe(true);
    // 400-shaped too: the refusal is target-local model behaviour on a healthy target.
    expect(comboFailureDecision(502, failure.classificationText, {
      code: failure.upstreamCode,
      undeclaredToolCallRefusal: failure.undeclaredToolCallRefusal,
    })).toBe("hop");
    expect(comboFailureDecision(400, failure.classificationText, {
      code: failure.upstreamCode,
      undeclaredToolCallRefusal: true,
    })).toBe("hop");
    expect(comboFailureCooldownScope(502, failure.classificationText, {
      code: failure.upstreamCode,
      undeclaredToolCallRefusal: failure.undeclaredToolCallRefusal,
    })).toBe("none");
  });
});
