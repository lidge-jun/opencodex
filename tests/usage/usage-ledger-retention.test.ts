import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { enforceUsageLedgerSizeLimit } from "../../src/usage/ledger-retention";
import {
  MIN_USAGE_LEDGER_MAX_BYTES,
  USAGE_LEDGER_RETENTION_TARGET_RATIO,
} from "../../src/usage/retention-contract";
import { usageLogPath } from "../../src/usage/log";

let home: string;
let previousHome: string | undefined;

/** Rows of a known size, each carrying a field no normalizer in this build knows about. */
function writeRows(count: number, padding: number): string[] {
  const path = usageLogPath();
  mkdirSync(dirname(path), { recursive: true });
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
    requestId: `req-${index}`,
    aFieldThisBuildDoesNotKnow: "x".repeat(padding),
  }));
  writeFileSync(path, lines.map(line => `${line}\n`).join(""), { encoding: "utf-8", mode: 0o600 });
  return lines;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-ledger-retention-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("usage ledger retention", () => {
  test("no limit, a limit below the floor, and a ledger under the limit leave the file alone", () => {
    writeRows(20, 64);
    const before = readFileSync(usageLogPath(), "utf-8");
    expect(enforceUsageLedgerSizeLimit(undefined).kind).toBe("disabled");
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES - 1).kind).toBe("disabled");
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("unchanged");
    expect(readFileSync(usageLogPath(), "utf-8")).toBe(before);
  });

  test("it keeps the newest whole rows, byte for byte, including fields it does not understand", () => {
    const lines = writeRows(200, 16 * 1024);
    const originalBytes = statSync(usageLogPath()).size;
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");

    const after = readFileSync(usageLogPath(), "utf-8");
    const retained = after.split("\n").filter(line => line !== "");
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(lines.length);
    // Identical to the tail they came from: rows are copied, never parsed and rewritten, which
    // is what keeps a field this build has never heard of intact through a compaction.
    expect(retained).toEqual(lines.slice(lines.length - retained.length));
    expect(after).toContain("aFieldThisBuildDoesNotKnow");
    expect(after.endsWith("\n")).toBe(true);
    const size = statSync(usageLogPath()).size;
    expect(size).toBeLessThan(originalBytes);
    expect(size).toBeLessThanOrEqual(
      Math.floor(MIN_USAGE_LEDGER_MAX_BYTES * USAGE_LEDGER_RETENTION_TARGET_RATIO),
    );
  });

  test("an unterminated final row is carried as-is and never promoted", () => {
    writeRows(200, 16 * 1024);
    const torn = JSON.stringify({ requestId: "torn" }).slice(0, 12);
    appendFileSync(usageLogPath(), torn);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const lines = readFileSync(usageLogPath(), "utf-8").split("\n");
    // No LF was invented to make it committed: the scanner's definition is unchanged here.
    expect(lines.at(-1)).toBe(torn);
    for (const line of lines.slice(0, -1)) {
      if (line !== "") expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  test("one row larger than the whole target defers instead of emptying the ledger", () => {
    writeRows(1, MIN_USAGE_LEDGER_MAX_BYTES * 2);
    const before = readFileSync(usageLogPath(), "utf-8");
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES);
    expect(result.kind).toBe("deferred");
    expect(result).toMatchObject({ reason: "no-boundary" });
    expect(readFileSync(usageLogPath(), "utf-8")).toBe(before);
  });

  test("a row appended while the retained span is copied aborts the replacement", () => {
    const lines = writeRows(200, 16 * 1024);
    const raced = JSON.stringify({ requestId: "appended-during-copy" });
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES, {
      onSpanCopied: () => appendFileSync(usageLogPath(), `${raced}\n`),
    });

    // This is the defect the revision contract exists to close. #5063 captured a size, copied a
    // suffix and renamed over whatever was there, so this row was silently lost.
    expect(result.kind).toBe("deferred");
    expect(result).toMatchObject({ reason: "revision-changed" });
    const after = readFileSync(usageLogPath(), "utf-8");
    expect(after).toContain("appended-during-copy");
    // Nothing was trimmed either: the original file is exactly as it was, plus the new row.
    expect(after.split("\n").filter(line => line !== "").length).toBe(lines.length + 1);
  });

  test("a replacement after copying is preserved with the source handle already closed", () => {
    writeRows(200, 16 * 1024);
    const path = usageLogPath();
    const before = readFileSync(path, "utf8");
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES, {
      onSpanCopied: () => {
        // Also exercises Windows, where our own open reader would deny this rename.
        renameSync(path, `${path}.previous`);
        writeFileSync(path, before);
      },
    });
    expect(result).toMatchObject({ kind: "deferred", reason: "revision-changed" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("the published file keeps owner-only permissions", () => {
    if (process.platform === "win32") return;
    writeRows(200, 16 * 1024);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    expect(statSync(usageLogPath()).mode & 0o777).toBe(0o600);
  });
});
