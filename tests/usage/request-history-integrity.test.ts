/** Regression coverage for #7966: integrity scans never run on the serving thread. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  resetUsageReadCacheForTests,
  usageLogPath,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import {
  closeRequestHistoryIndex,
  openRequestHistoryIndex,
  openRequestHistoryIndexSync,
  queryRequestHistory,
  rebuildRequestHistoryIndex,
  requestHistoryDb,
  requestHistoryIndexStatus,
  requestHistoryRowById,
  RequestHistoryIndexBusyError,
  RequestHistoryIndexClosedError,
  setRequestHistoryIntegrityOptionsForTests,
  setRequestHistoryRebuildJobFactoryForTests,
  setRequestHistoryWorkerRebuildMinBytesForTests,
  withRequestHistoryRead,
} from "../../src/routing/history/indexer";
import { HISTORY_META_KEYS, HISTORY_SCHEMA_VERSION } from "../../src/routing/history/schema";
import { RequestHistoryIntegrityMonitor } from "../../src/routing/history/integrity";
import { isHistoryIndexCorruption } from "../../src/routing/history/sqlite-errors";
import { computeRoutingAnalytics } from "../../src/routing/analytics";
import { clearHealthHistoryCacheForTests, healthEvidenceForCandidate } from "../../src/routing/health";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

function entry(requestId: string, timestamp: number): PersistedUsageEntry {
  return { requestId, timestamp, provider: "a", model: "m1", status: 200, durationMs: 10, usageStatus: "reported" };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-integrity-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  clearHealthHistoryCacheForTests();
  closeRequestHistoryIndex();
  setRequestHistoryIntegrityOptionsForTests(undefined);
});

afterEach(async () => {
  clearHealthHistoryCacheForTests();
  closeRequestHistoryIndex();
  setRequestHistoryIntegrityOptionsForTests(undefined);
  setRequestHistoryRebuildJobFactoryForTests(undefined);
  setRequestHistoryWorkerRebuildMinBytesForTests(undefined);
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(testDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(testDir);
});

async function existingIndex(): Promise<string> {
  for (let index = 0; index < 4; index++) appendUsageEntry(entry(`req-${index}`, 1000 + index));
  const meta = await rebuildRequestHistoryIndex();
  closeRequestHistoryIndex();
  return meta.dbPath;
}

interface Check {
  path: string;
  resolve(healthy: boolean): void;
  reject(error: unknown): void;
}

/** A pending check is controlled by the test; release is immediate once it settles or is disposed. */
function controlledChecks() {
  const checks: Check[] = [];
  let clock = 0;
  setRequestHistoryIntegrityOptionsForTests({
    now: () => clock,
    intervalMs: 1000,
    failureCooldownMs: 100,
    createJob: () => ({
      check: (path: string) => new Promise<boolean>((resolve, reject) => { checks.push({ path, resolve, reject }); }),
      dispose: async () => {},
      afterExit: async (cleanup: () => void) => { cleanup(); },
    }),
  });
  return { checks, advance: (ms: number) => { clock += ms; } };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await Bun.sleep(0);
  expect(predicate()).toBe(true);
}

async function verifyInitial(checks: Check[]): Promise<void> {
  const ready = openRequestHistoryIndex();
  await until(() => checks.length === 1);
  checks[0]!.resolve(true);
  await ready;
}

function corruptModelIndex(handle: Database, path: string, index = "idx_requests_model"): void {
  const { rootpage } = handle.query("SELECT rootpage FROM sqlite_master WHERE name = ?").get(index) as { rootpage: number };
  const { page_size: pageSize } = handle.query("PRAGMA page_size").get() as { page_size: number };
  expect(rootpage).toBeGreaterThan(1);
  const checkpoint = handle.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
  expect(checkpoint.busy).toBe(0);
  // Keep SQLite's header, schema and request table intact, but invalidate a
  // separate index B-tree that the default timestamp-ordered page does not visit.
  const fd = openSync(path, "r+");
  try { writeSync(fd, Buffer.from([0]), 0, 1, (rootpage - 1) * pageSize); }
  finally { closeSync(fd); }
  handle.exec("PRAGMA shrink_memory");
}

