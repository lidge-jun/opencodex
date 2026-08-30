import { describe, expect, test } from "bun:test";
import { fetchWithTransientRetry, isTransientUpstreamStatus } from "../src/lib/upstream-retry";

function bodyResponse(status: number, headers?: Record<string, string>): Response {
  // ReadableStream body so cancel() is observable.
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() { cancelled = true; },
  });
  const res = new Response(status === 204 ? null : stream, { status, headers });
  return Object.assign(res, { __wasCancelled: () => cancelled });
}

describe("isTransientUpstreamStatus", () => {
  test("classifies gateway/Cloudflare transients, excludes 4xx and 507", () => {
    for (const s of [500, 502, 503, 504, 520, 521, 522]) expect(isTransientUpstreamStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 429, 499, 507, 529]) expect(isTransientUpstreamStatus(s)).toBe(false);
  });
});

describe("fetchWithTransientRetry", () => {
  test("attempts is one total-send budget, not a per-layer multiplier", async () => {
    // The two layers used to multiply: attempts:3 meant 3 transient rounds each independently
    // retrying 3 connection resets, so a single call could emit 9 upstream sends. This mixes
    // resets and 503s precisely so a per-layer count would exceed the budget and be caught.
    let sends = 0;
    const script: Array<"reset" | number> = ["reset", 503, "reset", 503, 503, 503, 503, 503, 503];
    const res = await fetchWithTransientRetry(async () => {
      const step = script[sends++];
      if (step === "reset") {
        const err = new Error("socket hang up") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return bodyResponse(step ?? 503);
    }, { attempts: 3, slowAttemptMs: 60_000 });

    // Exactly the budget: 3 real upstream requests, never 9.
    expect(sends).toBe(3);
    expect(res.status).toBe(503);
    // Exhaustion returns the last response with its body intact.
    expect((res as Response & { __wasCancelled: () => boolean }).__wasCancelled()).toBe(false);
  });

  test("a clean sequence still spends only what it needs", async () => {
    let sends = 0;
    const responses = [bodyResponse(503), bodyResponse(503), bodyResponse(200)];
    const res = await fetchWithTransientRetry(async () => {
      return responses[sends++]!;
    }, { attempts: 3, slowAttemptMs: 60_000 });
    expect(sends).toBe(3);
    expect(res.status).toBe(200);
  });

  test("retries a 502 then returns the 200; failed body is cancelled", async () => {
    const first = bodyResponse(502) as Response & { __wasCancelled: () => boolean };
    const responses = [first, bodyResponse(200)];
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => responses[calls++]!, { slowAttemptMs: 60_000 });
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
    expect(first.__wasCancelled()).toBe(true);
  });

  test("exhausts attempts on persistent 502 and returns the final 502 with body intact", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return bodyResponse(502); }, { slowAttemptMs: 60_000 });
    expect(calls).toBe(3);
    expect(res.status).toBe(502);
    expect(res.body).not.toBeNull();
  });

  test("does not retry non-transient statuses", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return bodyResponse(400); }, { slowAttemptMs: 60_000 });
    expect(calls).toBe(1);
    expect(res.status).toBe(400);
  });

  test("honors Retry-After header for the backoff delay", async () => {
    let calls = 0;
    const started = Date.now();
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      return calls === 1 ? bodyResponse(503, { "retry-after": "1" }) : bodyResponse(200);
    }, { slowAttemptMs: 60_000 });
    expect(res.status).toBe(200);
    // Retry-After: 1s should dominate the 400ms base backoff.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 10_000);

  test("returns the 5xx as-is when the caller aborted", async () => {
    const ac = new AbortController();
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      ac.abort();
      return bodyResponse(502);
    }, { abortSignal: ac.signal, slowAttemptMs: 60_000 });
    expect(calls).toBe(1);
    expect(res.status).toBe(502);
  });

  test("does not retry a slow failed attempt (slow-502 incident shape)", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      await new Promise(r => setTimeout(r, 30));
      return bodyResponse(502);
    }, { slowAttemptMs: 10 });
    expect(calls).toBe(1);
    expect(res.status).toBe(502);
  });
});
