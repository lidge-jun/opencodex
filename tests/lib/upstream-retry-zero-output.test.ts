import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { wrapWithZeroOutputRefetch } from "../../src/lib/upstream-retry";

function resetError(): Error {
  // Shape of Bun's fetch rejection on a stale pooled socket.
  const err = new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  (err as Error & { code: string }).code = "ECONNRESET";
  return err;
}

const encoder = new TextEncoder();

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

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const allow = {
  authorize: () => true,
  acceptResponse: (r: Response) => r.headers.get("content-type") === "text/event-stream",
};

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

describe("wrapWithZeroOutputRefetch", () => {
  test("swaps in the replacement stream on a zero-byte reset", async () => {
    silenceWarn();
    let calls = 0;
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => { calls += 1; return sseResponse(streamOf([encoder.encode("ok")])); },
      { ...allow, attempts: 1 },
    );
    const chunks = await collect(wrapped);
    expect(new TextDecoder().decode(chunks[0])).toBe("ok");
    expect(calls).toBe(1);
  });

  test("refuses the replacement when the operator granted no allowance", async () => {
    silenceWarn();
    let calls = 0;
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => { calls += 1; return sseResponse(streamOf([encoder.encode("never")])); },
      { ...allow, authorize: () => false, attempts: 1 },
    );
    await expect(collect(wrapped)).rejects.toThrow(/socket connection was closed/i);
    expect(calls).toBe(0);
  });

  test("refuses the replacement when the send budget is spent", async () => {
    silenceWarn();
    let calls = 0;
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => { calls += 1; return sseResponse(streamOf([encoder.encode("never")])); },
      { ...allow, attempts: 0 },
    );
    await expect(collect(wrapped)).rejects.toThrow(/socket connection was closed/i);
    expect(calls).toBe(0);
  });

  test("rejects a replacement that is not the event stream the client was promised", async () => {
    silenceWarn();
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => new Response(streamOf([encoder.encode("{}")]), { headers: { "Content-Type": "application/json" } }),
      { ...allow, attempts: 1 },
    );
    await expect(collect(wrapped)).rejects.toThrow(/socket connection was closed/i);
  });

  test("rejects a non-OK replacement", async () => {
    silenceWarn();
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => new Response("nope", { status: 502, headers: { "Content-Type": "text/event-stream" } }),
      { ...allow, attempts: 1 },
    );
    await expect(collect(wrapped)).rejects.toThrow(/socket connection was closed/i);
  });

  test("does not refetch after bytes were already consumed", async () => {
    silenceWarn();
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(encoder.encode("partial"));
          return;
        }
        controller.error(resetError());
      },
    });
    let calls = 0;
    const wrapped = wrapWithZeroOutputRefetch(
      stream,
      async () => { calls += 1; return sseResponse(streamOf([encoder.encode("never")])); },
      { ...allow, attempts: 1 },
    );
    const reader = wrapped.getReader();
    const first = await reader.read();
    // Partial output reached the caller, so the original failure must stand: masking it with a
    // replay would deliver a second turn's bytes after the first turn's.
    expect(new TextDecoder().decode(first.value)).toBe("partial");
    await expect(reader.read()).rejects.toThrow(/socket connection was closed/i);
    expect(calls).toBe(0);
  });

  test("propagates a non-reset failure without asking for a replacement", async () => {
    let calls = 0;
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(new Error("boom")),
      async () => { calls += 1; return sseResponse(streamOf([])); },
      { ...allow, attempts: 1 },
    );
    await expect(collect(wrapped)).rejects.toThrow("boom");
    expect(calls).toBe(0);
  });

  test("propagates the original reset when the replacement send itself fails", async () => {
    silenceWarn();
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => { throw new Error("refetch failed"); },
      { ...allow, attempts: 1 },
    );
    await expect(collect(wrapped)).rejects.toThrow(/socket connection was closed/i);
  });

  test("retries at most once: a second zero-byte reset on the replacement propagates", async () => {
    silenceWarn();
    let calls = 0;
    const wrapped = wrapWithZeroOutputRefetch(
      failingStream(resetError()),
      async () => { calls += 1; return sseResponse(failingStream(resetError())); },
      { ...allow, attempts: 2 },
    );
    await expect(collect(wrapped)).rejects.toThrow(/socket connection was closed/i);
    expect(calls).toBe(1);
  });

  test("forwards cancellation to the active reader", async () => {
    const cancelled: string[] = [];
    const original = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("x"));
      },
      cancel(reason) {
        cancelled.push(String(reason));
      },
    });
    const wrapped = wrapWithZeroOutputRefetch(original, async () => sseResponse(streamOf([])), allow);
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel("stop");
    expect(cancelled.length).toBe(1);
  });
});
