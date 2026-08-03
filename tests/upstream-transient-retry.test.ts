import { describe, expect, test } from "bun:test";
import {
  fetchWithResetRetry,
  fetchWithTransientRetry,
  isTransientUpstreamStatus,
  lastUpstreamAttemptResponseStatus,
  type UpstreamAttemptObservation,
} from "../src/lib/upstream-retry";

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
  test("preserves ordered physical evidence when a 503 is followed by rejection", async () => {
    const observations: UpstreamAttemptObservation[] = [];
    const rejection = new Error("opaque transport rejection");
    let calls = 0;
    await expect(fetchWithTransientRetry(async () => {
      calls += 1;
      if (calls === 1) return bodyResponse(503, { "retry-after": "0" });
      throw rejection;
    }, {
      slowAttemptMs: 60_000,
      onAttempt: observation => observations.push(observation),
    })).rejects.toBe(rejection);

    expect(calls).toBe(2);
    expect(observations).toEqual([
      { kind: "response", status: 503 },
      { kind: "rejection", recovery: "transient-5xx" },
    ]);
    expect(lastUpstreamAttemptResponseStatus(observations)).toBe(503);
  });

  test("observer exceptions do not replace a successful response", async () => {
    const response = await fetchWithResetRetry(async () => bodyResponse(200), {
      onAttempt: () => { throw new Error("observer failed"); },
    });
    expect(response.status).toBe(200);
  });

  test("observer exceptions do not replace the original rejection", async () => {
    const rejection = new Error("opaque transport rejection");
    await expect(fetchWithResetRetry(async () => { throw rejection; }, {
      onAttempt: () => { throw new Error("observer failed"); },
    })).rejects.toBe(rejection);
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
