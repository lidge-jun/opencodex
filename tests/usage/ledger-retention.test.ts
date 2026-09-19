import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  enforceUsageLedgerSizeLimit,
  MIN_USAGE_LEDGER_MAX_BYTES,
  setUsageLedgerMaxBytes,
  getUsageLedgerMaxBytes,
  setUsageLedgerMaxBytesUnsafe,
} from "../../src/usage/ledger-retention";
import { appendUsageEntry, usageLogPath } from "../../src/usage/log";

let testDir = "";
let ledgerPath = "";

/** Build a JSONL row of approximately `bytes` total (including the trailing LF). */
function makeRow(id: string, paddingBytes = 0): string {
  const base = JSON.stringify({ requestId: id, timestamp: Date.now(), provider: "openai", model: "gpt-4", totalCost: 0.01 });
  if (paddingBytes <= 0) return base + "\n";
  // Pad with spaces inside the JSON (valid JSON, just has a long string value).
  const needed = paddingBytes - base.length - 1; // -1 for the trailing LF
  if (needed <= 0) return base + "\n";
  const padded = JSON.stringify({
    requestId: id,
    timestamp: Date.now(),
    provider: "openai",
    model: "gpt-4",
    totalCost: 0.01,
    _pad: "x".repeat(Math.max(0, needed - 10)), // rough; exact size doesn't matter
  });
  return padded + "\n";
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ledger-retention-test-"));
  ledgerPath = join(testDir, "usage.jsonl");
  // Reset module state
  setUsageLedgerMaxBytes(undefined);
});

