import { describe, expect, test } from "bun:test";
import { adapterFailureFromMessage, parseRetryAfterFromMessage } from "../../src/lib/errors";

describe("stated reset duration boundaries", () => {
  test("the error adapter retains a local parser binding after extraction", () => {
    const failure = adapterFailureFromMessage("Devin rate limit: reset in 5 minutes 30 seconds");
    expect(failure.httpStatus).toBe(429);
    expect(failure.error.message).toBe("Devin rate limit: reset in 5 minutes 30 seconds Please try again in 330s.");
    expect(failure.error.code).toBe("rate_limit_exceeded");
  });

  test.each([
    ["reset in 5 minutes 30 seconds", 330],
    ["reset in 1 hour, 5 minutes and 30 seconds", 3930],
    ["reset in 1h30m", 5400],
    ["try again in 500ms", 1],
    ["retry after 1500 milliseconds", 2],
    ["reset in 1 minute 500 milliseconds", 61],
    ["retry after 7.2s", 8],
    ["Retry-After: 30", 30],
    ["Retry-After: 0.1", 1],
    ["Your limit RESETS IN 21 MINUTES", 1260],
    ["try again in 2s. Your limit will reset in 21 minutes.", 1260],
  ] as const)("%s -> %i seconds", (message, expected) => {
    expect(parseRetryAfterFromMessage(message)).toBe(expected);
  });

  test.each([
    "reset in 2026",
    "reset in -5 minutes",
    "reset in 5 minutes -30 seconds",
    "reset in 5 minutes 30 bananas",
    "reset in 5 minutes 30",
    "reset in 5 months",
    "retry after 3 monkeys",
    "try again in 1e3s",
    "Retry-After: 3:30",
    "Retry-After: 123abc",
    "reset in 0 seconds",
    "reset in 999999999999999999999999999999999999999999 hours",
  ])("does not salvage a misleading partial duration: %s", message => {
    expect(parseRetryAfterFromMessage(message)).toBeUndefined();
  });
});
