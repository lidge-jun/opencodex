import { describe, expect, test } from "bun:test";
import {
  bunHasAsyncPullCancelFix,
  compareBunVersions,
  decideEagerRelay,
  isStreamMode,
  isWin32EagerRewrite,
  MIN_FIXED_BUN_VERSION,
  parseBunVersion,
  selectEagerPath,
} from "../src/lib/bun-stream-caps";

describe("isWin32EagerRewrite (#864 transport gate)", () => {
  test("win32 + rewrite → eager inline rewrite; everything else stays out", () => {
    expect(isWin32EagerRewrite("win32", true)).toBe(true);
    expect(isWin32EagerRewrite("win32", false)).toBe(false);
    expect(isWin32EagerRewrite("darwin", true)).toBe(false);
    expect(isWin32EagerRewrite("linux", true)).toBe(false);
  });
});

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
  test("shipped threshold is Bun 1.4.0; a null threshold is never fixed", () => {
    expect(MIN_FIXED_BUN_VERSION).toBe("1.4.0");
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

describe("selectEagerPath (platform policy matrix)", () => {
  const configLegacy = { useEagerRelay: false, reason: "config-legacy" } as const;
  const configEager = { useEagerRelay: true, reason: "config-eager" } as const;
  const autoFixed = { useEagerRelay: true, reason: "auto-fixed-runtime" } as const;
  const cases: Array<{
    platform: NodeJS.Platform;
    mode: "auto" | "legacy-tee" | "eager-relay";
    rewrite: boolean;
    expected: typeof configLegacy | typeof configEager | typeof autoFixed | null;
  }> = [
    { platform: "win32", mode: "legacy-tee", rewrite: false, expected: configLegacy },
    { platform: "win32", mode: "eager-relay", rewrite: false, expected: configEager },
    { platform: "win32", mode: "auto", rewrite: false, expected: autoFixed },
    { platform: "win32", mode: "legacy-tee", rewrite: true, expected: null },
    { platform: "win32", mode: "eager-relay", rewrite: true, expected: null },
    { platform: "win32", mode: "auto", rewrite: true, expected: null },
    { platform: "darwin", mode: "legacy-tee", rewrite: false, expected: null },
    { platform: "darwin", mode: "eager-relay", rewrite: false, expected: configEager },
    { platform: "darwin", mode: "auto", rewrite: false, expected: null },
    { platform: "darwin", mode: "legacy-tee", rewrite: true, expected: null },
    { platform: "darwin", mode: "eager-relay", rewrite: true, expected: configEager },
    { platform: "darwin", mode: "auto", rewrite: true, expected: null },
    { platform: "linux", mode: "legacy-tee", rewrite: false, expected: null },
    { platform: "linux", mode: "eager-relay", rewrite: false, expected: null },
    { platform: "linux", mode: "auto", rewrite: false, expected: null },
    { platform: "linux", mode: "legacy-tee", rewrite: true, expected: null },
    { platform: "linux", mode: "eager-relay", rewrite: true, expected: null },
    { platform: "linux", mode: "auto", rewrite: true, expected: null },
  ];

  for (const { platform, mode, rewrite, expected } of cases) {
    test(`${platform} + ${mode} + rewrite=${rewrite}`, () => {
      expect(selectEagerPath(platform, rewrite, mode, "1.4.0", "1.4.0")).toEqual(expected);
    });
  }
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
