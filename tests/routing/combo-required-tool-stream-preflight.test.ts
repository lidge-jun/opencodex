import { describe, expect, jest, test } from "bun:test";
import { preflightComboStreamResponse } from "../../src/server/responses/combo-stream-preflight";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../../src/server/sse-frame-buffer";
import { createComboRequiredToolStreamGuard } from "../../src/server/responses/combo-required-tool-stream";

const frame = (payload: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
const requiredFailure = { type: "response.failed", response: { status: "failed", output: [], error: {
  type: "upstream_error", code: "required_tool_contract_unsatisfied", message: "missing required tool", retryable: true,
} } };
const preflight = (chunks: Uint8Array[]) => preflightComboStreamResponse(new Response(new ReadableStream({
  pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); },
}), { headers: { "content-type": "text/event-stream" } }), { model: "fixture", provider: "fixture" }, undefined, { requiredToolPrelude: true });

const reasoning = frame({ type: "response.reasoning_text.delta", delta: "held" });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("mandatory-tool reasoning hold deadline", () => {
  for (const trickle of [false, true]) test(`fixed deadline releases ${trickle ? "trickling" : "silent"} reasoning and preserves the pending read`, async () => {
    jest.useFakeTimers();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; controller.enqueue(reasoning); } }),
      { headers: { "content-type": "text/event-stream" } });
    const pending = preflightComboStreamResponse(response, { model: "fixture", provider: "fixture" }, undefined,
      { requiredToolPrelude: true, signal: abort.signal });
    let result: Awaited<typeof pending> | undefined;
    void pending.then(value => { result = value; }, () => {});
    try {
      await flush();
      let copies = 1;
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(250);
        if (trickle) { source.enqueue(reasoning); copies++; }
        await flush();
        expect(result).toBeUndefined();
      }
      jest.advanceTimersByTime(249);
      await flush();
      expect(result).toBeUndefined();
      jest.advanceTimersByTime(1);
      await flush();
      // One second from the first held reasoning frame, never reset by trickling frames.
      expect(result?.kind).toBe("accepted");
      const reader = result!.response.body!.getReader();
      for (let i = 0; i < copies; i++) expect((await reader.read()).value).toEqual(reasoning);
      const late = frame(requiredFailure);
      source.enqueue(late);
      source.close();
      expect((await reader.read()).value).toEqual(late);
      expect((await reader.read()).done).toBe(true);
    } finally {
      abort.abort(new Error("fixture cleanup"));
      await pending.catch(() => {});
      jest.useRealTimers();
    }
  });
  test("cancelling held reasoning clears the deadline without a replacement verdict", async () => {
    jest.useFakeTimers();
    const abort = new AbortController();
    let cancelled = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(reasoning); }, cancel() { cancelled++; },
    }), { headers: { "content-type": "text/event-stream" } });
    const pending = preflightComboStreamResponse(response, { model: "fixture", provider: "fixture" }, undefined,
      { requiredToolPrelude: true, signal: abort.signal });
    try {
      await flush();
      jest.advanceTimersByTime(500);
      abort.abort(new Error("fixture cancelled during hold"));
      await expect(pending).rejects.toThrow("fixture cancelled during hold");
      expect(cancelled).toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});

describe("mandatory native tool preflight commitment", () => {
  test("the reserved functions selector keeps a bare call identity", () => {
    const guard = createComboRequiredToolStreamGuard({ tools: [{ type: "function", name: "marker" }],
      tool_choice: { type: "function", namespace: "functions", name: "marker" } }, new Set());
    const [block] = guard!.blockRewrite(`data: ${JSON.stringify({ type: "response.completed", response: {
      status: "completed", output: [{ type: "function_call", name: "marker", call_id: "inert" }],
    } })}`);
    expect(block).toContain("response.completed");
  });
  for (const callId of ["xs_call-hosted", "client_call"]) test(`custom call ownership follows the call id: ${callId}`, async () => {
    const guard = createComboRequiredToolStreamGuard({ tools: [{ type: "custom", name: "fixture" }], tool_choice: "required" },
      new Set([{ itemType: "custom_tool_call", callIdPrefix: "xs_call-" }]));
    const output = [{ type: "custom_tool_call", name: "fixture", call_id: callId, input: "inert" }];
    const [block] = guard!.blockRewrite(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output } })}`);
    expect(block).toContain(callId === "client_call" ? "response.completed" : "response.failed");
    const result = await preflight([new TextEncoder().encode(`${block}\n\n`)]);
    expect(result.kind).toBe("accepted");
    await result.response.body?.cancel();
  });
  for (const type of ["response.in_progress", "response.queued", "response.heartbeat", "response.created"]) {
    test(`${type} snapshots with output commit even if the later terminal omits it`, async () => {
      const result = await preflight([frame({ type, response: { output: [{ type: "web_search_call", id: "effect" }] } }), frame(requiredFailure)]);
      expect(result.kind).toBe("accepted");
      await result.response.body?.cancel();
    });
  }
  for (const type of ["response.failed", "response.incomplete"]) for (const item of [
    { type: "web_search_call" }, { type: "custom_tool_call", call_id: "xs_call-1" },
    { type: "function_call", call_id: "client_call" }, { type: "message" },
  ]) test(`${type} with ${item.type} is committed`, async () => {
    const result = await preflight([frame({ type, response: { status: type.slice(9), output: [item], incomplete_details: { reason: "adapter_eof" } } })]);
    expect(result.kind).toBe("accepted");
    await result.response.body?.cancel();
  });
  test("a forged retryable verdict cannot hide a hosted terminal effect", async () => {
    const result = await preflight([frame({ ...requiredFailure, response: { ...requiredFailure.response, output: [{ type: "web_search_call" }] } })]);
    expect(result.kind).toBe("accepted");
    await result.response.body?.cancel();
  });
  test("opaque output commits before a required-tool failure", async () => {
    const result = await preflight([new TextEncoder().encode("data: opaque\n\n"), frame(requiredFailure)]);
    expect(result.kind).toBe("accepted");
    await result.response.body?.cancel();
  });
  test("retained chunk cap commits and preserves the later failure without replay", async () => {
    const count = Math.max(1, Math.ceil(MAX_CLIENT_SSE_FRAME_BYTES / 1024));
    const chunks = Array.from({ length: count }, () => new TextEncoder().encode(": held\n\n"));
    chunks[0] = reasoning;
    chunks.push(frame(requiredFailure));
    const result = await preflight(chunks);
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toContain("required_tool_contract_unsatisfied");
  });
  test("aggregate byte cap commits even a reasoning-only prelude", async () => {
    const result = await preflight([reasoning, frame({ type: "response.reasoning_text.delta", delta: "x".repeat(MAX_CLIENT_SSE_FRAME_BYTES) }), frame(requiredFailure)]);
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toContain("required_tool_contract_unsatisfied");
  });
  test("cancelling a pending read settles without a replacement verdict", async () => {
    let cancelled = 0;
    const abort = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
    const pending = preflightComboStreamResponse(response, { model: "fixture", provider: "fixture" }, undefined,
      { requiredToolPrelude: true, signal: abort.signal });
    abort.abort(new Error("fixture cancelled"));
    await expect(pending).rejects.toThrow("fixture cancelled");
    expect(cancelled).toBe(1);
  });
});
