import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  fetchWithResetRetry,
  isConnectionResetError,
  prepareSameTarget429Wait,
  releaseResponseBodyBestEffort,
  retryBackoffDelayMs,
  sleepWithHeartbeats,
} from "../src/lib/upstream-retry";

function bunResetError(): Error {
  // Shape of Bun's fetch rejection on a stale pooled socket.
  const err = new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  (err as Error & { code: string }).code = "ECONNRESET";
  return err;
}

function mockDoFetch(results: Array<Response | Error>): { calls: number[]; doFetch: () => Promise<Response> } {
  const state = { calls: [] as number[], i: 0 };
  const doFetch = async (): Promise<Response> => {
    state.calls.push(state.i);
    const next = results[state.i++] ?? results[results.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls: state.calls, doFetch };
}

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

describe("isConnectionResetError", () => {
  test("classifies reset shapes and non-retryable errors", () => {
    expect(isConnectionResetError(bunResetError())).toBe(true);
    const epipe = new Error("write failed");
    (epipe as Error & { code: string }).code = "EPIPE";
    expect(isConnectionResetError(epipe)).toBe(true);
    // Message-only match (no code property).
    expect(isConnectionResetError(new Error("The socket connection was closed unexpectedly."))).toBe(true);
    expect(isConnectionResetError(new Error("read: connection reset by peer"))).toBe(true);

    expect(isConnectionResetError(new DOMException("Timeout elapsed", "TimeoutError"))).toBe(false);
    expect(isConnectionResetError(new DOMException("The operation was aborted", "AbortError"))).toBe(false);
    const refused = new Error("Unable to connect");
    (refused as Error & { code: string }).code = "ECONNREFUSED";
    expect(isConnectionResetError(refused)).toBe(false);
    expect(isConnectionResetError(new Error("something else"))).toBe(false);
    expect(isConnectionResetError("ECONNRESET")).toBe(false);
    expect(isConnectionResetError(undefined)).toBe(false);
  });

  test("a reset-coded error whose name is TimeoutError/AbortError is not retryable", () => {
    const err = new Error("Timeout elapsed");
    err.name = "TimeoutError";
    (err as Error & { code: string }).code = "ECONNRESET";
    expect(isConnectionResetError(err)).toBe(false);
  });
});

describe("sleepWithHeartbeats", () => {
  test("a non-positive heartbeat interval is clamped instead of spinning forever", async () => {
    const events: string[] = [];
    for await (const event of sleepWithHeartbeats(3, undefined, 0)) {
      events.push(event.type);
    }
    // 3ms of wait with a clamped 1ms step -> exactly 3 beats, then termination (no spin).
    expect(events).toHaveLength(3);
  });

  test("a NaN heartbeat interval waits the full duration instead of aborting after one beat", async () => {
    const started = Date.now();
    const events: string[] = [];
    for await (const event of sleepWithHeartbeats(120, undefined, Number.NaN)) {
      events.push(event.type);
    }
    // NaN falls back to the 1ms step: the full 120ms wait happens (120 beats), instead of the
    // buggy NaN-chunk path that exited after one beat.
    expect(events).toHaveLength(120);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  test("zero wait yields nothing", async () => {
    const events: string[] = [];
    for await (const event of sleepWithHeartbeats(0, undefined)) {
      events.push(event.type);
    }
    expect(events).toEqual([]);
  });
});

describe("releaseResponseBodyBestEffort", () => {
  test("a never-settling cancel() does not block past the bounded timeout", async () => {
    const signal = new AbortController().signal;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        // Never settles — the release must still be bounded.
        return new Promise<void>(() => {});
      },
    });
    const started = Date.now();
    await releaseResponseBodyBestEffort(body, signal, 120);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("a never-settling cancel() resolves immediately when the signal aborts", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    const pending = releaseResponseBodyBestEffort(body, controller.signal, 60_000);
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const started = Date.now();
    await pending;
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("an already-aborted signal initiates cancellation without awaiting it", async () => {
    const controller = new AbortController();
    controller.abort();
    let cancelInitiated = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelInitiated = true;
        return new Promise<void>(() => {});
      },
    });
    await releaseResponseBodyBestEffort(body, controller.signal, 60_000);
    expect(cancelInitiated).toBe(true);
  });

  test("null body is a no-op", async () => {
    await expect(releaseResponseBodyBestEffort(null, new AbortController().signal, 10)).resolves.toBeUndefined();
  });
});

