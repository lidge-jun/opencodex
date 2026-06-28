import { describe, expect, test } from "bun:test";
import { formatCrashEntry } from "../src/crash-guard";

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

  test("never throws on non-object rejection values", () => {
    expect(() => formatCrashEntry("unhandledRejection", null)).not.toThrow();
    expect(() => formatCrashEntry("unhandledRejection", "string reason")).not.toThrow();
    expect(formatCrashEntry("unhandledRejection", 42)).toContain("42");
  });
});
