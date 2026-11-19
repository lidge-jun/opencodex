import { expect, spyOn, test } from "bun:test";
import type { AdapterRequest } from "../../../src/adapters/base";
import { fetchVertexWithRetry } from "../../../src/adapters/google-http";
import * as retry from "../../../src/lib/upstream-retry";

const request: AdapterRequest = {
  url: "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini:streamGenerateContent",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};

function neutralBody(details: readonly object[] = []): string {
  return JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Try again shortly.", details } });
}

async function send429(body: string, retryAfter?: string) {
  const first = new Response(body, {
    status: 429,
    headers: retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
  });
  let sends = 0;
  const waits: number[] = [];
  const sleep = spyOn(retry, "sleepWithAbort").mockImplementation(async ms => { waits.push(ms); });
  try {
    const response = await fetchVertexWithRetry(request, {
      executor: (async () => ++sends === 1 ? first : new Response("ok")) as typeof fetch,
    });
    return { status: response.status, sends, waits };
  } finally {
    sleep.mockRestore();
  }
}

test("Google 429 rejects a null @type on an otherwise allowlisted reason", async () => {
  const body = neutralBody([{ "@type": null, reason: "RATE_LIMIT_EXCEEDED" }]);
  expect(await send429(body)).toEqual({ status: 429, sends: 1, waits: [] });
});

test("Google 429 still accepts an allowlisted reason when @type is absent", async () => {
  const body = neutralBody([{ reason: "RATE_LIMIT_EXCEEDED" }]);
  expect(await send429(body)).toMatchObject({ status: 200, sends: 2 });
});

test("Google 429 accepts ErrorInfo quotaResetDelay despite a stray RetryInfo field", async () => {
  const body = neutralBody([{
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    retryDelay: "invalid",
    metadata: { quotaResetDelay: "1s" },
  }]);
  expect(await send429(body)).toMatchObject({ status: 200, sends: 2 });
});

test("Google 429 accepts an explicit zero reset delay in an untyped detail with a malformed retryDelay", async () => {
  const body = neutralBody([{ retryDelay: "invalid", metadata: { quotaResetDelay: "0s" } }]);
  expect(await send429(body)).toMatchObject({ status: 200, sends: 2 });
});

test("Google 429 rejects a quota reset delay in RetryInfo", async () => {
  const body = neutralBody([{
    "@type": "google.rpc.RetryInfo",
    retryDelay: "invalid",
    metadata: { quotaResetDelay: "1s" },
  }]);
  expect(await send429(body)).toEqual({ status: 429, sends: 1, waits: [] });
});

test("Google 429 rejects a garbage Retry-After as the sole evidence", async () => {
  expect(await send429(neutralBody(), "garbage")).toEqual({ status: 429, sends: 1, waits: [] });
});

test("Google 429 uses an explicit zero Retry-After as evidence and still applies local backoff", async () => {
  const result = await send429(neutralBody(), "0");
  expect(result).toMatchObject({ status: 200, sends: 2 });
  expect(result.waits).toHaveLength(1);
  expect(result.waits[0]).toBeGreaterThan(0);
});

test("Google 429 honors delta-seconds Retry-After when the body is complete", async () => {
  const result = await send429(neutralBody(), "30");
  expect(result).toEqual({ status: 200, sends: 2, waits: [30_000] });
});

test("Google 429 vetoes retry when the body exceeds the read limit despite Retry-After", async () => {
  const result = await send429("x".repeat(64 * 1024 + 1), "30");
  expect(result).toEqual({ status: 429, sends: 1, waits: [] });
});

test("Google 429 uses an HTTP-date Retry-After for both eligibility and scheduling", async () => {
  const retryAt = new Date(Date.now() + 30_000);
  const result = await send429(neutralBody(), retryAt.toUTCString());
  expect(result).toMatchObject({ status: 200, sends: 2 });
  expect(result.waits).toHaveLength(1);
  expect(result.waits[0]).toBeGreaterThanOrEqual(28_000);
});

test("Google 429 still accepts rate-limit wording from a root JSON envelope", async () => {
  expect(await send429(JSON.stringify({ message: "Too many requests" })))
    .toMatchObject({ status: 200, sends: 2 });
});
