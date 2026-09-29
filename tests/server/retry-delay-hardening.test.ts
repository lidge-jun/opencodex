import { describe, expect, test } from "bun:test";
import { adapterFailureFromMessage, parseRetryAfterFromMessage } from "../../src/lib/errors";
import { formatRetryAfterAdvice } from "../../src/lib/retry-delay";

describe("stated reset duration boundaries", () => {
  test("the error adapter retains a local parser binding after extraction", () => {
    const failure = adapterFailureFromMessage("Devin rate limit: reset in 5 minutes 30 seconds");
    expect(failure.httpStatus).toBe(429);
    expect(failure.error.message).toBe("Please try again in 330s. Devin rate limit: reset in 5 minutes 30 seconds");
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
    ["retry after ~180s", 180],
    ["Retry-After: ~3 minutes", 180],
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
    "reset in ~3 minutes",
    "retry after ~1 minute ~30 seconds",
    "Retry-After: ~~180s",
    "try again in 1e3s",
    "Retry-After: 3:30",
    "Retry-After: 123abc",
    "reset in 0 seconds",
    "reset in 999999999999999999999999999999999999999999 hours",
  ])("does not salvage a misleading partial duration: %s", message => {
    expect(parseRetryAfterFromMessage(message)).toBeUndefined();
  });
});

// These are wire-advice checks, not elapsed-time or Desktop-rendering tests.
describe("Codex long-wait advice", () => {
  test.each([120, 900, 1800, 2460, 3600])("preserves a %i-second hint without shortening it", seconds => {
    const message = `Devin rate limit; retry after ~${seconds}s`;
    const formatted = formatRetryAfterAdvice(message);
    expect(formatted).toBe(`Please try again in ${seconds}s. ${message}`);
    expect(parseRetryAfterFromMessage(formatted!)).toBe(seconds);
    expect(formatRetryAfterAdvice(formatted!)).toBe(formatted);
  });

  test.each([2460, 3600])("puts the %i-second lower bound before shorter advice", seconds => {
    const message = `Please try again in 1s. retry after ~${seconds}s`;
    const formatted = formatRetryAfterAdvice(message);
    expect(formatted).toBe(`Please try again in ${seconds}s. Provider detail: ${message}`);
    expect(parseRetryAfterFromMessage(formatted!)).toBe(seconds);
    expect(formatRetryAfterAdvice(formatted!)).toBe(formatted);
  });

  test("a later refusal uses its own delay; an intervening disconnect has no invented advice", () => {
    const first = "Devin rate limit; retry after ~2460s";
    const disconnect = "upstream_server_error: socket closed";
    const later = "Devin rate limit; retry after ~120s";
    expect(formatRetryAfterAdvice(first)).toBe(`Please try again in 2460s. ${first}`);
    expect(parseRetryAfterFromMessage(disconnect)).toBeUndefined();
    expect(formatRetryAfterAdvice(disconnect)).toBeUndefined();
    expect(formatRetryAfterAdvice(later)).toBe(`Please try again in 120s. ${later}`);
    expect(formatRetryAfterAdvice("resource_exhausted")).toBeUndefined();
  });
});
