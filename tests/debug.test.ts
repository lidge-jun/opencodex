import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendDebugLogLine, debugBufferMetrics, getDebugLogEntries, resetDebugLogBufferForTests, subscribeDebugLogEntries } from "../src/lib/debug-log-buffer";
import { ResourceAdmissionError, RETAINED_TRUNCATION_MARKER, retainedUtf8Bytes } from "../src/lib/admission";
import { getInjectionDebugLogEntries, injectionDebugLog, resetInjectionDebugLogBufferForTests } from "../src/lib/injection-debug-log";
import { markActivity, activityBreadcrumb } from "../src/lib/sidecar-tracker";
import { debugDroppedFrame, debugProviderDiagnostic } from "../src/lib/debug";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";

describe("debug frame logging", () => {
  const previous = process.env.OCX_DEBUG;

  afterEach(() => {
    resetDebugSettingsForTests();
    resetDebugLogBufferForTests();
    resetInjectionDebugLogBufferForTests();
    if (previous === undefined) delete process.env.OCX_DEBUG;
    else process.env.OCX_DEBUG = previous;
  });

  test("debugDroppedFrame redacts payload content", () => {
    process.env.OCX_DEBUG = "1";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugDroppedFrame("openai-chat", "secret frame body bearer-token@example.test");
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("openai-chat");
      expect(line).toContain("payload redacted");
      expect(line).not.toContain("secret frame body");
      expect(line).not.toContain("bearer-token@example.test");
      expect(getDebugLogEntries().some(entry => entry.line.includes("openai-chat"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  test("debugProviderDiagnostic emits under OCX_DEBUG with provider prefix and redacts secrets", () => {
    process.env.OCX_DEBUG = "1";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugProviderDiagnostic("cursor", "dial", { host: "api2.cursor.sh", authorization: "Bearer secret-cursor-token" });
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[ocx:cursor:dial]");
      expect(line).toContain("api2.cursor.sh");
      expect(line).not.toContain("secret-cursor-token");
      expect(line).toContain("[REDACTED]");
    } finally {
      error.mockRestore();
    }
  });

  test("legacy OCX_DEBUG_FRAMES still enables provider diagnostics", () => {
    delete process.env.OCX_DEBUG;
    process.env.OCX_DEBUG_FRAMES = "1";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugProviderDiagnostic("cursor", "connected", { connectMs: 12 });
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0] ?? "")).toContain("[ocx:cursor:connected]");
    } finally {
      error.mockRestore();
    }
  });

  test("debugProviderDiagnostic stays quiet unless explicitly enabled", () => {
    delete process.env.OCX_DEBUG;
    delete process.env.OCX_DEBUG_FRAMES;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugProviderDiagnostic("cursor", "dial", { host: "api2.cursor.sh" });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("debugProviderDiagnostic emits when enabled via runtime settings API", () => {
    delete process.env.OCX_DEBUG;
    setDebugSettings({ debug: true });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugProviderDiagnostic("cursor", "connected", { connectMs: 42 });
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0] ?? "")).toContain("[ocx:cursor:connected]");
    } finally {
      error.mockRestore();
    }
  });

  test("debugDroppedFrame stays quiet unless explicitly enabled", () => {
    delete process.env.OCX_DEBUG;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugDroppedFrame("openai-chat", "secret frame body");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("debugProviderDiagnostic redacts structured secrets", () => {
    process.env.OCX_DEBUG = "1";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugProviderDiagnostic("kiro", "request", {
        region: "us-east-1",
        authorization: "Bearer secret-debug-token",
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
      });
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[ocx:kiro:request]");
      expect(line).toContain("us-east-1");
      expect(line).not.toContain("secret-debug-token");
      expect(line).not.toContain("arn:aws:codewhisperer");
      expect(line).toContain("[REDACTED]");
    } finally {
      error.mockRestore();
    }
  });

  test("appendDebugLogLine supports after/limit queries with monotonic seq", () => {
    appendDebugLogLine("[ocx:test:one]");
    appendDebugLogLine("[ocx:test:two]");
    const all = getDebugLogEntries();
    expect(all).toHaveLength(2);
    expect(all[0]!.seq).toBe(1);
    expect(all[1]!.seq).toBe(2);
    const tail = getDebugLogEntries({ after: all[0]!.seq, limit: 10 });
    expect(tail).toHaveLength(1);
    expect(tail[0]!.line).toContain("two");
  });

  test("provider and injection debug rings evict the oldest on entry 2001", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let index = 1; index <= 2_001; index++) {
        appendDebugLogLine(`provider-${index}`);
        injectionDebugLog(`injection-${index}`);
      }
      const provider = getDebugLogEntries({ limit: 3_000 });
      const injection = getInjectionDebugLogEntries({ limit: 3_000 });
      expect(provider).toHaveLength(2_000);
      expect(injection).toHaveLength(2_000);
      expect(provider[0]?.line).toBe("provider-2");
      expect(injection[0]?.line).toBe("injection-2");
      expect(provider.at(-1)?.line).toBe("provider-2001");
      expect(injection.at(-1)?.line).toBe("injection-2001");
    } finally {
      log.mockRestore();
    }
  });

  test("same-millisecond bursts keep every line via seq cursor", () => {
    const now = Date.now();
    const spy = spyOn(Date, "now").mockReturnValue(now);
    try {
      appendDebugLogLine("[ocx:test:a]");
      appendDebugLogLine("[ocx:test:b]");
      const all = getDebugLogEntries();
      const tail = getDebugLogEntries({ after: all[0]!.seq, limit: 10 });
      expect(tail).toHaveLength(1);
      expect(tail[0]!.line).toContain("b");
    } finally {
      spy.mockRestore();
    }
  });

  test("debug subscriber 65 is rejected while the first 64 still receive entries", () => {
    const seen = Array.from({ length: 64 }, () => 0);
    const unsubscribe = seen.map((_value, index) => subscribeDebugLogEntries(() => { seen[index] += 1; }));
    expect(() => subscribeDebugLogEntries(() => {})).toThrow(ResourceAdmissionError);
    appendDebugLogLine("entry");
    expect(seen.every(count => count === 1)).toBe(true);
    for (const stop of unsubscribe) stop();
  });

  test("subscriber unsubscribe is idempotent and only a foreign owner records release miss", () => {
    const stop = subscribeDebugLogEntries(() => {});
    const before = debugBufferMetrics().subscribers.releaseMisses;
    stop();
    stop();
    expect(debugBufferMetrics().subscribers.releaseMisses).toBe(before);
    expect(debugBufferMetrics().subscribers.active).toBe(0);
  });

  test("stale subscriber disposer cannot remove a replacement registration", () => {
    let seen = 0;
    const listener = () => { seen += 1; };
    const staleStop = subscribeDebugLogEntries(listener);
    staleStop();
    const replacementStop = subscribeDebugLogEntries(listener);
    const before = debugBufferMetrics().subscribers;

    staleStop();
    appendDebugLogLine("replacement remains active");

    expect(seen).toBe(1);
    expect(debugBufferMetrics().subscribers).toMatchObject({
      active: before.active,
      releaseMisses: before.releaseMisses,
    });
    replacementStop();
  });

  test("debug injection crash and fixed-slot strings truncate on UTF-8 boundary with marker", () => {
    const oversized = "한".repeat(8_000);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      appendDebugLogLine(oversized);
      injectionDebugLog(oversized);
      markActivity(oversized);
      for (const retained of [
        getDebugLogEntries()[0]!.line,
        getInjectionDebugLogEntries()[0]!.line,
        activityBreadcrumb().note,
      ]) {
        expect(retained.endsWith(RETAINED_TRUNCATION_MARKER)).toBe(true);
        expect(retainedUtf8Bytes(retained)).toBeLessThanOrEqual(16 * 1024);
        expect(retained).not.toContain("�");
      }
    } finally {
      log.mockRestore();
    }
  });
});
