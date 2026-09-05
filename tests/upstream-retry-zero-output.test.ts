import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  refetchOnZeroOutputReset,
  wrapWithZeroOutputRefetch,
} from "../src/lib/upstream-retry";

function resetError(): Error {
  // Shape of Bun's fetch rejection on a stale pooled socket.
  const err = new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  (err as Error & { code: string }).code = "ECONNRESET";
  return err;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

function failingStream(err: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(err);
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function responseWith(body: ReadableStream<Uint8Array>): Response {
  return new Response(body);
}

function noBodyResponse(): Response {
  return new Response(null);
}

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

describe("refetchOnZeroOutputReset", () => {
  test("refetches once on a reset-shaped error with a live signal", async () => {
    silenceWarn();
    const calls: string[] = [];
    const doFetch = async (recovery?: string): Promise<Response> => {
      calls.push(recovery ?? "none");
      return responseWith(streamOf([new TextEncoder().encode("replacement")]));
    };
    const result = await refetchOnZeroOutputReset(doFetch, resetError(), {});
    expect(result).not.toBeNull();
    expect(calls).toEqual(["connection-reset"]);
  });

  test("returns null for non-reset errors", async () => {
    let calls = 0;
    const result = await refetchOnZeroOutputReset(async () => { calls += 1; return responseWith(streamOf([])); }, new Error("something else"), {});
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  test("returns null when the caller signal is aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const result = await refetchOnZeroOutputReset(
      async () => { calls += 1; return responseWith(streamOf([])); },
      resetError(),
      { abortSignal: controller.signal },
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  test("returns null when the refetch throws", async () => {
    silenceWarn();
    const result = await refetchOnZeroOutputReset(
      async () => { throw new Error("refetch failed"); },
      resetError(),
      {},
    );
    expect(result).toBeNull();
  });

  test("returns null when the replacement has no body", async () => {
    silenceWarn();
    const result = await refetchOnZeroOutputReset(
      async () => noBodyResponse(),
      resetError(),
      {},
    );
    expect(result).toBeNull();
  });

  test("returns null when the replacement is non-ok even with a body (503 regression)", async () => {
    silenceWarn();
    // CodeRabbit review: a body-bearing 503 replacement must be treated as a
    // failed refetch, not relayed as stream data under the original 200 status.
    const result = await refetchOnZeroOutputReset(
      async () => new Response(new TextEncoder().encode("service unavailable"), { status: 503 }),
      resetError(),
      {},
    );
    expect(result).toBeNull();
  });

  test("redacts the refetch error message before logging", async () => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((msg: string) => { warns.push(String(msg)); });
    warnSpies.push(spy);
    await refetchOnZeroOutputReset(
      async () => { throw new Error("fetch failed: https://api.example.com/v1?api_key=sk-secret123"); },
      resetError(),
      {},
    );
    expect(warns.some(w => w.includes("sk-secret123"))).toBe(false);
    expect(warns.some(w => w.includes("refetch failed"))).toBe(true);
  });
});

describe("wrapWithZeroOutputRefetch", () => {
  test("swaps in the refetched stream on a zero-byte reset", async () => {
    silenceWarn();
    const original = failingStream(resetError());
    const refetchCalls: string[] = [];
    const doFetch = async (recovery?: string): Promise<Response> => {
      refetchCalls.push(recovery ?? "none");
      return responseWith(streamOf([new TextEncoder().encode("ok")]));
    };
    const wrapped = wrapWithZeroOutputRefetch(original, doFetch, {});
    const chunks = await collect(wrapped);
    expect(new TextDecoder().decode(chunks[0])).toBe("ok");
    expect(refetchCalls).toEqual(["connection-reset"]);
  });

  test("does not refetch after bytes were already consumed", async () => {
    silenceWarn();
    const good = new TextEncoder().encode("partial");
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(good);
          return;
        }
        controller.error(resetError());
      },
    });
    let refetchCalls = 0;
    const doFetch = async (): Promise<Response> => {
      refetchCalls += 1;
      return responseWith(streamOf([new TextEncoder().encode("never")]));
    };
    const wrapped = wrapWithZeroOutputRefetch(stream, doFetch, {});
    const reader = wrapped.getReader();
    const first = await reader.read();
    // Partial output was delivered, then the original error propagated: the
    // wrapper must NOT mask a partial-output failure with a replay.
    expect(new TextDecoder().decode(first.value)).toBe("partial");
    await expect(reader.read()).rejects.toThrow(/socket connection was closed/i);
    expect(refetchCalls).toBe(0);
  });

  test("propagates the original error on a non-reset failure", async () => {
    let refetchCalls = 0;
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(new Error("boom")),
      async () => { refetchCalls += 1; return responseWith(streamOf([])); },
      {},
    );
    const reader = wrapped.getReader();
    await expect(reader.read()).rejects.toThrow("boom");
    expect(refetchCalls).toBe(0);
  });

  test("propagates the original error when the refetch itself fails", async () => {
    silenceWarn();
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => { throw new Error("refetch failed"); },
      {},
    );
    const reader = wrapped.getReader();
    await expect(reader.read()).rejects.toThrow(/socket connection was closed/i);
  });

  test("propagates the original error when the refetch returns a bodyless response", async () => {
    silenceWarn();
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => noBodyResponse(),
      {},
    );
    const reader = wrapped.getReader();
    await expect(reader.read()).rejects.toThrow(/socket connection was closed/i);
  });

  test("propagates the original error when the refetch returns a body-bearing 503 (not relayed as SSE)", async () => {
    silenceWarn();
    // CodeRabbit review: without a replacement.ok gate, a 503 body would be
    // relayed as stream data under the original 200 status, surfacing as a
    // malformed "successful" SSE stream. The wrapper must reject it and keep
    // the original reset failure.
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => new Response(new TextEncoder().encode("service unavailable"), { status: 503 }),
      {},
    );
    const reader = wrapped.getReader();
    await expect(reader.read()).rejects.toThrow(/socket connection was closed/i);
  });

  test("propagates the original error when the refetch returns a body-bearing 401", async () => {
    silenceWarn();
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => new Response(new TextEncoder().encode("unauthorized"), { status: 401 }),
      {},
    );
    const reader = wrapped.getReader();
    await expect(reader.read()).rejects.toThrow(/socket connection was closed/i);
  });

  test("retries at most once: a second zero-byte reset on the replacement propagates", async () => {
    silenceWarn();
    const replacement = failingStream(resetError());
    let calls = 0;
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => { calls += 1; return responseWith(replacement); },
      {},
    );
    const reader = wrapped.getReader();
    await expect(reader.read()).rejects.toThrow(/socket connection was closed/i);
    expect(calls).toBe(1);
  });

  test("forwards cancellation to the active reader", async () => {
    const cancelled: string[] = [];
    const original = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
      },
      cancel(reason) {
        cancelled.push(String(reason));
      },
    });
    const wrapped = wrapWithZeroOutputRefetch(original, async () => responseWith(streamOf([])), {});
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel("stop");
    expect(cancelled.length).toBe(1);
  });
});
