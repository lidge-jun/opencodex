import { describe, expect, test } from "bun:test";
import { fetchWithTransientRetry, isTransientUpstreamStatus } from "../src/lib/upstream-retry";
import { transientRetryPolicyFor } from "../src/providers/key-failover";
import type { OcxProviderConfig } from "../src/types";

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

describe("transientRetryPolicyFor", () => {
  const base = { adapter: "openai-chat", authMode: "key" } as unknown as OcxProviderConfig;

  test("is off unless the provider opts in", () => {
    expect(transientRetryPolicyFor(base)).toBeNull();
    expect(transientRetryPolicyFor({ ...base, transientRetryOn5xx: { enabled: false } })).toBeNull();
  });

  test("a bare object opts in with defaults", () => {
    expect(transientRetryPolicyFor({ ...base, transientRetryOn5xx: {} })).toEqual({ enabled: true, attempts: 3 });
    expect(transientRetryPolicyFor({ ...base, transientRetryOn5xx: { attempts: 5 } })).toEqual({ enabled: true, attempts: 5 });
  });

  test("only key-auth openai-chat qualifies", () => {
    // The adapter gate is the accepted scope, not an incidental detail: without it any
    // generic key-auth provider would inherit the policy.
    for (const adapter of ["openai-responses", "anthropic", "google"]) {
      expect(transientRetryPolicyFor({ ...base, adapter, transientRetryOn5xx: {} } as unknown as OcxProviderConfig)).toBeNull();
    }
    // Fail closed on credential shape: OAuth/forward/local are never replayed here.
    for (const authMode of ["oauth", "forward", "local"]) {
      expect(transientRetryPolicyFor({ ...base, authMode, transientRetryOn5xx: {} } as unknown as OcxProviderConfig)).toBeNull();
    }
    // An omitted authMode is the documented key-auth default for custom providers.
    expect(transientRetryPolicyFor({ adapter: "openai-chat", transientRetryOn5xx: {} } as unknown as OcxProviderConfig))
      .toEqual({ enabled: true, attempts: 3 });
  });
});

describe("fetchWithTransientRetry", () => {
  test("attempts is one total-send budget, not a per-layer multiplier", async () => {
    // The two layers used to multiply: attempts:3 meant 3 transient rounds each independently
    // retrying 3 connection resets, so a single call could emit up to 9 upstream sends. All
    // 503s here, so a per-layer count would keep going well past the budget.
    let sends = 0;
    const res = await fetchWithTransientRetry(async () => {
      sends += 1;
      return bodyResponse(503);
    }, { attempts: 3, slowAttemptMs: 60_000 });

    // Exactly the budget: 3 real upstream requests, never 9.
    expect(sends).toBe(3);
    expect(res.status).toBe(503);
    // Exhaustion returns the last response with its body intact.
    expect((res as Response & { __wasCancelled: () => boolean }).__wasCancelled()).toBe(false);
  });

  test("onSendsConsumed reports the real count so callers can share one budget", async () => {
    // A Responses request can send several times across legs: the initial send, then a
    // 429/account-recovery refetch. Each leg calls this helper separately, so the only way
    // the total stays bounded is if the helper reports what it spent and the next leg
    // receives the remainder. Without this the legs each get a fresh budget.
    const reported: number[] = [];
    let sends = 0;

    // Leg 1: the initial send burns two of three (503 then 200).
    await fetchWithTransientRetry(async () => {
      sends += 1;
      return bodyResponse(sends === 1 ? 503 : 200);
    }, { attempts: 3, slowAttemptMs: 60_000, onSendsConsumed: n => reported.push(n) });
    expect(reported).toEqual([2]);

    // Leg 2 (the recovery refetch) gets only the remaining budget: 3 - 2 = 1 send.
    const remaining = Math.max(1, 3 - reported[0]!);
    expect(remaining).toBe(1);
    let legTwoSends = 0;
    const res = await fetchWithTransientRetry(async () => {
      legTwoSends += 1;
      return bodyResponse(503);
    }, { attempts: remaining, slowAttemptMs: 60_000, onSendsConsumed: n => reported.push(n) });

    // One send, not a fresh three: the request-scoped total stays at the configured 3.
    expect(legTwoSends).toBe(1);
    expect(reported).toEqual([2, 1]);
    expect(reported.reduce((a, b) => a + b, 0)).toBe(3);
    expect(res.status).toBe(503);
  });

  test("onSendsConsumed still reports when the helper throws", async () => {
    // The evidence-error path is a throw, not a return. If it skipped reporting, a caller
    // sharing the budget would under-count and hand the next leg too much.
    const reported: number[] = [];
    let sends = 0;
    await expect(fetchWithTransientRetry(async () => {
      sends += 1;
      if (sends === 1) return bodyResponse(503);
      const err = new Error("socket hang up") as Error & { code?: string };
      err.code = "ECONNRESET";
      throw err;
    }, { attempts: 3, slowAttemptMs: 60_000, onSendsConsumed: n => reported.push(n) })).rejects.toThrow();
    expect(reported.length).toBe(1);
    expect(reported[0]!).toBeGreaterThan(0);
  });

  test("a connection reset and a transient status share the same budget", async () => {
    // Mixed recovery: the reset layer and the transient layer draw from one pool. With a
    // per-layer count the reset retries would have been free, so this would emit more than 3.
    let sends = 0;
    const res = await fetchWithTransientRetry(async () => {
      sends += 1;
      if (sends === 1) {
        const err = new Error("socket hang up") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return bodyResponse(sends === 3 ? 200 : 503);
    }, { attempts: 3, slowAttemptMs: 60_000 });

    expect(sends).toBe(3);
    expect(res.status).toBe(200);
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
