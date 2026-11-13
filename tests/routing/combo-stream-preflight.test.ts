import { describe, expect, jest, spyOn, test } from "bun:test";
import { collectBufferedResponsesSse } from "../../src/server/responses/buffered-sse-json";
import { bridgeToResponsesSSE } from "../../src/bridge";
import {
  comboStreamPayloadCommitsOutput,
  deferProtocolSafeResetRecovery,
  preflightComboStreamResponse,
  replayBufferedResponse,
} from "../../src/server/responses/combo-stream-preflight";
import { stageCommitment, type RequestFailureStage } from "../../src/lib/request-failure-model";
import type { RequestLogContext } from "../../src/server/request-log";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../../src/server/sse-frame-buffer";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { markPacedStream } from "../../src/lib/paced-stream";

const sse = (...payloads: unknown[]): Response => new Response(
  payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);

const preflightChunkLimit = Math.max(1, Math.ceil(MAX_CLIENT_SSE_FRAME_BYTES / 1024));
const flushMicrotasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function prefixThenReadError(prefix: Uint8Array, error: Error): {
  response: Response;
  cancelSpy: () => ReturnType<typeof spyOn> | undefined;
} {
  let sentPrefix = false;
  let cancelSpy: ReturnType<typeof spyOn> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        controller.enqueue(prefix);
        return;
      }
      return Promise.reject(error);
    },
  });
  const originalGetReader = stream.getReader.bind(stream);
  stream.getReader = (() => {
    const reader = originalGetReader();
    cancelSpy = spyOn(reader, "cancel");
    return reader;
  }) as ReadableStream<Uint8Array>["getReader"];
  return {
    response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    cancelSpy: () => cancelSpy,
  };
}

const createdPrefix = new TextEncoder().encode(`data: ${JSON.stringify({
  type: "response.created",
  response: { id: "r1", status: "in_progress" },
})}

`);

