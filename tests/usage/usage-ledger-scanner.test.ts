import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanUsageLedgerCooperatively,
  USAGE_LEDGER_BOUNDARY_DIGEST_BYTES,
  USAGE_LEDGER_MAX_LINE_BYTES,
  UsageLedgerRebuildRequiredError,
} from "../../src/usage/ledger-scanner";
import { usageLogIdentityKey, usageLogPath, type PersistedUsageEntry } from "../../src/usage/log";
import { discardRequestHistoryProjection } from "../../src/routing/history/discard-index";
import { historyIndexPath } from "../../src/routing/history/schema";
import {
  DEFAULT_USAGE_LEDGER_MAX_BYTES,
  MIN_USAGE_LEDGER_MAX_BYTES,
  normalizeUsageLedgerRetention,
  prepareUsageLedgerCompaction,
  usageLedgerRevisionMatches,
} from "../../src/usage/ledger-retention";
import { parseUsageLedgerRetentionInput } from "../../src/usage/ledger-retention-config";
import {
  commitPreparedUsageLedgerCompaction,
  getUsageLedgerRetentionJobState,
  invalidateUsageLedgerRetentionRun,
  requestUsageLedgerRetentionRun,
  resetUsageLedgerRetentionJobForTests,
} from "../../src/usage/ledger-retention-job";
import { getConfigPath, getDefaultConfig, saveConfig } from "../../src/config";

let testDir = "";
let previousHome: string | undefined;

function entry(requestId: string, overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId,
    timestamp: 1,
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 1, outputTokens: 1 },
    totalTokens: 2,
    ...overrides,
  };
}

