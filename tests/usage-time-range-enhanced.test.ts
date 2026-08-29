
import { describe, expect, it } from "bun:test";
import { parseTimeBoundary, resolveTimeRange } from "../src/usage/time-range";
import { summarizeUsage, summarizeUsageFromLogFile } from "../src/usage/summary";
import { formatUsageMarkdownReport } from "../src/cli/usage-report";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Time Range Parsing & Resolution", () => {
  const fixedNow = new Date("2026-08-30T12:00:00+08:00").getTime();

  it("parses numeric epoch timestamps", () => {
    expect(parseTimeBoundary(1787966220000, fixedNow)).toBe(1787966220000);
    expect(parseTimeBoundary("1787966220000", fixedNow)).toBe(1787966220000);
    // 10-digit seconds timestamp
    expect(parseTimeBoundary(1787966220, fixedNow)).toBe(1787966220000);
  });

  it("parses ISO and space-separated date times", () => {
    const ts = parseTimeBoundary("2026-08-29 09:17:00", fixedNow);
    expect(ts).toBeNumber();
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August (0-indexed)
    expect(d.getDate()).toBe(29);
  });

  it("parses relative natural expressions (today, yesterday, Xh ago)", () => {
    const yesterdayTs = parseTimeBoundary("yesterday 09:17", fixedNow);
    expect(yesterdayTs).toBeNumber();
    const d = new Date(yesterdayTs!);
    expect(d.getDate()).toBe(29);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(17);

    const twoHoursAgo = parseTimeBoundary("2h ago", fixedNow);
    expect(twoHoursAgo).toBe(fixedNow - 2 * 3600 * 1000);
  });

  it("resolves time range window bounds correctly", () => {
    const custom = resolveTimeRange({
      since: "2026-08-29 09:17",
      until: "2026-08-30 04:23",
      now: fixedNow,
    });
    expect(custom.isCustom).toBe(true);
    expect(custom.since).toBeNumber();
    expect(custom.until).toBeNumber();
    expect(custom.until!).toBeGreaterThan(custom.since!);
  });
});

describe("Usage Summarization and Markdown Output", () => {
  it("formats markdown report properly", () => {
    const md = formatUsageMarkdownReport({
      range: "custom",
      rangeLabel: "2026-08-29 09:17 ~ 2026-08-30 04:23",
      summary: {
        requests: 100,
        totalTokens: 50000,
        inputTokens: 45000,
        cachedInputTokens: 40000,
        outputTokens: 5000,
        estimatedCostUsd: 1.25,
      },
      models: [
        { model: "gpt-5.6-sol", provider: "openai", requests: 80, totalTokens: 40000, estimatedCostUsd: 1.10 },
        { model: "gpt-5.6-luna", provider: "openai", requests: 20, totalTokens: 10000, estimatedCostUsd: 0.15 },
      ],
    });

    const text = md.join("\n");
    expect(text).toContain("### OpenCodex Usage Report");
    expect(text).toContain("| gpt-5.6-sol | openai | 80 | 40,000 |");
    expect(text).toContain("Estimated API Cost");
  });

  it("can summarize usage from offline jsonl file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ocx-test-"));
    const tmpFile = join(tmpDir, "test-usage.jsonl");

    const sample = [
      JSON.stringify({
        requestId: "req-1",
        timestamp: 1787966300000,
        provider: "openai",
        model: "gpt-5.6-sol",
        usageStatus: "reported",
        usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800, totalTokens: 1100 },
        totalTokens: 1100,
      }),
      JSON.stringify({
        requestId: "req-2",
        timestamp: 1787966400000,
        provider: "openai",
        model: "gpt-5.6-luna",
        usageStatus: "reported",
        usage: { inputTokens: 2000, outputTokens: 200, cachedInputTokens: 1500, totalTokens: 2200 },
        totalTokens: 2200,
      }),
    ].join("\n");

    writeFileSync(tmpFile, sample, "utf-8");

    const summary = summarizeUsageFromLogFile({
      filePath: tmpFile,
      since: 1787966200000,
      until: 1787966500000,
    });

    expect(summary.summary.requests).toBe(2);
    expect(summary.summary.totalTokens).toBe(3300);
    expect(summary.models.length).toBe(2);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

