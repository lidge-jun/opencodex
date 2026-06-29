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
        message: "expired token accessToken=aoa-secret path /Users/jun/private.json",
      }), { status: 403 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).toContain("Kiro authentication failed: AccessDeniedException");
    expect(text).not.toContain("aoa-secret");
    expect(text).not.toContain("/Users/jun");
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
