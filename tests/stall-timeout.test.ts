import { describe, expect, test } from "bun:test";
import { DEFAULT_STALL_TIMEOUT_SEC, resolveStallTimeoutSec } from "../src/stall-timeout";

describe("resolveStallTimeoutSec", () => {
  test("defaults to 300 seconds when unset", () => {
    expect(DEFAULT_STALL_TIMEOUT_SEC).toBe(300);
    expect(resolveStallTimeoutSec(undefined)).toBe(300);
  });

  test("honors finite configured values with a minimum of 1", () => {
    expect(resolveStallTimeoutSec(90)).toBe(90);
    expect(resolveStallTimeoutSec(600.2)).toBe(601);
    expect(resolveStallTimeoutSec(0)).toBe(1);
    expect(resolveStallTimeoutSec(-5)).toBe(1);
  });

  test("rejects non-finite values back to the default", () => {
    expect(resolveStallTimeoutSec(Number.NaN)).toBe(300);
    expect(resolveStallTimeoutSec(Number.POSITIVE_INFINITY)).toBe(300);
    expect(resolveStallTimeoutSec(Number.NEGATIVE_INFINITY)).toBe(300);
  });
});
