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

function mockFetch(responses: Array<Response | Error>): { calls: RequestInit[]; urls: string[] } {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    urls.push(url instanceof Request ? url.url : String(url));
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, urls };
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

  test("does not replay a per-attempt TimeoutError", async () => {
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

    await expect(fetchKiroWithRetry(request, { timeoutMs: 1 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(1);
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

  test("does not replay throttling responses", async () => {
    const mock = mockFetch([
      new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Kiro rate limit exceeded");
    expect(mock.calls).toHaveLength(1);
  });

  test("does not replay ordinary 5xx responses", async () => {
    const mock = mockFetch([
      new Response("temporarily unavailable", { status: 503, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(503);
    expect(mock.calls).toHaveLength(1);
  });

  test("falls back once from canonical runtime to the legacy endpoint for 404", async () => {
    const mock = mockFetch([new Response("missing", { status: 404 }), new Response("ok", { status: 200 })]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
    expect(mock.urls).toEqual([
      "https://runtime.us-east-1.kiro.dev/",
      "https://q.us-east-1.amazonaws.com/",
    ]);
  });

  test("falls back for endpoint-specific 403 and connection-refused errors", async () => {
    const signature = mockFetch([
      new Response("InvalidSignatureException", { status: 403 }),
      new Response("ok", { status: 200 }),
    ]);
    expect((await fetchKiroWithRetry(request, { timeoutMs: 5_000 })).status).toBe(200);
    expect(signature.urls.at(-1)).toBe("https://q.us-east-1.amazonaws.com/");

    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const connected = mockFetch([refused, new Response("ok", { status: 200 })]);
    expect((await fetchKiroWithRetry(request, { timeoutMs: 5_000 })).status).toBe(200);
    expect(connected.urls).toEqual([
      "https://runtime.us-east-1.kiro.dev/",
      "https://q.us-east-1.amazonaws.com/",
    ]);
  });

  test("a custom base URL disables legacy fallback", async () => {
    const custom = { ...request, url: "https://kiro.internal.example/generate" };
    const mock = mockFetch([new Response("missing", { status: 404 }), new Response("unexpected", { status: 200 })]);
    const res = await fetchKiroWithRetry(custom, { timeoutMs: 5_000 });
    expect(res.status).toBe(404);
    expect(mock.urls).toEqual([custom.url]);

    const customPath = { ...request, url: "https://runtime.us-east-1.kiro.dev/custom/generate" };
    const pathMock = mockFetch([new Response("missing", { status: 404 }), new Response("unexpected", { status: 200 })]);
    const pathResponse = await fetchKiroWithRetry(customPath, { timeoutMs: 5_000 });
    expect(pathResponse.status).toBe(404);
    expect(pathMock.urls).toEqual([customPath.url]);
  });

  test("does not retry non-retryable 400", async () => {
    const mock = mockFetch([new Response("bad request", { status: 400 })]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Kiro invalid request");
    expect(mock.calls).toHaveLength(1);
  });

  test("raw mode preserves final error body and headers without normalization", async () => {
    const raw = JSON.stringify({ __type: "ValidationException", message: "provider-private-detail" });
    const mock = mockFetch([new Response(raw, { status: 400, headers: { "x-provider-error": "raw" } })]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000, returnRawErrors: true });
    expect(res.headers.get("x-provider-error")).toBe("raw");
    expect(await res.text()).toBe(raw);
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

  test("normalizes final 429 without adapter replay", async () => {
    const mock = mockFetch([
      new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
      new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
      new Response(JSON.stringify({ message: "too many requests" }), { status: 429, headers: { "Retry-After": "0" } }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Kiro rate limit exceeded");
    expect(mock.calls).toHaveLength(1);
  });

  test("does not start fetch when caller signal is already aborted", async () => {
    const mock = mockFetch([new Response("ok", { status: 200 })]);
    const ac = new AbortController();
    ac.abort(new DOMException("client closed", "AbortError"));
    await expect(fetchKiroWithRetry(request, { abortSignal: ac.signal, timeoutMs: 5_000 })).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);
  });
});

describe("kiro adapter error formatter", () => {
  test("is classified, redacted, and does not copy secret headers", async () => {
    const { createKiroAdapter } = await import("../src/adapters/kiro");
    const adapter = createKiroAdapter({ adapter: "kiro", apiKey: "unused" } as never);
    const text = adapter.formatErrorBody!(403, new Headers({
      authorization: "Bearer header-secret",
    }), JSON.stringify({ __type: "AccessDeniedException", message: "expired Bearer payload-secret at /Users/example/key.json" }));
    expect(text).toContain("Kiro authentication failed");
    expect(text).not.toContain("header-secret");
    expect(text).not.toContain("payload-secret");
    expect(text).not.toContain("/Users/example/key.json");
  });
});
