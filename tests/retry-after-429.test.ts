import { describe, expect, test } from "bun:test";
import { formatErrorResponse } from "../src/bridge";
import {
  DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC,
  resolveClientRetryAfter,
} from "../src/lib/retry-after";
import { formatPassthroughUpstreamError } from "../src/server/responses/passthrough-error";
import { consumeComboFailure } from "../src/server/responses/core";

describe("resolveClientRetryAfter (#507)", () => {
  test("prefers a validated upstream Retry-After header", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Too Many Requests",
      upstreamRetryAfter: "15",
    })).toBe("15");
  });

  test("parses delay hints embedded in the error message", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Throttled. Please try again in 7s.",
    })).toBe("7");
  });

  test("defaults retryable rate-limit 429s when upstream omitted Retry-After", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Too many requests — please slow down",
    })).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
  });

  test("does not invent Retry-After for quota-exhausted 429s", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Kiro quota exhausted: monthly quota exceeded",
    })).toBeUndefined();
  });

  test("does not invent Retry-After for non-429 statuses", () => {
    expect(resolveClientRetryAfter({
      status: 503,
      message: "Service Unavailable",
    })).toBeUndefined();
  });

  test("drops invalid upstream Retry-After and falls through to the 429 default", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "rate limited",
      upstreamRetryAfter: "not-a-delay",
    })).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
  });

  test("preserves an explicit Retry-After: 0 on 429", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Too Many Requests",
      upstreamRetryAfter: "0",
    })).toBe("0");
  });

  test("preserves an explicit Retry-After: 0 on 503 (chat/Claude bridge)", () => {
    expect(resolveClientRetryAfter({
      status: 503,
      message: "Service Unavailable",
      upstreamRetryAfter: "0",
    })).toBe("0");
  });

  test("includeDefault:false omits the synthetic retryable-429 fallback", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Too many requests — please slow down",
      includeDefault: false,
    })).toBeUndefined();
  });

  test("includeDefault:false still keeps header and message-derived delays", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "rate limited",
      upstreamRetryAfter: "12",
      includeDefault: false,
    })).toBe("12");
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Please try again in 9s.",
      includeDefault: false,
    })).toBe("9");
  });
});

describe("formatErrorResponse Retry-After (#507)", () => {
  test("attaches Retry-After when provided", () => {
    const response = formatErrorResponse(429, "rate_limit_error", "Too Many Requests", {
      retryAfter: "2",
    });
    expect(response.headers.get("Retry-After")).toBe("2");
  });
});

describe("formatPassthroughUpstreamError Retry-After (#507)", () => {
  test("empty-body retryable 429 gets a default Retry-After", async () => {
    const response = formatPassthroughUpstreamError(429, "");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
    const json = await response.json() as { error?: { message?: string } };
    expect(json.error?.message).toContain("429");
  });

  test("empty-body quota 429 does not invent Retry-After", () => {
    // Message used for classification comes from the body text.
    const response = formatPassthroughUpstreamError(
      429,
      JSON.stringify({ error: { message: "exceeded your current quota" } }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  test("non-empty retryable 429 without Retry-After gets the default", () => {
    const body = JSON.stringify({ error: { message: "Too many requests" } });
    const response = formatPassthroughUpstreamError(429, body);
    expect(response.headers.get("Retry-After")).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("preserves an explicit upstream Retry-After on non-empty 429", () => {
    const body = JSON.stringify({ error: { message: "Too many requests" } });
    const headers = new Headers({ "retry-after": "30", "content-type": "application/json" });
    const response = formatPassthroughUpstreamError(429, body, { headers });
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  test("replaces a malformed non-empty upstream Retry-After on retryable 429", () => {
    const body = JSON.stringify({ error: { message: "Too many requests" } });
    const headers = new Headers({ "retry-after": "not-a-delay", "content-type": "application/json" });
    const response = formatPassthroughUpstreamError(429, body, { headers });
    expect(response.headers.get("Retry-After")).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
  });

  test("removes malformed Retry-After on quota-exhausted non-empty 429 (no synthetic 2)", async () => {
    const body = JSON.stringify({ error: { message: "exceeded your current quota" } });
    const headers = new Headers({
      "retry-after": "not-a-delay",
      "content-type": "application/json",
      "x-pool-retry-test": "keep-me",
    });
    const response = formatPassthroughUpstreamError(429, body, {
      statusText: "Too Many Requests",
      headers,
    });
    expect(response.status).toBe(429);
    expect(response.statusText).toBe("Too Many Requests");
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-pool-retry-test")).toBe("keep-me");
    expect(await response.text()).toBe(body);
  });

  test("removes expired Retry-After on quota-exhausted non-empty 429 (no synthetic 2)", async () => {
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    const expired = new Date(now - 60_000).toUTCString();
    const body = JSON.stringify({ error: { message: "exceeded your current quota" } });
    const headers = new Headers({
      "retry-after": expired,
      "content-type": "application/json",
      "x-pool-retry-test": "keep-me",
    });
    const response = formatPassthroughUpstreamError(429, body, {
      statusText: "Too Many Requests",
      headers,
      now,
    });
    expect(response.status).toBe(429);
    expect(response.statusText).toBe("Too Many Requests");
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-pool-retry-test")).toBe("keep-me");
    expect(await response.text()).toBe(body);
  });

  test("preserves valid Retry-After: 0 and unrelated headers on non-empty 429", async () => {
    const body = JSON.stringify({ error: { message: "Too many requests" } });
    const headers = new Headers({
      "retry-after": "0",
      "content-type": "application/json",
      "x-pool-retry-test": "keep-me",
    });
    const response = formatPassthroughUpstreamError(429, body, {
      statusText: "Too Many Requests",
      headers,
    });
    expect(response.status).toBe(429);
    expect(response.statusText).toBe("Too Many Requests");
    expect(response.headers.get("Retry-After")).toBe("0");
    expect(response.headers.get("x-pool-retry-test")).toBe("keep-me");
    expect(await response.text()).toBe(body);
  });
});

describe("consumeComboFailure Retry-After separation (#507 review)", () => {
  test("missing Retry-After attaches client fallback but omits it from cooldown metadata", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
      status: 429,
    });
    const failure = await consumeComboFailure(upstream);
    expect(failure.response.headers.get("Retry-After")).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
    expect(failure.retryAfter).toBeUndefined();
  });

  test("valid upstream Retry-After is kept for both client and cooldown metadata", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
      status: 429,
      headers: { "retry-after": "45" },
    });
    const failure = await consumeComboFailure(upstream);
    expect(failure.response.headers.get("Retry-After")).toBe("45");
    expect(failure.retryAfter).toBe("45");
  });
});