describe("combo stream preflight", () => {
  test.each(["silence", "comment", "lifecycle"] as const)("buffered collector counts upstream activity, not timer heartbeats (%s)", async activity => {
    jest.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = 0;
    const original = new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; }, cancel() { cancelled++; },
    }), { headers: { "content-type": "text/event-stream" } });
    const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => null,
      { heartbeatIntervalMs: 15_000, keepalive: "upstream-activity" });
    const upstream = new AbortController();
    const cancellation = new AbortController();
    const pending = collectBufferedResponsesSse(wrapped.body!, upstream,
      { signal: cancellation.signal, read: { firstByteTimeoutMs: 300_000, inactivityTimeoutMs: 300_000, totalTimeoutMs: 900_000 } });
    let result: Awaited<typeof pending> | undefined;
    void pending.then(value => { result = value; });
    try {
      await flushMicrotasks();
      for (let i = 0; i < 19; i++) { jest.advanceTimersByTime(15_000); await flushMicrotasks(); }
      expect(result).toBeUndefined();
      if (activity !== "silence") {
        source.enqueue(activity === "comment" ? new TextEncoder().encode(": upstream\n\n") : createdPrefix);
        await flushMicrotasks();
        for (let i = 0; i < 19; i++) { jest.advanceTimersByTime(15_000); await flushMicrotasks(); }
        expect(result).toBeUndefined();
      }
      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      expect(result?.ok).toBe(false);
      if (result && !result.ok) expect(result.kind).toBe("timeout");
      expect(upstream.signal.aborted).toBe(true);
      expect(cancelled).toBe(1);
    } finally {
      cancellation.abort();
      await pending;
      jest.useRealTimers();
    }
  });

  test("combo preflight can fail over after more than its chunk cap of heartbeat intervals", async () => {
    jest.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const original = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }),
      { headers: { "content-type": "text/event-stream" } });
    const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => null,
      { heartbeatIntervalMs: 1, keepalive: "none" });
    const abort = new AbortController();
    const pending = preflightComboStreamResponse(wrapped, { model: "m1", provider: "a" }, undefined, { signal: abort.signal });
    let result: Awaited<typeof pending> | undefined;
    void pending.then(value => { result = value; }, () => {});
    try {
      await flushMicrotasks();
      for (let i = 0; i <= preflightChunkLimit; i++) { jest.advanceTimersByTime(1); await flushMicrotasks(); }
      expect(result).toBeUndefined();
      source.enqueue(new TextEncoder().encode('data: {"type":"response.failed","response":{"status":"failed","error":{"message":"busy"}}}\n\n'));
      source.close();
      await flushMicrotasks();
      expect((await pending).kind).toBe("failed");
    } finally { abort.abort(); await pending.catch(() => {}); jest.useRealTimers(); }
  });

  test("buffered collector accepts a successful recovery after real prelude activity", async () => {
    let replacements = 0;
    const wrapped = deferProtocolSafeResetRecovery(
      sse({ type: "response.created", response: { id: "original", status: "in_progress", output: [] } }),
      { model: "m1", provider: "a" }, async () => {
        replacements++;
        return sse({ type: "response.completed", response: { id: "replacement", status: "completed", output: [] } });
      }, { keepalive: "upstream-activity" },
    );
    const result = await collectBufferedResponsesSse(wrapped.body!, new AbortController());
    expect(result).toMatchObject({ ok: true, terminal: { status: "completed", response: { id: "replacement" } } });
    expect(replacements).toBe(1);
  });

  test("buffered collector cancellation aborts held preflight without starting recovery", async () => {
    let cancelled = 0;
    let replacements = 0;
    const original = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }),
      { headers: { "content-type": "text/event-stream" } });
    const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
      replacements++;
      return null;
    }, { keepalive: "upstream-activity" });
    const cancellation = new AbortController();
    const result = collectBufferedResponsesSse(wrapped.body!, new AbortController(), { signal: cancellation.signal });
    await flushMicrotasks();
    cancellation.abort(new Error("client cancelled"));
    expect(await result).toMatchObject({ ok: false, kind: "aborted" });
    await flushMicrotasks();
    expect(cancelled).toBe(1);
    expect(replacements).toBe(0);
  });
  test("a required-tool contract failure carrying a tool call is not replayed", async () => {
    const failed = (output: unknown[], retryable?: boolean) => sse({ type: "response.failed", response: {
      id: "r1", status: "failed", output,
      error: { code: "required_tool_contract_unsatisfied", message: "no tool call", ...(retryable === undefined ? {} : { retryable }) },
    } });
    const held = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "held" }] }];
    expect((await preflightComboStreamResponse(failed(held), { model: "m1", provider: "a" })).kind).toBe("failed");
    expect((await preflightComboStreamResponse(failed(held, false), { model: "m1", provider: "a" })).kind).toBe("accepted");
    const call = [{ type: "function_call", call_id: "c1", name: "f", arguments: "{}" }];
    expect((await preflightComboStreamResponse(failed(call), { model: "m1", provider: "a" })).kind).toBe("accepted");
    // A tool call on the event's own output counts too, even beside an empty snapshot output.
    const topLevel = sse({ type: "response.failed", output: call, response: {
      id: "r1", status: "failed", output: [], error: { code: "required_tool_contract_unsatisfied", message: "no tool call" },
    } });
    expect((await preflightComboStreamResponse(topLevel, { model: "m1", provider: "a" })).kind).toBe("accepted");
  });

  test("keeps only lifecycle preamble replayable and treats unknown output conservatively", () => {
    expect(comboStreamPayloadCommitsOutput({ type: "response.created" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.heartbeat" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.failed" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.incomplete" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.output_text.delta", delta: "" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.output_text.delta" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.output_text.delta", delta: "x" })).toBe(true);
    expect(comboStreamPayloadCommitsOutput({ type: "response.output_item.added", item: { type: "function_call" } })).toBe(true);
    expect(comboStreamPayloadCommitsOutput({ type: "provider.future_event" })).toBe(true);
  });

  test("converts a zero-output failed terminal into a retryable HTTP failure", async () => {
    const logCtx: RequestLogContext = { model: "m1", provider: "a" };
    const result = await preflightComboStreamResponse(sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      {
        type: "response.failed",
        response: {
          id: "r1",
          status: "failed",
          error: { type: "server_error", code: "upstream_server_error", message: "busy" },
          usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
          provider_trace_id: "must-not-cross-the-combo-boundary",
        },
      },
    ), logCtx);

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body).toMatchObject({
      error: { code: "upstream_server_error", message: "busy" },
      response: { usage: { input_tokens: 7, output_tokens: 0 } },
    });
    expect(JSON.stringify(body)).not.toContain("provider_trace_id");
  });

  test("converts zero-output transport incompletes into retryable HTTP failures", async () => {
    const cases = [
      ["adapter_eof", "Upstream stream ended unexpectedly without a terminal event"],
      ["missing_terminal_event", "Upstream incomplete"],
      ["upstream_stall_timeout", "Upstream stalled"],
    ] as const;
    for (const [reason, message] of cases) {
      const result = await preflightComboStreamResponse(sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        {
          type: "response.incomplete",
          response: {
            id: "r1",
            status: "incomplete",
            incomplete_details: { reason },
            usage: { input_tokens: 11, output_tokens: 0, total_tokens: 11 },
          },
        },
      ), { model: "m1", provider: "a" });

      expect(result.kind).toBe("failed");
      expect(result.response.status).toBe(502);
      const body = await result.response.json();
      expect(body.error).toMatchObject({ type: "upstream_error", code: "upstream_server_error" });
      expect(body.error.message).toContain(message);
      expect(body.response.usage).toMatchObject({ input_tokens: 11, output_tokens: 0 });
    }
  });

  test("converts a zero-output incomplete without a stated reason into a retryable failure", async () => {
    for (const response of [
      { id: "r1", status: "incomplete" },
      { id: "r1", status: "incomplete", incomplete_details: null },
    ]) {
      const result = await preflightComboStreamResponse(sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        { type: "response.incomplete", response },
      ), { model: "m1", provider: "a" });
      expect(result.kind).toBe("failed");
      expect(result.response.status).toBe(502);
    }
  });

  for (const item of [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "already answered" }] },
    { type: "function_call", name: "lookup", call_id: "call-snapshot", arguments: "{}" },
  ]) test(`does not replay a reasonless incomplete carrying terminal snapshot output (${item.type})`, async () => {
    const source = sse({ type: "response.incomplete", response: {
      id: "r1", status: "incomplete", output: [item],
    } });
    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  for (const reason of ["content_filter", "future_semantic_reason", "", null])
  test(`does not replay semantic or explicit unknown incomplete reasons (${JSON.stringify(reason)})`, async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason },
        },
      },
    );
    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  for (const reason of ["adapter_eof", undefined])
  test(`does not replay incompletes after output commits the target (${reason ?? "missing reason"})`, async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "visible" },
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason },
        },
      },
    );
    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("replays buffered bytes unchanged after output commits the target", async () => {
    const original = [
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "visible" },
      {
        type: "response.failed",
        response: { status: "failed", error: { type: "server_error", message: "late" } },
      },
    ];
    const source = sse(...original);
    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });

    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("commits an oversized next chunk without copying it beyond the preflight cap", async () => {
    const encoder = new TextEncoder();
    const preamble = encoder.encode(`data: ${JSON.stringify({
      type: "response.created",
      response: { id: "r1", status: "in_progress" },
    })}\n\n`);
    const oversized = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1);
    oversized.fill(120);
    const chunks = [preamble, oversized];
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });

    const result = await preflightComboStreamResponse(response, { model: "m1", provider: "a" });
    expect(result.kind).toBe("accepted");
    const reader = result.response.body!.getReader();
    const first = await reader.read();
    const second = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(new TextDecoder().decode(preamble));
    expect(second.value).toBe(oversized);
    await reader.cancel();
  });

  test("commits at the retained-chunk boundary without reading one more chunk", async () => {
    const prefix = Array.from(
      { length: preflightChunkLimit },
      (_, index) => Uint8Array.of((index % 251) + 1),
    );
    const tail = Uint8Array.of(252, 253);
    let sourceIndex = 0;
    let releaseTail: (() => void) | undefined;
    let reportNextPull!: () => void;
    const nextPull = new Promise<void>(resolve => { reportNextPull = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sourceIndex < prefix.length) {
          controller.enqueue(prefix[sourceIndex++]!);
          return;
        }
        reportNextPull();
        return new Promise<void>(resolve => {
          releaseTail = () => {
            controller.enqueue(tail);
            controller.close();
            resolve();
          };
        });
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });

    const preflight = preflightComboStreamResponse(response, { model: "m1", provider: "a" });
    const winner = await Promise.race([
      preflight.then(result => ({ kind: "preflight" as const, result })),
      nextPull.then(() => ({ kind: "next-pull" as const })),
    ]);
    if (winner.kind === "next-pull") {
      releaseTail!();
      const late = await preflight;
      await late.response.body?.cancel();
    }
    expect(winner.kind).toBe("preflight");
    if (winner.kind !== "preflight") return;

    expect(winner.result.kind).toBe("accepted");
    const reader = winner.result.response.body!.getReader();
    for (let index = 0; index < prefix.length; index += 1) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      expect(next.value).not.toBe(prefix[index]);
      expect(next.value).toEqual(prefix[index]);
    }

    const tailRead = reader.read();
    await nextPull;
    expect(releaseTail).toBeDefined();
    releaseTail!();
    const replayedTail = await tailRead;
    expect(replayedTail.done).toBe(false);
    expect(replayedTail.value).toBe(tail);
    expect((await reader.read()).done).toBe(true);
  });

  test("keeps a failed terminal authoritative at the retained-chunk boundary", async () => {
    const encoder = new TextEncoder();
    const comment = encoder.encode(":\n\n");
    const failed = encoder.encode(`data: ${JSON.stringify({
      type: "response.failed",
      response: {
        status: "failed",
        error: { type: "server_error", code: "upstream_server_error", message: "busy" },
        usage: { input_tokens: 9, output_tokens: 0, total_tokens: 9 },
        provider_trace_id: "must-not-cross-the-combo-boundary",
      },
    })}\n\n`);
    let sourceIndex = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sourceIndex < preflightChunkLimit - 1) {
          sourceIndex += 1;
          controller.enqueue(comment);
          return;
        }
        if (sourceIndex === preflightChunkLimit - 1) {
          sourceIndex += 1;
          controller.enqueue(failed);
        }
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });

    const result = await preflightComboStreamResponse(response, { model: "m1", provider: "a" });
    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body).toMatchObject({
      error: { code: "upstream_server_error", message: "busy" },
      response: { usage: { input_tokens: 9, output_tokens: 0 } },
    });
    expect(JSON.stringify(body)).not.toContain("provider_trace_id");
  });

  const DECRYPT_REJECTION =
    "Encrypted function output content could not be decrypted or decoded.";

  const exactDecryptRetryable = (payload: unknown): boolean => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const event = payload as {
      type?: unknown;
      message?: unknown;
      error?: { message?: unknown };
      response?: { error?: { message?: unknown } };
    };
    if (event.type !== "error" && event.type !== "response.failed" && event.type !== "response.incomplete") {
      return false;
    }
    const message = event.error?.message
      ?? event.response?.error?.message
      ?? (event.type === "error" ? event.message : undefined);
    return message === DECRYPT_REJECTION;
  };

  test("default preflight retries zero-output bare errors without structured status", async () => {
    expect(comboStreamPayloadCommitsOutput({ type: "error" })).toBe(true);
    for (const [payload, status] of [
      [{ type: "error", message: "An error occurred while processing your request. Please include request ID r1." }, 502],
      [{ type: "error", error: { message: "unknown upstream failure" } }, 502],
      [{ type: "error", error: { type: "server_error", message: "busy" } }, 502],
      [{ type: "error", error: { status: "429", message: "slow down" } }, 429],
      [{ type: "error", error: { http_status: 503, message: "unavailable" } }, 503],
    ]) {
      const source = sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        payload,
      );
      const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
      expect(result.kind).toBe("failed");
      expect(result.response.status).toBe(status);
    }
  });

  test("does not retry explicit zero-output client errors", async () => {
    for (const payload of [
      { type: "error", error: { status: 400, message: "bad request" } },
      { type: "error", error: { type: "invalid_request_error", message: "bad parameter" } },
      { type: "error", code: "invalid_request_error", message: "bad argument" },
    ]) {
      const source = sse(
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        payload,
      );
      const expected = await source.clone().text();
      const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
      expect(result.kind).toBe("accepted");
      expect(await result.response.text()).toBe(expected);
    }
  });

  test("commits an untyped error envelope instead of advancing the combo (#8216)", async () => {
    // Not a control event, so it is never resent to another target; the relay reports it as failed.
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { error: { message: "openai_error", code: "bad_response_status_code" } },
    );
    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("retries a zero-output opaque OpenRouter numeric 400 without a structured code", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      status: 400,
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
      },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(400);
  });

  test("retries a zero-output opaque OpenRouter numeric 400 when status is omitted from SSE error", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
      },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(400);
    const body = await result.response.json();
    expect(body.error).toMatchObject({
      message: "Provider returned error",
      code: 400,
      metadata: { raw: "ERROR" },
    });
  });

  test("treats a zero-output opaque OpenRouter numeric 400 carrying root detail for malformed response_format as terminal", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      detail: "Invalid schema for response_format: 'type' must be 'object'",
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
      },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("accepted");
  });

  test("a conflicting root and nested code still fails over when each would on its own", async () => {
    // Neither code is a hard stop, so the conflict alone is no reason to keep a retryable failure.
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      code: "server_error",
      status: 503,
      error: { message: "overloaded", code: "server_is_overloaded" },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
  });

  test("a conflicting root hard stop keeps a retryable nested code terminal", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      code: "origin_rejected",
      status: 429,
      error: { message: "rate limited", code: "rate_limit_exceeded" },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("accepted");
  });

  test("treats a zero-output opaque OpenRouter numeric 400 carrying root code invalid_request_error as terminal", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      code: "invalid_request_error",
      status: 400,
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
      },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("accepted");
  });

  test("retries a zero-output flat opaque OpenRouter numeric 400 SSE frame without status", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      message: "Provider returned error",
      code: 400,
      metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(400);
    const body = await result.response.json();
    expect(body.error).toMatchObject({
      message: "Provider returned error",
      code: 400,
      metadata: { raw: "ERROR" },
    });
  });

  test("retries a zero-output flat opaque OpenRouter numeric 400 SSE frame with explicit status 400", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      status: 400,
      message: "Provider returned error",
      code: 400,
      metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(400);
  });

  test("treats a wrapped invalid_request_error with upstream_error as terminal", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      status: 400,
      error: {
        type: "upstream_error",
        message: 'Provider error 400: {"type":"error","error":{"type":"invalid_request_error","message":"tools.0.custom.name: String should match pattern ..."}}',
      },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("accepted");
  });

  test("retries a zero-output bare SSE error carrying numeric code 1308", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      error: { code: 1308, message: "Usage limit reached" },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
  });

  test("treats a zero-output bare SSE error with HTTP 400 and non-400 numeric code as terminal", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      status: 400,
      error: {
        code: 404,
        type: "upstream_error",
        message: "Resource not found",
      },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("accepted");
  });

  test("a root hop code leaves an opaque wrapper retryable, and a blank root code is no verdict", async () => {
    // HTTP used to stop on any root code other than "400". The stream never did, so the carrier
    // -- not the envelope -- decided. These four were the divergence: two hop signals, and the
    // two ways a root states no code at all.
    for (const code of ["model_not_found", "input_admission_refused", "", "  "]) {
      const result = await preflightComboStreamResponse(sse({
        type: "error",
        status: 400,
        code,
        error: { message: "Provider returned error", code: 400, metadata: { raw: "ERROR" } },
      }), { model: "m1", provider: "a" });

      expect(result.kind).toBe("failed");
      expect(result.response.status).toBe(400);
    }
  });

  test("a root hard stop keeps a retryable nested record terminal, matching HTTP", async () => {
    for (const code of ["content_policy_violation", "origin_rejected", "context_length_exceeded"]) {
      const result = await preflightComboStreamResponse(sse({
        type: "error",
        status: 400,
        code,
        error: { message: "retryable", code: "model_not_found" },
      }), { model: "m1", provider: "a" });

      expect(result.kind).toBe("accepted");
    }
  });

  test("a bare response.error is not an error event, so the frame commits like any other payload", async () => {
    // Neither transport reads this carrier: under `type: "error"` it is not an error event, and
    // HTTP has no error record to classify. Reading it on HTTP alone made one document hop there
    // and stop here.
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      status: 400,
      response: { error: { message: "Provider returned error", code: 400, metadata: { raw: "ERROR" } } },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("accepted");
  });

  test("passes a zero-output credential error to the ordinary combo classifier", async () => {
    const result = await preflightComboStreamResponse(sse({
      type: "error",
      error: { type: "authentication_error", message: "bad credential" },
    }), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(401);
  });

  test("retries a structured model-lifecycle 410 through the ordinary combo classifier", async () => {
    const result = await preflightComboStreamResponse(sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      {
        type: "error",
        status: 410,
        error: { code: "model_end_of_life", message: "model retired" },
      },
    ), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(410);
  });

  test("honors root status when a bare error has a nested error object", async () => {
    const clientError = sse({
      type: "error",
      status: 400,
      error: { status: 503, message: "bad request" },
    });
    const expected = await clientError.clone().text();
    const clientResult = await preflightComboStreamResponse(clientError, { model: "m1", provider: "a" });
    expect(clientResult.kind).toBe("accepted");
    expect(await clientResult.response.text()).toBe(expected);

    const serverResult = await preflightComboStreamResponse(sse({
      type: "error",
      status: 503,
      error: { status: 400, message: "upstream failed" },
    }), { model: "m1", provider: "a" });
    expect(serverResult.kind).toBe("failed");
    expect(serverResult.response.status).toBe(503);
  });

  test("treats invalid explicit error statuses as unknown upstream failures", async () => {
    for (const status of [Number.NaN, 204, 999, "999"]) {
      const result = await preflightComboStreamResponse(sse({
        type: "error",
        status,
        error: { message: "upstream failed" },
      }), { model: "m1", provider: "a" });
      expect(result.kind).toBe("failed");
      expect(result.response.status).toBe(502);
    }
  });

  test("an explicit predicate can retry a known client-classified bare error", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "error", error: { status: 400, message: DECRYPT_REJECTION } },
    );
    const original = await source.clone().text();
    const result = await preflightComboStreamResponse(
      source,
      { model: "m1", provider: "a" },
      exactDecryptRetryable,
    );

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.text()).not.toBe(original);
  });

  test("an explicit predicate still commits an unrelated bare error", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "error", message: "unrelated upstream busy" },
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: { type: "server_error", message: DECRYPT_REJECTION },
        },
      },
    );
    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(
      source,
      { model: "m1", provider: "a" },
      exactDecryptRetryable,
    );

    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("output before a bare error does not retry", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "visible" },
      { type: "error", message: DECRYPT_REJECTION },
    );
    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(
      source,
      { model: "m1", provider: "a" },
      exactDecryptRetryable,
    );

    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("a bare error before output in the same chunk keeps the retry decision", async () => {
    const result = await preflightComboStreamResponse(sse(
      { type: "error", message: "upstream failed" },
      { type: "response.output_text.delta", delta: "too late" },
    ), { model: "m1", provider: "a" });

    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(502);
  });

  test("a completed terminal before a bare error in the same chunk stays authoritative", async () => {
    const source = sse(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      { type: "error", message: "too late" },
    );
    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });

    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  for (const contentType of ["text/event-stream", "Text/Event-Stream; charset=UTF-8", "TEXT/EVENT-STREAM ; charset=utf-8"]) {
    test(`recognizes an exact SSE media type (${contentType})`, async () => {
      const source = sse({ type: "error", message: "upstream failed" });
      source.headers.set("content-type", contentType);
      const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
      expect(result.kind).toBe("failed");
      expect(result.response.status).toBe(502);
      expect((await result.response.json()).error.message).toBe("upstream failed");
    });
  }

  for (const contentType of ["application/json; profile=\"text/event-stream\"", "text/event-stream-invalid", "application/text/event-stream"]) {
    for (const allowMissingContentType of [false, true]) {
      test(`leaves non-SSE media types unread (${contentType}, missing fallback ${allowMissingContentType})`, async () => {
        const body = JSON.stringify({ output: [{ type: "message", content: "complete JSON response" }] });
        const source = new Response(body, { headers: { "content-type": contentType } });
        const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" }, undefined, { allowMissingContentType });
        expect(result.kind).toBe("accepted");
        expect(result.response).toBe(source);
        expect(source.bodyUsed).toBe(false);
        expect(source.headers.get("content-type")).toBe(contentType);
        expect(await result.response.text()).toBe(body);
      });
    }
  }

  test("default missing content-type is refused, and allowMissingContentType accepts only an absent type", async () => {
    const payloads = [
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "error", message: DECRYPT_REJECTION },
    ];
    const body = payloads.map(payload => "data: " + JSON.stringify(payload) + "\n\n").join("");
    const encoded = () => new TextEncoder().encode(body);
    const missingTypeResponse = () => {
      const headers = new Headers();
      headers.delete("content-type");
      const response = new Response(encoded(), { headers });
      response.headers.delete("content-type");
      return response;
    };

    const missing = missingTypeResponse();
    expect(missing.headers.get("content-type")).toBeNull();
    const missingDefault = await preflightComboStreamResponse(missing, { model: "m1", provider: "a" });
    expect(missingDefault.kind).toBe("accepted");
    expect(await missingDefault.response.text()).toBe(body);

    const allowedMissingSource = missingTypeResponse();
    expect(allowedMissingSource.headers.get("content-type")).toBeNull();
    const allowedMissing = await preflightComboStreamResponse(
      allowedMissingSource,
      { model: "m1", provider: "a" },
      exactDecryptRetryable,
      { allowMissingContentType: true },
    );
    expect(allowedMissing.kind).toBe("failed");
    expect(allowedMissing.response.status).toBe(502);

    for (const contentType of ["application/json", "text/plain"]) {
      const source = new Response(encoded(), { headers: { "content-type": contentType } });
      const result = await preflightComboStreamResponse(
        source,
        { model: "m1", provider: "a" },
        exactDecryptRetryable,
        { allowMissingContentType: true },
      );
      expect(result.kind).toBe("accepted");
      expect(await result.response.text()).toBe(body);
    }
  });

  test("default reader.read rejection still throws and does not cancel the reader", async () => {
    const readError = new Error("preflight-read-reset");
    const source = prefixThenReadError(createdPrefix, readError);
    await expect(preflightComboStreamResponse(source.response, { model: "m1", provider: "a" }))
      .rejects.toBe(readError);
    expect(source.cancelSpy()).toBeDefined();
    expect(source.cancelSpy()!.mock.calls).toHaveLength(0);
  });

  test("replayReadErrors returns a reconstructed prefix, the same read error, and the observed stage", async () => {
    const readError = new Error("preflight-read-reset");
    const source = prefixThenReadError(createdPrefix, readError);
    const result = await preflightComboStreamResponse(
      source.response,
      { model: "m1", provider: "a" },
      undefined,
      { replayReadErrors: true },
    );
    expect(result.kind).toBe("read-error");
    if (result.kind === "read-error") {
      expect(result.error).toBe(readError);
      // response.created and nothing else: the failure model puts that in the prelude, and a
      // prelude is a stage at which the caller has observed nothing.
      expect(result.stage).toBe("protocol-prelude");
      expect(stageCommitment(result.stage)).toBe("nothing-observed");
    }
    expect(source.cancelSpy()).toBeDefined();
    expect(source.cancelSpy()!.mock.calls).toHaveLength(0);
    const reader = result.response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(createdPrefix);
    await expect(reader.read()).rejects.toBe(readError);
    expect(source.cancelSpy()).toBeDefined();
    expect(source.cancelSpy()!.mock.calls).toHaveLength(0);
  });

  test("a read error before any event is headers-only, and a committed stream never reports one", async () => {
    const readError = new Error("preflight-read-reset");
    const bare = await preflightComboStreamResponse(
      prefixThenReadError(new TextEncoder().encode(""), readError).response,
      { model: "m1", provider: "a" },
      undefined,
      { replayReadErrors: true },
    );
    expect(bare.kind).toBe("read-error");
    if (bare.kind === "read-error") {
      expect(bare.stage).toBe("headers-only");
      expect(stageCommitment(bare.stage)).toBe("nothing-observed");
    }

    // Once output commits the preflight stops buffering and hands the body back, so the read
    // error that follows happens on the caller's side of the boundary and no stage is ever
    // reported. That is the stronger statement: a committed stream does not reach the resend
    // gate at all, rather than reaching it and being refused there.
    const outputPrefix = new TextEncoder().encode(`data: ${JSON.stringify({
      type: "response.output_text.delta", delta: "hi",
    })}\n\n`);
    const committed = await preflightComboStreamResponse(
      prefixThenReadError(outputPrefix, readError).response,
      { model: "m1", provider: "a" },
      undefined,
      { replayReadErrors: true },
    );
    expect(committed.kind).toBe("accepted");
    // The prefix is still relayed and the error still reaches whoever reads it.
    const reader = committed.response.body!.getReader();
    expect((await reader.read()).value).toEqual(outputPrefix);
    await expect(reader.read()).rejects.toBe(readError);
  });

  /**
   * The boundary that decides resend permission, asserted where it is actually enforced.
   *
   * The stage a read error is reported at is only half the guarantee. What matters is that a
   * stream which committed output never gets a replacement offered at all, and the seam that
   * decides it is the deferred wrapper, not the preflight. The commitment is read from
   * `stageCommitment` rather than compared against a written-out stage name, so a stage added
   * to the model later cannot pass this by being unlisted.
   */
  test("a replacement is offered only for a stage the caller observed nothing at", async () => {
    const readError = new Error("preflight-read-reset");
    const logCtx: RequestLogContext = { model: "m1", provider: "a" };
    const seen: RequestFailureStage[] = [];
    const recover = async (_error: unknown, stage: RequestFailureStage): Promise<Response | null> => {
      seen.push(stage);
      return null;
    };

    const prelude = deferProtocolSafeResetRecovery(
      prefixThenReadError(createdPrefix, readError).response, logCtx, recover);
    const preludeReader = prelude.body!.getReader();
    expect((await preludeReader.read()).value).toEqual(createdPrefix);
    await expect(preludeReader.read()).rejects.toBe(readError);
    expect(seen).toHaveLength(1);
    expect(stageCommitment(seen[0]!)).toBe("nothing-observed");

    seen.length = 0;
    const outputPrefix = new TextEncoder().encode(`data: ${JSON.stringify({
      type: "response.output_text.delta", delta: "hi",
    })}\n\n`);
    const committed = deferProtocolSafeResetRecovery(
      prefixThenReadError(outputPrefix, readError).response, logCtx, recover);
    const committedReader = committed.body!.getReader();
    expect((await committedReader.read()).value).toEqual(outputPrefix);
    await expect(committedReader.read()).rejects.toBe(readError);
    // Never consulted. A turn whose output the caller already saw cannot be replaced, and it
    // does not get as far as asking.
    expect(seen).toEqual([]);
  });

  test("a clean prelude-only EOF offers one replacement before relaying the prefix", async () => {
    const original = sse({ type: "response.created", response: { id: "first", output: [] } });
    const stages: RequestFailureStage[] = [];
    const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async (_error, stage) => {
      stages.push(stage);
      return sse({ type: "response.completed", response: { id: "replacement", status: "completed" } });
    });
    const text = await wrapped.text();
    expect(stages).toEqual(["protocol-prelude"]);
    expect(text).toContain("replacement");
    expect(text).not.toContain('"first"');
  });

  test("declined clean EOF recovery preserves the original prelude", async () => {
    const original = sse({ type: "response.created", response: { id: "first", output: [] } });
    let calls = 0;
    const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
      calls++;
      return null;
    });
    expect(await wrapped.text()).toContain('"first"');
    expect(calls).toBe(1);
  });

  test.each([
    [{ type: "response.completed", response: { status: "completed", output: [] } }],
    [{ type: "response.output_text.delta", delta: "visible" }],
    [{ error: { type: "server_error", message: "fixture" } }],
    [{ type: "response.created", response: { output: [{ type: "message" }] } }],
  ])("terminal, output or explicit error never offers EOF recovery (%j)", async payload => {
    let calls = 0;
    const wrapped = deferProtocolSafeResetRecovery(sse(payload), { model: "m1", provider: "a" }, async () => {
      calls++;
      return null;
    });
    await wrapped.text();
    expect(calls).toBe(0);
  });

  test.each(["data: {not-json}\n\n", 'data: {"type":"response.output'])(
    "opaque or truncated payload never offers EOF recovery", async payload => {
      let calls = 0;
      const source = new Response(payload, { headers: { "content-type": "text/event-stream" } });
      const wrapped = deferProtocolSafeResetRecovery(source, { model: "m1", provider: "a" }, async () => { calls++; return null; });
      expect(await wrapped.text()).toBe(payload);
      expect(calls).toBe(0);
    },
  );

  test("downstream cancellation while the prelude is held never starts a replacement", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let onPull!: () => void;
    const pulled = new Promise<void>(resolve => { onPull = resolve; });
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      pull() { onPull(); },
    });
    let calls = 0;
    const wrapped = deferProtocolSafeResetRecovery(new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      { model: "m1", provider: "a" }, async () => { calls++; return null; });
    const reader = wrapped.body!.getReader();
    const pending = reader.read();
    await pulled;
    await reader.cancel();
    try { source.close(); } catch { /* a correct wrapper may already cancel the source */ }
    await pending;
    await Bun.sleep(0);
    expect(calls).toBe(0);
  });

  test("downstream cancellation aborts a replacement already in flight", async () => {
    let started!: (signal: AbortSignal) => void;
    const recoveryStarted = new Promise<AbortSignal>(resolve => { started = resolve; });
    const wrapped = deferProtocolSafeResetRecovery(
      sse({ type: "response.created", response: { id: "first", output: [] } }),
      { model: "m1", provider: "a" },
      async (_error, _stage, signal) => {
        started(signal);
        return new Promise(resolve => signal.addEventListener("abort", () => resolve(null), { once: true }));
      },
    );
    const reader = wrapped.body!.getReader();
    const pending = reader.read();
    const signal = await recoveryStarted;
    await reader.cancel();
    await pending;
    expect(signal.aborted).toBe(true);
  });

  test("held prelude sends bounded keepalive comments while upstream is silent", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, pull() {} });
    const wrapped = deferProtocolSafeResetRecovery(new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      { model: "m1", provider: "a" }, async () => null, { heartbeatIntervalMs: 5 });
    const reader = wrapped.body!.getReader();
    try {
      for (let i = 0; i < 2; i++) {
        const result = await Promise.race([reader.read(), Bun.sleep(150).then(() => null)]);
        expect(result).not.toBeNull();
        if (result && !result.done) expect(new TextDecoder().decode(result.value)).toMatch(/^:.*\n\n$/);
      }
      source.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
      source.close();
      const result = await reader.read();
      expect(result.done).toBe(false);
      if (!result.done) expect(new TextDecoder().decode(result.value)).toContain("response.completed");
      expect((await reader.read()).done).toBe(true);
    } finally { await reader.cancel(); }
  });

  test.each([
    ['event: error\ndata: {"type":"response.created"}\n\n'],
    ['event: response.output_text.delta\ndata: {"type":"response.created"}\n\n'],
    ['event: response.created\nevent: error\ndata: {"type":"response.created"}\n\n'],
    ['event: error\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n'],
    ['event: error\ndata:\n\n'],
  ])("conflicting or opaque SSE frames preserve original bytes (%s)", async frame => {
    const bytes = new TextEncoder().encode(frame);
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, ++offset));
      },
    });
    let calls = 0;
    const wrapped = deferProtocolSafeResetRecovery(
      new Response(source, { headers: { "content-type": "text/event-stream" } }),
      { model: "m1", provider: "a" }, async () => { calls++; return sse({ type: "response.completed" }); },
    );
    expect(await wrapped.text()).toBe(frame);
    expect(calls).toBe(0);
  });

  test.each([
    'data: {"type":"response.created"}\n\n',
    'event: error\nevent: response.created\ndata: {"type":"response.created"}\n\n',
    'event:\ndata: {"type":"response.created"}\n\n',
  ])("ordinary prelude event semantics still allow EOF recovery (%s)", async frame => {
    let calls = 0;
    const wrapped = deferProtocolSafeResetRecovery(
      new Response(frame, { headers: { "content-type": "text/event-stream" } }),
      { model: "m1", provider: "a" }, async () => { calls++; return sse({ type: "response.completed", response: { id: "replacement" } }); },
    );
    expect(await wrapped.text()).toContain('"replacement"');
    expect(calls).toBe(1);
  });

  test("a retryable bare error remains authoritative over a later conflicting frame in the same chunk", async () => {
    const body = 'data: {"type":"error","error":{"message":"first"}}\n\n'
      + 'event: error\ndata: {"type":"response.created"}\n\n';
    const result = await preflightComboStreamResponse(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      { model: "m1", provider: "a" },
    );
    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(502);
  });

  test.each([
    'data: {"type":"response.output_text.delta","delta":"original"}',
    'data: {"type":"error","error":{"message":"original"}}',
    'data: {"type":"response.completed","response":{"status":"completed"}}',
    'data: {"type":"response.output',
    'data:',
    'event: error',
  ])("read rejection retains unfinished unsafe frame and the same error (%s)", async frame => {
    const readError = new Error("original reset");
    const prefix = new TextEncoder().encode(frame);
    let calls = 0;
    const wrapped = deferProtocolSafeResetRecovery(
      prefixThenReadError(prefix, readError).response, { model: "m1", provider: "a" },
      async () => { calls++; return sse({ type: "response.completed", response: { id: "replacement" } }); },
    );
    const reader = wrapped.body!.getReader();
    expect((await reader.read()).value).toEqual(prefix);
    await expect(reader.read()).rejects.toBe(readError);
    expect(calls).toBe(0);
  });

  test("read rejection after an unfinished empty control still allows recovery", async () => {
    const prefix = new TextEncoder().encode('data: {"type":"response.created","response":{"output":[]}}');
    let calls = 0;
    const wrapped = deferProtocolSafeResetRecovery(
      prefixThenReadError(prefix, new Error("reset")).response, { model: "m1", provider: "a" },
      async () => { calls++; return sse({ type: "response.completed", response: { id: "replacement" } }); },
    );
    expect(await wrapped.text()).toContain('"replacement"');
    expect(calls).toBe(1);
  });

  // #8107: the Codex WebSocket writes its quota/metadata frames into the same body, usually before
  // `response.created`. They must neither commit the child nor end the preflight.
  test("Codex metadata control frames neither commit nor terminate the preflight", async () => {
    expect(comboStreamPayloadCommitsOutput({ type: "codex.rate_limits" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "codex.response.metadata", headers: {} })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "codex.future_control" })).toBe(true);

    const rateLimits = { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } } };
    const overloaded = {
      type: "error",
      status: 503,
      error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded." },
    };
    const failed = await preflightComboStreamResponse(sse(
      rateLimits,
      { type: "codex.response.metadata", headers: { "x-codex-turn-state": "t" } },
      { type: "response.created", response: { id: "r1", status: "in_progress", output: [] } },
      { type: "response.in_progress", response: { id: "r1", status: "in_progress", output: [] } },
      overloaded,
    ), { model: "m1", provider: "a" });
    expect(failed.kind).toBe("failed");
    expect(failed.response.status).toBe(503);
    expect(await failed.response.json()).toMatchObject({ error: { code: "server_is_overloaded" } });

    // Output after the metadata still commits, and the bytes replay unchanged.
    const committed = sse(
      rateLimits,
      { type: "response.created", response: { id: "r1", status: "in_progress", output: [] } },
      { type: "response.output_text.delta", delta: "visible" },
      overloaded,
    );
    const expected = await committed.clone().text();
    const accepted = await preflightComboStreamResponse(committed, { model: "m1", provider: "a" });
    expect(accepted.kind).toBe("accepted");
    expect(await accepted.response.text()).toBe(expected);

    // A stream that ends after metadata alone was not a terminal; it is accepted, not failed.
    const metadataOnly = await preflightComboStreamResponse(sse(rateLimits), { model: "m1", provider: "a" });
    expect(metadataOnly.kind).toBe("accepted");

    // A read error after metadata alone reports that nothing was observed.
    const reset = await preflightComboStreamResponse(
      prefixThenReadError(new TextEncoder().encode(`data: ${JSON.stringify(rateLimits)}\n\n`),
        new Error("preflight-read-reset")).response,
      { model: "m1", provider: "a" },
      undefined,
      { replayReadErrors: true },
    );
    expect(reset.kind).toBe("read-error");
    if (reset.kind === "read-error") expect(reset.stage).toBe("headers-only");
  });

  test("a response.created carrying output is not a prelude", () => {
    expect(comboStreamPayloadCommitsOutput({
      type: "response.created", response: { id: "r1", output: [] },
    })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({
      type: "response.created",
      response: { id: "r1", output: [{ type: "message", role: "assistant" }] },
    })).toBe(true);
  });

  for (const type of ["response.created", "response.in_progress", "response.queued", "response.heartbeat"]) {
    for (const extra of [
      { output_text: "already produced" },
      { content: [{ type: "output_text", text: "already produced" }] },
      { tool_calls: [{ type: "function", name: "act" }] },
      { future_signal: { effect: "unknown" } },
      { text: "already produced" },
      { text: { output_text: "already produced" } },
      { reasoning: { summary: [{ type: "summary_text", text: "already produced" }] } },
      { model: { output_text: "already produced" } },
      { prompt: { output_text: "already produced" } },
      { tool_choice: { output_text: "already produced" } },
      { instructions: { output_text: "already produced" } },
      { usage: { output_tokens_details: { output_text: "already produced" } } },
      { usage: { input_tokens: { output_text: "already produced" } } },
      { prompt: { id: { output_text: "already produced" } } },
      { tool_choice: { type: "function", function: { output_text: "already produced" } } },
      { tools: [{ type: "web_search" }] },
      { tools: [{ type: "function", name: "read", output_text: "already produced" }] },
      { tools: [{ type: "namespace", name: "ns", tools: [{ type: "mcp" }] }] },
      { tools: [{ type: "custom", name: "act", format: { type: { output_text: "already produced" } } }] },
      { tool_choice: "already produced" },
      { reasoning: { summary: "already produced" } },
    ]) {
      for (const ending of ["eof", "read-error"] as const) {
        test(`${type} preserves unknown snapshot evidence on ${ending}`, async () => {
          const frame = `data: ${JSON.stringify({ type, response: { output: [], ...extra } })}\n\n`;
          const bytes = new TextEncoder().encode(frame);
          const error = new Error("original reset");
          const original = ending === "eof"
            ? new Response(bytes, { headers: { "content-type": "text/event-stream" } })
            : prefixThenReadError(bytes, error).response;
          let calls = 0;
          const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
            calls++;
            return sse({ type: "response.completed", response: { id: "replacement" } });
          });
          const reader = wrapped.body!.getReader();
          expect((await reader.read()).value).toEqual(bytes);
          if (ending === "eof") expect((await reader.read()).done).toBe(true);
          else await expect(reader.read()).rejects.toBe(error);
          expect(calls).toBe(0);
        });
      }
    }
    test(`${type} with ordinary response metadata remains replayable`, async () => {
      let calls = 0;
      const response = {
        id: "resp_first", object: "response", created_at: 1, completed_at: null, status: type === "response.queued" ? "queued" : "in_progress",
        model: "m1", output: [], error: null, incomplete_details: null,
        usage: { input_tokens: 4, output_tokens: 0, total_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        background: false, instructions: null, max_output_tokens: null, max_tool_calls: null,
        metadata: {}, parallel_tool_calls: true, previous_response_id: null, prompt_cache_key: null,
        reasoning: { effort: null, summary: null }, safety_identifier: null, service_tier: "default",
        store: false, temperature: 1, text: { format: { type: "text" } },
        tool_choice: { type: "function", name: "read" }, tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} }, strict: false }], top_p: 1, truncation: "disabled", user: null,
      };
      const wrapped = deferProtocolSafeResetRecovery(sse({ type, response }),
        { model: "m1", provider: "a" }, async () => {
          calls++;
          return sse({ type: "response.completed", response: { id: "replacement" } });
        });
      expect(await wrapped.text()).toContain('"replacement"');
      expect(calls).toBe(1);
    });
    for (const value of [true, null, "false", 0]) {
      for (const ending of ["eof", "read-error"] as const) {
        test(`${type} preserves replayUnsafe=${JSON.stringify(value)} on ${ending}`, async () => {
          const frame = `data: ${JSON.stringify({ type, replayUnsafe: value })}\n\n`;
          const bytes = new TextEncoder().encode(frame);
          const error = new Error("original reset");
          const original = ending === "eof"
            ? new Response(bytes, { headers: { "content-type": "text/event-stream" } })
            : prefixThenReadError(bytes, error).response;
          let calls = 0;
          const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
            calls++;
            return sse({ type: "response.completed", response: { id: "replacement" } });
          });
          const reader = wrapped.body!.getReader();
          expect((await reader.read()).value).toEqual(bytes);
          if (ending === "eof") expect((await reader.read()).done).toBe(true);
          else await expect(reader.read()).rejects.toBe(error);
          expect(calls).toBe(0);
        });
      }
    }
    test(`${type} with replayUnsafe=false remains replayable`, async () => {
      let calls = 0;
      const wrapped = deferProtocolSafeResetRecovery(sse({ type, replayUnsafe: false, sequence_number: 1 }),
        { model: "m1", provider: "a" }, async () => {
          calls++;
          return sse({ type: "response.completed", response: { id: "replacement" } });
        });
      expect(await wrapped.text()).toContain('"replacement"');
      expect(calls).toBe(1);
    });
    for (const field of ["error", "response.error", "response.last_error", "last_error"] as const) {
      for (const ending of ["eof", "read-error"] as const) {
        test(`${type} preserves ${field} evidence on ${ending}`, async () => {
          const payload = field === "error" || field === "last_error"
            ? { type, [field]: { message: "original error" }, response: { output: [] } }
            : { type, response: { output: [], [field === "response.error" ? "error" : "last_error"]: { message: "original error" } } };
          const frame = `data: ${JSON.stringify(payload)}\n\n`;
          const bytes = new TextEncoder().encode(frame);
          const error = new Error("original reset");
          const original = ending === "eof"
            ? new Response(bytes, { headers: { "content-type": "text/event-stream" } })
            : prefixThenReadError(bytes, error).response;
          let replacements = 0;
          const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
            replacements++;
            return sse({ type: "response.completed", response: { id: "replacement" } });
          });
          const reader = wrapped.body!.getReader();
          expect((await reader.read()).value).toEqual(bytes);
          if (ending === "read-error") await expect(reader.read()).rejects.toBe(error);
          else expect((await reader.read()).done).toBe(true);
          expect(replacements).toBe(0);
        });
      }
    }
    for (const status of ["completed", "failed", "incomplete", "cancelled", "future_terminal", 400]) {
      for (const ending of ["eof", "read-error"] as const) {
        test(`${type} preserves snapshot status ${status} on ${ending}`, async () => {
          const frame = `data: ${JSON.stringify({ type, response: { output: [], status } })}\n\n`;
          const bytes = new TextEncoder().encode(frame);
          const error = new Error("original reset");
          const original = ending === "eof"
            ? new Response(bytes, { headers: { "content-type": "text/event-stream" } })
            : prefixThenReadError(bytes, error).response;
          let calls = 0;
          const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
            calls++;
            return sse({ type: "response.completed", response: { id: "replacement" } });
          });
          const reader = wrapped.body!.getReader();
          expect((await reader.read()).value).toEqual(bytes);
          if (ending === "eof") expect((await reader.read()).done).toBe(true);
          else await expect(reader.read()).rejects.toBe(error);
          expect(calls).toBe(0);
        });
      }
    }
    for (const payload of [
      { type, status: 400 },
      { type, last_error: { message: "original" } },
      { type, output: [{ type: "message" }] },
      { type, item: { type: "function_call" } },
      { type, delta: "original output" },
      { type, response: { output: [], incomplete_details: { reason: "upstream_stall_timeout" } } },
      { type, response: ["malformed snapshot"] },
      { type, stream_id: "another-stream" },
      { type, sequence_number: "invalid" },
      { type, response: { output: [], replayUnsafe: true } },
      { type, future_signal: { effect: "unknown" } },
    ]) {
      test(`${type} preserves contradictory or malformed evidence at EOF (%j)`, async () => {
        const original = sse(payload);
        const expected = await original.clone().text();
        let calls = 0;
        const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
          calls++;
          return sse({ type: "response.completed", response: { id: "replacement" } });
        });
        expect(await wrapped.text()).toBe(expected);
        expect(calls).toBe(0);
      });
    }
    for (const [description, snapshot] of [
      ["output", { output: [{ type: "message", role: "assistant" }] }],
      ["malformed output", { output: { type: "message" } }],
      ["error", { output: [], error: { code: "server_error", message: "original failure" } }],
    ] as const) {
      test(`${type} snapshot with ${description} preserves the original at EOF`, async () => {
        const original = sse({ type, response: snapshot });
        const expected = await original.clone().text();
        let calls = 0;
        const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
          calls++;
          return sse({ type: "response.completed", response: { id: "replacement" } });
        });
        expect(await wrapped.text()).toBe(expected);
        expect(calls).toBe(0);
      });
    }
    test(`${type} with an empty snapshot still permits EOF recovery`, async () => {
      let calls = 0;
      const original = sse({ type, error: null, last_error: null, response: { output: [], error: null, last_error: null, status: "in_progress" } });
      const wrapped = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => {
        calls++;
        return sse({ type: "response.completed", response: { id: "replacement" } });
      });
      expect(await wrapped.text()).toContain('"replacement"');
      expect(calls).toBe(1);
    });
    test(`${type} with null errors still permits read-error recovery`, async () => {
      const frame = new TextEncoder().encode(`data: ${JSON.stringify({ type, error: null, response: { output: [], error: null, last_error: null } })}\n\n`);
      let calls = 0;
      const wrapped = deferProtocolSafeResetRecovery(prefixThenReadError(frame, new Error("reset")).response,
        { model: "m1", provider: "a" }, async () => {
          calls++;
          return sse({ type: "response.completed", response: { id: "replacement" } });
        });
      expect(await wrapped.text()).toContain('"replacement"');
      expect(calls).toBe(1);
    });
  }
  test("converts a zero-output incomplete with max_output_tokens into a retryable failure", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          usage: { input_tokens: 25, output_tokens: 0, total_tokens: 25 },
        },
      },
    );

    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body).toMatchObject({
      error: {
        code: "zero_output_token_limit",
        message: "Provider reached its output token limit before producing output",
      },
      response: {
        usage: { input_tokens: 25, output_tokens: 0 },
      },
    });
  });

  test("does not retry max_output_tokens when output was already produced", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "partial answer" },
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    );

    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("does not replay an empty max_output_tokens incomplete with end_turn false", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          end_turn: false,
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          usage: { input_tokens: 25, output_tokens: 0, total_tokens: 25 },
        },
      },
    );

    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("does not replay an empty max_output_tokens incomplete marked non-retryable", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens", retryable: false },
          output: [],
          usage: { input_tokens: 25, output_tokens: 0, total_tokens: 25 },
        },
      },
    );

    const expected = await source.clone().text();
    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(expected);
  });

  test("delivers a translated pause_turn incomplete without replaying it", async () => {
    // The Anthropic adapter reports `pause_turn` on its `done` event; the bridge normalizes the
    // client-visible reason to `max_output_tokens`, so only the request context can still tell a
    // paused long-running turn from a real output limit.
    const context: RequestLogContext = { model: "m1", provider: "a" };
    const budget = createTestTranslatorBudget();
    try {
      async function* events(): AsyncGenerator<AdapterEvent> {
        yield { type: "done", stopReason: "pause_turn", usage: { inputTokens: 25, outputTokens: 4, totalTokens: 29 } };
      }
      const source = new Response(bridgeToResponsesSSE(
        events(), "claude-test", undefined, undefined, undefined, undefined, 2_000,
        { translatorBudget: budget, proxyErrorContext: context },
      ), { headers: { "content-type": "text/event-stream" } });

      const result = await preflightComboStreamResponse(source, context);
      expect(result.kind).toBe("accepted");
      const body = await result.response.text();
      expect(body).toContain("event: response.incomplete");
      expect(body).toContain('"reason":"max_output_tokens"');
      expect(body).toContain('"input_tokens":25');
      expect(body).toContain('"output_tokens":4');
    } finally { budget.dispose(); }
  });

  test("converts a zero-output incomplete with max_output_tokens after empty delta into a retryable failure", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "" },
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          usage: { input_tokens: 25, output_tokens: 0, total_tokens: 25 },
        },
      },
    );

    const result = await preflightComboStreamResponse(source, { model: "m1", provider: "a" });
    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body).toMatchObject({
      error: {
        code: "zero_output_token_limit",
        message: "Provider reached its output token limit before producing output",
      },
      response: {
        usage: { input_tokens: 25, output_tokens: 0 },
      },
    });
  });

});



