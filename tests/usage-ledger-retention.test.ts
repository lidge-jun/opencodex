import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import {
  compactUsageLedgerToMaxBytes,
  discardHistoryIndex,
  MIN_USAGE_LEDGER_MAX_BYTES,
  normalizeUsageLedgerRetention,
  usageLedgerPath,
} from "../src/usage/ledger-retention";
import { HISTORY_DB_FILENAME } from "../src/routing/history/schema";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-ledger-ret-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function writeLines(path: string, lines: string[]): void {
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""), { encoding: "utf-8", mode: 0o600 });
}

describe("normalizeUsageLedgerRetention", () => {
  test("stays disabled unless enabled is exactly true", () => {
    expect(normalizeUsageLedgerRetention(undefined).enabled).toBe(false);
    expect(normalizeUsageLedgerRetention({ enabled: 1 }).enabled).toBe(false);
    expect(normalizeUsageLedgerRetention({ enabled: "true" }).enabled).toBe(false);
    expect(normalizeUsageLedgerRetention({ enabled: true }).enabled).toBe(true);
  });

  test("clamps maxBytes to the 1 MiB floor", () => {
    expect(normalizeUsageLedgerRetention({ enabled: true, maxBytes: 12 }).maxBytes).toBe(MIN_USAGE_LEDGER_MAX_BYTES);
    expect(normalizeUsageLedgerRetention({ enabled: true, maxBytes: 8 * 1024 * 1024 }).maxBytes).toBe(8 * 1024 * 1024);
  });
});

describe("compactUsageLedgerToMaxBytes", () => {
  test("no-ops when the ledger is missing or already under the ceiling", () => {
    const path = usageLedgerPath(testDir);
    expect(compactUsageLedgerToMaxBytes(path, 1024).skipped).toBe("missing");
    writeLines(path, ['{"requestId":"a"}']);
    const under = compactUsageLedgerToMaxBytes(path, 1024);
    expect(under.skipped).toBe("under_limit");
    expect(readFileSync(path, "utf-8")).toContain('"a"');
  });

  test("keeps the newest complete JSONL rows", () => {
    const path = usageLedgerPath(testDir);
    const old = `{"id":"old","pad":"${"x".repeat(200)}"}`;
    const mid = `{"id":"mid","pad":"${"y".repeat(200)}"}`;
    const newest = `{"id":"new","pad":"${"z".repeat(200)}"}`;
    writeLines(path, [old, mid, newest]);
    const before = statSync(path).size;
    const twoNewest = Buffer.byteLength(`${mid}\n${newest}\n`, "utf-8");
    // Land the cut inside the oldest row so the first kept newline is the row boundary.
    const result = compactUsageLedgerToMaxBytes(path, twoNewest + 10);
    expect(result.skipped).toBeUndefined();
    expect(result.beforeBytes).toBe(before);
    expect(result.afterBytes).toBeLessThan(before);
    const kept = readFileSync(path, "utf-8");
    expect(kept).toContain('"id":"new"');
    expect(kept).not.toContain('"id":"old"');
  });
});

describe("discardHistoryIndex", () => {
  test("deletes the sqlite projection and wal companions", () => {
    mkdirSync(testDir, { recursive: true });
    const db = join(testDir, HISTORY_DB_FILENAME);
    writeFileSync(db, "sqlite");
    writeFileSync(`${db}-wal`, "wal");
    writeFileSync(`${db}-shm`, "shm");
    discardHistoryIndex(testDir);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
  });
});
