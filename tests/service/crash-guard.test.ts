import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCrashTraceForTests, crashRingEntriesForTests, formatCrashEntry, installCrashGuards, isBenignAbortTeardown, recordCrashForTests, resetBenignFoldForTests, resetCrashRingForTests } from "../../src/lib/crash-guard";
import { RETAINED_TRUNCATION_MARKER, retainedUtf8Bytes } from "../../src/lib/admission";
import { sidecarEnter } from "../../src/lib/sidecar-tracker";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("crash-guard diagnostics", () => {
  test("the 13th fetch trace evicts the oldest and 8 KiB values truncate on UTF-8 boundaries", () => {
    resetCrashRingForTests();
    for (let index = 1; index <= 12; index++) appendCrashTraceForTests(`https://example.test/${index}`, `origin-${index}`);
    const oversized = "한".repeat(8_000);
    appendCrashTraceForTests("https://example.test/13", oversized, oversized);

    const traces = crashRingEntriesForTests();
    expect(traces).toHaveLength(12);
    expect(traces.some(trace => trace.url.endsWith("/1"))).toBe(false);
    expect(traces[0]?.url).toEndWith("/2");
    const last = traces.at(-1)!;
    for (const value of [last.origin, last.rejected!]) {
      expect(value.endsWith(RETAINED_TRUNCATION_MARKER)).toBe(true);
      expect(retainedUtf8Bytes(value)).toBeLessThanOrEqual(8 * 1024);
      expect(value).not.toContain("�");
    }
    resetCrashRingForTests();
  });

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

  test("does NOT flag unparenthesized, async, file-URL, or Windows JS source frames", () => {
    for (const frame of [
      "at /abs/src/server.ts:120:13",
      "at async handler (file:///abs/src/server.ts:120:13)",
      "at file:///abs/src/server.ts:120:13",
      "at C:\\app\\src\\server.ts:120:13",
    ]) {
      const err = new TypeError("null is not an object");
      err.stack = `TypeError: null is not an object\r\n    at <anonymous> (native:1:11)\r\n    ${frame}`;
      expect(isBenignAbortTeardown(err), frame).toBe(false);
    }
  });

  test("hidden JSC source fields alone do not veto a native-only stack", () => {
    // Bun can attach sourceURL/line/column to errors raised from builtin frames, and the
    // benign summary still records them through diagnose(); only a real JS frame vetoes.
    const err = new TypeError("null is not an object");
    err.stack = "TypeError: null is not an object\n    at <anonymous> (native:1:11)\n    at native:7:39";
    Object.assign(err, { sourceURL: "/abs/src/server.ts", line: 1216, column: 24 });
    expect(isBenignAbortTeardown(err)).toBe(true);
  });

  const withCrashHome = (run: (crashLog: () => string) => void) => {
    const home = mkdtempSync(join(tmpdir(), "ocx-crash-guard-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    resetBenignFoldForTests();
    try {
      run(() => readFileSync(join(home, "crash.log"), "utf8"));
    } finally {
      resetBenignFoldForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  };

  test("a new hidden throw site is logged inside the fold window; repeats still fold", () => {
    const teardown = (site: { sourceURL: string; line?: number; column?: number }) => {
      const err = new TypeError("null is not an object");
      err.stack = "TypeError: null is not an object\n    at <anonymous> (native:1:11)";
      return Object.assign(err, site);
    };
    withCrashHome(crashLog => {
      recordCrashForTests("unhandledRejection", teardown({ sourceURL: "/abs/src/a.ts", line: 1, column: 2 }));
      recordCrashForTests("unhandledRejection", teardown({ sourceURL: "/abs/src/a.ts", line: 1, column: 2 }));
      recordCrashForTests("unhandledRejection", teardown({ sourceURL: "/abs/src/b.ts", line: 3, column: 4 }));
      recordCrashForTests("unhandledRejection", teardown({ sourceURL: "" }));
      const log = crashLog();
      expect(log.match(/benign-abort-teardown/g)).toHaveLength(2);
      expect(log).toContain("origin: /abs/src/a.ts:1:2");
      expect(log).toContain("origin: /abs/src/b.ts:3:4");
    });
  });

  test("a throwing hidden-field accessor cannot escape the crash handler", () => {
    const err = new TypeError("null is not an object");
    err.stack = "TypeError: null is not an object\n    at <anonymous> (native:1:11)";
    // A Proxy keeps instanceof TypeError while making the hidden field read throw.
    const hostile = new Proxy(err, {
      get(target, key) {
        if (key === "sourceURL") throw new Error("accessor failure fixture");
        return Reflect.get(target, key, target);
      },
    });
    withCrashHome(crashLog => {
      expect(() => recordCrashForTests("unhandledRejection", hostile)).not.toThrow();
      expect(crashLog()).toContain("benign-abort-teardown");
    });
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

  test("flags the native-only locked-ReadableStream sink-close teardown as benign (260712)", () => {
    const err = new TypeError("Invalid state: ReadableStream is locked");
    (err as { code?: string }).code = "ERR_INVALID_STATE";
    err.stack = "TypeError: Invalid state: ReadableStream is locked\n    at unknown\n    at <anonymous> (native:1:11)\n    at onSinkClose2 (native:5:32)";
    expect(isBenignAbortTeardown(err)).toBe(true);
  });

  test("locked-ReadableStream shape needs the code AND a native-only stack", () => {
    const noCode = new TypeError("Invalid state: ReadableStream is locked");
    noCode.stack = "TypeError: ...\n    at onSinkClose2 (native:5:32)";
    expect(isBenignAbortTeardown(noCode)).toBe(false);

    const jsFrame = new TypeError("Invalid state: ReadableStream is locked");
    (jsFrame as { code?: string }).code = "ERR_INVALID_STATE";
    jsFrame.stack = "TypeError: ...\n    at relay (/abs/src/server/relay.ts:88:7)";
    expect(isBenignAbortTeardown(jsFrame)).toBe(false);
  });
});