describe("fetchWithResetRetry", () => {
  test("retries a Bun-shaped reset and returns the second attempt's response", async () => {
    silenceWarn();
    const mock = mockDoFetch([bunResetError(), new Response("ok", { status: 200 })]);
    const res = await fetchWithResetRetry(mock.doFetch, { label: "test" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mock.calls).toHaveLength(2);
    expect(warnSpies[0]).toHaveBeenCalledTimes(1);
  });

  test("retries on message-only reset (no code property)", async () => {
    silenceWarn();
    const mock = mockDoFetch([
      new Error("The socket connection was closed unexpectedly."),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchWithResetRetry(mock.doFetch);
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("does not retry TimeoutError", async () => {
    const mock = mockDoFetch([new DOMException("Timeout elapsed", "TimeoutError")as unknown as Error]);
    await expect(fetchWithResetRetry(mock.doFetch)).rejects.toThrow("Timeout elapsed");
    expect(mock.calls).toHaveLength(1);
  });

  test("does not retry ECONNREFUSED", async () => {
    const refused = new Error("Unable to connect");
    (refused as Error & { code: string }).code = "ECONNREFUSED";
    const mock = mockDoFetch([refused]);
    await expect(fetchWithResetRetry(mock.doFetch)).rejects.toThrow("Unable to connect");
    expect(mock.calls).toHaveLength(1);
  });

  test("passes HTTP error responses through without retrying", async () => {
    const mock = mockDoFetch([new Response("upstream boom", { status: 502 })]);
    const res = await fetchWithResetRetry(mock.doFetch);
    expect(res.status).toBe(502);
    expect(mock.calls).toHaveLength(1);
  });

  test("gives up after max attempts and rethrows the last reset error", async () => {
    silenceWarn();
    const mock = mockDoFetch([bunResetError(), bunResetError(), bunResetError(), bunResetError()]);
    await expect(fetchWithResetRetry(mock.doFetch)).rejects.toThrow("socket connection was closed unexpectedly");
    expect(mock.calls).toHaveLength(3);
    expect(warnSpies[0]).toHaveBeenCalledTimes(2);
  });

  test("does not start when the signal is already aborted", async () => {
    const mock = mockDoFetch([new Response("ok", { status: 200 })]);
    const ac = new AbortController();
    ac.abort(new DOMException("client closed", "AbortError"));
    await expect(fetchWithResetRetry(mock.doFetch, { abortSignal: ac.signal })).rejects.toThrow("client closed");
    expect(mock.calls).toHaveLength(0);
  });

  test("aborting during the backoff sleep rejects without a further attempt", async () => {
    silenceWarn();
    const ac = new AbortController();
    const mock = mockDoFetch([bunResetError(), new Response("ok", { status: 200 })]);
    const pending = fetchWithResetRetry(mock.doFetch, { abortSignal: ac.signal });
    // First attempt rejects with a reset synchronously-ish; abort lands mid-backoff.
    setTimeout(() => ac.abort(new DOMException("client closed", "AbortError")), 10);
    await expect(pending).rejects.toThrow("client closed");
    expect(mock.calls).toHaveLength(1);
  });

  test("does not retry when the signal aborts during the failing attempt", async () => {
    const ac = new AbortController();
    const doFetch = async (): Promise<Response> => {
      // Simulate a client disconnect racing the reset: signal is aborted by the time we reject.
      ac.abort(new DOMException("client closed", "AbortError"));
      throw bunResetError();
    };
    await expect(fetchWithResetRetry(doFetch, { abortSignal: ac.signal })).rejects.toThrow("socket connection was closed unexpectedly");
  });
});

describe("retryBackoffDelayMs", () => {
  test("honors Retry-After seconds before exponential jitter", () => {
    const headers = new Headers({ "Retry-After": "3" });
    expect(retryBackoffDelayMs(0, {
      baseDelayMs: 250,
      maxDelayMs: 5_000,
      headers,
    })).toBe(3_000);
  });

  test("parses Retry-After HTTP dates and caps them", () => {
    const nowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const headers = new Headers({
        "Retry-After": new Date(1_700_000_004_000).toUTCString(),
      });
      expect(retryBackoffDelayMs(0, {
        baseDelayMs: 250,
        maxDelayMs: 2_000,
        headers,
      })).toBe(2_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("falls back to capped exponential jitter when Retry-After is absent", () => {
    const randomSpy = spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(retryBackoffDelayMs(2, {
        baseDelayMs: 250,
        maxDelayMs: 2_000,
      })).toBe(800);
    } finally {
      randomSpy.mockRestore();
    }
  });
});


describe("prepareSameTarget429Wait", () => {
  test("releases the body then waits without heartbeats when no interval is set", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const events: string[] = [];
    const started = Date.now();
    for await (const event of prepareSameTarget429Wait({
      body,
      delayMs: 40,
    })) {
      events.push(event.type);
    }
    expect(cancelled).toBe(true);
    expect(events).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  test("yields heartbeats when a heartbeat interval is provided", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return;
      },
    });
    const events: string[] = [];
    for await (const event of prepareSameTarget429Wait({
      body,
      delayMs: 30,
      heartbeatIntervalMs: 10,
    })) {
      events.push(event.type);
    }
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every(type => type === "heartbeat")).toBe(true);
  });
});
