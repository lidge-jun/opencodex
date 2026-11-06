import { formatErrorResponse as formatReplaySafetyError } from "../../src/bridge/errors";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  SendBudgetExhaustedError,
  fetchWithResetRetry,
  fetchWithTransientRetry,
  isConnectionResetError,
  isNonReplayableResponse,
  isReplayRefusalResponse,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
  prepareSameTarget429Wait,
  releaseResponseBodyBestEffort,
  retryBackoffDelayMs,
  sleepWithHeartbeats,
} from "../../src/lib/upstream-retry";

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
    const res = await fetchWithResetRetry(mock.doFetch, { label: "test", replaySafe: true });
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
    const res = await fetchWithResetRetry(mock.doFetch, { replaySafe: true });
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
    await expect(fetchWithResetRetry(mock.doFetch, { replaySafe: true })).rejects.toThrow("socket connection was closed unexpectedly");
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
    const pending = fetchWithResetRetry(mock.doFetch, { abortSignal: ac.signal, replaySafe: true });
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

  test("treats Retry-After as a lower bound when the caller opts in (#4546)", () => {
    const headers = new Headers({ "Retry-After": "30" });
    // The local maximum bounds our OWN exponential backoff. Shortening a provider's stated
    // wait to 5s just sends a request we already know will be refused, which is the storm the
    // header exists to prevent.
    expect(retryBackoffDelayMs(0, {
      baseDelayMs: 250,
      maxDelayMs: 5_000,
      headers,
      retryAfterIsLowerBound: true,
    })).toBe(30_000);
  });

  test("an honoured Retry-After is preserved in full, never shortened (#4546)", () => {
    const headers = new Headers({ "Retry-After": "3600" });
    // The instruction is the provider's statement of when it will serve again. Clamping it
    // to a local ceiling produced a send the upstream already said it would refuse; whether
    // the request can wait that long is the caller's deadline decision, not a shorter delay.
    expect(retryBackoffDelayMs(0, {
      baseDelayMs: 250,
      maxDelayMs: 5_000,
      headers,
      retryAfterIsLowerBound: true,
      retryAfterCeilingMs: 60_000,
    })).toBe(3_600_000);
  });

  test("an instruction past the wait deadline ends with the upstream answer intact (#4546)", async () => {
    silenceWarn();
    const upstream = new Response("overloaded", {
      status: 503,
      headers: { "Retry-After": "3600" },
    });
    const { calls, doFetch } = mockDoFetch([upstream]);
    const res = await fetchWithTransientRetry(doFetch);
    // No early retry: one send, and the caller gets the real 503 with its Retry-After
    // rather than a second refusal the provider already announced.
    expect(calls.length).toBe(1);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("3600");
  });

  test("an upstream no-retry verdict stops transient retries and preserves its response", async () => {
    silenceWarn();
    let cancelled = false;
    const body = JSON.stringify({ error: { details: { retryable: false } } });
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
      cancel() { cancelled = true; },
    }), { status: 503, headers: { "x-should-retry": "false", "content-type": "application/json" } });
    const mock = mockDoFetch([upstream, new Response("duplicate"), new Response("duplicate")]);

    const response = await fetchWithTransientRetry(mock.doFetch);

    expect(response).toBe(upstream);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.json()).toEqual({ error: { details: { retryable: false } } });
    expect(cancelled).toBe(false);
    expect(mock.calls).toHaveLength(1);
  });

  test("a 5xx context-overflow verdict is returned without a resend (#8127)", async () => {
    silenceWarn();
    for (const body of [
      JSON.stringify({ error: { type: "server_error", message: "Your input exceeds the context window of this model" } }),
      "Your input exceeds the context window of this model",
    ]) {
      const upstream = new Response(body, { status: 500 });
      const mock = mockDoFetch([upstream, new Response("duplicate"), new Response("duplicate")]);
      const response = await fetchWithTransientRetry(mock.doFetch);
      expect(response).toBe(upstream);
      expect(await response.text()).toBe(body);
      expect(mock.calls).toHaveLength(1);
    }
  });

  test("the overflow peek stops at the byte limit even for multibyte text", async () => {
    silenceWarn();
    const body = "é".repeat(8_192) + " Your input exceeds the context window of this model";
    const mock = mockDoFetch([new Response(body, { status: 500 }), new Response("ok")]);
    expect((await fetchWithTransientRetry(mock.doFetch)).status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("time spent inspecting a response body does not count as a slow upstream attempt", async () => {
    silenceWarn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode("unavailable")); controller.close(); }, 180); },
    });
    const mock = mockDoFetch([new Response(body, { status: 500 }), new Response("ok")]);
    expect((await fetchWithTransientRetry(mock.doFetch, { slowAttemptMs: 100 })).status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("aborting during an overflow peek returns the original response promptly", async () => {
    silenceWarn();
    const abort = new AbortController();
    const first = new Response(new ReadableStream<Uint8Array>({}), { status: 500 });
    const mock = mockDoFetch([first, new Response("ok")]);
    setTimeout(() => abort.abort(), 20);
    const result = await Promise.race([
      fetchWithTransientRetry(mock.doFetch, { abortSignal: abort.signal }),
      new Promise<"late">(resolve => setTimeout(() => resolve("late"), 150)),
    ]);
    expect(result).toBe(first);
    expect(mock.calls).toHaveLength(1);
  });

  test("empty body chunks cannot starve cancellation during the overflow peek", async () => {
    silenceWarn();
    const abort = new AbortController();
    let pulls = 0;
    const first = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls >= 10_000) controller.close(); else controller.enqueue(new Uint8Array());
      },
    }, { highWaterMark: 0 }), { status: 500 });
    const mock = mockDoFetch([first, new Response("ok")]);
    const clone = first.clone.bind(first);
    first.clone = () => { setTimeout(() => abort.abort(), 30); return clone(); };
    expect(await fetchWithTransientRetry(mock.doFetch, { abortSignal: abort.signal })).toBe(first);
    expect(pulls).toBeLessThan(10_000);
    expect(mock.calls).toHaveLength(1);
  });

  test("a 5xx body that never ends does not stall the overflow check (#8127)", async () => {
    silenceWarn();
    const mock = mockDoFetch([new Response(new ReadableStream(), { status: 503 }), new Response("ok")]);
    const response = await fetchWithTransientRetry(mock.doFetch);
    expect(response.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("a 5xx throttle worded as too many tokens is still retried (#8127)", async () => {
    silenceWarn();
    const mock = mockDoFetch([
      new Response(JSON.stringify({ error: { message: "Too many tokens, please wait before trying again." } }), { status: 500 }),
      new Response("ok"),
    ]);
    const response = await fetchWithTransientRetry(mock.doFetch);
    expect(response.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test.each([
    "Your input does not exceed the context window; the service is unavailable",
    "Your request doesn't exceed the token limit; retry later",
    "Your request exceeds neither the context window nor the token limit; the service is temporarily unavailable",
    "if the input exceeds the context window, shorten it; the server is unavailable",
    "Failed to load the maximum context length configuration",
    "Does the input exceed the context window? The server is unavailable",
    "Invalid tool name: 'prompt is too long'",
    "Input is too long for username",
  ])("a 5xx without an actual overflow verdict remains retryable: %s", async message => {
    silenceWarn();
    const mock = mockDoFetch([Response.json({ error: { message } }, { status: 503 }), new Response("ok")]);
    expect((await fetchWithTransientRetry(mock.doFetch)).status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("a JSON-escaped negation does not stop a transient retry", async () => {
    silenceWarn();
    const body = '{"error":{"message":"Your input does not exceed the context \\u0077indow; retry later"}}';
    const mock = mockDoFetch([new Response(body, { status: 503 }), new Response("ok")]);
    expect((await fetchWithTransientRetry(mock.doFetch)).status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("a definite overflow still stops retries when a later sentence says not to retry", async () => {
    silenceWarn();
    const first = new Response("Your input exceeds the context window. Do not retry.", { status: 503 });
    const mock = mockDoFetch([first, new Response("duplicate")]);
    expect(await fetchWithTransientRetry(mock.doFetch)).toBe(first);
    expect(mock.calls).toHaveLength(1);
  });

  test("a definite overflow stays terminal when its remedy mentions configuration", async () => {
    silenceWarn();
    const first = new Response("Your input exceeds the context window; adjust your configuration.", { status: 503 });
    const mock = mockDoFetch([first, new Response("duplicate")]);
    expect(await fetchWithTransientRetry(mock.doFetch)).toBe(first);
    expect(mock.calls).toHaveLength(1);
  });

  test.each([
    "If input exceeds the context window, shorten it. This input exceeds the context window.",
    "Failed to load context window configuration. Your input exceeds the context window.",
    "Too many tokens: prompt is too long",
  ])("a separate or explicit overflow verdict stops a resend: %s", async message => {
    silenceWarn();
    const first = new Response(message, { status: 503 });
    const mock = mockDoFetch([first, new Response("duplicate")]);
    expect(await fetchWithTransientRetry(mock.doFetch)).toBe(first);
    expect(mock.calls).toHaveLength(1);
  });

  test("an instruction inside the wait deadline is still honoured before retrying (#4546)", async () => {
    silenceWarn();
    const limited = new Response("overloaded", {
      status: 503,
      headers: { "Retry-After": "1" },
    });
    const ok = new Response("fine", { status: 200 });
    const { calls, doFetch } = mockDoFetch([limited, ok]);
    const started = Date.now();
    const res = await fetchWithTransientRetry(doFetch);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test("a caller deadline shorter than the default is not slept past (#4546)", async () => {
    silenceWarn();
    const limited = new Response("overloaded", {
      status: 503,
      headers: { "Retry-After": "1" },
    });
    const ok = new Response("fine", { status: 200 });
    const { calls, doFetch } = mockDoFetch([limited, ok]);
    const started = Date.now();
    // The caller can wait 500ms; the upstream asked for 1s. Reading the module default
    // instead of this deadline parked the request for the full second -- the 30s-budget /
    // 45s-instruction shape, scaled down so the test does not have to sleep it.
    const res = await fetchWithTransientRetry(doFetch, { retryAfterCeilingMs: 500 });
    expect(calls.length).toBe(1);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("an instruction exactly at the caller deadline is honoured, not refused (#4546)", async () => {
    silenceWarn();
    const limited = new Response("overloaded", {
      status: 503,
      headers: { "Retry-After": "1" },
    });
    const ok = new Response("fine", { status: 200 });
    const { calls, doFetch } = mockDoFetch([limited, ok]);
    const started = Date.now();
    // Equality is inside the budget: the deadline is what the caller CAN wait, so a wait of
    // exactly that length is affordable and the retry happens after it.
    const res = await fetchWithTransientRetry(doFetch, { retryAfterCeilingMs: 1_000 });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test("a caller deadline longer than the default waits instead of ending early (#4546)", async () => {
    silenceWarn();
    const limited = new Response("overloaded", {
      status: 503,
      headers: { "Retry-After": "90" },
    });
    const { calls, doFetch } = mockDoFetch([limited, new Response("fine", { status: 200 })]);
    const ac = new AbortController();
    // 90s is past the module default but inside this caller's 120s deadline, so the call must
    // be waiting -- not returning the 503 the default ceiling used to hand back immediately.
    // Aborting mid-wait is how the test observes the wait without sitting through it.
    setTimeout(() => ac.abort(new DOMException("deadline probe", "AbortError")), 20);
    await expect(fetchWithTransientRetry(doFetch, {
      retryAfterCeilingMs: 120_000,
      abortSignal: ac.signal,
    })).rejects.toThrow("deadline probe");
    expect(calls.length).toBe(1);
  });

  test("opting in never shortens a wait below the local backoff (#4546)", () => {
    const headers = new Headers({ "Retry-After": "0" });
    // A past or zero Retry-After means "no enforced wait", not "send immediately with no
    // backoff at all" -- the count and ratio budgets still apply and so does our own pacing.
    expect(retryBackoffDelayMs(0, {
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
      headers,
      retryAfterIsLowerBound: true,
    })).toBeGreaterThanOrEqual(800);
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

describe("ambiguous reset safety", () => {
  test("a reset is terminal by default, even with a remaining send budget", async () => {
    const reports: number[] = [];
    const mock = mockDoFetch([bunResetError(), new Response("duplicate")]);
    const response = await fetchWithResetRetry(mock.doFetch, {
      attempts: 3, onSendsConsumed: count => reports.push(count),
    });
    // 429, not 502: the Codex client is configured retry_5xx / no-retry-429, so a 5xx here
    // would be re-sent four times by the caller this refusal exists to protect.
    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(mock.calls).toHaveLength(1);
    expect(reports).toEqual([1]);
  });

  test("a 503 followed by a reset stops both retry layers and reports both sends once", async () => {
    silenceWarn();
    const reports: number[] = [];
    const mock = mockDoFetch([
      new Response("busy", { status: 503 }), bunResetError(), new Response("duplicate"),
    ]);
    const response = await fetchWithTransientRetry(mock.doFetch, {
      attempts: 3, onSendsConsumed: count => reports.push(count),
    });
    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(mock.calls).toHaveLength(2);
    expect(reports).toEqual([2]);
  });

  test("an exhausted last send still carries the no-replay verdict", async () => {
    const mock = mockDoFetch([bunResetError()]);
    const response = await fetchWithResetRetry(mock.doFetch, { attempts: 1 });
    expect(isNonReplayableResponse(response)).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });

  test("EPIPE and message-only resets are ambiguous too, without leaking the exception", async () => {
    for (const error of [
      Object.assign(new Error("private transport detail"), { code: "EPIPE" }),
      new Error("The socket connection was closed unexpectedly. private transport detail"),
    ]) {
      const mock = mockDoFetch([error]);
      const response = await fetchWithResetRetry(mock.doFetch);
      expect(isNonReplayableResponse(response)).toBe(true);
      expect(await response.text()).not.toContain("private transport detail");
      expect(mock.calls).toHaveLength(1);
    }
  });

  test("zero and invalid budgets never dispatch regardless of replay safety", async () => {
    for (const replaySafe of [false, true]) {
      for (const attempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const mock = mockDoFetch([new Response("must not send")]);
        await expect(fetchWithResetRetry(mock.doFetch, { attempts, replaySafe })).rejects.toThrow();
        expect(mock.calls).toHaveLength(0);
      }
    }
  });

  test("explicitly replay-safe resets still share the total budget with 5xx", async () => {
    silenceWarn();
    const reports: number[] = [];
    const mock = mockDoFetch([
      bunResetError(), new Response("busy", { status: 503 }), new Response("ok"),
    ]);
    const response = await fetchWithTransientRetry(mock.doFetch, {
      attempts: 3, replaySafe: true, onSendsConsumed: count => reports.push(count),
    });
    expect(await response.text()).toBe("ok");
    expect(mock.calls).toHaveLength(3);
    expect(reports).toEqual([3]);
  });
});

describe("operator-granted replacement of an ambiguous reset", () => {
  test("no claim callback keeps the refusal and never sends again", async () => {
    const mock = mockDoFetch([bunResetError(), new Response("duplicate")]);
    const response = await fetchWithResetRetry(mock.doFetch, { attempts: 3 });
    expect(response.status).toBe(429);
    expect(mock.calls).toHaveLength(1);
  });

  test("a granted claim buys exactly one more send and is asked exactly once", async () => {
    silenceWarn();
    const reports: number[] = [];
    let asked = 0;
    const mock = mockDoFetch([bunResetError(), new Response("ok")]);
    const response = await fetchWithResetRetry(mock.doFetch, {
      attempts: 3,
      onSendsConsumed: count => reports.push(count),
      claimAmbiguousResend: () => { asked += 1; return asked === 1; },
    });
    expect(await response.text()).toBe("ok");
    expect(mock.calls).toHaveLength(2);
    expect(asked).toBe(1);
    expect(reports).toEqual([1, 1]);
  });

  test("a spent grant settles as the refusal rather than sending again", async () => {
    silenceWarn();
    const mock = mockDoFetch([bunResetError(), bunResetError(), new Response("duplicate")]);
    const response = await fetchWithResetRetry(mock.doFetch, {
      attempts: 3,
      // The shape a request-wide allowance of one produces on its second question.
      claimAmbiguousResend: (() => { let left = 1; return () => left-- > 0; })(),
    });
    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(mock.calls).toHaveLength(2);
  });

  test("the grant never widens the send budget it was given", async () => {
    const mock = mockDoFetch([bunResetError(), new Response("duplicate")]);
    let asked = 0;
    const response = await fetchWithResetRetry(mock.doFetch, {
      attempts: 1,
      claimAmbiguousResend: () => { asked += 1; return true; },
    });
    expect(response.status).toBe(429);
    expect(mock.calls).toHaveLength(1);
    // Asking would have spent the request's one replacement on a send there was no room for.
    expect(asked).toBe(0);
  });

  test("a replay-safe operation never consults the grant", async () => {
    silenceWarn();
    let asked = 0;
    const mock = mockDoFetch([bunResetError(), new Response("ok")]);
    const response = await fetchWithResetRetry(mock.doFetch, {
      attempts: 3, replaySafe: true, claimAmbiguousResend: () => { asked += 1; return true; },
    });
    expect(await response.text()).toBe("ok");
    expect(asked).toBe(0);
  });

  test("a non-reset failure after a replacement settles as the refusal, not a rejection", async () => {
    silenceWarn();
    // The hazard the refusal exists for: a thrown transport error here becomes a 502 at the
    // caller, and a 502 is what the Codex client retries -- so the turn whose first send may
    // already have run would be sent again, four more times.
    const mock = mockDoFetch([bunResetError(), new Error("upstream fetch failed")]);
    const response = await fetchWithResetRetry(mock.doFetch, {
      attempts: 3, claimAmbiguousResend: () => true,
    });
    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(mock.calls).toHaveLength(2);
  });

  test("a transient response after a replacement settles as the refusal", async () => {
    silenceWarn();
    const mock = mockDoFetch([
      bunResetError(), new Response("busy", { status: 502 }), new Response("duplicate"),
    ]);
    const response = await fetchWithTransientRetry(mock.doFetch, {
      attempts: 3, claimAmbiguousResend: () => true,
    });
    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(mock.calls).toHaveLength(2);
  });

  // 429 and 529 are the cases the gateway-only transient set let through: the client retry table
  // and the proxy's own quota rotation both resend them. 401 and 402 are proxy recovery triggers.
  test.each([307, 308, 401, 402, 408, 409, 413, 429, 500, 501, 503, 507, 529])(
    "a %d answer to a spent replacement settles as the refusal and releases its body",
    async (status) => {
      silenceWarn();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
      const mock = mockDoFetch([
        bunResetError(), new Response(body, { status }), new Response("duplicate"),
      ]);
      const response = await fetchWithTransientRetry(mock.doFetch, {
        attempts: 3, claimAmbiguousResend: () => true,
      });
      expect(response.status).toBe(429);
      expect(isNonReplayableResponse(response)).toBe(true);
      expect(isReplayRefusalResponse(response)).toBe(true);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
      expect(cancelled).toBe(true);
      expect(mock.calls).toHaveLength(2);
    },
  );

  test.each([400, 403, 404, 422])(
    "a %d answer to a spent replacement keeps its status but can no longer trigger recovery",
    async (status) => {
      silenceWarn();
      const mock = mockDoFetch([
        bunResetError(), new Response("request defect", { status }), new Response("duplicate"),
      ]);
      const response = await fetchWithTransientRetry(mock.doFetch, {
        attempts: 3, claimAmbiguousResend: () => true,
      });
      expect(response.status).toBe(status);
      expect(isNonReplayableResponse(response)).toBe(true);
      // Still the upstream's own answer: quota and credential recorders must not treat it as a
      // refusal this proxy synthesized.
      expect(isReplayRefusalResponse(response)).toBe(false);
      expect(await response.text()).toBe("request defect");
      expect(mock.calls).toHaveLength(2);
    },
  );

  test("a successful answer to a spent replacement is returned unchanged", async () => {
    silenceWarn();
    const mock = mockDoFetch([bunResetError(), new Response("answer"), new Response("duplicate")]);
    const response = await fetchWithTransientRetry(mock.doFetch, {
      attempts: 3, claimAmbiguousResend: () => true,
    });
    expect(response.status).toBe(200);
    expect(isNonReplayableResponse(response)).toBe(false);
    expect(await response.text()).toBe("answer");
    expect(mock.calls).toHaveLength(2);
  });

  test("an error answer with no replacement spent stays an ordinary recoverable response", async () => {
    const mock = mockDoFetch([new Response("request defect", { status: 400 })]);
    const response = await fetchWithResetRetry(mock.doFetch, {
      attempts: 3, claimAmbiguousResend: () => true,
    });
    expect(response.status).toBe(400);
    expect(isNonReplayableResponse(response)).toBe(false);
    expect(mock.calls).toHaveLength(1);
  });

  test("the transient layer carries the grant into its inner reset layer", async () => {
    silenceWarn();
    const reports: number[] = [];
    const mock = mockDoFetch([
      new Response("busy", { status: 503 }), bunResetError(), new Response("ok"),
    ]);
    const response = await fetchWithTransientRetry(mock.doFetch, {
      attempts: 3,
      onSendsConsumed: count => reports.push(count),
      claimAmbiguousResend: () => true,
    });
    expect(await response.text()).toBe("ok");
    expect(mock.calls).toHaveLength(3);
    // One report, from the one layer that owns the budget: three sends, counted once each.
    expect(reports).toEqual([3]);
  });
});

describe("ambiguous reset safety through error formatting", () => {
  test("every terminal code survives formatting without advertising Retry-After", async () => {
    for (const code of ["upstream_no_response", "upstream_closed_before_response", "upstream_reset_replay_refused"]) {
      const response = formatReplaySafetyError(502, "upstream_error", "closed", { code, retryAfter: "2" });
      expect(isNonReplayableResponse(response)).toBe(true);
      expect(response.headers.get("retry-after")).toBeNull();
      expect((await response.json()).error.code).toBe(code);
    }
  });

  test("only the proxy-owned refusal restates the status; upstream verdicts keep theirs", async () => {
    // The formatter is reached from combo and adapter paths holding an upstream-shaped 502.
    // The two transport verdicts describe something upstream did and keep it; the refusal is
    // this proxy's own decision and carries its own status wherever it is re-wrapped.
    const refused = formatReplaySafetyError(502, "upstream_error", "closed", {
      code: "upstream_reset_replay_refused",
    });
    expect(refused.status).toBe(429);
    for (const code of ["upstream_no_response", "upstream_closed_before_response"]) {
      expect(formatReplaySafetyError(502, "upstream_error", "closed", { code }).status).toBe(502);
    }
  });

  test("unrecognized upstream codes do not override ordinary error classification", async () => {
    const response = formatReplaySafetyError(502, "upstream_error", "failed", {
      code: "untrusted_provider_code", retryAfter: "2",
    });
    expect(isNonReplayableResponse(response)).toBe(false);
    expect(response.headers.get("retry-after")).toBe("2");
    expect((await response.json()).error.code).not.toBe("untrusted_provider_code");
  });

  test("the cyber-policy hard block retains precedence", async () => {
    const response = formatReplaySafetyError(502, "upstream_error", "blocked due to high-risk cybersecurity activity", {
      code: "upstream_closed_before_response", retryAfter: "2",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("retry-after")).toBeNull();
    expect((await response.json()).error.code).toBe("cyber_policy");
  });
});

const destinationSentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
for (const [input, expected] of [
  ["https://provider.example.test", "https://provider.example.test"],
  [`https://${destinationSentinel}:password@provider.example.test/v1`, "https://provider.example.test"],
  [`https://provider.example.test/${destinationSentinel}`, "https://provider.example.test"],
  [`https://provider.example.test/v1?key=${destinationSentinel}`, "https://provider.example.test"],
  [`https://provider.example.test/v1#${destinationSentinel}`, "https://provider.example.test"],
  [`https://${destinationSentinel}@provider.example.test:8443/${destinationSentinel}?key=${destinationSentinel}#${destinationSentinel}`, "https://provider.example.test:8443"],
  ["http://[2001:db8::1]:8080/v1?key=fixture", "http://[2001:db8::1]:8080"],
  ["https://provider.example.test:443/", "https://provider.example.test"],
  ["wss://provider.example.test:8443/live?key=fixture", "wss://provider.example.test:8443"],
  [destinationSentinel, "the provider"], ["not a URL", "the provider"], ["__proto__", "the provider"],
  ["constructor", "the provider"], ["toString", "the provider"], ["https://provider.example.test:65536/", "the provider"],
  [`file:///${destinationSentinel}`, "the provider"], [`data:text/plain,${destinationSentinel}`, "the provider"],
] as const) test(`send-budget constructor bounds destination case=${expected} input=${input.includes(destinationSentinel) ? "sentinel" : input}`, () => {
  // Constructor validation also covers values supplied without the branded type.
  const error = new SendBudgetExhaustedError(input as never);
  expect(error).toBeInstanceOf(SendBudgetExhaustedError);
  expect(error.code).toBe("request_send_budget_exhausted");
  expect(error.message).toBe(`request send budget exhausted before dispatch (${expected})`);
  expect(error.message).not.toContain(destinationSentinel);
});

test("pacing constructor bounds a value that is not a provider id", async () => {
  const { RequestPacingQueueOverloadError } = await import("../../src/providers/request-pacing");
  const error = new RequestPacingQueueOverloadError(`https://${destinationSentinel}@provider.example.test/${destinationSentinel}?key=${destinationSentinel}`, "queue_full", 1);
  expect(error).toBeInstanceOf(RequestPacingQueueOverloadError);
  expect(error.reason).toBe("queue_full");
  expect(error.message).toBe("request pacing queue for provider 'the provider' is full");
  expect(error.message).not.toContain(destinationSentinel);
});

test("destination factories retain only owned origins or validated provider ids", async () => {
  const { errorDestinationLabel, providerErrorDestinationLabel, errorDestinationText } = await import("../../src/lib/error-destination");
  const label = errorDestinationLabel(`https://${destinationSentinel}@provider.example.test:8443/${destinationSentinel}?key=${destinationSentinel}`);
  expect(errorDestinationText(label)).toBe("https://provider.example.test:8443");
  expect(new SendBudgetExhaustedError(label).code).toBe("request_send_budget_exhausted");
  expect(new SendBudgetExhaustedError(label).message).toBe("request send budget exhausted before dispatch (https://provider.example.test:8443)");
  expect(errorDestinationText(providerErrorDestinationLabel("cursor"))).toBe("cursor");
  expect(new SendBudgetExhaustedError(providerErrorDestinationLabel("cursor")).message).toBe("request send budget exhausted before dispatch (cursor)");
  expect(errorDestinationText(providerErrorDestinationLabel("x".repeat(65)))).toBe("the provider");
  expect(errorDestinationText(providerErrorDestinationLabel({ toString() { throw new Error("unexpected conversion"); } } as never))).toBe("the provider");
  expect(errorDestinationText(providerErrorDestinationLabel(`https://${destinationSentinel}@provider.example.test`))).toBe("the provider");
  for (const copy of [{ ...label }, JSON.parse(JSON.stringify(label)), { kind: "provider", value: destinationSentinel }, Object.create({ value: destinationSentinel })]) {
    expect(errorDestinationText(copy as never)).toBe("the provider");
    const failure = new SendBudgetExhaustedError(copy as never);
    expect(failure).toBeInstanceOf(SendBudgetExhaustedError);
    expect(failure.code).toBe("request_send_budget_exhausted");
    expect(failure.message).toBe("request send budget exhausted before dispatch (the provider)");
    expect(failure.message).not.toContain(destinationSentinel);
  }
  expect(new SendBudgetExhaustedError().message).toBe("request send budget exhausted before dispatch");
});

for (const kind of ["unsupported", "login"] as const) test(`OAuth provider constructor bounds an invalid provider id kind=${kind}`, async () => {
  const { UnsupportedOAuthProviderError, OAuthLoginRequiredError } = await import("../../src/oauth");
  const id = `https://${destinationSentinel}@provider.example.test/${destinationSentinel}?key=${destinationSentinel}`;
  const error = kind === "unsupported" ? new UnsupportedOAuthProviderError(id) : new OAuthLoginRequiredError(id);
  expect(error).toBeInstanceOf(kind === "unsupported" ? UnsupportedOAuthProviderError : OAuthLoginRequiredError);
  expect(error.name).toBe(kind === "unsupported" ? "UnsupportedOAuthProviderError" : "OAuthLoginRequiredError");
  expect(error.message).toBe(kind === "unsupported" ? "Unsupported OAuth provider in config: the provider" : "Not logged in to the provider. Run: ocx login the provider");
  expect(error.message).not.toContain(destinationSentinel);
});

for (const value of [destinationSentinel, { toString: () => destinationSentinel }, NaN, Infinity, -1]) {
  test(`invalid send-budget diagnostic bounds ${typeof value}`, async () => {
    const { InvalidSendBudgetError } = await import("../../src/lib/upstream-retry");
    const error = new InvalidSendBudgetError(value);
    expect(error).toBeInstanceOf(InvalidSendBudgetError);
    expect(error.name).toBe("InvalidSendBudgetError");
    expect(error.message).toBe("invalid upstream send budget: invalid");
    expect(error.message).not.toContain(destinationSentinel);
  });
}
for (const statuses of [[], [503]]) test(`retry evidence owns its diagnostic statuses=${statuses.length}`, async () => {
  const { UpstreamRetryEvidenceError } = await import("../../src/lib/upstream-retry");
  const cause = new Error(destinationSentinel);
  const error = new UpstreamRetryEvidenceError(statuses, cause);
  expect(error).toBeInstanceOf(UpstreamRetryEvidenceError);
  expect(error.cause).toBe(cause);
  expect(error.transientStatuses).toEqual(statuses);
  expect(error.message).toBe(statuses.length ? "upstream fetch failed after transient 5xx response(s)" : "upstream fetch failed");
  expect(error.message).not.toContain(destinationSentinel);
});

for (const [value, expected] of [["provider/model-v1", "provider/model-v1"], ["combo/fast", "combo/fast"],
  [`https://${destinationSentinel}@provider.example/${destinationSentinel}?key=${destinationSentinel}`, "the requested model"],
  ["a".repeat(129), "the requested model"], ["model\nmetadata", "the requested model"], ["", "the requested model"],
  [{ toString: () => destinationSentinel }, "the requested model"]] as const) {
  test(`client model label projects ${typeof value}, length=${typeof value === "string" ? value.length : 0}`, async () => {
    const { clientFacingModelLabel, clientFacingModelText } = await import("../../src/lib/error-destination");
    const label = clientFacingModelLabel(value);
    expect(typeof label).toBe("object"); expect(Object.isFrozen(label)).toBe(true);
    expect(clientFacingModelText(label)).toBe(expected);
    expect(clientFacingModelText({} as never)).toBe("the requested model");
  });
}
