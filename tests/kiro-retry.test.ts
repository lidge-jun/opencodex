import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterRequest } from "../src/adapters/base";
import { fetchKiroWithRetry } from "../src/adapters/kiro-retry";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const request: AdapterRequest = {
  url: "https://runtime.us-east-1.kiro.dev/",
  method: "POST",
  headers: { authorization: "Bearer tok", accept: "application/vnd.amazon.eventstream" },
  body: "{}",
};

function mockFetch(responses: Array<Response | Error>): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls };
}

describe("kiro retry fetch", () => {
  test("retries connection resets and broken pipes", async () => {
    for (const code of ["ECONNRESET", "EPIPE"]) {
      const error = Object.assign(new Error(`network failure: ${code}`), { code });
      const mock = mockFetch([error, new Response("ok", { status: 200 })]);

      const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });

      expect(res.status).toBe(200);
      expect(mock.calls).toHaveLength(2);
    }
  });

  test("retries the per-attempt TimeoutError raised by AbortSignal.timeout", async () => {
    let calls = 0;
    const timeoutReasons: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) return new Response("ok", { status: 200 });
      const signal = init?.signal;
      if (!signal) throw new Error("expected per-attempt signal");

      // Reproduce the Windows runner race: the 1ms signal may abort before a
      // fetch implementation subscribes. EventTarget does not replay abort.
      await Bun.sleep(10);
      if (signal.aborted) {
        timeoutReasons.push(signal.reason);
        throw signal.reason;
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          timeoutReasons.push(signal.reason);
          reject(signal.reason);
        }, { once: true });
      });
    }) as typeof fetch;

    const res = await fetchKiroWithRetry(request, { timeoutMs: 1 });

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(timeoutReasons).toHaveLength(1);
    expect((timeoutReasons[0] as Error).name).toBe("TimeoutError");
  });

  test("rethrows deterministic fetch and URL errors without retrying", async () => {
    for (const error of [
      new TypeError("fetch input rejected"),
      new TypeError("Invalid URL"),
      new Error("TLS configuration rejected"),
    ]) {
      const mock = mockFetch([error, new Response("unexpected retry", { status: 200 })]);

      await expect(fetchKiroWithRetry(request, { timeoutMs: 5_000 })).rejects.toThrow(error.message);
      expect(mock.calls).toHaveLength(1);
    }
  });

  test("retries 429 then returns the successful response", async () => {
    const mock = mockFetch([
      new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mock.calls).toHaveLength(2);
  });

  test("retries 503 with Retry-After then returns success", async () => {
    const mock = mockFetch([
      new Response("temporarily unavailable", { status: 503, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("does not retry non-retryable 400", async () => {
    const mock = mockFetch([new Response("bad request", { status: 400 })]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Kiro invalid request");
    expect(mock.calls).toHaveLength(1);
  });

  test("normalizes final 403 response body into a redacted Kiro auth error", async () => {
    const mock = mockFetch([
      new Response(JSON.stringify({
        __type: "AccessDeniedException",
        message: "expired token accessToken=aoa-secret path /Users/example/private.json",
      }), { status: 403 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).toContain("Kiro authentication failed: AccessDeniedException");
    expect(text).not.toContain("aoa-secret");
    expect(text).not.toContain("/Users/example");
    expect(mock.calls).toHaveLength(1);
  });

  test("normalizes final 400 validation/model body into an invalid request error", async () => {
    const mock = mockFetch([
      new Response(JSON.stringify({
        __type: "ValidationException",
        message: "model not found in region us-east-1",
      }), { status: 400 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Kiro invalid request: ValidationException");
    expect(mock.calls).toHaveLength(1);
  });

  test("normalizes final retryable 429 after attempts while preserving retry count", async () => {
    const mock = mockFetch([
      new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
      new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
      new Response(JSON.stringify({ message: "too many requests" }), { status: 429, headers: { "Retry-After": "0" } }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Kiro rate limit exceeded");
    expect(mock.calls).toHaveLength(3);
  });

  test("does not start fetch when caller signal is already aborted", async () => {
    const mock = mockFetch([new Response("ok", { status: 200 })]);
    const ac = new AbortController();
    ac.abort(new DOMException("client closed", "AbortError"));
    await expect(fetchKiroWithRetry(request, { abortSignal: ac.signal, timeoutMs: 5_000 })).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);
  });
});
