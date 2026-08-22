import { describe, expect, test } from "bun:test";

import { formatCodexLogGuardDoctor, printCodexLogGuardDoctor } from "../src/cli/codex-log-guard-doctor";
import type { CodexLogGuardInspection } from "../src/codex/log-guard/inspect";

function report(overrides: Partial<CodexLogGuardInspection> = {}): CodexLogGuardInspection {
  return {
    generatedAt: 1,
    externalSqliteHome: true,
    snapshot: "checkpointed",
    files: { databaseBytes: 10 * 1024, walBytes: 2 * 1024, shmBytes: 3 * 1024 },
    schema: { state: "compatible" },
    capabilities: {
      inspection: { state: "supported" },
      protection: { state: "supported" },
      reclaim: { state: "supported" },
    },
    metrics: {
      totalRows: 4,
      rowsByLevel: { TRACE: 2, INFO: 2 },
      traceRows: 2,
      traceShare: 0.5,
      topTargets: [{ target: "codex_api::sse", rows: 2 }],
      pageSize: 4096,
      pageCount: 3,
      freelistPages: 1,
      reclaimableBytes: 4096,
      estimatedLogBytes: 350,
    },
    ...overrides,
  };
}

describe("Codex Log Guard doctor output", () => {
  test("summarizes compatible diagnostics without inventing a write-rate threshold", () => {
    const lines = formatCodexLogGuardDoctor(report());
    const text = lines.join("\n");

    expect(lines[0]).toBe("Codex diagnostic logs");
    expect(text).toContain("schema compatible");
    expect(text).toContain("4 rows");
    expect(text).toContain("TRACE 50.0%");
    expect(text).toContain("reclaimable 4.0 KiB");
    expect(text).toContain("external sqlite_home");
    expect(text).toContain("DB 10.0 KiB");
    expect(text).toContain("WAL 2.0 KiB");
    expect(text).toContain("SHM 3.0 KiB");
    expect(text).not.toContain("high write activity");
    expect(text).not.toContain("TBW");
    expect(text).not.toContain("NAND");
  });

  test("warns that a future schema is inspect-only", () => {
    const lines = formatCodexLogGuardDoctor(report({
      schema: { state: "unsupported", reason: "unknown_schema" },
      capabilities: {
        inspection: { state: "supported" },
        protection: { state: "unsupported", reason: "unknown_schema" },
        reclaim: { state: "unsupported", reason: "unknown_schema" },
      },
    }));

    expect(lines.join("\n")).toContain("unknown schema; inspection only");
  });

  test("reports file metadata for unreadable databases", () => {
    const lines = formatCodexLogGuardDoctor(report({
      files: { databaseBytes: 1024, walBytes: 2048, shmBytes: 4096 },
      schema: { state: "unreadable", reason: "database_unreadable" },
      capabilities: {
        inspection: { state: "supported" },
        protection: { state: "unsupported", reason: "database_unreadable" },
        reclaim: { state: "unsupported", reason: "database_unreadable" },
      },
      metrics: null,
    }));
    const text = lines.join("\n");

    expect(text).toContain("logs_2.sqlite is unreadable");
    expect(text).toContain("DB 1.0 KiB");
    expect(text).toContain("WAL 2.0 KiB");
    expect(text).toContain("SHM 4.0 KiB");
  });

  test("reports a missing database as an informational absence", () => {
    const lines = formatCodexLogGuardDoctor(report({
      files: { databaseBytes: 0, walBytes: 0, shmBytes: 0 },
      schema: { state: "missing", reason: "database_missing" },
      capabilities: {
        inspection: { state: "supported" },
        protection: { state: "unsupported", reason: "database_missing" },
        reclaim: { state: "unsupported", reason: "database_missing" },
      },
      metrics: null,
    }));

    expect(lines.join("\n")).toContain("logs_2.sqlite is not present");
  });

  test("printer obtains the report through an injectable read-only inspector", () => {
    let inspections = 0;
    const lines: string[] = [];

    printCodexLogGuardDoctor({
      inspect: () => {
        inspections += 1;
        return report();
      },
      log: line => lines.push(line),
    });

    expect(inspections).toBe(1);
    expect(lines[0]).toBe("Codex diagnostic logs");
    expect(lines.join("\n")).toContain("TRACE 50.0%");
  });

  test("printer redacts path-bearing inspection failures", () => {
    const lines: string[] = [];
    printCodexLogGuardDoctor({
      inspect: () => { throw new Error("failed at /private/state/logs_2.sqlite"); },
      log: line => lines.push(line),
    });

    const text = lines.join("\n");
    expect(text).toContain("inspection unavailable");
    expect(text).not.toContain("/private/state");
    expect(text).not.toContain("failed at");
  });
});
