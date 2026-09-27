import { describe, expect, test } from "bun:test";
import { DEFAULT_STALL_TIMEOUT_SEC, resolveStallTimeoutMs, resolveStallTimeoutSec } from "../../src/stall-timeout";

describe("resolveStallTimeoutSec", () => {
  test("defaults to 300 seconds for a public upstream when unset", () => {
    expect(DEFAULT_STALL_TIMEOUT_SEC).toBe(300);
    expect(resolveStallTimeoutSec(undefined)).toBe(300);
    expect(resolveStallTimeoutSec(undefined, { localUpstream: false })).toBe(300);
  });

  test("defaults to disabled for a local upstream when unset", () => {
    // Local models (LM Studio, Ollama, a self-hosted vLLM) are often CPU-bound and go silent for
    // minutes while thinking; an unset budget must not kill a healthy local turn.
    expect(resolveStallTimeoutSec(undefined, { localUpstream: true })).toBe(0);
  });

  test("an explicit 0 disables the budget everywhere, local and public alike", () => {
    // The operator's documented off-switch. Regression: 0 previously resolved to a 1s minimum,
    // which re-armed the watchdog instead of disarming it.
    expect(resolveStallTimeoutSec(0)).toBe(0);
    expect(resolveStallTimeoutSec(0, { localUpstream: false })).toBe(0);
    expect(resolveStallTimeoutSec(0, { localUpstream: true })).toBe(0);
  });

  test("a non-positive configured value disables the budget", () => {
    expect(resolveStallTimeoutSec(-5)).toBe(0);
    expect(resolveStallTimeoutSec(-5, { localUpstream: true })).toBe(0);
  });

  test("honors positive configured values with a 1s floor, local and public", () => {
    expect(resolveStallTimeoutSec(90)).toBe(90);
    expect(resolveStallTimeoutSec(90, { localUpstream: true })).toBe(90);
    expect(resolveStallTimeoutSec(600.2)).toBe(601);
    // A sub-second positive budget rounds up to the 1s floor rather than being dropped.
    expect(resolveStallTimeoutSec(0.4)).toBe(1);
    expect(resolveStallTimeoutSec(0.4, { localUpstream: true })).toBe(1);
  });

  test("rejects non-finite values back to the destination default", () => {
    expect(resolveStallTimeoutSec(Number.NaN)).toBe(300);
    expect(resolveStallTimeoutSec(Number.POSITIVE_INFINITY)).toBe(300);
    expect(resolveStallTimeoutSec(Number.NEGATIVE_INFINITY)).toBe(300);
    expect(resolveStallTimeoutSec(Number.NaN, { localUpstream: true })).toBe(0);
  });
});

describe("resolveStallTimeoutMs", () => {
  test("scales the seconds resolution to milliseconds", () => {
    expect(resolveStallTimeoutMs(undefined)).toBe(300_000);
    expect(resolveStallTimeoutMs(undefined, { localUpstream: true })).toBe(0);
    expect(resolveStallTimeoutMs(0)).toBe(0);
    expect(resolveStallTimeoutMs(90)).toBe(90_000);
  });

  test("0 is a stable disabled sentinel for inactivity guards", () => {
    expect(resolveStallTimeoutMs(0, { localUpstream: true })).toBe(0);
    // Guards treat a non-positive budget as "arm no clock"; the resolver must hand them exactly 0.
    expect(resolveStallTimeoutMs(undefined, { localUpstream: true })).toBe(0);
  });
});
