import { describe, expect, test } from "bun:test";
import { googleErrorDetails, parseGoogleDurationMs } from "../../../src/adapters/google-error-details";

const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";

describe("Google duration text", () => {
  test.each([
    ["30s", 30_000], ["0.5s", 500], ["42.5s", 42_500], ["1h2m3s", 3_723_000], ["1.5h", 5_400_000],
    ["500ms", 500], ["2m", 120_000], [" 3s ", 3_000], ["1m0.25s", 60_250],
  ])("%s is %d ms", (raw, ms) => expect(parseGoogleDurationMs(raw)).toBe(ms));

  test.each(["", "-1s", "abc", "3", "3 s", "1h-2m", "999999h", "1s2", "s", "1.s", "1h".repeat(40)])("%p is not a duration", raw => {
    expect(parseGoogleDurationMs(raw)).toBeUndefined();
  });
});

describe("Google error details", () => {
  test("typed ErrorInfo and RetryInfo are read; RetryInfo wins over quotaResetDelay", () => {
    expect(googleErrorDetails(JSON.stringify({ error: { code: 429, details: [
      { "@type": ERROR_INFO, reason: "RATE_LIMIT_EXCEEDED", domain: "cloudcode-pa.googleapis.com", metadata: { quotaResetDelay: "1h2m3s" } },
      { "@type": RETRY_INFO, retryDelay: "3s" },
    ] } }))).toEqual({ reason: "RATE_LIMIT_EXCEEDED", domain: "cloudcode-pa.googleapis.com", retryDelayMs: 3_000 });
  });

  test("quotaResetDelay is used without RetryInfo, also on an array-rooted body", () => {
    expect(googleErrorDetails(JSON.stringify([{ error: { details: [
      { "@type": ERROR_INFO, reason: "QUOTA_EXHAUSTED", metadata: { quotaResetDelay: "1h2m3s" } },
    ] } }]))).toEqual({ reason: "QUOTA_EXHAUSTED", retryDelayMs: 3_723_000 });
  });

  test("an untyped reason is kept apart from the typed one", () => {
    expect(googleErrorDetails(JSON.stringify({ error: { details: [{ reason: "TOS_VIOLATION" }] } }))).toEqual({ reasonUntyped: "TOS_VIOLATION" });
  });

  test("the message's reset hint is the last resort", () => {
    expect(googleErrorDetails(JSON.stringify({ error: { message: "You have exhausted your capacity. Your quota will reset after 2m30s." } })))
      .toEqual({ retryDelayMs: 150_000 });
    expect(googleErrorDetails(JSON.stringify({ error: { message: "reset after never" } }))).toEqual({});
  });

  test("unreadable bodies yield nothing", () => {
    for (const body of ["", "not json", "[]", "{}", JSON.stringify({ error: { details: "x" } })]) expect(googleErrorDetails(body)).toEqual({});
  });
});

describe("retry delay selection across details", () => {
  const RETRY = "type.googleapis.com/google.rpc.RetryInfo";
  test("a zero RetryInfo does not hide a later positive one", () => {
    expect(googleErrorDetails(JSON.stringify({ error: { details: [{ "@type": RETRY, retryDelay: "0s" }, { "@type": RETRY, retryDelay: "60s" }] } })).retryDelayMs).toBe(60_000);
  });
  test("a typed RetryInfo outranks an untyped delay listed before it", () => {
    expect(googleErrorDetails(JSON.stringify({ error: { details: [{ retryDelay: "1s" }, { "@type": RETRY, retryDelay: "60s" }] } })).retryDelayMs).toBe(60_000);
  });
});