describe("combo preflight replay under a stalled reader (#8601)", () => {
  const encoder = new TextEncoder();
  const replay = (buffered: Uint8Array[], paced: boolean) => {
    const source = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
    // A paced link turn's body is marked (src/lib/paced-stream.ts): the replay then queues nothing ahead of its client.
    const response = new Response(paced ? markPacedStream(source) : source, { headers: { "content-type": "text/event-stream" } });
    return replayBufferedResponse(response, response.body!.getReader(), buffered).body!.getReader();
  };
  // One event-loop turn after each read lets the replay run any pull it scheduled for its own queue.
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));

  test("on a paced turn each replayed chunk leaves the buffer as the client reads it, and no sooner", async () => {
    const chunks = ["a", "bb", "ccc"].map(text => encoder.encode(text));
    const buffered = [...chunks];
    const reader = replay(buffered, true);
    for (let read = 0; read < chunks.length; read++) {
      expect((await reader.read()).value).toBe(chunks[read]!);
      await turn();
      expect(buffered.map(chunk => chunk.byteLength)).toEqual(chunks.map((chunk, index) => index <= read ? 0 : chunk.byteLength));
    }
    await reader.cancel();
  });

  test("on any turn every chunk the client read has left the buffer", async () => {
    const chunks = ["a", "bb", "ccc"].map(text => encoder.encode(text));
    const buffered = [...chunks];
    const reader = replay(buffered, false);
    for (let read = 0; read < chunks.length; read++) {
      expect((await reader.read()).value).toBe(chunks[read]!);
      await turn();
      // An unpaced replay keeps its default queue of one, so a slot past this read may already be taken.
      expect(buffered.slice(0, read + 1).map(chunk => chunk.byteLength)).toEqual(Array(read + 1).fill(0));
    }
    await reader.cancel();
  });

  test("a cancel empties every slot the client never read", async () => {
    const buffered = ["a", "bb", "ccc"].map(text => encoder.encode(text));
    const reader = replay(buffered, true);
    await reader.read();
    await reader.cancel();
    expect(buffered.map(chunk => chunk.byteLength)).toEqual([0, 0, 0]);
  });
});
