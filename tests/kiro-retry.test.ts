import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterRequest } from "../src/adapters/base";
import {
  fetchKiroWithRetry,
  noteKiroTransientThrottle,
  resetKiroThrottleStateForTests,
} from "../src/adapters/kiro-retry";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetKiroThrottleStateForTests();
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

  test("does not replay hard quota exhaustion", async () => {
    const mock = mockFetch([
      new Response("monthly quota exceeded", { status: 429 }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Kiro quota exhausted");
    expect(mock.calls).toHaveLength(1);
  });

  test("retries a transient USER_REQUEST_RATE_EXCEEDED response inside the adapter", async () => {
    const mock = mockFetch([
      new Response(JSON.stringify({
        __type: "ThrottlingException",
        message: "USER_REQUEST_RATE_EXCEEDED: Too many requests, please wait before trying again.",
      }), { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);

    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("concurrent transient throttles elect one probe before followers resume", async () => {
    let calls = 0;
    let initialCalls = 0;
    let releaseInitial!: () => void;
    let releaseProbe!: () => void;
    const initialBarrier = new Promise<void>(resolve => { releaseInitial = resolve; });
    const probeBarrier = new Promise<void>(resolve => { releaseProbe = resolve; });
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>(resolve => { markProbeStarted = resolve; });

    globalThis.fetch = (async () => {
      calls += 1;
      if (calls <= 2) {
        initialCalls += 1;
        if (initialCalls === 2) releaseInitial();
        await initialBarrier;
        return new Response(JSON.stringify({
          __type: "ThrottlingException",
          message: "USER_REQUEST_RATE_EXCEEDED: please wait",
        }), { status: 429, headers: { "Retry-After": "0" } });
      }
      if (calls === 3) {
        markProbeStarted();
        await probeBarrier;
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const first = fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    const second = fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    await probeStarted;
    await Bun.sleep(10);
    expect(calls).toBe(3);

    releaseProbe();
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(calls).toBe(4);
  });

  test("a waiting probe re-checks a cooldown extended by another 429", async () => {
    let calls = 0;
    let initialCalls = 0;
    let releaseInitial!: () => void;
    const initialBarrier = new Promise<void>(resolve => { releaseInitial = resolve; });
    const startedAt = Date.now();

    globalThis.fetch = (async () => {
      const call = ++calls;
      if (call <= 2) {
        initialCalls += 1;
        if (initialCalls === 2) releaseInitial();
        await initialBarrier;
        const retryAfter = call === 1 ? "0.02" : "0.08";
        return new Response("USER_REQUEST_RATE_EXCEEDED", {
          status: 429,
          headers: { "Retry-After": retryAfter },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const responses = await Promise.all([
      fetchKiroWithRetry(request, { timeoutMs: 5_000 }),
      fetchKiroWithRetry(request, { timeoutMs: 5_000 }),
    ]);

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(calls).toBe(4);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
  });

  test("a follower can abort while a post-cooldown probe is in flight", async () => {
    noteKiroTransientThrottle(20);
    let calls = 0;
    let releaseProbe!: () => void;
    const probeBarrier = new Promise<void>(resolve => { releaseProbe = resolve; });
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>(resolve => { markProbeStarted = resolve; });
    globalThis.fetch = (async () => {
      calls += 1;
      markProbeStarted();
      await probeBarrier;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const leader = fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    await probeStarted;
    const abort = new AbortController();
    const follower = fetchKiroWithRetry(request, { timeoutMs: 5_000, abortSignal: abort.signal });
    abort.abort(new DOMException("client closed", "AbortError"));

    await expect(follower).rejects.toThrow();
    expect(calls).toBe(1);
    releaseProbe();
    expect((await leader).status).toBe(200);
  });

  test("an aborted cooldown owner releases the gate for the next request", async () => {
    noteKiroTransientThrottle(40);
    const ownerAbort = new AbortController();
    const owner = fetchKiroWithRetry(request, { timeoutMs: 5_000, abortSignal: ownerAbort.signal });
    await Bun.sleep(5);
    ownerAbort.abort(new DOMException("owner cancelled", "AbortError"));
    await expect(owner).rejects.toThrow();

    const mock = mockFetch([new Response("ok", { status: 200 })]);
    const next = fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    const response = await Promise.race([
      next,
      Bun.sleep(150).then(() => { throw new Error("Kiro throttle gate stayed locked after owner abort"); }),
    ]);
    expect(response.status).toBe(200);
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

  test("a profileArn-required 400 classifies as kiro_profile_required with actionable copy (#993)", async () => {
    const mock = mockFetch([
      new Response(JSON.stringify({
        __type: "ValidationException",
        message: "profileArn is required for this account",
      }), { status: 400 }),
    ]);
    const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain("kiro_profile_required");
    expect(text).toContain("ocx account login kiro --reauth");
    // Non-retryable: exactly one upstream call.
    expect(mock.calls).toHaveLength(1);
  });

  test("normalizes final transient 429 after bounded adapter retries", async () => {
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
