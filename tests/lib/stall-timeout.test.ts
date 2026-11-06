import { describe, expect, test } from "bun:test";
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_STALL_TIMEOUT_SEC, MIN_JSON_BODY_READ_MS, resolveConnectTimeoutMs, resolveJsonBodyReadTimeoutMs, resolveStallTimeoutMs, resolveStallTimeoutSec } from "../../src/stall-timeout";

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

describe("resolveConnectTimeoutMs", () => {
  test("defaults to the 200s header deadline for a public upstream", () => {
    expect(resolveConnectTimeoutMs(undefined)).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    expect(resolveConnectTimeoutMs(undefined)).toBe(200_000);
    expect(resolveConnectTimeoutMs(undefined, { localUpstream: false })).toBe(200_000);
  });

  test("disables the header deadline for a local upstream when unset", () => {
    // A large prompt can hold a local model (LM Studio/Ollama) silent for minutes during prefill;
    // an unset budget must resolve to disabled so the header clock never cuts a healthy turn.
    expect(resolveConnectTimeoutMs(undefined, { localUpstream: true })).toBe(0);
  });

  test("an explicit value wins verbatim for local and public alike", () => {
    expect(resolveConnectTimeoutMs(45_000)).toBe(45_000);
    expect(resolveConnectTimeoutMs(45_000, { localUpstream: true })).toBe(45_000);
    // Fractional budgets ceil to at least 1ms, matching the stall resolver's shape.
    expect(resolveConnectTimeoutMs(0.4)).toBe(1);
    expect(resolveConnectTimeoutMs(0.4, { localUpstream: true })).toBe(1);
  });

  test("an explicit non-positive value disables everywhere", () => {
    expect(resolveConnectTimeoutMs(0)).toBe(0);
    expect(resolveConnectTimeoutMs(0, { localUpstream: false })).toBe(0);
    expect(resolveConnectTimeoutMs(-5)).toBe(0);
    expect(resolveConnectTimeoutMs(-5, { localUpstream: true })).toBe(0);
  });

  test("non-finite falls back to the destination default", () => {
    expect(resolveConnectTimeoutMs(Number.NaN)).toBe(200_000);
    expect(resolveConnectTimeoutMs(Number.POSITIVE_INFINITY)).toBe(200_000);
    expect(resolveConnectTimeoutMs(Number.NaN, { localUpstream: true })).toBe(0);
  });
});

describe("resolveJsonBodyReadTimeoutMs", () => {
  test("disables the body-read budget for a local upstream when unset", () => {
    // The regression this guards: a local upstream resolves connect to 0, and the JSON reader used
    // to derive its budget from that as Math.max(0, 5000) = 5s, cutting a slow local body. The
    // body-read budget must follow the stall clock instead and resolve to disabled for local.
    expect(resolveJsonBodyReadTimeoutMs(undefined, { localUpstream: true })).toBe(0);
  });

  test("public JSON default ignores the separate streaming stall setting", () => {
    expect(resolveJsonBodyReadTimeoutMs(undefined)).toBe(200_000);
    expect(resolveJsonBodyReadTimeoutMs(undefined, { localUpstream: false })).toBe(200_000);
    expect(resolveJsonBodyReadTimeoutMs(1)).toBe(200_000);
    expect(resolveJsonBodyReadTimeoutMs(2)).toBe(200_000);
    expect(resolveJsonBodyReadTimeoutMs(30)).toBe(200_000);
  });

  test("public JSON reads retain the legacy connect-derived budget", () => {
    expect(resolveJsonBodyReadTimeoutMs(0)).toBe(200_000);
    expect(resolveJsonBodyReadTimeoutMs(0, { localUpstream: false })).toBe(200_000);
    expect(resolveJsonBodyReadTimeoutMs(-1, { localUpstream: true })).toBe(0);
  });

  test("an explicit local stall budget applies without the public five-second floor", () => {
    expect(resolveJsonBodyReadTimeoutMs(1, { localUpstream: true })).toBe(1_000);
  });

  test("public JSON custom connect budgets preserve the legacy floor", () => {
    expect(resolveJsonBodyReadTimeoutMs(90, {}, 12_345)).toBe(12_345);
    expect(resolveJsonBodyReadTimeoutMs(0, {}, 0)).toBe(MIN_JSON_BODY_READ_MS);
    expect(resolveJsonBodyReadTimeoutMs(0, {}, -1)).toBe(MIN_JSON_BODY_READ_MS);
  });
});
