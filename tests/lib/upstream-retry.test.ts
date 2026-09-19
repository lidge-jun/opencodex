import { formatErrorResponse as formatReplaySafetyError } from "../../src/bridge/errors";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  fetchWithResetRetry,
  fetchWithTransientRetry,
  isConnectionResetError,
  isNonReplayableResponse,
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

describe("operator reset replay (replayResets)", () => {
  test("replays a reset once and returns the second attempt's response", async () => {
    silenceWarn();
    const reports: number[] = [];
    const mock = mockDoFetch([bunResetError(), new Response("ok", { status: 200 })]);
    const res = await fetchWithResetRetry(mock.doFetch, {
      attempts: 3, replayResets: 2, label: "test", onSendsConsumed: count => reports.push(count),
    });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
    expect(reports).toEqual([1, 1]);
    expect(warnSpies[0]).toHaveBeenCalledTimes(1);
    expect(String(warnSpies[0]!.mock.calls[0]?.[0])).toContain("retryOnReset");
  });

  test("a spent ceiling settles as the refusal, never a throw", async () => {
    silenceWarn();
    const mock = mockDoFetch([bunResetError(), bunResetError(), new Response("duplicate")]);
    const response = await fetchWithResetRetry(mock.doFetch, { attempts: 3, replayResets: 2 });
    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    // Two sends: the original and the one replay. The third result was never requested.
    expect(mock.calls).toHaveLength(2);
  });

  test("the ceiling never widens the leg's own budget", async () => {
    const mock = mockDoFetch([bunResetError(), new Response("duplicate")]);
    const response = await fetchWithResetRetry(mock.doFetch, { attempts: 1, replayResets: 3 });
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(mock.calls).toHaveLength(1);
  });

  test("a replay that fails any other way is still the refusal, not a transport rejection", async () => {
    silenceWarn();
    const refused = Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" });
    const mock = mockDoFetch([bunResetError(), refused]);
    // Without the policy the same sequence rethrows as credential-visible evidence, and the
    // caller's transport path would answer with a 502 the client is invited to resend.
    const response = await fetchWithResetRetry(mock.doFetch, { attempts: 3, replayResets: 3 });
    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect(mock.calls).toHaveLength(2);
  });

  test("a zero ceiling is the plain refusal and a replay-safe caller is unaffected", async () => {
    silenceWarn();
    const off = mockDoFetch([bunResetError(), new Response("duplicate")]);
    const refusal = await fetchWithResetRetry(off.doFetch, { attempts: 3, replayResets: 0 });
    expect(refusal.status).toBe(429);
    expect(off.calls).toHaveLength(1);
    const safe = mockDoFetch([bunResetError(), bunResetError(), bunResetError()]);
    await expect(fetchWithResetRetry(safe.doFetch, { replaySafe: true, replayResets: 1 }))
      .rejects.toThrow("socket connection was closed unexpectedly");
    expect(safe.calls).toHaveLength(3);
  });

  test("shares one budget with the transient layer", async () => {
    silenceWarn();
    const reports: number[] = [];
    const mock = mockDoFetch([
      new Response("busy", { status: 503 }), bunResetError(), new Response("ok", { status: 200 }),
    ]);
    const res = await fetchWithTransientRetry(mock.doFetch, {
      attempts: 3, replayResets: 3, onSendsConsumed: count => reports.push(count),
    });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(3);
    expect(reports).toEqual([3]);
    const spent = mockDoFetch([
      new Response("busy", { status: 503 }), new Response("busy", { status: 503 }), bunResetError(), new Response("ok"),
    ]);
    const response = await fetchWithTransientRetry(spent.doFetch, { attempts: 3, replayResets: 3 });
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(spent.calls).toHaveLength(3);
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
