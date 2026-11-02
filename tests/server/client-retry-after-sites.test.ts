import { describe, expect, test } from "bun:test";
import { formatErrorResponse } from "../../src/bridge";
import { fallbackRefusedResponse, type FallbackEvent } from "../../src/routing/fallback-policy";
import { formatPassthroughUpstreamError } from "../../src/server/responses/passthrough-error";
import { bufferCompactResponse } from "../../src/server/responses/compact";
import { safeResponseHeaders } from "../../src/server/safe-response-headers";

// All digits, so a Retry-After parser accepts it as a delay in seconds.
const NUMERIC_KEY = "73915028461739205817";
const now = Date.parse("2026-11-02T00:00:00Z");

const event: FallbackEvent = {
  at: new Date(now).toISOString(), site: "routing-profile", route: "profile", kind: "provider", from: "a", to: "b",
  trigger: "rate_limited", outcome: "refused", scope: "global",
} as FallbackEvent;

describe("client Retry-After is regenerated at every boundary", () => {
  test("WebSocket response metadata", () => {
    expect(safeResponseHeaders(new Headers({ "retry-after": NUMERIC_KEY }))["retry-after"]).toBe("691200");
    expect(safeResponseHeaders(new Headers({ "retry-after": "12" }))["retry-after"]).toBe("12");
    expect(safeResponseHeaders(new Headers({ "retry-after": "must-not-echo" }))["retry-after"]).toBeUndefined();
  });

  test("fallback refusal", () => {
    expect(fallbackRefusedResponse(event, { failureStatus: 429, retryAfter: NUMERIC_KEY }).headers.get("retry-after")).toBe("691200");
    expect(fallbackRefusedResponse(event, { failureStatus: 429, retryAfter: "30" }).headers.get("retry-after")).toBe("30");
    expect(fallbackRefusedResponse(event, { failureStatus: 429, retryAfter: "must-not-echo" }).headers.get("retry-after")).toBeNull();
  });

  test("Responses error re-wrap", () => {
    const body = JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } });
    for (const raw of [NUMERIC_KEY, " 691201 ", "Mon, 02 Nov 2026 00:00:30 GMT"]) {
      const response = formatPassthroughUpstreamError(429, body, { headers: new Headers({ "retry-after": raw }), now });
      const value = response.headers.get("retry-after");
      expect(value).toMatch(/^\d+$/);
      expect(value).not.toBe(raw);
      expect(Number(value)).toBeLessThanOrEqual(691200);
    }
    const empty = formatPassthroughUpstreamError(429, "", { headers: new Headers({ "retry-after": NUMERIC_KEY }), now });
    expect(empty.headers.get("retry-after")).toBe("691200");
  });

  test("translated error response", () => {
    expect(formatErrorResponse(429, "rate_limit_error", "slow down", { retryAfter: NUMERIC_KEY }).headers.get("retry-after")).toBe("691200");
    expect(formatErrorResponse(429, "rate_limit_error", "slow down", { retryAfter: "must-not-echo" }).headers.get("retry-after")).toBeNull();
  });

  test("compact response buffering", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429, headers: { "content-type": "application/json", "retry-after": NUMERIC_KEY },
    });
    const response = await bufferCompactResponse(upstream, new AbortController().signal);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("691200");
  });
});
