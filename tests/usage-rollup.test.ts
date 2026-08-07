import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../src/config";
import { recordOwnedConfigPath } from "../src/lib/config-ownership";
import { usageLogPath, type PersistedUsageEntry } from "../src/usage/log";
import {
  ensureRollupCurrent,
  readRollupSnapshot,
  resetRollupForTests,
  setFoldSegmentCapForTests,
  type RollupCommitRow,
  type RollupMeta,
} from "../src/usage/rollup";

const DAY_MS = 86_400_000;
const FIXED_NOW = Date.UTC(2026, 7, 4, 12);

let testDir = "";
let previousHome: string | undefined;
let previousTimezone: string | undefined;
let clock: ReturnType<typeof spyOn>;

function rollupPath(): string {
  return join(getConfigDir(), "usage-rollup.jsonl");
}

function metaPath(): string {
  return join(getConfigDir(), "usage-rollup-meta.json");
}

function entry(overrides: Partial<PersistedUsageEntry> & { requestId: string; timestamp: number }): PersistedUsageEntry {
  return {
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 2 },
    totalTokens: 12,
    ...overrides,
  };
}

function rawLine(value: PersistedUsageEntry): string {
  return `${JSON.stringify(value)}\n`;
}

function writeRaw(entries: PersistedUsageEntry[]): void {
  writeFileSync(usageLogPath(), entries.map(rawLine).join(""), { mode: 0o600 });
}

function readMeta(): RollupMeta {
  return JSON.parse(readFileSync(metaPath(), "utf8")) as RollupMeta;
}

