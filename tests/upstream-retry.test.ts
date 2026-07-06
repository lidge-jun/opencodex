import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchWithResetRetry, isConnectionResetError } from "../src/lib/upstream-retry";

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