function line(requestId: string, overrides: Partial<PersistedUsageEntry> = {}): string {
  return `${JSON.stringify(entry(requestId, overrides))}\n`;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-ledger-scan-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("usage ledger cooperative scanner", () => {
  test("a missing ledger is a complete empty snapshot", async () => {
    const entries: PersistedUsageEntry[] = [];
    const result = await scanUsageLedgerCooperatively({ onEntry: value => entries.push(value) });

    expect(result).toMatchObject({
      revision: null,
      parsedRows: 0,
      invalidRows: 0,
      oversizedRows: 0,
      bytesRead: 0,
      processedThroughBytes: 0,
    });
    expect(result.processedThroughDigest).toHaveLength(64);
    expect(entries).toEqual([]);
  });

  test("frames UTF-8 and CRLF rows before decoding even at one-byte read boundaries", async () => {
    const contents = [
      JSON.stringify(entry("요청-🙂", { provider: "공급자", model: "모델-한글" })),
      JSON.stringify(entry("request-two", { provider: "anthropic", model: "claude-fable-5" })),
    ].join("\r\n") + "\r\n";
    writeFileSync(usageLogPath(), contents);

    const entries: PersistedUsageEntry[] = [];
    const result = await scanUsageLedgerCooperatively({
      chunkBytes: 1,
      onEntry: value => entries.push(value),
    });

    expect(entries.map(value => [value.requestId, value.provider, value.model])).toEqual([
      ["요청-🙂", "공급자", "모델-한글"],
      ["request-two", "anthropic", "claude-fable-5"],
    ]);
    expect(result).toMatchObject({
      parsedRows: 2,
      invalidRows: 0,
      oversizedRows: 0,
      bytesRead: Buffer.byteLength(contents),
    });
    expect(result.revision?.size).toBe(Buffer.byteLength(contents));
    expect(result.processedThroughBytes).toBe(Buffer.byteLength(contents));
  });

  test("the checkpoint digest tracks the last 64 KiB after the rolling window wraps", async () => {
    const contents = Array.from({ length: 1_000 }, (_, index) => line(`digest-${index}`)).join("");
    const bytes = Buffer.from(contents);
    expect(bytes.byteLength).toBeGreaterThan(USAGE_LEDGER_BOUNDARY_DIGEST_BYTES);
    writeFileSync(usageLogPath(), bytes);

    const result = await scanUsageLedgerCooperatively({ onEntry: () => {} });
    const expected = createHash("sha256")
      .update(bytes.subarray(bytes.byteLength - USAGE_LEDGER_BOUNDARY_DIGEST_BYTES))
      .digest("hex");

    expect(result.processedThroughDigest).toBe(expected);
  });

  test("yields while scanning a large ledger and visits every row once", async () => {
    const rows = Array.from({ length: 2_100 }, (_, index) => line(`row-${index}`));
    writeFileSync(usageLogPath(), rows.join(""));
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    let totalTokens = 0;

    const result = await scanUsageLedgerCooperatively({
      chunkBytes: 128,
      onEntry: value => { totalTokens += value.totalTokens ?? 0; },
    });

    expect(timerRan).toBe(true);
    expect(result.parsedRows).toBe(2_100);
    expect(result.invalidRows).toBe(0);
    expect(totalTokens).toBe(4_200);
  });

  test("skips malformed, invalid UTF-8, oversized, and torn final rows with bounded recovery", async () => {
    const exactlyAtLimit = Buffer.concat([
      Buffer.alloc(USAGE_LEDGER_MAX_LINE_BYTES, 0x20),
      Buffer.from("\n"),
    ]);
    const oversized = Buffer.from(`${"x".repeat(USAGE_LEDGER_MAX_LINE_BYTES + 1)}\n`);
    const torn = Buffer.from(JSON.stringify(entry("valid-json-without-lf")));
    const contents = Buffer.concat([
      Buffer.from(line("valid")),
      Buffer.from("{not-json}\n"),
      Buffer.from(`${JSON.stringify({ requestId: "missing-provider" })}\n`),
      Buffer.from([0xff, 0x0a]),
      Buffer.from("\r\n"),
      exactlyAtLimit,
      oversized,
      Buffer.from(line("after-oversized")),
      torn,
    ]);
    writeFileSync(usageLogPath(), contents);
    const ids: string[] = [];

    const result = await scanUsageLedgerCooperatively({
      onEntry: value => ids.push(value.requestId),
    });

    expect(ids).toEqual(["valid", "after-oversized"]);
    expect(result).toMatchObject({
      parsedRows: 2,
      invalidRows: 4,
      oversizedRows: 1,
      bytesRead: contents.byteLength,
      processedThroughBytes: contents.byteLength - torn.byteLength,
    });
  });

  test("the line ceiling leaves headroom for an extreme writer-shaped attempt row", async () => {
    const attempts = Array.from({ length: 1_000 }, (_, index) => ({
      ordinal: index + 1,
      provider: "openai",
      model: "gpt-5.5",
      adapter: "openai-responses",
      status: 200,
      durationMs: 1,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    }));
    const contents = line("many-attempts", { attempts });
    expect(Buffer.byteLength(contents)).toBeLessThan(USAGE_LEDGER_MAX_LINE_BYTES);
    writeFileSync(usageLogPath(), contents);

    const ids: string[] = [];
    const result = await scanUsageLedgerCooperatively({ onEntry: value => ids.push(value.requestId) });

    expect(ids).toEqual(["many-attempts"]);
    expect(result).toMatchObject({ parsedRows: 1, invalidRows: 0, oversizedRows: 0 });
    expect(result.processedThroughDigest).toBe(
      createHash("sha256")
        .update(Buffer.from(contents).subarray(-USAGE_LEDGER_BOUNDARY_DIGEST_BYTES))
        .digest("hex"),
    );
  });

  test("uses the opened EOF and leaves a concurrent append for the next scan", async () => {
    const initial = Array.from({ length: 1_500 }, (_, index) => line(`initial-${index}`)).join("");
    writeFileSync(usageLogPath(), initial);
    const firstIds: string[] = [];
    const firstScan = scanUsageLedgerCooperatively({
      chunkBytes: 128,
      onEntry: value => firstIds.push(value.requestId),
    });
    queueMicrotask(() => appendFileSync(usageLogPath(), line("appended")));

    const first = await firstScan;
    expect(first.revision?.size).toBe(Buffer.byteLength(initial));
    expect(first.bytesRead).toBe(Buffer.byteLength(initial));
    expect(first.processedThroughBytes).toBe(Buffer.byteLength(initial));
    expect(firstIds).toHaveLength(1_500);
    expect(firstIds).not.toContain("appended");

    const secondIds: string[] = [];
    const second = await scanUsageLedgerCooperatively({ onEntry: value => secondIds.push(value.requestId) });
    expect(second.parsedRows).toBe(1_501);
    expect(secondIds.at(-1)).toBe("appended");
  });

  test("continuous pure appends during verification do not invalidate the captured prefix", async () => {
    const rows = Array.from({ length: 15_000 }, (_, index) => line(`stable-${index}`));
    const initial = rows.join("");
    expect(Buffer.byteLength(initial)).toBeGreaterThan(2 * 1024 * 1024);
    writeFileSync(usageLogPath(), initial);
    let callbacks = 0;
    const scan = scanUsageLedgerCooperatively({ onEntry: () => { callbacks += 1; } });
    let appendIndex = 0;
    const interval = setInterval(() => {
      appendFileSync(usageLogPath(), line(`concurrent-${appendIndex++}`));
    }, 0);

    try {
      const result = await scan;
      expect(result.parsedRows).toBe(15_000);
      expect(callbacks).toBe(15_000);
      expect(result.revision?.size).toBe(Buffer.byteLength(initial));
    } finally {
      clearInterval(interval);
    }
    expect(appendIndex).toBeGreaterThan(0);
  });

  test("an append scan visits only bytes after the previous LF checkpoint", async () => {
    const initial = `${line("first")}${line("second")}`;
    writeFileSync(usageLogPath(), initial);
    const initialIds: string[] = [];
    const first = await scanUsageLedgerCooperatively({ onEntry: value => initialIds.push(value.requestId) });
    expect(initialIds).toEqual(["first", "second"]);

    const appended = `${line("third")}${line("fourth")}`;
    appendFileSync(usageLogPath(), appended);
    const appendedIds: string[] = [];
    const second = await scanUsageLedgerCooperatively({
      startAtBytes: first.processedThroughBytes,
      expectedIdentityKey: usageLogIdentityKey(first.revision),
      expectedProcessedThroughDigest: first.processedThroughDigest,
      onEntry: value => appendedIds.push(value.requestId),
    });

    expect(appendedIds).toEqual(["third", "fourth"]);
    expect(second.bytesRead).toBe(Buffer.byteLength(appended));
    expect(second.processedThroughBytes).toBe(Buffer.byteLength(initial + appended));
  });

  test("a torn EOF keeps the checkpoint behind it and is counted once after completion", async () => {
    const committed = line("committed");
    const completedRow = Buffer.from(JSON.stringify(entry("완성-🙂")));
    const splitAt = completedRow.indexOf(Buffer.from("🙂")) + 2;
    writeFileSync(usageLogPath(), Buffer.concat([
      Buffer.from(committed),
      completedRow.subarray(0, splitAt),
    ]));
    const firstIds: string[] = [];
    const first = await scanUsageLedgerCooperatively({
      chunkBytes: 3,
      onEntry: value => firstIds.push(value.requestId),
    });
    expect(firstIds).toEqual(["committed"]);
    expect(first.invalidRows).toBe(1);
    expect(first.processedThroughBytes).toBe(Buffer.byteLength(committed));
    expect(first.processedThroughDigest).toBe(
      createHash("sha256").update(committed).digest("hex"),
    );

    appendFileSync(usageLogPath(), Buffer.concat([
      completedRow.subarray(splitAt),
      Buffer.from("\n"),
    ]));
    const completedIds: string[] = [];
    const second = await scanUsageLedgerCooperatively({
      chunkBytes: 2,
      startAtBytes: first.processedThroughBytes,
      expectedIdentityKey: usageLogIdentityKey(first.revision),
      expectedProcessedThroughDigest: first.processedThroughDigest,
      onEntry: value => completedIds.push(value.requestId),
    });
    expect(completedIds).toEqual(["완성-🙂"]);
    expect(second.invalidRows).toBe(0);

    const afterIds: string[] = [];
    const third = await scanUsageLedgerCooperatively({
      startAtBytes: second.processedThroughBytes,
      expectedIdentityKey: usageLogIdentityKey(second.revision),
      expectedProcessedThroughDigest: second.processedThroughDigest,
      onEntry: value => afterIds.push(value.requestId),
    });
    expect(afterIds).toEqual([]);
    expect(third.bytesRead).toBe(0);
  });

  test("incremental preconditions fail with explicit rebuild-required reasons", async () => {
    const contents = `${line("first")}${line("second")}`;
    writeFileSync(usageLogPath(), contents);
    const full = await scanUsageLedgerCooperatively({ onEntry: () => {} });

    const wrongIdentity = scanUsageLedgerCooperatively({
      startAtBytes: full.processedThroughBytes,
      expectedIdentityKey: "not-the-ledger",
      expectedProcessedThroughDigest: full.processedThroughDigest,
      onEntry: () => {},
    });
    await expect(wrongIdentity).rejects.toMatchObject({
      code: "usage_ledger_rebuild_required",
      reason: "identity_mismatch",
    });

    const middleOfRow = scanUsageLedgerCooperatively({
      startAtBytes: 2,
      expectedIdentityKey: usageLogIdentityKey(full.revision),
      expectedProcessedThroughDigest: full.processedThroughDigest,
      onEntry: () => {},
    });
    await expect(middleOfRow).rejects.toMatchObject({
      code: "usage_ledger_rebuild_required",
      reason: "boundary_mismatch",
    });

    writeFileSync(usageLogPath(), line("short"));
    const shrink = scanUsageLedgerCooperatively({
      startAtBytes: full.processedThroughBytes,
      expectedIdentityKey: usageLogIdentityKey(full.revision),
      expectedProcessedThroughDigest: full.processedThroughDigest,
      onEntry: () => {},
    });
    await expect(shrink).rejects.toBeInstanceOf(UsageLedgerRebuildRequiredError);
    await expect(shrink).rejects.toMatchObject({ reason: "shrink" });
  });

  test("a nonzero checkpoint requires both its identity and trailing digest", async () => {
    writeFileSync(usageLogPath(), line("checkpoint"));
    const full = await scanUsageLedgerCooperatively({ onEntry: () => {} });

    await expect(scanUsageLedgerCooperatively({
      startAtBytes: full.processedThroughBytes,
      expectedProcessedThroughDigest: full.processedThroughDigest,
      onEntry: () => {},
    })).rejects.toBeInstanceOf(TypeError);
    await expect(scanUsageLedgerCooperatively({
      startAtBytes: full.processedThroughBytes,
      expectedIdentityKey: usageLogIdentityKey(full.revision),
      onEntry: () => {},
    })).rejects.toBeInstanceOf(TypeError);
  });

  test("a boundary digest rejects a same-identity rewrite before the append offset", async () => {
    const original = `${line("aaaa")}${line("bbbb")}`;
    writeFileSync(usageLogPath(), original);
    const full = await scanUsageLedgerCooperatively({ onEntry: () => {} });
    const rewritten = original.replace("aaaa", "zzzz");
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
    writeFileSync(usageLogPath(), rewritten);

    const scan = scanUsageLedgerCooperatively({
      startAtBytes: full.processedThroughBytes,
      expectedIdentityKey: usageLogIdentityKey(full.revision),
      expectedProcessedThroughDigest: full.processedThroughDigest,
      onEntry: () => {},
    });
    await expect(scan).rejects.toMatchObject({
      code: "usage_ledger_rebuild_required",
      reason: "content_changed",
    });
  });

  test("the returned checkpoint digest stays paired with bytes captured by the scan", async () => {
    const original = line("old-checkpoint");
    const rewritten = line("new-checkpoint");
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
    writeFileSync(usageLogPath(), original);
    let abortChecks = 0;
    const rewriteAfterVerification = {
      get aborted() {
        abortChecks += 1;
        if (abortChecks === 4) writeFileSync(usageLogPath(), rewritten);
        return false;
      },
    } as AbortSignal;

    const ids: string[] = [];
    const result = await scanUsageLedgerCooperatively({
      signal: rewriteAfterVerification,
      onEntry: value => ids.push(value.requestId),
    });
    const originalDigest = createHash("sha256").update(original).digest("hex");
    expect(abortChecks).toBeGreaterThanOrEqual(4);
    expect(ids).toEqual(["old-checkpoint"]);
    expect(result.processedThroughDigest).toBe(originalDigest);

    await expect(scanUsageLedgerCooperatively({
      startAtBytes: result.processedThroughBytes,
      expectedIdentityKey: usageLogIdentityKey(result.revision),
      expectedProcessedThroughDigest: result.processedThroughDigest,
      onEntry: () => {},
    })).rejects.toMatchObject({
      code: "usage_ledger_rebuild_required",
      reason: "content_changed",
    });
  });

  test("rejects a shrink while the scanner is yielded", async () => {
    writeFileSync(
      usageLogPath(),
      Array.from({ length: 1_500 }, (_, index) => line(`old-${index}`)).join(""),
    );
    const scan = scanUsageLedgerCooperatively({ chunkBytes: 128, onEntry: () => {} });
    queueMicrotask(() => writeFileSync(usageLogPath(), line("replacement")));

    await expect(scan).rejects.toMatchObject({
      code: "usage_ledger_rebuild_required",
      reason: "shrink",
    });
  });

  test("rejects when the path is replaced while the original descriptor stays readable", async () => {
    writeFileSync(
      usageLogPath(),
      Array.from({ length: 1_500 }, (_, index) => line(`old-${index}`)).join(""),
    );
    const scan = scanUsageLedgerCooperatively({ chunkBytes: 128, onEntry: () => {} });
    queueMicrotask(() => {
      renameSync(usageLogPath(), `${usageLogPath()}.old`);
      writeFileSync(usageLogPath(), line("replacement"));
    });

    await expect(scan).rejects.toMatchObject({
      code: "usage_ledger_rebuild_required",
      reason: "identity_mismatch",
    });
  });

  test("rejects a same-inode rewrite plus growth instead of publishing a mixed snapshot", async () => {
    writeFileSync(
      usageLogPath(),
      Array.from({ length: 1_500 }, (_, index) => line(`old-${String(index).padStart(4, "0")}`)).join(""),
    );
    const scan = scanUsageLedgerCooperatively({ chunkBytes: 128, onEntry: () => {} });
    queueMicrotask(() => {
      writeFileSync(
        usageLogPath(),
        Array.from({ length: 1_600 }, (_, index) => line(`new-${String(index).padStart(4, "0")}`)).join(""),
      );
    });

    await expect(scan).rejects.toMatchObject({
      code: "usage_ledger_rebuild_required",
      reason: "content_changed",
    });
  });

  test("honors an existing abort and an abort delivered at a cooperative yield", async () => {
    const beforeStart = new AbortController();
    const beforeStartReason = new Error("stop-before-start");
    beforeStart.abort(beforeStartReason);
    await expect(scanUsageLedgerCooperatively({
      signal: beforeStart.signal,
      onEntry: () => {},
    })).rejects.toBe(beforeStartReason);

    writeFileSync(
      usageLogPath(),
      Array.from({ length: 1_500 }, (_, index) => line(`abort-${index}`)).join(""),
    );
    const duringScan = new AbortController();
    const duringScanReason = new Error("stop-during-scan");
    let callbacks = 0;
    const scan = scanUsageLedgerCooperatively({
      signal: duringScan.signal,
      chunkBytes: 128,
      onEntry: () => { callbacks += 1; },
    });
    queueMicrotask(() => duringScan.abort(duringScanReason));

    await expect(scan).rejects.toBe(duringScanReason);
    expect(callbacks).toBeGreaterThan(0);
    expect(callbacks).toBeLessThan(1_500);
  });

  test("propagates accumulator failures instead of misclassifying them as invalid rows", async () => {
    writeFileSync(usageLogPath(), line("callback-error"));
    const sentinel = new Error("accumulator failed");

    await expect(scanUsageLedgerCooperatively({
      onEntry: () => { throw sentinel; },
    })).rejects.toBe(sentinel);
  });
});

const homes: string[] = [];

/** Allocate one isolated filesystem home and remember it for teardown. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-ledger-retention-"));
  homes.push(dir);
  return dir;
}

/** Build one JSONL row whose encoded byte length is exactly `totalBytes`. */
function jsonlRowOfSize(requestId: string, totalBytes: number, fill = "x"): string {
  const empty = `${JSON.stringify({ requestId, filler: "" })}\n`;
  const overhead = Buffer.byteLength(empty);
  if (totalBytes < overhead) throw new Error("row target is smaller than JSONL overhead");
  const row = `${JSON.stringify({ requestId, filler: fill.repeat(totalBytes - overhead) })}\n`;
  if (Buffer.byteLength(row) !== totalBytes) throw new Error("row byte sizing drifted");
  return row;
}

afterEach(async () => {
  await resetUsageLedgerRetentionJobForTests();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitForRetentionIdle(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getUsageLedgerRetentionJobState().status === "idle") return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for usage ledger retention job");
}

describe("usage ledger retention v2", () => {
  test("missing or unknown persisted config keys stay Unlimited", () => {
    expect(normalizeUsageLedgerRetention(undefined).enabled).toBe(false);
    expect(normalizeUsageLedgerRetention({ enabled: true, maxByets: 8 * 1024 * 1024 })).toEqual({
      enabled: false,
      maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES,
    });
  });

  test("live writes reject unknown config keys instead of silently stripping them", () => {
    const parsed = parseUsageLedgerRetentionInput(
      { enabled: true, maxByets: 8 * 1024 * 1024 },
      { enabled: false, maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected strict parser failure");
    expect(parsed.error).toContain("maxByets");
  });

  test("partial live writes preserve the previous enabled state", () => {
    const maxBytes = 8 * 1024 * 1024;
    expect(parseUsageLedgerRetentionInput(
      { maxBytes },
      { enabled: true, maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES },
    )).toEqual({ ok: true, policy: { enabled: true, maxBytes } });
  });

  test("unsafe or below-floor byte limits disable destructive retention", () => {
    for (const maxBytes of [Number.MAX_SAFE_INTEGER + 1, MIN_USAGE_LEDGER_MAX_BYTES - 1, MIN_USAGE_LEDGER_MAX_BYTES + 0.5]) {
      expect(normalizeUsageLedgerRetention({ enabled: true, maxBytes }).enabled).toBe(false);
    }
  });

  test("normalizes an explicitly enabled safe byte limit", () => {
    const maxBytes = 8 * 1024 * 1024;
    expect(normalizeUsageLedgerRetention({ enabled: true, maxBytes })).toEqual({ enabled: true, maxBytes });
  });

  test("drops an oversized single row instead of retaining a partial JSONL fragment", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const huge = `${JSON.stringify({ requestId: "huge", payload: "x".repeat(MIN_USAGE_LEDGER_MAX_BYTES + 1024) })}\n`;
    writeFileSync(path, huge);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    expect(prepared.afterBytes).toBe(0);
    expect(readFileSync(prepared.tempPath, "utf8")).toBe("");
  });

  test("drops an unterminated crash tail while retaining a complete row at the ceiling", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const complete = jsonlRowOfSize("complete", MIN_USAGE_LEDGER_MAX_BYTES);
    const partial = JSON.stringify({ requestId: "partial", filler: "y".repeat(1024) });
    writeFileSync(path, complete + partial);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    const retained = readFileSync(prepared.tempPath, "utf8");
    expect(retained).toBe(complete);
    expect(retained.endsWith("\n")).toBe(true);
    expect(retained).not.toContain("partial");
  });

  test("retains the row when the byte ceiling lands exactly on its start boundary", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old" })}\n`;
    const newest = jsonlRowOfSize("new", MIN_USAGE_LEDGER_MAX_BYTES, "b");
    writeFileSync(path, old + newest);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    expect(prepared.afterBytes).toBe(MIN_USAGE_LEDGER_MAX_BYTES);
    expect(readFileSync(prepared.tempPath, "utf8")).toBe(newest);
  });

  test("never starts the candidate in the middle of a long row", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const first = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES + 128) })}\n`;
    const second = `${JSON.stringify({ requestId: "new", filler: "b".repeat(64 * 1024) })}\n`;
    writeFileSync(path, first + second);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    const retained = readFileSync(prepared.tempPath, "utf8");
    expect(retained).toBe(second);
    expect(() => JSON.parse(retained.trim())).not.toThrow();
  });

  test("uses a parent-owned candidate path when one is supplied", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const tempPath = join(dir, "owned-retention.tmp");
    writeFileSync(path, jsonlRowOfSize("old", MIN_USAGE_LEDGER_MAX_BYTES) + `${JSON.stringify({ requestId: "new" })}\n`);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES, tempPath);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    expect(prepared.tempPath).toBe(tempPath);
    expect(existsSync(tempPath)).toBe(true);
  });

  test("discards the derived request-history database and sidecars from an isolated config home", () => {
    const dir = home();
    const path = historyIndexPath(dir);
    writeFileSync(path, "main");
    writeFileSync(`${path}-wal`, "wal");
    writeFileSync(`${path}-shm`, "shm");

    expect(discardRequestHistoryProjection(dir)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  test("revision comparator detects a source mutation before commit", () => {
    const revision = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
    expect(usageLedgerRevisionMatches(revision, revision)).toBe(true);
    expect(usageLedgerRevisionMatches(revision, { ...revision, size: 4 })).toBe(false);
  });

  test("defers commit while a request turn is active and discards the candidate", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");

    const result = commitPreparedUsageLedgerCompaction(prepared, { activeTurnCount: () => 1 });
    expect(result.deferred).toBe("active_turns");
    expect(existsSync(prepared.tempPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(old + latest);
  });

  test("does not overwrite an append that landed after Worker preparation", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");

    const appended = `${JSON.stringify({ requestId: "after-prepare" })}\n`;
    appendFileSync(path, appended);
    const result = commitPreparedUsageLedgerCompaction(prepared, { activeTurnCount: () => 0 });
    expect(result.deferred).toBe("source_changed");
    expect(existsSync(prepared.tempPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(old + latest + appended);
  });

  test("closes the derived history index before replace and discards it only after publication", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");
    const expected = readFileSync(prepared.tempPath, "utf8");
    let closed = false;
    let replaced = false;
    let discarded = false;

    const result = commitPreparedUsageLedgerCompaction(prepared, {
      activeTurnCount: () => 0,
      closeHistoryIndex: () => { closed = true; },
      rename: (from, to) => {
        expect(closed).toBe(true);
        renameSync(from, to);
        replaced = true;
      },
      discardHistoryProjection: configDir => {
        expect(replaced).toBe(true);
        expect(configDir).toBe(dir);
        discarded = true;
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.droppedBytes).toBeGreaterThan(0);
    expect(discarded).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(expected);
  });

  test("derived projection cleanup failure does not reverse a successful canonical commit", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");
    const expected = readFileSync(prepared.tempPath, "utf8");
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const result = commitPreparedUsageLedgerCompaction(prepared, {
        activeTurnCount: () => 0,
        rename: renameSync,
        discardHistoryProjection: () => { throw new Error("projection busy"); },
      });
      expect(result.ok).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(expected);
    } finally {
      console.warn = warn;
    }
  });

  test("does not discard the derived projection when canonical publication fails", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    const original = old + latest;
    writeFileSync(path, original);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");
    let discarded = false;

    const result = commitPreparedUsageLedgerCompaction(prepared, {
      activeTurnCount: () => 0,
      closeHistoryIndex: () => undefined,
      rename: () => { throw new Error("rename failed"); },
      discardHistoryProjection: () => {
        discarded = true;
        return true;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("commit_failed");
    expect(discarded).toBe(false);
    expect(existsSync(prepared.tempPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("invalidating a policy generation prevents a prepared Worker candidate from publishing", async () => {
    const dir = home();
    const previousRetentionHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      const maxBytes = MIN_USAGE_LEDGER_MAX_BYTES;
      const config = {
        ...getDefaultConfig(),
        usageLedgerRetention: { enabled: true, maxBytes },
      };
      saveConfig(config);

      const path = join(dir, "usage.jsonl");
      const original = jsonlRowOfSize("old", maxBytes) + jsonlRowOfSize("new", 256);
      writeFileSync(path, original);

      const started = requestUsageLedgerRetentionRun();
      expect(started.accepted).toBe(true);
      invalidateUsageLedgerRetentionRun();
      await waitForRetentionIdle();

      expect(readFileSync(path, "utf8")).toBe(original);
      expect(getUsageLedgerRetentionJobState().lastOutcome).toBeUndefined();
      expect(readdirSync(dir).filter(name => name.includes(".retention-")).length).toBe(0);
    } finally {
      if (previousRetentionHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousRetentionHome;
      expect(getConfigPath()).not.toBe(join(dir, "config.json"));
    }
  });
});
