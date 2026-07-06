import { describe, expect, test } from "bun:test";
import { formatCrashEntry, installCrashGuards, isBenignAbortTeardown } from "../src/lib/crash-guard";
import { sidecarEnter } from "../src/lib/sidecar-tracker";

describe("crash-guard diagnostics", () => {
  test("surfaces the JSC throw site from hidden source fields when the stack is native-only", () => {
    const err = new TypeError("null is not an object");
    err.stack = "TypeError: null is not an object\n    at <anonymous> (native:1:11)\n    at processTicksAndRejections (native:7:39)";
    Object.assign(err, { sourceURL: "/abs/src/server.ts", line: 1216, column: 24 });

    const entry = formatCrashEntry("unhandledRejection", err);

    expect(entry).toContain("ctor: TypeError");
    expect(entry).toContain("origin: /abs/src/server.ts:1216:24");
  });

  test("does not add origin when a usable source frame already exists", () => {
    const err = new TypeError("boom");
    err.stack = "TypeError: boom\n    at go (/Users/x/opencodex/src/server.ts:120:13)";

    const entry = formatCrashEntry("uncaughtException", err);

    expect(entry).not.toContain("inspect:");
  });

  test("captures cause and code for shaped errors", () => {
    const err = Object.assign(new Error("upstream failed"), { code: "ECONNRESET", cause: new Error("socket hang up") });

    const entry = formatCrashEntry("unhandledRejection", err);

    expect(entry).toContain("code: ECONNRESET");
    expect(entry).toContain("cause: Error: socket hang up");
  });

  test("redacts secrets from crash entry details and diagnostics", () => {
    const err = Object.assign(
      new Error("failed with Bearer access-token-value-123456 and refreshToken=refresh-live-value"),
      {
        code: "api_key=sk-crash-secret-key",
        cause: new Error("cookie session=secret; profile arn:aws:codewhisperer:us-east-1:123456789012:profile/demo"),
      },
    );
    err.stack = "Error: failed with Bearer stack-token-value-123456\n    at go (/abs/src/server.ts:120:13)";

    const entry = formatCrashEntry("unhandledRejection", err);

    for (const leaked of [
      "access-token-value-123456",
      "refresh-live-value",
      "sk-crash-secret-key",
      "stack-token-value-123456",
      "arn:aws:codewhisperer",
    ]) {
      expect(entry).not.toContain(leaked);
    }
    expect(entry).toContain("Bearer [REDACTED]");
    expect(entry).toContain("refreshToken=[REDACTED]");
    expect(entry).toContain("api_key=[REDACTED]");
  });

  test("never throws on non-object rejection values", () => {
    expect(() => formatCrashEntry("unhandledRejection", null)).not.toThrow();
    expect(() => formatCrashEntry("unhandledRejection", "string reason")).not.toThrow();
    expect(formatCrashEntry("unhandledRejection", 42)).toContain("42");
  });

  test("dumps recent fetch origins (pending/rejected) in the breadcrumb", async () => {
    installCrashGuards(); // idempotent; wraps global fetch once
    await fetch("https://opencodex.invalid.test/v1/models?token=secret").catch(() => {});
    const entry = formatCrashEntry("unhandledRejection", new TypeError("null is not an object"));
    expect(entry).toContain("fetches:");
    expect(entry).toContain("opencodex.invalid.test/v1/models");
    expect(entry).not.toContain("token=secret"); // query redacted
  });

  test("records a sidecar breadcrumb when one is in flight", () => {
    const exit = sidecarEnter("web-search");
    try {
      const entry = formatCrashEntry("unhandledRejection", new TypeError("null is not an object"));
      expect(entry).toContain("sidecar: inFlight=1");
      expect(entry).toContain("last=web-search");
    } finally {
      exit();
    }
  });
});

describe("benign abort-teardown classification", () => {
  test("flags the native-only bare TypeError as benign", () => {
    const err = new TypeError("null is not an object");
    err.stack = "TypeError: null is not an object\n    at <anonymous> (native:1:11)\n    at processTicksAndRejections (native:7:39)";
    expect(isBenignAbortTeardown(err)).toBe(true);
  });

  test("does NOT flag a TypeError with a real JS source frame", () => {
    const err = new TypeError("null is not an object");
    err.stack = "TypeError: null is not an object\n    at handler (/abs/src/server.ts:120:13)";
    expect(isBenignAbortTeardown(err)).toBe(false);
  });

  test("does NOT flag a different message or the (evaluating …) form", () => {
    const a = new TypeError("null is not an object (evaluating 'x.y')");
    a.stack = "TypeError: ...\n    at <anonymous> (native:1:11)";
    expect(isBenignAbortTeardown(a)).toBe(false);

    const b = new TypeError("Cannot read properties of null");
    b.stack = "TypeError: ...\n    at <anonymous> (native:1:11)";
    expect(isBenignAbortTeardown(b)).toBe(false);
  });

  test("does NOT flag non-TypeError rejections", () => {
    expect(isBenignAbortTeardown(new Error("null is not an object"))).toBe(false);
    expect(isBenignAbortTeardown(null)).toBe(false);
    expect(isBenignAbortTeardown("null is not an object")).toBe(false);
  });
});