function writeMeta(meta: RollupMeta): void {
  writeFileSync(metaPath(), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

function expireThrottle(): void {
  writeMeta({ ...readMeta(), lastFoldAttemptAt: 0, updatedAt: 0 });
}

function parsedRollupLines(): Array<Record<string, unknown>> {
  return readFileSync(rollupPath(), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

function commits(): RollupCommitRow[] {
  return parsedRollupLines().filter(row => row.kind === "commit") as unknown as RollupCommitRow[];
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousTimezone = process.env.TZ;
  testDir = mkdtempSync(join(tmpdir(), "ocx-rollup-"));
  process.env.OPENCODEX_HOME = testDir;
  recordOwnedConfigPath(testDir, usageLogPath());
  clock = spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  resetRollupForTests();
});

afterEach(() => {
  clock.mockRestore();
  resetRollupForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("usage rollup core", () => {
  test("1. folds day, model, provider, and key aggregates with combo and surface semantics", async () => {
    writeRaw([
      entry({
        requestId: "priced", timestamp: FIXED_NOW - 12 * DAY_MS,
        admissionKind: "configured", apiKeyId: "key-a",
        usage: { inputTokens: 100, outputTokens: 10 }, totalTokens: 110,
      }),
      entry({
        requestId: "combo", timestamp: FIXED_NOW - 11 * DAY_MS,
        surface: "claude-desktop", provider: "anthropic", model: "claude-fable-5",
        usageStatus: "estimated", usage: { inputTokens: 20, outputTokens: 3, estimated: true }, totalTokens: 23,
        attempts: [
          { ordinal: 1, provider: "anthropic", model: "claude-fable-5", adapter: "anthropic-messages", status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 20, outputTokens: 2 }, totalTokens: 22 },
          { ordinal: 2, provider: "unknown", model: "unpriced-model", adapter: "openai-chat", status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "estimated", usage: { inputTokens: 5, outputTokens: 1, estimated: true }, totalTokens: 6 },
        ],
      }),
      entry({
        requestId: "unsupported", timestamp: FIXED_NOW - 10 * DAY_MS,
        surface: "grok", provider: "xai", model: "grok-4", usageStatus: "unsupported",
        usage: undefined, totalTokens: undefined, admissionKind: "environment",
      }),
    ]);

    await ensureRollupCurrent();
    const snapshot = readRollupSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.days).toHaveLength(3);
    expect(snapshot!.models).toHaveLength(4);
    expect(snapshot!.providers).toHaveLength(4);
    expect(snapshot!.keys).toHaveLength(2);
    expect(snapshot!.days.find(row => row.surface === "codex")).toMatchObject({
      statusCounts: { reported: 1, unreported: 0, unsupported: 0, estimated: 0 },
      attemptCount: 1,
      tokens: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      pricedRequests: 1, unpricedRequests: 0, unmeteredRequests: 0,
    });
    expect(snapshot!.days.find(row => row.surface === "claude-desktop")).toMatchObject({
      statusCounts: { reported: 0, unreported: 0, unsupported: 0, estimated: 1 },
      attemptCount: 2,
      tokens: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
      pricedRequests: 0, unpricedRequests: 1, unmeteredRequests: 0,
    });
    expect(snapshot!.days.find(row => row.surface === "grok")).toMatchObject({
      statusCounts: { reported: 0, unreported: 0, unsupported: 1, estimated: 0 },
      unmeteredRequests: 1,
    });
    expect(snapshot!.models.find(row => row.model === "unpriced-model")).toMatchObject({
      surface: "claude-desktop", requests: 1, attemptCount: 1,
      foldedStatusCounts: { reported: 0, unreported: 0, unsupported: 0, estimated: 1 },
      tokens: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      estimatedCostUsd: 0,
    });
    expect(snapshot!.providers.find(row => row.provider === "anthropic")).toMatchObject({ requests: 1, attemptCount: 1, totalTokens: 22 });
    expect(snapshot!.keys.find(row => row.apiKeyId === "key-a")).toMatchObject({ requests: 1, requestsWithTimestamp: 1 });
    expect(snapshot!.attributionSinceMs).toBe(FIXED_NOW - 12 * DAY_MS);
    expect(snapshot!.oldestTimestampMs).toBe(FIXED_NOW - 12 * DAY_MS);
  });

  test("2a-b. truncated commit and abandoned rows stay invisible while a fresh attempt succeeds", async () => {
    const entries = [entry({ requestId: "a", timestamp: FIXED_NOW - 12 * DAY_MS })];
    writeRaw(entries);
    await ensureRollupCurrent();
    const firstAttempt = commits()[0]!.attemptId;
    const text = readFileSync(rollupPath(), "utf8");
    const commitStart = text.lastIndexOf('{"kind":"commit"');
    writeFileSync(rollupPath(), text.slice(0, commitStart) + text.slice(commitStart, commitStart + 24));
    expireThrottle();

    await ensureRollupCurrent();
    const snapshot = readRollupSnapshot();
    expect(snapshot?.days.reduce((sum, row) => sum + Object.values(row.statusCounts).reduce((a, b) => a + b, 0), 0)).toBe(1);
    const attempts = new Set(parsedRollupLines().filter(row => row.kind !== "commit").map(row => row.attemptId));
    expect(attempts.has(firstAttempt)).toBe(true);
    expect(attempts.size).toBe(2);
    expect(commits()).toHaveLength(1);
    expect(commits()[0]!.attemptId).not.toBe(firstAttempt);
  });

  test("2c. row-count or payload-digest mismatch rejects a segment", async () => {
    writeRaw([entry({ requestId: "bad-commit", timestamp: FIXED_NOW - 12 * DAY_MS })]);
    await ensureRollupCurrent();
    const rows = parsedRollupLines();
    const commit = rows.at(-1)!;
    const originalDigest = String(commit.payloadDigest);
    commit.payloadDigest = "0".repeat(64);
    writeFileSync(rollupPath(), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    expect(readRollupSnapshot()).toMatchObject({ cutlineOffset: 0, days: [] });
    // Restore the ORIGINAL digest (re-reading commits() here would read the
    // tampered file back and leave the digest broken, so the rowCount check
    // below would never be exercised in isolation).
    commit.payloadDigest = originalDigest;
    commit.rowCount = Number(commit.rowCount) + 1;
    writeFileSync(rollupPath(), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    expect(readRollupSnapshot()).toMatchObject({ cutlineOffset: 0, days: [] });
  });

  test("2d. missing meta makes the snapshot null and rebuilds from raw", async () => {
    writeRaw([entry({ requestId: "meta", timestamp: FIXED_NOW - 12 * DAY_MS })]);
    await ensureRollupCurrent();
    unlinkSync(metaPath());
    expect(readRollupSnapshot()).toBeNull();
    await ensureRollupCurrent();
    expect(readRollupSnapshot()).toMatchObject({ days: [expect.objectContaining({ attemptCount: 1 })] });
  });

  test("2e. append-boundary truncation repairs a partial trailing group row", async () => {
    const first = entry({ requestId: "first", timestamp: FIXED_NOW - 12 * DAY_MS });
    writeRaw([first]);
    await ensureRollupCurrent();
    const firstCutline = readRollupSnapshot()!.cutlineOffset;
    appendFileSync(rollupPath(), '{"kind":"day","seg":');
    appendFileSync(usageLogPath(), rawLine(entry({ requestId: "second", timestamp: FIXED_NOW - 11 * DAY_MS })));
    expireThrottle();

    await ensureRollupCurrent();
    const snapshot = readRollupSnapshot()!;
    expect(snapshot.cutlineOffset).toBeGreaterThan(firstCutline);
    expect(snapshot.days.reduce((sum, row) => sum + row.attemptCount, 0)).toBe(2);
    expect(readFileSync(rollupPath(), "utf8")).not.toContain('{"kind":"day","seg":{"kind"');
    expect(commits()).toHaveLength(2);
  });

  test("3. lineage mismatch returns null and refolds from offset zero", async () => {
    const rows = [entry({ requestId: "lineage", timestamp: FIXED_NOW - 12 * DAY_MS })];
    writeRaw(rows);
    await ensureRollupCurrent();
    const oldAttempt = commits()[0]!.attemptId;
    renameSync(usageLogPath(), `${usageLogPath()}.old`);
    writeRaw(rows);
    expect(readRollupSnapshot()).toBeNull();
    await ensureRollupCurrent();
    expect(commits()).toHaveLength(1);
    expect(commits()[0]!.seg).toBe(0);
    expect(commits()[0]!.attemptId).not.toBe(oldAttempt);
  });

  test("4a. price-fingerprint mismatch rebuilds the cache from zero", async () => {
    writeRaw([entry({ requestId: "price", timestamp: FIXED_NOW - 12 * DAY_MS })]);
    await ensureRollupCurrent();
    const oldAttempt = commits()[0]!.attemptId;
    writeMeta({ ...readMeta(), priceFingerprint: "stale", lastFoldAttemptAt: 0 });
    expect(readRollupSnapshot()).toBeNull();
    await ensureRollupCurrent();
    expect(commits()).toHaveLength(1);
    expect(commits()[0]).toMatchObject({ seg: 0 });
    expect(commits()[0]!.attemptId).not.toBe(oldAttempt);
  });

  test("4b. boundary-digest mismatch rebuilds the cache", async () => {
    writeRaw([entry({ requestId: "boundary-a", timestamp: FIXED_NOW - 12 * DAY_MS })]);
    await ensureRollupCurrent();
    const oldAttempt = commits()[0]!.attemptId;
    const raw = readFileSync(usageLogPath(), "utf8").replace("boundary-a", "boundary-b");
    writeFileSync(usageLogPath(), raw);
    expireThrottle();
    await ensureRollupCurrent();
    expect(commits()).toHaveLength(1);
    expect(commits()[0]!.attemptId).not.toBe(oldAttempt);
  });

  test("4c. live raw size below the committed cutline rebuilds", async () => {
    const first = entry({ requestId: "first", timestamp: FIXED_NOW - 13 * DAY_MS });
    const second = entry({ requestId: "second", timestamp: FIXED_NOW - 12 * DAY_MS });
    writeRaw([first, second]);
    await ensureRollupCurrent();
    const oldCutline = readRollupSnapshot()!.cutlineOffset;
    truncateSync(usageLogPath(), Buffer.byteLength(rawLine(first)));
    expireThrottle();
    await ensureRollupCurrent();
    expect(readRollupSnapshot()!.cutlineOffset).toBeLessThan(oldCutline);
    expect(readRollupSnapshot()!.days.reduce((sum, row) => sum + row.attemptCount, 0)).toBe(1);
  });

  test("5. cutline ends on a newline and a partial raw row remains in the tail", async () => {
    const complete = rawLine(entry({ requestId: "complete", timestamp: FIXED_NOW - 12 * DAY_MS }));
    const partial = JSON.stringify(entry({ requestId: "partial", timestamp: FIXED_NOW - 13 * DAY_MS })).slice(0, 40);
    writeFileSync(usageLogPath(), `${complete}${partial}`);
    await ensureRollupCurrent();
    const snapshot = readRollupSnapshot()!;
    expect(snapshot.cutlineOffset).toBe(Buffer.byteLength(complete));
    expect(readFileSync(usageLogPath()).subarray(snapshot.cutlineOffset).toString()).toBe(partial);
  });

  test("6. the nine-local-day watermark is timezone-aware and stops at the first young row", async () => {
    process.env.TZ = "America/New_York";
    const localNow = new Date(2026, 7, 4, 0, 30).getTime();
    clock.mockReturnValue(localNow);
    const old = entry({ requestId: "old", timestamp: new Date(2026, 6, 25, 23, 30).getTime() });
    const boundaryDay = entry({ requestId: "boundary", timestamp: new Date(2026, 6, 26, 0, 1).getTime() });
    const outOfOrderOld = entry({ requestId: "old-after-boundary", timestamp: new Date(2026, 6, 24, 12).getTime() });
    writeRaw([old, boundaryDay, outOfOrderOld]);

    await ensureRollupCurrent();
    const snapshot = readRollupSnapshot()!;
    expect(snapshot.cutlineOffset).toBe(Buffer.byteLength(rawLine(old)));
    expect(snapshot.days.reduce((sum, row) => sum + row.attemptCount, 0)).toBe(1);
    expect(readFileSync(usageLogPath(), "utf8").slice(snapshot.cutlineOffset)).toContain("old-after-boundary");
  });

  test("7. a complete malformed row does not stall the cutline; the fold advances past it", async () => {
    const before = entry({ requestId: "before-junk", timestamp: FIXED_NOW - 12 * DAY_MS });
    const after = entry({ requestId: "after-junk", timestamp: FIXED_NOW - 11 * DAY_MS });
    writeFileSync(usageLogPath(), `${rawLine(before)}{not json}\n${rawLine(after)}`, { mode: 0o600 });

    await ensureRollupCurrent();
    const snapshot = readRollupSnapshot()!;
    // The cutline covers all three complete rows (junk skipped like the parser does).
    expect(snapshot.cutlineOffset).toBe(statSync(usageLogPath()).size);
    expect(snapshot.days.reduce((sum, row) => sum + row.attemptCount, 0)).toBe(2);
  });

  test("7b. a recent object row without a requestId cannot stall the cutline either", async () => {
    const old = entry({ requestId: "old-real", timestamp: FIXED_NOW - 12 * DAY_MS });
    const noId = `{"timestamp":${FIXED_NOW - DAY_MS},"provider":"openai"}\n`;
    const oldAfter = entry({ requestId: "old-after", timestamp: FIXED_NOW - 11 * DAY_MS });
    writeFileSync(usageLogPath(), `${rawLine(old)}${noId}${rawLine(oldAfter)}`, { mode: 0o600 });

    await ensureRollupCurrent();
    const snapshot = readRollupSnapshot()!;
    // parseUsageRange requires a string requestId, so the id-less row can never
    // contribute usage — the cutline advances past it instead of stalling.
    expect(snapshot.cutlineOffset).toBe(statSync(usageLogPath()).size);
    expect(snapshot.days.reduce((sum, row) => sum + row.attemptCount, 0)).toBe(2);
  });

  test("9b. a same-size rewrite of an EARLIER folded segment invalidates the snapshot at read time", async () => {
    setFoldSegmentCapForTests(1); // one row per segment → multiple segments
    try {
      const first = entry({ requestId: "seg-one", timestamp: FIXED_NOW - 14 * DAY_MS });
      const second = entry({ requestId: "seg-two", timestamp: FIXED_NOW - 12 * DAY_MS });
      writeRaw([first, second]);
      await ensureRollupCurrent();
      expect(commits().length).toBeGreaterThanOrEqual(2);
      expect(readRollupSnapshot()).not.toBeNull();

      // Rewrite ONLY the first row, same byte length, leaving the final
      // segment's bytes (and its boundary tail) untouched.
      const tampered = entry({ requestId: "seg-0ne", timestamp: FIXED_NOW - 14 * DAY_MS });
      expect(rawLine(tampered).length).toBe(rawLine(first).length);
      writeFileSync(usageLogPath(), `${rawLine(tampered)}${rawLine(second)}`, { mode: 0o600 });
      expect(readRollupSnapshot()).toBeNull();
    } finally {
      setFoldSegmentCapForTests(null);
    }
  });

  test("8. the fold catches up a backlog in bounded segments, one commit per segment", async () => {
    setFoldSegmentCapForTests(1); // every row closes a segment
    try {
      const entries = [
        entry({ requestId: "seg-a", timestamp: FIXED_NOW - 14 * DAY_MS }),
        entry({ requestId: "seg-b", timestamp: FIXED_NOW - 13 * DAY_MS }),
        entry({ requestId: "seg-c", timestamp: FIXED_NOW - 12 * DAY_MS }),
      ];
      writeRaw(entries);
      await ensureRollupCurrent();
      expect(commits()).toHaveLength(3);
      const snapshot = readRollupSnapshot()!;
      expect(snapshot.cutlineOffset).toBe(statSync(usageLogPath()).size);
      expect(snapshot.days.reduce((sum, row) => sum + row.attemptCount, 0)).toBe(3);
      // Segments chain: each commit's seg is the previous commit's toOffset.
      const chain = commits();
      for (let i = 1; i < chain.length; i++) expect(chain[i]!.seg).toBe(chain[i - 1]!.toOffset);
    } finally {
      setFoldSegmentCapForTests(null);
    }
  });

  test("9. a truncated-then-regrown raw log invalidates the snapshot at read time, before any fold", async () => {
    const old = entry({ requestId: "will-vanish", timestamp: FIXED_NOW - 12 * DAY_MS });
    writeRaw([old]);
    await ensureRollupCurrent();
    expect(readRollupSnapshot()).not.toBeNull();

    // Rewrite the raw file to the SAME length with different bytes (regrow after
    // truncation) without touching meta or the throttle: a reader must notice.
    const replacement = entry({ requestId: "will-van1sh", timestamp: FIXED_NOW - 12 * DAY_MS });
    writeFileSync(usageLogPath(), rawLine(replacement), { mode: 0o600 });
    expect(readRollupSnapshot()).toBeNull();
  });

  test("rollup files are owned config state and mode 0600 on POSIX", async () => {
    writeRaw([entry({ requestId: "mode", timestamp: FIXED_NOW - 12 * DAY_MS })]);
    await ensureRollupCurrent();
    const manifest = JSON.parse(readFileSync(join(getConfigDir(), ".opencodex-uninstall.json"), "utf8")) as { paths: string[] };
    expect(manifest.paths).toContain("usage-rollup.jsonl");
    expect(manifest.paths).toContain("usage-rollup-meta.json");
    if (process.platform !== "win32") {
      expect(statSync(rollupPath()).mode & 0o777).toBe(0o600);
      expect(statSync(metaPath()).mode & 0o777).toBe(0o600);
    }
  });
});
