import { expect, spyOn, test } from "bun:test";
import type { AdapterRequest } from "../../../src/adapters/base";
import { fetchDirectGeminiWithRetry, fetchVertexWithRetry } from "../../../src/adapters/google-http";
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

test.each([
  "garbage", "-1", "+0", "0x0", "1e3", "5.0", "", "2026-11-06",
  "Fri, 06 Nov 2026 08:49:37 UTC", "Fri, 31 Feb 2026 08:49:37 GMT",
  "fri, 06 nov 2026 08:49:37 gmt", "Thu, 06 Nov 2026 08:49:37 GMT", "Fri, 06 Nov 2026 08:49:60 GMT",
])("Google 429 discards invalid Retry-After %j as sole evidence", async header => {
  let sends = 0;
  const response = await fetchDirectGeminiWithRetry(request, {
    executor: (async () => ++sends === 1
      ? new Response(neutralBody(), { status: 429, headers: { "retry-after": header } })
      : new Response("unexpected replay")) as typeof fetch,
  });
  expect({ sends, status: response.status, retryAfter: response.headers.get("retry-after") })
    .toEqual({ sends: 1, status: 429, retryAfter: null });
  expect(await response.text()).toBe(neutralBody());
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

test.each([false, true])("Google 429 does not replay an oversized body despite Retry-After (raw=%s)", async returnRawErrors => {
  const payload = "x".repeat(64 * 1024 + 1);
  const upstream = new Response(payload, { status: 429, headers: { "Retry-After": "30" } });
  let sends = 0;
  const waits: number[] = [];
  const sleep = spyOn(retry, "sleepWithAbort").mockImplementation(async ms => { waits.push(ms); });
  try {
    const response = await fetchVertexWithRetry(request, {
      returnRawErrors,
      executor: (async () => ++sends === 1 ? upstream : new Response("unexpected second send")) as typeof fetch,
    });
    expect({ status: response.status, sends, waits }).toEqual({ status: 429, sends: 1, waits: [] });
    if (returnRawErrors) {
      expect(response).toBe(upstream);
      expect(retry.hasClientReplayVeto(response)).toBe(true);
      expect(response.headers.get("retry-after")).toBe("30");
      expect(response.headers.get("x-should-retry")).toBeNull();
      expect(await response.text()).toBe(payload);
    } else {
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.text()).toStartWith("Vertex AI");
    }
  } finally {
    sleep.mockRestore();
  }
});

test.each([undefined, "garbage", "-1", "+0", "0x0", "1e3", "5.0", ""])(
  "Google 429 takes the same typed body delay with Retry-After %j",
  async header => {
    const body = neutralBody([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }]);
    const sleep = spyOn(retry, "sleepWithAbort").mockResolvedValue(undefined);
    try {
      for (const fetchWithRetry of [fetchDirectGeminiWithRetry, fetchVertexWithRetry]) {
        let sends = 0;
        const response = await fetchWithRetry(request, {
          executor: (async () => {
            sends++;
            return sends === 1
              ? new Response(body, { status: 429, headers: header === undefined ? undefined : { "retry-after": header } })
              : new Response("unexpected replay");
          }) as typeof fetch,
        });
        expect({ sends, status: response.status, retryAfter: response.headers.get("retry-after") })
          .toEqual({ sends: 1, status: 429, retryAfter: "90" });
        const responseBody = await response.text();
        if (fetchWithRetry === fetchDirectGeminiWithRetry) expect(responseBody).toBe(body);
      }
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      sleep.mockRestore();
    }
  },
);

test("Google 429 honors a compound body delay even with an invalid header", async () => {
  const body = neutralBody([{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quotaResetDelay: "1m30s" } }]);
  expect(await send429(body, "garbage")).toEqual({ status: 429, sends: 1, waits: [] });
});

test("the last Google 429 replaces an invalid header with its typed wait", async () => {
  const body = neutralBody([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }]);
  let sends = 0;
  const sleep = spyOn(retry, "sleepWithAbort").mockResolvedValue(undefined);
  try {
    const response = await fetchVertexWithRetry(request, {
      executor: (async () => ++sends < retry.TRANSIENT_RETRY_MAX_ATTEMPTS
        ? new Response("unavailable", { status: 503 })
        : new Response(body, { status: 429, headers: { "retry-after": "0x0" } })) as typeof fetch,
    });
    expect(sends).toBe(retry.TRANSIENT_RETRY_MAX_ATTEMPTS);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90");
  } finally {
    sleep.mockRestore();
  }
});

test.each(["0", "Sun, 06 Nov 1994 08:49:37 GMT"])("Google 429 prefers zero delay from header %j to a long body delay", async header => {
  const body = neutralBody([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }]);
  const result = await send429(body, header);
  expect(result).toMatchObject({ status: 200, sends: 2 });
  expect(result.waits).toHaveLength(1);
  expect(result.waits[0]).toBeLessThan(1_000);
});

test("Google 429 schedules the typed body delay when the header is fractional", async () => {
  const body = neutralBody([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "10s" }]);
  expect(await send429(body, "5.0")).toEqual({ status: 200, sends: 2, waits: [10_000] });
});

test.each([" 5", "00005"])("Google 429 accepts normalized or zero-padded delta-seconds %j", async header => {
  const body = neutralBody([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }]);
  expect(await send429(body, header)).toEqual({ status: 200, sends: 2, waits: [5_000] });
});

test.each([
  ["Fri, 06 Nov 2026 08:49:37 GMT", Date.UTC(2026, 10, 6, 8, 49, 7), 30_000],
  ["Friday, 06-Nov-26 08:49:37 GMT", Date.UTC(2026, 10, 6, 8, 49, 7), 30_000],
  ["Fri Nov  6 08:49:37 2026", Date.UTC(2026, 10, 6, 8, 49, 7), 30_000],
  ["Sat, 31 Dec 2016 23:59:60 GMT", Date.UTC(2016, 11, 31, 23, 59, 59), 1_000],
  ["Friday, 01-Jan-00 00:00:10 GMT", Date.UTC(2099, 11, 31, 23, 59, 50), 20_000],
] as const)("Google 429 prefers the HTTP-date %j to a long body delay", async (header, now, delay) => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const body = neutralBody([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }]);
  try {
    const expected = { status: 200, sends: 2, waits: [delay] };
    expect(await send429(neutralBody(), header)).toEqual(expected);
    expect(await send429(body, header)).toEqual(expected);
  } finally {
    clock.mockRestore();
  }
});

test("Google 429 still accepts rate-limit wording from a root JSON envelope", async () => {
  expect(await send429(JSON.stringify({ message: "Too many requests" })))
    .toMatchObject({ status: 200, sends: 2 });
});