// Several indexes can serve the health query; which one SQLite's planner picks differs between
// builds (Bun bundles SQLite on Linux and Windows, macOS uses the system library). Corrupt the one
// this build actually reads instead of assuming the model index.
function healthQueryIndex(handle: Database): string {
  // prepare + finalize: a query() statement stays cached on the handle and holds a table lock.
  const statement = handle.prepare(
    "EXPLAIN QUERY PLAN SELECT status FROM requests WHERE provider = ? AND model = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
  );
  let plan: Array<{ detail: string }>;
  try { plan = statement.all("a", "m1", 0, 1) as Array<{ detail: string }>; }
  finally { statement.finalize(); }
  const index = plan.map(row => /USING (?:COVERING )?INDEX (\w+)/.exec(row.detail)?.[1]).find(Boolean);
  expect(index).toMatch(/^idx_requests_/);
  return index!;
}

describe("request-history integrity lifecycle (#7966)", () => {
  test("a silent scanner times out for readers but retains the replacement barrier", async () => {
    let clock = 0;
    let fire: (() => void) | undefined;
    const exits: Array<() => void> = [];
    let jobs = 0;
    let disposals = 0;
    const monitor = new RequestHistoryIntegrityMonitor({
      now: () => clock,
      failureCooldownMs: 100,
      checkTimeoutMs: 50,
      scheduleTimeout: (callback: () => void, ms: number) => {
        expect(ms).toBe(50);
        fire = callback;
        return () => { fire = undefined; };
      },
      createJob: () => {
        jobs++;
        return {
          check: () => new Promise<boolean>(() => {}),
          dispose: async () => { disposals++; },
          afterExit: async (cleanup: () => void) => { exits.push(cleanup); },
        };
      },
    });
    const handle = {};
    const first = monitor.inspect(handle, "index.sqlite");
    if (first.state !== "pending") throw new Error("initial check must be pending");
    expect(fire).toBeDefined();
    clock = 50;
    fire!();
    await first.promise;
    expect(disposals).toBe(1);
    expect(monitor.inspect(handle, "index.sqlite").state).toBe("unavailable");
    expect(jobs).toBe(1);
    clock = 150;
    expect(monitor.inspect(handle, "index.sqlite").state).toBe("pending");
    expect(jobs).toBe(2);
    const barrier = monitor.quiesce();
    expect(barrier).not.toBeNull();
    let released = false;
    void barrier!.then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    exits[0]!();
    await Promise.resolve();
    expect(released).toBe(false);
    // Let cancellation schedule the second worker's exit callback.
    await Promise.resolve();
    exits[1]!();
    await barrier;
    expect(released).toBe(true);
  }, 1000);

  test("a verdict arriving after the timeout never changes the generation's state", async () => {
    for (const lateVerdict of [true, false]) {
      let clock = 0;
      const fires: Array<() => void> = [];
      const answers: Array<(healthy: boolean) => void> = [];
      const exits: Array<() => void> = [];
      const monitor = new RequestHistoryIntegrityMonitor({
        now: () => clock,
        failureCooldownMs: 100,
        checkTimeoutMs: 50,
        scheduleTimeout: callback => { fires.push(callback); return () => {}; },
        createJob: () => ({
          check: () => new Promise<boolean>(resolve => { answers.push(resolve); }),
          dispose: async () => {},
          afterExit: async (cleanup: () => void) => { exits.push(cleanup); },
        }),
      });
      const handle = {};
      const first = monitor.inspect(handle, "index.sqlite");
      if (first.state !== "pending") throw new Error("initial check must be pending");
      await Promise.resolve();
      fires[0]!();
      await first.promise;
      expect(monitor.inspect(handle, "index.sqlite").state).toBe("unavailable");
      // The timed-out worker answers late, then exits.
      answers[0]!(lateVerdict);
      exits[0]!();
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
      expect(monitor.inspect(handle, "index.sqlite").state).toBe("unavailable");
      // After the cooldown a fresh check decides, and only its verdict counts.
      clock = 150;
      const fresh = monitor.inspect(handle, "index.sqlite");
      if (fresh.state !== "pending") throw new Error("fresh check must be pending");
      await Promise.resolve();
      answers[1]!(true);
      for (let turn = 0; turn < 5 && !exits[1]; turn++) await Promise.resolve();
      exits[1]!();
      await fresh.promise;
      expect(monitor.inspect(handle, "index.sqlite").state).toBe("ready");
    }
  }, 1000);

  test("shared async readers leave a silent initial integrity check with a bounded error", async () => {
    await existingIndex();
    let fire!: () => void;
    let started!: () => void;
    let exit!: () => void;
    const scheduled = new Promise<void>(resolve => { started = resolve; });
    setRequestHistoryIntegrityOptionsForTests({
      scheduleTimeout: callback => { fire = callback; started(); return () => {}; },
      createJob: () => ({
        check: () => new Promise<boolean>(() => {}),
        dispose: async () => {},
        afterExit: async cleanup => { exit = cleanup; },
      }),
    });
    const first = openRequestHistoryIndex();
    const second = openRequestHistoryIndex();
    const errors = Promise.all([first.catch(error => error), second.catch(error => error)]);
    await scheduled;
    fire();
    expect((await errors).every(error => error instanceof RequestHistoryIndexBusyError)).toBe(true);
    exit();
  }, 5000);
  test("real worker checks leave repeated page, row, status and routing reads free of full serving-thread scans", async () => {
    await existingIndex();
    const query = spyOn(Database.prototype, "query");
    const prepare = spyOn(Database.prototype, "prepare");
    const exec = spyOn(Database.prototype, "exec");
    try {
      for (let repeat = 0; repeat < 4; repeat++) {
        const page = await queryRequestHistory({}, undefined, 1);
        expect(page.rows.map(row => row.requestId)).toEqual(["req-3"]);
        expect((await requestHistoryRowById("req-1"))?.requestId).toBe("req-1");
        expect((await requestHistoryIndexStatus()).indexedRows).toBe(4);
        expect(openRequestHistoryIndexSync().indexedRows).toBe(4);
      }
      appendUsageEntry(entry("tail", 2000));
      expect((await queryRequestHistory({}, undefined, 1)).rows[0]?.requestId).toBe("tail");
      const fullChecks = [...query.mock.calls, ...prepare.mock.calls, ...exec.mock.calls]
        .filter(([sql]) => /\bPRAGMA\s+(?:quick_check|integrity_check)\b/i.test(String(sql)));
      expect(fullChecks).toEqual([]);
    } finally {
      query.mockRestore();
      prepare.mockRestore();
      exec.mockRestore();
    }
  });

  test("existing-index validation is single-flight and routing never waits for the first check", async () => {
    const path = await existingIndex();
    const { checks } = controlledChecks();
    let finished = false;
    const page = queryRequestHistory({}, undefined, 1).then(value => { finished = true; return value; });
    const row = requestHistoryRowById("req-1");
    const status = requestHistoryIndexStatus();
    await until(() => checks.length === 1);
    expect(checks[0]!.path).toBe(path);
    expect(finished).toBe(false);
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    expect(checks).toHaveLength(1);
    checks[0]!.resolve(true);
    const [result, found, meta] = await Promise.all([page, row, status]);
    expect(result.rows[0]?.requestId).toBe("req-3");
    expect(found?.requestId).toBe("req-1");
    expect(meta.indexedRows).toBe(4);
    expect(openRequestHistoryIndexSync().indexedRows).toBe(4);
    expect(checks).toHaveLength(1);
  });

  test("periodic checks are single-flight and do not delay a verified index's reads", async () => {
    await existingIndex();
    const { checks, advance } = controlledChecks();
    await verifyInitial(checks);
    advance(999);
    await queryRequestHistory({}, undefined, 1);
    expect(checks).toHaveLength(1);
    advance(1);
    expect((await queryRequestHistory({}, undefined, 1)).rows[0]?.requestId).toBe("req-3");
    await until(() => checks.length === 2);
    for (let repeat = 0; repeat < 3; repeat++) {
      expect((await requestHistoryIndexStatus()).indexedRows).toBe(4);
      expect(openRequestHistoryIndexSync().indexedRows).toBe(4);
    }
    expect(checks).toHaveLength(2);
    checks[1]!.resolve(true);
    await Bun.sleep(0);
  });

  test("a transient initial check failure preserves the database and retries only after cooldown", async () => {
    await existingIndex();
    const canonical = readFileSync(usageLogPath());
    const { checks, advance } = controlledChecks();
    const first = openRequestHistoryIndex();
    const failure = first.catch((error: unknown) => error);
    await until(() => checks.length === 1);
    const handle = requestHistoryDb();
    checks[0]!.reject(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
    expect(await failure).toBeInstanceOf(RequestHistoryIndexBusyError);
    for (let repeat = 0; repeat < 3; repeat++) {
      await expect(openRequestHistoryIndex()).rejects.toBeInstanceOf(RequestHistoryIndexBusyError);
      expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    }
    expect(requestHistoryDb()).toBe(handle);
    expect(checks).toHaveLength(1);
    expect(handle.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 4 });
    advance(100);
    const retry = openRequestHistoryIndex();
    await until(() => checks.length === 2);
    checks[1]!.resolve(true);
    expect((await retry).indexedRows).toBe(4);
    expect(requestHistoryDb()).toBe(handle);
    expect(readFileSync(usageLogPath())).toEqual(canonical);
  });

  test("a background check failure leaves verified reads available without a worker retry storm", async () => {
    await existingIndex();
    const { checks, advance } = controlledChecks();
    await verifyInitial(checks);
    const handle = requestHistoryDb();
    advance(1000);
    await openRequestHistoryIndex();
    await until(() => checks.length === 2);
    checks[1]!.reject(new Error("worker exited"));
    await Bun.sleep(0);
    for (let repeat = 0; repeat < 3; repeat++) expect((await openRequestHistoryIndex()).indexedRows).toBe(4);
    expect(checks).toHaveLength(2);
    expect(requestHistoryDb()).toBe(handle);
    advance(100);
    await openRequestHistoryIndex();
    await until(() => checks.length === 3);
    checks[2]!.resolve(true);
    await Bun.sleep(0);
  });

  test("a late corrupt verdict from a closed lifetime cannot rebuild the reopened index", async () => {
    await existingIndex();
    const { checks } = controlledChecks();
    const first = openRequestHistoryIndex();
    const closed = first.catch((error: unknown) => error);
    await until(() => checks.length === 1);
    closeRequestHistoryIndex();
    expect(await closed).toBeInstanceOf(RequestHistoryIndexClosedError);
    const next = openRequestHistoryIndex();
    await until(() => checks.length === 2);
    const reopened = requestHistoryDb();
    checks[0]!.resolve(false);
    checks[1]!.resolve(true);
    expect((await next).indexedRows).toBe(4);
    expect(requestHistoryDb()).toBe(reopened);
    expect((await queryRequestHistory({}, undefined, 10)).rows).toHaveLength(4);
    expect(checks).toHaveLength(2);
  });

  test("a manual rebuild shares one flight and releases readers waiting on an initial scan", async () => {
    await existingIndex();
    const { checks } = controlledChecks();
    const reader = openRequestHistoryIndex();
    await until(() => checks.length === 1);
    setRequestHistoryWorkerRebuildMinBytesForTests(0);
    const rebuild = rebuildRequestHistoryIndex();
    expect(rebuildRequestHistoryIndex()).toBe(rebuild);
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    const [readMeta, rebuildMeta] = await Promise.all([reader, rebuild]);
    expect(readMeta.indexedRows).toBe(4);
    expect(rebuildMeta.indexedRows).toBe(4);
    checks[0]!.resolve(false);
    await Bun.sleep(0);
    expect(openRequestHistoryIndexSync().indexedRows).toBe(4);
    expect(checks).toHaveLength(1);
  });

  test("close prevents a manual rebuild waiting on an existing worker from reopening the index", async () => {
    appendUsageEntry(entry("only", 1000));
    setRequestHistoryWorkerRebuildMinBytesForTests(0);
    let builds = 0;
    let rejectBuild: ((error: unknown) => void) | undefined;
    setRequestHistoryRebuildJobFactoryForTests(() => ({
      build: () => new Promise<number>((_resolve, reject) => { builds += 1; rejectBuild = reject; }),
      dispose: async () => { rejectBuild?.(new Error("worker stopped")); },
      afterExit: async (cleanup: () => void) => { cleanup(); },
    }));
    const reader = openRequestHistoryIndex().catch((error: unknown) => error);
    await until(() => builds === 1);
    const manual = rebuildRequestHistoryIndex().catch((error: unknown) => error);
    closeRequestHistoryIndex();
    expect(await reader).toBeInstanceOf(RequestHistoryIndexClosedError);
    expect(await manual).toBeInstanceOf(RequestHistoryIndexClosedError);
    expect(builds).toBe(1);
    expect(() => requestHistoryDb()).toThrow("not open");
  });

  test("source replacement cancels a background scan and reprojects only the replacement ledger", async () => {
    await existingIndex();
    const { checks, advance } = controlledChecks();
    await verifyInitial(checks);
    advance(1000);
    await openRequestHistoryIndex();
    await until(() => checks.length === 2);
    const path = usageLogPath();
    const replacement = JSON.stringify(entry("replacement", 5000)) + "\n";
    writeFileSync(`${path}.next`, replacement);
    renameSync(`${path}.next`, path);
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.map(row => row.requestId)).toEqual(["replacement"]);
    const rebuilt = requestHistoryDb();
    checks[1]!.resolve(false);
    await Bun.sleep(0);
    expect((await requestHistoryIndexStatus()).indexedRows).toBe(1);
    expect(requestHistoryDb()).toBe(rebuilt);
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(checks).toHaveLength(2);
  });

  test("a periodic corrupt verdict rebuilds the projection on the next read", async () => {
    await existingIndex();
    const canonical = readFileSync(usageLogPath());
    const { checks, advance } = controlledChecks();
    await verifyInitial(checks);
    const handle = requestHistoryDb();
    advance(1000);
    await openRequestHistoryIndex();
    await until(() => checks.length === 2);
    checks[1]!.resolve(false);
    await Bun.sleep(0);
    expect((await queryRequestHistory({}, undefined, 10)).rows).toHaveLength(4);
    expect(requestHistoryDb()).not.toBe(handle);
    expect(checks).toHaveLength(2);
    expect(readFileSync(usageLogPath())).toEqual(canonical);
  });

  test("worker spawn failures observe cooldown and never delete an unverified index", async () => {
    await existingIndex();
    let clock = 0;
    let spawns = 0;
    setRequestHistoryIntegrityOptionsForTests({
      now: () => clock,
      failureCooldownMs: 100,
      createJob: () => { spawns += 1; throw new Error("worker unavailable"); },
    });
    await expect(openRequestHistoryIndex()).rejects.toBeInstanceOf(RequestHistoryIndexBusyError);
    const handle = requestHistoryDb();
    await expect(openRequestHistoryIndex()).rejects.toBeInstanceOf(RequestHistoryIndexBusyError);
    expect(spawns).toBe(1);
    clock = 100;
    await expect(openRequestHistoryIndex()).rejects.toBeInstanceOf(RequestHistoryIndexBusyError);
    expect(spawns).toBe(2);
    expect(requestHistoryDb()).toBe(handle);
    expect(handle.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 4 });
  });

  test("the real worker detects an unqueried damaged B-tree and rebuilds from untouched canonical rows", async () => {
    const path = await existingIndex();
    const canonical = readFileSync(usageLogPath());
    const damaged = new Database(path);
    try {
      corruptModelIndex(damaged, path);
      expect(damaged.query("SELECT value FROM schema_meta WHERE key = ?").get(HISTORY_META_KEYS.schemaVersion))
        .toEqual({ value: String(HISTORY_SCHEMA_VERSION) });
      expect(damaged.query("SELECT request_id FROM requests ORDER BY timestamp DESC, request_id DESC LIMIT 1").get())
        .toEqual({ request_id: "req-3" });
      expect(() => damaged.query("SELECT request_id FROM requests INDEXED BY idx_requests_model WHERE model = ?").all("m1"))
        .toThrow();
    } finally { damaged.close(); }
    setRequestHistoryWorkerRebuildMinBytesForTests(0);
    const repaired = await queryRequestHistory({ model: "m1" }, undefined, 10);
    expect(repaired.rows.map(row => row.requestId)).toEqual(["req-3", "req-2", "req-1", "req-0"]);
    expect(repaired.meta.lastError).toMatch(/rebuilt|integrity|corrupt/i);
    expect(readFileSync(usageLogPath())).toEqual(canonical);
  });

  test("corruption encountered by a live query rebuilds once even before the next periodic check", async () => {
    const path = await existingIndex();
    await openRequestHistoryIndex();
    const original = requestHistoryDb();
    const canonical = readFileSync(usageLogPath());
    corruptModelIndex(original, path);
    let reads = 0;
    const rows = await withRequestHistoryRead(handle => {
      reads += 1;
      return handle.query("SELECT request_id FROM requests INDEXED BY idx_requests_model WHERE model = ? ORDER BY request_id").all("m1");
    });
    expect(reads).toBe(2);
    expect(rows).toEqual([0, 1, 2, 3].map(index => ({ request_id: `req-${index}` })));
    expect(requestHistoryDb()).not.toBe(original);
    expect(readFileSync(usageLogPath())).toEqual(canonical);
  });

  test("routing analytics recovers a corrupted model index through its read wrapper", async () => {
    const path = await existingIndex();
    await openRequestHistoryIndex();
    const handle = requestHistoryDb();
    const canonical = readFileSync(usageLogPath());
    corruptModelIndex(handle, path);
    const analytics = await computeRoutingAnalytics({ model: "m1" });
    expect(analytics.totalRequests).toBe(4);
    expect(analytics.successRate).toBe(1);
    expect(requestHistoryDb()).not.toBe(handle);
    expect(readFileSync(usageLogPath())).toEqual(canonical);
  });

  test("routing health marks query corruption for repair and recovers current historical evidence", async () => {
    const path = await existingIndex();
    const now = Date.now();
    appendUsageEntry(entry("recent", now));
    await openRequestHistoryIndex();
    const input = { provider: "a", model: "m1", now };
    expect(healthEvidenceForCandidate(input).sampleCount).toBe(1);
    clearHealthHistoryCacheForTests();
    // The read above left this index's pages in the connection's page cache, and PRAGMA
    // shrink_memory does not evict them on every SQLite build (macOS links the system library).
    // Corrupt through a fresh connection, as the other corruption cases do.
    closeRequestHistoryIndex();
    await openRequestHistoryIndex();
    const handle = requestHistoryDb();
    const canonical = readFileSync(usageLogPath());
    corruptModelIndex(handle, path, healthQueryIndex(handle));
    expect(healthEvidenceForCandidate(input)).toEqual({});
    expect((await openRequestHistoryIndex()).indexedRows).toBe(5);
    expect(requestHistoryDb()).not.toBe(handle);
    clearHealthHistoryCacheForTests();
    const repaired = healthEvidenceForCandidate(input);
    expect(repaired.sampleCount).toBe(1);
    expect(repaired.successRate).toBe(1);
    expect(readFileSync(usageLogPath())).toEqual(canonical);
  });

  test("tail ingestion recovers corruption in a secondary index before inserting the appended row", async () => {
    const path = await existingIndex();
    await openRequestHistoryIndex();
    const handle = requestHistoryDb();
    corruptModelIndex(handle, path);
    appendUsageEntry(entry("after-corruption", 2000));
    const canonical = readFileSync(usageLogPath());
    const page = await queryRequestHistory({ model: "m1" }, undefined, 10);
    expect(page.rows.map(row => row.requestId)).toEqual(["after-corruption", "req-3", "req-2", "req-1", "req-0"]);
    expect(page.meta.indexedRows).toBe(5);
    expect(requestHistoryDb()).not.toBe(handle);
    expect(readFileSync(usageLogPath())).toEqual(canonical);
  });

  test("query retries are bounded and ordinary SQLite lock errors do not recreate the index", async () => {
    await existingIndex();
    await openRequestHistoryIndex();
    const handle = requestHistoryDb();
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    let reads = 0;
    await expect(withRequestHistoryRead(() => { reads += 1; throw busy; })).rejects.toBe(busy);
    expect(reads).toBe(1);
    expect(requestHistoryDb()).toBe(handle);
    const corrupt = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
    reads = 0;
    await expect(withRequestHistoryRead(() => { reads += 1; throw corrupt; })).rejects.toBe(corrupt);
    expect(reads).toBe(2);
  });

  test("extended SQLite corruption codes are repairable while operational failures are not", () => {
    for (const error of [
      { code: "SQLITE_CORRUPT" }, { code: "SQLITE_CORRUPT_INDEX" }, { code: "SQLITE_NOTADB" },
      { errno: 11 }, { errno: 267 }, { errno: 26 },
    ]) expect(isHistoryIndexCorruption(error)).toBe(true);
    for (const error of [
      { code: "SQLITE_BUSY", errno: 5 }, { code: "SQLITE_LOCKED", errno: 6 },
      { code: "SQLITE_IOERR", errno: 10 }, { code: "SQLITE_FULL", errno: 13 },
      { code: "SQLITE_CANTOPEN", errno: 14 }, new Error("database disk image is malformed"), null,
    ]) expect(isHistoryIndexCorruption(error)).toBe(false);
  });

  test("a cancelled check holds the replacement barrier until its actual exit callback", async () => {
    const checks: Check[] = [];
    const exits: Array<() => void> = [];
    const monitor = new RequestHistoryIntegrityMonitor({
      createJob: () => ({
        check: (path: string) => new Promise<boolean>((resolve, reject) => { checks.push({ path, resolve, reject }); }),
        dispose: async () => {},
        // Simulate bounded disposal returning while the native thread is still alive.
        afterExit: async (cleanup: () => void) => { exits.push(cleanup); },
      }),
    });
    const first = monitor.inspect({}, "index.sqlite");
    if (first.state !== "pending") throw new Error("initial check must be pending");
    await until(() => checks.length === 1);
    monitor.reset();
    const replacement = {};
    const blocked = monitor.inspect(replacement, "index.sqlite");
    expect(blocked.state).toBe("pending");
    await until(() => exits.length === 1);
    let released = false;
    void first.promise.then(() => { released = true; });
    checks[0]!.resolve(false);
    await Bun.sleep(0);
    expect(released).toBe(false);
    expect(checks).toHaveLength(1);
    exits[0]!();
    await first.promise;
    const next = monitor.inspect(replacement, "index.sqlite");
    if (next.state !== "pending") throw new Error("replacement needs its own check");
    await until(() => checks.length === 2);
    checks[1]!.resolve(true);
    await until(() => exits.length === 2);
    exits[1]!();
    await next.promise;
    expect(monitor.inspect(replacement, "index.sqlite").state).toBe("ready");
  });

  test("a delayed healthy check cannot clear corruption reported by a statement", async () => {
    let clock = 0;
    let finish: ((healthy: boolean) => void) | undefined;
    let released = false;
    const monitor = new RequestHistoryIntegrityMonitor({
      now: () => clock,
      intervalMs: 100,
      createJob: () => ({
        check: () => new Promise<boolean>(resolve => { finish = resolve; }),
        dispose: async () => {},
        afterExit: async (cleanup: () => void) => { released = true; cleanup(); },
      }),
    });
    const handle = {};
    monitor.acceptRebuilt(handle, "index.sqlite");
    clock = 100;
    expect(monitor.inspect(handle, "index.sqlite").state).toBe("ready");
    await until(() => finish !== undefined);
    monitor.markCorrupt(handle);
    finish!(true);
    await until(() => released);
    await Bun.sleep(0);
    expect(monitor.inspect(handle, "index.sqlite").state).toBe("corrupt");
  });
});
