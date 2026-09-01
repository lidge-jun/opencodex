import { describe, expect, test } from "bun:test";
import {
  comboStreamPayloadCommitsOutput,
  preflightComboStreamResponse,
} from "../src/server/responses/combo-stream-preflight";
import type { RequestLogContext } from "../src/server/request-log";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../src/server/sse-frame-buffer";

const sse = (...payloads: unknown[]): Response => new Response(
  payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);

const preflightChunkLimit = Math.max(1, Math.ceil(MAX_CLIENT_SSE_FRAME_BYTES / 1024));

describe("combo stream preflight", () => {
  test("keeps only lifecycle preamble replayable and treats unknown output conservatively", () => {
    expect(comboStreamPayloadCommitsOutput({ type: "response.created" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.heartbeat" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.failed" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({ type: "response.incomplete" })).toBe(false);
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

  test("does not replay semantic incompletes that another provider cannot safely repair", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
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

  test("does not replay transport incompletes after output commits the target", async () => {
    const source = sse(
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "visible" },
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason: "adapter_eof" },
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
});
