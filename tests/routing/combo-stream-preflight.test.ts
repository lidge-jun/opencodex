import { describe, expect, spyOn, test } from "bun:test";
import {
  comboStreamPayloadCommitsOutput,
  preflightComboStreamResponse,
} from "../../src/server/responses/combo-stream-preflight";
import type { RequestLogContext } from "../../src/server/request-log";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../../src/server/sse-frame-buffer";

const sse = (...payloads: unknown[]): Response => new Response(
  payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);

const preflightChunkLimit = Math.max(1, Math.ceil(MAX_CLIENT_SSE_FRAME_BYTES / 1024));

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
  test("keeps only lifecycle preamble replayable and treats unknown output conservatively", () => {
    expect(comboStreamPayloadCommitsOutput({ type: "response.created" })).toBe(false);
    expect(comboStreamPayloadCommitsOutput({
      type: "response.created", response: { output: [{ type: "function_call" }] },
    })).toBe(true);
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

  test("replayReadErrors exposes protocol-safe reset evidence after response.created", async () => {
    const readError = new Error("preflight-read-reset");
    const source = prefixThenReadError(createdPrefix, readError);
    const result = await preflightComboStreamResponse(
      source.response,
      { model: "m1", provider: "a" },
      undefined,
      { replayReadErrors: true },
    );
    expect(result.kind).toBe("read-error-before-output");
    if (result.kind !== "read-error-before-output") throw new Error("expected protocol reset evidence");
    expect(result.error).toBe(readError);
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

  test("replayReadErrors does not expose recovery evidence before response.created", async () => {
    const readError = new Error("preflight-read-reset");
    const source = prefixThenReadError(new TextEncoder().encode(": heartbeat\n\n"), readError);
    const result = await preflightComboStreamResponse(
      source.response,
      { model: "m1", provider: "a" },
      undefined,
      { replayReadErrors: true },
    );
    expect(result.kind).toBe("accepted");
    const reader = result.response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    await expect(reader.read()).rejects.toBe(readError);
  });

  test("replayReadErrors stays committed after a tool item event", async () => {
    const readError = new Error("preflight-read-reset");
    const prefix = new TextEncoder().encode(
      new TextDecoder().decode(createdPrefix)
      + `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "call_1", call_id: "call_1", name: "side_effect" },
      })}\n\n`,
    );
    const source = prefixThenReadError(prefix, readError);
    const result = await preflightComboStreamResponse(
      source.response,
      { model: "m1", provider: "a" },
      undefined,
      { replayReadErrors: true },
    );
    expect(result.kind).toBe("accepted");
    expect(await result.response.body!.getReader().read()).toMatchObject({ done: false });
  });

  for (const opaque of ["data: {not-json}\n\n", "data: [DONE]\n\n"]) {
    test(`replayReadErrors stays committed after opaque payload ${JSON.stringify(opaque.trim())}`, async () => {
      const readError = new Error("preflight-read-reset");
      const source = prefixThenReadError(new TextEncoder().encode(
        new TextDecoder().decode(createdPrefix) + opaque,
      ), readError);
      const result = await preflightComboStreamResponse(
        source.response,
        { model: "m1", provider: "a" },
        undefined,
        { replayReadErrors: true },
      );
      expect(result.kind).toBe("accepted");
    });
  }

});
