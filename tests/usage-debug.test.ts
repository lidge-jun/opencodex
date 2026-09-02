import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageDebug,
  isUsageDebugEnabled,
  truncateForDebug,
  USAGE_DEBUG_BODY_SAMPLE_BYTES,
  USAGE_DEBUG_ENV,
  USAGE_DEBUG_KEEP_LINES,
  USAGE_DEBUG_MAX_LINES,
  usageDebugPath,
} from "../src/usage/debug";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let previousDebug: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDebug = process.env[USAGE_DEBUG_ENV];
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-debug-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDebug === undefined) delete process.env[USAGE_DEBUG_ENV];
  else process.env[USAGE_DEBUG_ENV] = previousDebug;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("isUsageDebugEnabled", () => {
  test("returns false by default", () => {
    delete process.env[USAGE_DEBUG_ENV];
    expect(isUsageDebugEnabled()).toBe(false);
  });

  test("returns true only when env equals exactly '1'", () => {
    process.env[USAGE_DEBUG_ENV] = "1";
    expect(isUsageDebugEnabled()).toBe(true);
    for (const value of ["0", "true", "yes", "TRUE", ""]) {
      process.env[USAGE_DEBUG_ENV] = value;
      expect(isUsageDebugEnabled()).toBe(false);
    }
  });
});

describe("truncateForDebug", () => {
  test("returns shorter strings verbatim", () => {
    expect(truncateForDebug("hello")).toBe("hello");
  });

  test("clamps and appends remaining-byte hint", () => {
    const big = "x".repeat(USAGE_DEBUG_BODY_SAMPLE_BYTES + 100);
    const clamped = truncateForDebug(big);
    expect(clamped.startsWith("x".repeat(USAGE_DEBUG_BODY_SAMPLE_BYTES))).toBe(true);
    expect(clamped).toContain("... [+100 more]");
  });

  test("respects a custom max", () => {
    expect(truncateForDebug("abcdef", 3)).toBe("abc... [+3 more]");
  });

  test("redacts before clamping so partial secrets are not preserved", () => {
    const text = `Bearer access-token-value-123456 ${"x".repeat(20)}`;
    const clamped = truncateForDebug(text, 18);
    expect(clamped).not.toContain("access-token-value");
    expect(clamped).toContain("Bearer [REDACTED]");
  });
});

describe("appendUsageDebug", () => {
  function sample(extra: Partial<{ requestId: string; ts: number }> = {}) {
    return {
      ts: extra.ts ?? 1,
      requestId: extra.requestId ?? "ocx-debug-1",
      provider: "chatgpt",
      model: "gpt-5.5",
      upstreamContentType: "text/event-stream",
      upstreamStatus: 200,
      bodyKind: "sse" as const,
      bodySample: "data: {\"type\":\"response.completed\"}",
      extractedUsage: null,
    };
  }

  test("appends one JSON line with the expected shape and 0o600 perms", () => {
    appendUsageDebug(sample());
    const path = usageDebugPath();
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.requestId).toBe("ocx-debug-1");
    expect(parsed.bodyKind).toBe("sse");
    expect(parsed.upstreamContentType).toBe("text/event-stream");
    if (process.platform !== "win32") {
      expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    }
  });

  test("redacts body samples before writing JSONL", () => {
    appendUsageDebug({
      ...sample(),
      bodySample: "data: {\"authorization\":\"Bearer usage-debug-token\",\"refreshToken\":\"refresh-debug-token\"}",
    });

    const lines = readFileSync(usageDebugPath(), "utf-8").split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[0]) as { bodySample: string };
    expect(parsed.bodySample).not.toContain("usage-debug-token");
    expect(parsed.bodySample).not.toContain("refresh-debug-token");
    // A credential value now masks to end of line, so the trailing fields of a
    // serialized body go with it. That is deliberate: every attempt to stop
    // early and keep the siblings readable turned out to be a way to smuggle a
    // credential past the redactor. The first field name still identifies what
    // the sample was, which is what a debug line actually needs.
    expect(parsed.bodySample).not.toContain("Bearer usage-debug-token");
    expect(parsed.bodySample).toContain("authorization");
    expect(parsed.bodySample).toContain("[REDACTED]");
  });

  test("preserves estimated extracted usage while redacting surrounding secrets", () => {
    appendUsageDebug({
      ...sample(),
      bodySample: "Bearer usage-debug-token-123456",
      extractedUsage: { inputTokens: 9, outputTokens: 4, estimated: true },
    });

    const parsed = JSON.parse(readFileSync(usageDebugPath(), "utf-8")) as {
      bodySample: string;
      extractedUsage: { inputTokens: number; outputTokens: number; estimated?: boolean };
    };
    expect(parsed.extractedUsage).toEqual({ inputTokens: 9, outputTokens: 4, estimated: true });
    expect(parsed.bodySample).not.toContain("usage-debug-token");
    expect(parsed.bodySample).toContain("Bearer [REDACTED]");
  });

  test("rotates to the most recent USAGE_DEBUG_KEEP_LINES once USAGE_DEBUG_MAX_LINES is exceeded", () => {
    // Lazy rotation: append #(MAX+1) triggers one rewrite to KEEP. Subsequent appends
    // grow the file again up to MAX before the next rewrite. After MAX+1 appends the
    // file holds exactly KEEP lines and the most-recent record survives.
    const total = USAGE_DEBUG_MAX_LINES + 1;
    for (let i = 0; i < total; i++) {
      appendUsageDebug(sample({ requestId: `ocx-${i}`, ts: i }));
    }
    const path = usageDebugPath();
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(USAGE_DEBUG_KEEP_LINES);
    const last = JSON.parse(lines[lines.length - 1]) as { requestId: string };
    const first = JSON.parse(lines[0]) as { requestId: string };
    expect(last.requestId).toBe(`ocx-${total - 1}`);
    expect(first.requestId).toBe(`ocx-${total - USAGE_DEBUG_KEEP_LINES}`);
  });

  test("keeps file size bounded by MAX_LINES across long runs", () => {
    // Cross the rotate threshold twice — enough to prove the bound holds across
    // multiple rewrites without MAX*3 appends (that path times out under full-suite load).
    //
    // These 325 appends still cost ~1,950 synchronous fs calls: six per append
    // (mkdir + chmod from ensureUsageDebugDir, then append, chmod, exists, read),
    // plus a write/chmod pair on each of the two rotations. On windows-latest under
    // full-suite load that measured 13.6s — past the 5s default — while ubuntu and
    // macos stay well under it. The cost is per-open (Defender scans each handle),
    // not per-byte, so shaving one of the six calls would not move it enough to
    // matter. Give the test the time it needs instead of trading away coverage:
    // 325 is already the minimum that crosses the rotate threshold twice.
    const total = USAGE_DEBUG_MAX_LINES + USAGE_DEBUG_KEEP_LINES + 25;
    for (let i = 0; i < total; i++) {
      appendUsageDebug(sample({ requestId: `ocx-${i}`, ts: i }));
    }
    const path = usageDebugPath();
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(USAGE_DEBUG_MAX_LINES);
    expect(lines.length).toBeGreaterThanOrEqual(USAGE_DEBUG_KEEP_LINES);
  }, 15_000);
});
