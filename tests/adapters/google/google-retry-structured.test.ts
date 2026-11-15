import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as retry from "../../../src/lib/upstream-retry";
import type { AdapterRequest } from "../../../src/adapters/base";
import { fetchAntigravityWithRetry } from "../../../src/adapters/google-http";

const request: AdapterRequest = { url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";
const rateLimited = (retryDelay: string, reason = "RATE_LIMIT_EXCEEDED", message = "Resource has been exhausted (e.g. check quota).") => new Response(JSON.stringify({ error: {
  code: 429, status: "RESOURCE_EXHAUSTED", message,
  details: [{ "@type": ERROR_INFO, reason }, { "@type": RETRY_INFO, retryDelay }],
} }), { status: 429 });

let waits: ReturnType<typeof spyOn> | undefined;
afterEach(() => { waits?.mockRestore(); waits = undefined; });

describe("Google 429 retry delays from the body", () => {
  test("a body-only RetryInfo.retryDelay is the floor for the next send", async () => {
    const slept: number[] = [];
    waits = spyOn(retry, "sleepWithAbort").mockImplementation(async (ms: number) => { slept.push(ms); });
    const responses = [rateLimited("3s"), new Response("ok", { status: 200 })];
    const res = await fetchAntigravityWithRetry(request, { executor: (async () => responses.shift()!) as typeof fetch });
    expect(res.status).toBe(200);
    expect(slept.length).toBe(1);
    expect(slept[0]!).toBeGreaterThanOrEqual(3_000);
  });

  test("an explicit Retry-After header wins over the body's delay", async () => {
    const slept: number[] = [];
    waits = spyOn(retry, "sleepWithAbort").mockImplementation(async (ms: number) => { slept.push(ms); });
    const body = await rateLimited("30s").text();
    const responses = [new Response(body, { status: 429, headers: { "Retry-After": "1" } }), new Response("ok", { status: 200 })];
    const res = await fetchAntigravityWithRetry(request, { executor: (async () => responses.shift()!) as typeof fetch });
    expect(res.status).toBe(200);
    expect(slept[0]!).toBeLessThan(30_000);
    expect(slept[0]!).toBeGreaterThanOrEqual(1_000);
  });

  test("a stated wait beyond the retry ceiling ends with the 429 and carries it as Retry-After", async () => {
    waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    let sends = 0;
    const res = await fetchAntigravityWithRetry(request, { executor: (async () => { sends++; return rateLimited("1h2m3s"); }) as typeof fetch });
    expect(res.status).toBe(429);
    expect(sends).toBe(1);
    expect(res.headers.get("retry-after")).toBe("3723");
  });

  test("RATE_LIMIT_EXCEEDED with quota-like prose is retried on Antigravity", async () => {
    waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const responses = [rateLimited("1s", "RATE_LIMIT_EXCEEDED", "Quota exceeded for quota metric 'requests'"), new Response("ok", { status: 200 })];
    const res = await fetchAntigravityWithRetry(request, { executor: (async () => responses.shift()!) as typeof fetch });
    expect(res.status).toBe(200);
  });

  test("QUOTA_EXHAUSTED is not retried even with transient prose", async () => {
    waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    let sends = 0;
    const res = await fetchAntigravityWithRetry(request, { executor: (async () => { sends++; return rateLimited("30s", "QUOTA_EXHAUSTED", "Too many requests"); }) as typeof fetch });
    expect(res.status).toBe(429);
    expect(sends).toBe(1);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.text()).toContain("Antigravity quota exhausted");
  });
});
