import { describe, expect, test } from "bun:test";
import {
  bunHasAsyncPullCancelFix,
  compareBunVersions,
  decideEagerRelay,
  isStreamMode,
  MIN_FIXED_BUN_VERSION,
  parseBunVersion,
} from "../src/lib/bun-stream-caps";

describe("parseBunVersion", () => {
  test("parses plain and prerelease versions to the numeric triple", () => {
    expect(parseBunVersion("1.3.14")).toEqual([1, 3, 14]);
    expect(parseBunVersion("1.3.14-canary.1")).toEqual([1, 3, 14]);
    expect(parseBunVersion(" 2.0.0 ")).toEqual([2, 0, 0]);
  });

  test("returns null for garbage", () => {
    expect(parseBunVersion("")).toBeNull();
    expect(parseBunVersion("bun")).toBeNull();
    expect(parseBunVersion("1.3")).toBeNull();
  });
});

describe("compareBunVersions", () => {
  test("orders numerically per segment", () => {
    expect(compareBunVersions("1.3.14", "1.3.14")).toBe(0);
    expect(compareBunVersions("1.4.0", "1.3.14")!).toBeGreaterThan(0);
    expect(compareBunVersions("1.3.9", "1.3.14")!).toBeLessThan(0);
    expect(compareBunVersions("2.0.0", "1.99.99")!).toBeGreaterThan(0);
  });

  test("null on unparseable input", () => {
    expect(compareBunVersions("nope", "1.0.0")).toBeNull();
  });
});

describe("bunHasAsyncPullCancelFix", () => {
  test("no min-fixed threshold → never fixed (today's shipped state)", () => {
    expect(MIN_FIXED_BUN_VERSION).toBeNull();
    expect(bunHasAsyncPullCancelFix("99.0.0", null)).toBe(false);
  });

  test("at/above threshold → fixed; below → not", () => {
    expect(bunHasAsyncPullCancelFix("1.4.0", "1.4.0")).toBe(true);
    expect(bunHasAsyncPullCancelFix("1.4.1", "1.4.0")).toBe(true);
    expect(bunHasAsyncPullCancelFix("1.3.14", "1.4.0")).toBe(false);
  });

  test("prerelease conservatism: canary of the fixed version is NOT fixed", () => {
    expect(bunHasAsyncPullCancelFix("1.4.0-canary.1", "1.4.0")).toBe(false);
  });

  test("unparseable version → not fixed", () => {
    expect(bunHasAsyncPullCancelFix("garbage", "1.4.0")).toBe(false);
  });
});

describe("decideEagerRelay (activation scenarios)", () => {
  test("auto on today's bundled runtime → legacy tee (auto-known-bad)", () => {
    expect(decideEagerRelay("auto", "1.3.14", null)).toEqual({
      useEagerRelay: false,
      reason: "auto-known-bad",
    });
  });

  test("auto on a future fixed runtime → eager relay", () => {
    expect(decideEagerRelay("auto", "1.4.0", "1.4.0")).toEqual({
      useEagerRelay: true,
      reason: "auto-fixed-runtime",
    });
  });

  test("explicit eager-relay opt-in wins even on known-bad runtimes", () => {
    expect(decideEagerRelay("eager-relay", "1.3.14", null)).toEqual({
      useEagerRelay: true,
      reason: "config-eager",
    });
  });

  test("explicit legacy-tee pin wins even on fixed runtimes", () => {
    expect(decideEagerRelay("legacy-tee", "9.9.9", "1.4.0")).toEqual({
      useEagerRelay: false,
      reason: "config-legacy",
    });
  });
});

describe("isStreamMode", () => {
  test("accepts the three modes, rejects everything else", () => {
    expect(isStreamMode("auto")).toBe(true);
    expect(isStreamMode("legacy-tee")).toBe(true);
    expect(isStreamMode("eager-relay")).toBe(true);
    expect(isStreamMode("legacy_tee")).toBe(false);
    expect(isStreamMode(1)).toBe(false);
    expect(isStreamMode(undefined)).toBe(false);
  });
});