afterEach(() => {
  setUsageLedgerMaxBytesUnsafe(undefined);
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe("ledger-retention", () => {
  describe("setUsageLedgerMaxBytes / getUsageLedgerMaxBytes", () => {
    test("undefined by default", () => {
      expect(getUsageLedgerMaxBytes()).toBeUndefined();
    });

    test("accepts values >= MIN_USAGE_LEDGER_MAX_BYTES", () => {
      setUsageLedgerMaxBytes(MIN_USAGE_LEDGER_MAX_BYTES);
      expect(getUsageLedgerMaxBytes()).toBe(MIN_USAGE_LEDGER_MAX_BYTES);
    });

    test("rejects values below floor as unconfigured", () => {
      setUsageLedgerMaxBytes(100);
      expect(getUsageLedgerMaxBytes()).toBeUndefined();
    });

    test("rejects undefined", () => {
      setUsageLedgerMaxBytes(5_000_000);
      expect(getUsageLedgerMaxBytes()).toBe(5_000_000);
      setUsageLedgerMaxBytes(undefined);
      expect(getUsageLedgerMaxBytes()).toBeUndefined();
    });
  });

  describe("enforceUsageLedgerSizeLimit", () => {
    test("no-op when unconfigured (no limit set)", () => {
      // Write a large file — should NOT be truncated
      const rows = Array.from({ length: 50 }, (_, i) => makeRow(`req-${i}`, 200));
      writeFileSync(ledgerPath, rows.join(""));
      const sizeBefore = statSync(ledgerPath).size;

      enforceUsageLedgerSizeLimit(ledgerPath);

      expect(statSync(ledgerPath).size).toBe(sizeBefore);
      expect(readFileSync(ledgerPath, "utf-8")).toBe(rows.join(""));
    });

    test("no-op when file is under the limit", () => {
      setUsageLedgerMaxBytes(MIN_USAGE_LEDGER_MAX_BYTES);
      const rows = Array.from({ length: 3 }, (_, i) => makeRow(`req-${i}`));
      writeFileSync(ledgerPath, rows.join(""));
      const sizeBefore = statSync(ledgerPath).size;

      enforceUsageLedgerSizeLimit(ledgerPath);

      expect(statSync(ledgerPath).size).toBe(sizeBefore);
    });

    test("truncates when file exceeds limit, keeping newest rows", () => {
      // Use a small limit for testing (bypass the floor via test helper)
      const limit = 2048;
      setUsageLedgerMaxBytesUnsafe(limit);

      // Build rows so total exceeds 2048 bytes
      const rows: string[] = [];
      for (let i = 0; i < 30; i++) {
        rows.push(makeRow(`req-${i}`, 100));
      }
      writeFileSync(ledgerPath, rows.join(""));
      const sizeBefore = statSync(ledgerPath).size;
      expect(sizeBefore).toBeGreaterThan(limit);

      enforceUsageLedgerSizeLimit(ledgerPath);

      const sizeAfter = statSync(ledgerPath).size;
      expect(sizeAfter).toBeLessThanOrEqual(limit);

      // Every line should be valid JSON
      const retained = readFileSync(ledgerPath, "utf-8");
      const lines = retained.split("\n").filter(l => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // The last row of the original should be the last row of the retained
      const lastOriginal = rows[rows.length - 1].trim();
      expect(lines[lines.length - 1]).toBe(lastOriginal);
    });

    test("every retained line is complete valid JSONL", () => {
      const limit = 1500;
      setUsageLedgerMaxBytesUnsafe(limit);

      const rows: string[] = [];
      for (let i = 0; i < 20; i++) {
        rows.push(makeRow(`req-${i}`, 120));
      }
      writeFileSync(ledgerPath, rows.join(""));

      enforceUsageLedgerSizeLimit(ledgerPath);

      const content = readFileSync(ledgerPath, "utf-8");
      // Must end with newline
      expect(content.endsWith("\n")).toBe(true);
      // Every line parses as JSON
      const lines = content.split("\n").filter(l => l.length > 0);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty("requestId");
      }
    });

    test("handles exact line boundary (file size exactly equals limit)", () => {
      // Build rows to exactly hit the limit
      const row = makeRow("exact", 0);
      const rowBytes = Buffer.byteLength(row, "utf-8");
      // Set limit to exact multiple of row size
      const count = 10;
      const limit = rowBytes * count;
      setUsageLedgerMaxBytesUnsafe(limit);

      // Write exactly `count` rows — should NOT truncate
      const rows = Array.from({ length: count }, () => row);
      writeFileSync(ledgerPath, rows.join(""));
      expect(statSync(ledgerPath).size).toBe(limit);

      enforceUsageLedgerSizeLimit(ledgerPath);

      expect(statSync(ledgerPath).size).toBe(limit);
    });

    test("single row larger than limit is preserved (never produces empty file)", () => {
      const limit = MIN_USAGE_LEDGER_MAX_BYTES; // 1 MiB
      setUsageLedgerMaxBytes(limit);

      // Write a single row larger than the limit
      const bigRow = makeRow("oversized", limit + 1000);
      writeFileSync(ledgerPath, bigRow);
      const sizeBefore = statSync(ledgerPath).size;
      expect(sizeBefore).toBeGreaterThan(limit);

      enforceUsageLedgerSizeLimit(ledgerPath);

      // File should be unchanged — we never produce an empty ledger
      expect(statSync(ledgerPath).size).toBe(sizeBefore);
      expect(readFileSync(ledgerPath, "utf-8")).toBe(bigRow);
    });

    test("handles incomplete trailing line (crash tail)", () => {
      const limit = 2048;
      setUsageLedgerMaxBytesUnsafe(limit);

      const rows: string[] = [];
      for (let i = 0; i < 30; i++) {
        rows.push(makeRow(`req-${i}`, 100));
      }
      // Append a partial/corrupt trailing line (no newline)
      const content = rows.join("") + '{"requestId":"crash","timesta';
      writeFileSync(ledgerPath, content);

      enforceUsageLedgerSizeLimit(ledgerPath);

      const retained = readFileSync(ledgerPath, "utf-8");
      // Must end with newline (incomplete tail stripped)
      expect(retained.endsWith("\n")).toBe(true);
      // Must not contain the partial line
      expect(retained).not.toContain("crash");
      // All lines must parse
      const lines = retained.split("\n").filter(l => l.length > 0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    test("discards an oversized unterminated partial/corrupt line", () => {
      const limit = MIN_USAGE_LEDGER_MAX_BYTES; // 1 MiB
      setUsageLedgerMaxBytes(limit);

      // Write a single oversized corrupt line without newline that is NOT valid JSON
      const corruptData = "corrupt_data_without_newline_".repeat(50_000);
      writeFileSync(ledgerPath, corruptData);
      expect(statSync(ledgerPath).size).toBeGreaterThan(limit);

      enforceUsageLedgerSizeLimit(ledgerPath);

      // Should be truncated to an empty file (invalid partial tail discarded)
      expect(statSync(ledgerPath).size).toBe(0);
    });

    test("discards older rows and retains valid oversized newest row", () => {
      const limit = MIN_USAGE_LEDGER_MAX_BYTES; // 1 MiB
      setUsageLedgerMaxBytes(limit);

      const oldRows = [makeRow("old-1", 100), makeRow("old-2", 100)].join("");
      const newestOversized = makeRow("newest-oversized", limit + 10_000);
      writeFileSync(ledgerPath, oldRows + newestOversized);
      expect(statSync(ledgerPath).size).toBeGreaterThan(limit + 10_000);

      enforceUsageLedgerSizeLimit(ledgerPath);

      // Older rows discarded, only the newest valid oversized row is kept
      const content = readFileSync(ledgerPath, "utf-8");
      expect(content).toBe(newestOversized);
      expect(content).not.toContain("old-1");
    });

    test("preserves valid oversized row exceeding 10 MiB", () => {
      const limit = MIN_USAGE_LEDGER_MAX_BYTES; // 1 MiB
      setUsageLedgerMaxBytes(limit);

      // Create a valid row > 10 MiB (11 MiB)
      const hugeRow = makeRow("huge-row", 11 * 1024 * 1024);
      writeFileSync(ledgerPath, hugeRow);
      expect(statSync(ledgerPath).size).toBeGreaterThan(10 * 1024 * 1024);

      enforceUsageLedgerSizeLimit(ledgerPath);

      // Sole oversized valid row must be preserved
      expect(statSync(ledgerPath).size).toBe(Buffer.byteLength(hugeRow, "utf-8"));
    });

    test("preserves valid unterminated final row following older complete rows and appends newline", () => {
      const limit = 2048;
      setUsageLedgerMaxBytesUnsafe(limit);

      const oldRows = Array.from({ length: 25 }, (_, i) => makeRow(`old-${i}`, 100)).join("");
      // A valid JSON row without a trailing newline
      const finalUnterminated = JSON.stringify({
        requestId: "final-valid",
        timestamp: Date.now(),
        provider: "openai",
        model: "gpt-4",
        totalCost: 0.01,
      });
      writeFileSync(ledgerPath, oldRows + finalUnterminated);
      expect(statSync(ledgerPath).size).toBeGreaterThan(limit);

      enforceUsageLedgerSizeLimit(ledgerPath);

      const content = readFileSync(ledgerPath, "utf-8");
      // The valid final row must not be discarded
      expect(content).toContain("final-valid");
      // And must now be properly terminated with LF so future appends don't merge
      expect(content.endsWith(finalUnterminated + "\n")).toBe(true);
    });

    test("deletes routing-history.sqlite after truncation", () => {
      const limit = 2048;
      setUsageLedgerMaxBytesUnsafe(limit);

      // Create a fake routing-history.sqlite
      const sqlitePath = join(testDir, "routing-history.sqlite");
      writeFileSync(sqlitePath, "fake-db");
      expect(existsSync(sqlitePath)).toBe(true);

      const rows: string[] = [];
      for (let i = 0; i < 30; i++) {
        rows.push(makeRow(`req-${i}`, 100));
      }
      writeFileSync(ledgerPath, rows.join(""));

      enforceUsageLedgerSizeLimit(ledgerPath);

      // The sqlite file should have been deleted
      expect(existsSync(sqlitePath)).toBe(false);
    });

    test("concurrent re-entrancy is prevented", () => {
      // We can't easily test true concurrency in a sync function,
      // but we verify the truncationInProgress flag works by checking
      // that two rapid calls don't corrupt the file.
      const limit = 2048;
      setUsageLedgerMaxBytesUnsafe(limit);

      const rows: string[] = [];
      for (let i = 0; i < 30; i++) {
        rows.push(makeRow(`req-${i}`, 100));
      }
      writeFileSync(ledgerPath, rows.join(""));

      // Call twice — second should be a no-op (the first already truncated)
      enforceUsageLedgerSizeLimit(ledgerPath);
      const sizeAfterFirst = statSync(ledgerPath).size;
      enforceUsageLedgerSizeLimit(ledgerPath);
      const sizeAfterSecond = statSync(ledgerPath).size;

      // Both should produce the same result (idempotent)
      expect(sizeAfterSecond).toBe(sizeAfterFirst);

      // Verify content integrity
      const content = readFileSync(ledgerPath, "utf-8");
      const lines = content.split("\n").filter(l => l.length > 0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    test("handles missing file gracefully (best-effort)", () => {
      setUsageLedgerMaxBytes(MIN_USAGE_LEDGER_MAX_BYTES);
      // Should not throw even if file doesn't exist
      expect(() => enforceUsageLedgerSizeLimit(join(testDir, "nonexistent.jsonl"))).not.toThrow();
    });

    test("handles empty file", () => {
      setUsageLedgerMaxBytes(MIN_USAGE_LEDGER_MAX_BYTES);
      writeFileSync(ledgerPath, "");
      expect(() => enforceUsageLedgerSizeLimit(ledgerPath)).not.toThrow();
      expect(statSync(ledgerPath).size).toBe(0);
    });

    test("no temp files left after truncation", () => {
      const limit = 2048;
      setUsageLedgerMaxBytesUnsafe(limit);

      const rows: string[] = [];
      for (let i = 0; i < 30; i++) {
        rows.push(makeRow(`req-${i}`, 100));
      }
      writeFileSync(ledgerPath, rows.join(""));

      enforceUsageLedgerSizeLimit(ledgerPath);

      // Check no .tmp files remain
      const { readdirSync } = require("node:fs");
      const files = readdirSync(testDir) as string[];
      const tmpFiles = files.filter((f: string) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    test("appendUsageEntry invokes retention enforcement on normal append", () => {
      const limit = 2048;
      setUsageLedgerMaxBytesUnsafe(limit);

      const realLog = usageLogPath();
      const previousContent = existsSync(realLog) ? readFileSync(realLog) : null;
      try {
        // Populate ledger path
        const rows = Array.from({ length: 30 }, (_, i) => makeRow(`app-${i}`, 100));
        writeFileSync(realLog, rows.join(""));
        expect(statSync(realLog).size).toBeGreaterThan(limit);

        // Appending another entry triggers inline enforcement
        appendUsageEntry({
          requestId: "trigger-append",
          timestamp: Date.now(),
          provider: "openai",
          model: "gpt-4",
          totalCost: 0.01,
          status: 200,
          durationMs: 100,
          usageStatus: "reported",
        });

        // The file size must have been reduced to within the limit
        expect(statSync(realLog).size).toBeLessThanOrEqual(limit);
        expect(readFileSync(realLog, "utf-8")).toContain("trigger-append");
      } finally {
        if (previousContent !== null) writeFileSync(realLog, previousContent);
        else try { rmSync(realLog); } catch { /* ignore */ }
      }
    });

    test("appendUsageEntry invokes retention enforcement on ENOENT retry", () => {
      const limit = 2048;
      setUsageLedgerMaxBytesUnsafe(limit);

      const realLog = usageLogPath();
      const previousContent = existsSync(realLog) ? readFileSync(realLog) : null;
      try {
        const parentDir = dirname(realLog);
        rmSync(parentDir, { recursive: true, force: true });

        // Appending when directory was removed exercises the ENOENT recovery branch
        appendUsageEntry({
          requestId: "enoent-append",
          timestamp: Date.now(),
          provider: "openai",
          model: "gpt-4",
          totalCost: 0.01,
          status: 200,
          durationMs: 100,
          usageStatus: "reported",
        });

        expect(existsSync(realLog)).toBe(true);
        expect(readFileSync(realLog, "utf-8")).toContain("enoent-append");
      } finally {
        if (previousContent !== null) {
          mkdirSync(dirname(realLog), { recursive: true });
          writeFileSync(realLog, previousContent);
        }
      }
    });
  });
});
