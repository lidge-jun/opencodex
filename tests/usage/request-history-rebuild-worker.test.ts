/**
 * Large request-history rebuilds run on a worker thread (#6990): the serving
 * thread only swaps the finished file in, routing-time reads never wait, and a
 * close or a replaced ledger never leaves a partial index or a stray build file.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import {
  appendUsageEntry,
  currentUsageLogRevision,
  resetUsageReadCacheForTests,
  usageLogPath,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import {
  closeRequestHistoryIndex,
  openRequestHistoryIndex,
  openRequestHistoryIndexSync,
  rebuildRequestHistoryIndex,
  requestHistoryDb,
  RequestHistoryIndexBusyError,
  RequestHistoryIndexClosedError,
  REQUEST_HISTORY_MAX_RECORD_BYTES,
  setRequestHistoryAsyncRefreshBuildsForTests,
  setRequestHistoryRebuildJobFactoryForTests,
  setRequestHistoryWorkerRebuildMinBytesForTests,
} from "../../src/routing/history/indexer";
import { buildFilePath, buildIndexFile } from "../../src/routing/history/build-file";
import { ingestSourceTail, metaValue, resetAndCreateSchema, RequestHistoryIndexStaleError } from "../../src/routing/history/ingest";
import { HISTORY_DB_FILENAME, HISTORY_META_KEYS } from "../../src/routing/history/schema";
import { getConfigDir } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

function entry(requestId: string, timestamp: number, overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId,
    timestamp,
    provider: "a",
    model: `m${timestamp % 3}`,
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    ...overrides,
  };
}

function ledgerLines(count: number, prefix = "req"): string {
  let text = "";
  for (let index = 0; index < count; index++) text += JSON.stringify(entry(`${prefix}-${index}`, 1000 + index)) + "\n";
  return text;
}

function writeLedger(text: string): void {
  // Replace the file, as retention does, so every ledger here is a new identity.
  const path = usageLogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.next`, text);
  renameSync(`${path}.next`, path);
}

function indexPath(): string {
  return join(getConfigDir(), HISTORY_DB_FILENAME);
}

function buildFilesLeft(): string[] {
  return readdirSync(getConfigDir()).filter(name => name.includes(".rebuild-"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

function snapshotIndex(): { rows: Array<{ request_id: string; row_json: string }>; offset: number; indexedRows: number; sourceSize: number } {
  const handle = requestHistoryDb();
  const meta = Object.fromEntries(
    (handle.query("SELECT key, value FROM schema_meta").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value]),
  );
  return {
    rows: handle.query("SELECT request_id, row_json FROM requests ORDER BY request_id").all() as Array<{ request_id: string; row_json: string }>,
    offset: Number(meta.indexed_offset),
    indexedRows: Number(meta.indexed_rows),
    sourceSize: Number(meta.source_size),
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-history-worker-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
  // Every ledger in this file takes the worker path unless a test says otherwise.
  setRequestHistoryWorkerRebuildMinBytesForTests(0);
});

afterEach(async () => {
  closeRequestHistoryIndex();
  setRequestHistoryWorkerRebuildMinBytesForTests(undefined);
  setRequestHistoryAsyncRefreshBuildsForTests(undefined);
  setRequestHistoryRebuildJobFactoryForTests(undefined);
  // A disposed worker's build files go only after its thread exits.
  await waitFor(() => buildFilesLeft().length === 0);
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(testDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("request-history worker rebuild (#6990)", () => {
  test("the worker build equals the inline build on an edge-case ledger", async () => {
    const oversized = JSON.stringify(entry("too-big", 5, { errorCode: "x".repeat(REQUEST_HISTORY_MAX_RECORD_BYTES + 16) }));
    writeLedger(
      ledgerLines(1_200)
      + "{not json\n"
      + oversized + "\n"
      + JSON.stringify(entry("after-oversized", 9_000)) + "\n"
      + "\n"
      + JSON.stringify(entry("partial", 9_001)).slice(0, 40),
    );

    setRequestHistoryWorkerRebuildMinBytesForTests(Number.POSITIVE_INFINITY);
    await rebuildRequestHistoryIndex();
    const inline = snapshotIndex();
    closeRequestHistoryIndex();

    setRequestHistoryWorkerRebuildMinBytesForTests(0);
    await rebuildRequestHistoryIndex();
    const worker = snapshotIndex();

    expect(inline.indexedRows).toBe(1_201);
    expect(worker.rows).toEqual(inline.rows);
    expect(worker.offset).toBe(inline.offset);
    expect(worker.indexedRows).toBe(inline.indexedRows);
    expect(worker.sourceSize).toBe(inline.sourceSize);
    expect(buildFilesLeft()).toEqual([]);
  });

  test("a worker rebuild lets the event loop run; an inline one does not", async () => {
    writeLedger(ledgerLines(2_000));
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    const meta = await openRequestHistoryIndex();
    expect(meta.indexedRows).toBe(2_000);
    expect(ticked).toBe(true);

    // Control: the same refresh inline finishes before any timer can run, so
    // the assertion above really distinguishes the two paths.
    closeRequestHistoryIndex();
    setRequestHistoryWorkerRebuildMinBytesForTests(Number.POSITIVE_INFINITY);
    writeLedger(ledgerLines(2_000, "inline"));
    ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    const inlineMeta = await openRequestHistoryIndex();
    expect(inlineMeta.indexedRows).toBe(2_000);
    expect(ticked).toBe(false);
  });

  test("routing-time reads report busy during the build and use the index once it is swapped in", async () => {
    writeLedger(ledgerLines(500));
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    // The second call joins the running build instead of starting another.
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    const meta = await openRequestHistoryIndex();
    expect(meta.indexedRows).toBe(500);
    expect(openRequestHistoryIndexSync().indexedRows).toBe(500);
    expect(buildFilesLeft()).toEqual([]);
  });

  test("the build that reaches the wait limit still returns its index", async () => {
    // With the limit at one build, the first build is also the last a reader
    // waits for; its successful swap must be served, not reported busy.
    setRequestHistoryAsyncRefreshBuildsForTests(1);
    writeLedger(ledgerLines(200));
    const meta = await openRequestHistoryIndex();
    expect(meta.indexedRows).toBe(200);
  });

  test("after a worker fails, async readers rebuild inline and routing stays busy", async () => {
    // A worker that spawns and then fails (a module that will not load, say).
    let builds = 0;
    setRequestHistoryRebuildJobFactoryForTests(() => ({
      build: async () => { builds += 1; throw new Error("worker module failed to load"); },
      dispose: async () => {},
      afterExit: async (cleanup: () => void) => { cleanup(); },
    }));
    writeLedger(ledgerLines(250));
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    await Bun.sleep(10);
    // During the cooldown routing neither respawns the worker nor rebuilds inline.
    expect(() => openRequestHistoryIndexSync()).toThrow(/rebuild failed recently/);
    expect(builds).toBe(1);
    const meta = await openRequestHistoryIndex();
    expect(meta.indexedRows).toBe(250);
    expect(builds).toBe(1);
    expect(openRequestHistoryIndexSync().indexedRows).toBe(250);
  });

  test("a manual rebuild falls back inline when its worker fails", async () => {
    setRequestHistoryRebuildJobFactoryForTests(() => ({
      build: async () => { throw new Error("worker exited"); },
      dispose: async () => {},
      afterExit: async (cleanup: () => void) => { cleanup(); },
    }));
    writeLedger(ledgerLines(180));
    const meta = await rebuildRequestHistoryIndex();
    expect(meta.indexedRows).toBe(180);
    expect(meta.lastError).toBe("manual rebuild requested");
  });

  test("rows appended during the build arrive as a tail after the swap", async () => {
    writeLedger(ledgerLines(300));
    const pending = openRequestHistoryIndex();
    // The refresh recorded the ledger size before this append; the worker stops there.
    appendUsageEntry(entry("late-1", 50_000));
    appendUsageEntry(entry("late-2", 50_001));
    const meta = await pending;
    expect(meta.indexedRows).toBe(302);
    expect(meta.indexedOffset).toBe(currentUsageLogRevision()!.size);
  });

  test("a ledger replaced under the build restarts it against the new ledger", async () => {
    writeLedger(ledgerLines(400, "old"));
    const pending = openRequestHistoryIndex();
    writeLedger(ledgerLines(150, "new"));
    const meta = await pending;
    expect(meta.indexedRows).toBe(150);
    const ids = (requestHistoryDb().query("SELECT request_id FROM requests").all() as Array<{ request_id: string }>).map(row => row.request_id);
    expect(ids.every(id => id.startsWith("new-"))).toBe(true);
  });

  test("a close during the build rejects waiting readers and removes the build files", async () => {
    writeLedger(ledgerLines(3_000));
    const pending = openRequestHistoryIndex();
    closeRequestHistoryIndex();
    await expect(pending).rejects.toBeInstanceOf(RequestHistoryIndexClosedError);
    expect(await waitFor(() => buildFilesLeft().length === 0)).toBe(true);
    // The discarded build was never swapped in: the next open rebuilds from scratch.
    const meta = await openRequestHistoryIndex();
    expect(meta.indexedRows).toBe(3_000);
  });

  test("history endpoints wait for the worker build instead of failing", async () => {
    writeLedger(ledgerLines(120));
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: { a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] } },
    };
    const req = new ManagementRequest("http://localhost/api/request-history?limit=5", { method: "GET" });
    const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
    expect(response!.status).toBe(200);
    const body = await response!.json() as { entries: unknown[]; index: { indexedRows: number } };
    expect(body.entries.length).toBe(5);
    expect(body.index.indexedRows).toBe(120);
  });

  test("the worker sweeps build files abandoned by a dead process and keeps its own", async () => {
    const child = Bun.spawn([process.execPath, "-e", ""]);
    await child.exited;
    mkdirSync(getConfigDir(), { recursive: true });
    const dead = buildFilePath(indexPath(), child.pid, 1);
    const own = buildFilePath(indexPath(), process.pid, 999_999);
    for (const path of [dead, `${dead}-wal`, own]) writeFileSync(path, "stale");
    writeLedger(ledgerLines(50));
    await openRequestHistoryIndex();
    const left = buildFilesLeft();
    expect(left).toEqual([own.slice(getConfigDir().length + 1)]);
    // Leave nothing for afterEach to wait on.
    removeTreeWithRetry(own);
  });

  test("a build whose ledger is not the recorded file fails stale and leaves no file", () => {
    writeLedger(ledgerLines(10));
    const revision = currentUsageLogRevision()!;
    // NTFS file ids exceed 2^53, where a Number cannot tell id and id + 1 apart (#7070 on
    // Windows). The revision must carry the id exactly, and the neighbour must be rejected.
    const exact = statSync(usageLogPath(), { bigint: true });
    expect([revision.dev, revision.ino]).toEqual([exact.dev.toString(), exact.ino.toString()]);
    const buildPath = buildFilePath(join(testDir, "unit.sqlite"), process.pid, 1);
    expect(() => buildIndexFile(buildPath, "test", { ...revision, ino: (BigInt(revision.ino) + 1n).toString() }))
      .toThrow(RequestHistoryIndexStaleError);
    expect(readdirSync(testDir).filter(name => name.startsWith("unit.sqlite"))).toEqual([]);
  });
});

describe("request-history unchanged partial tail", () => {
  function withIndex(run: (handle: Database, path: string) => void): void {
    const handle = new Database(":memory:");
    try {
      resetAndCreateSchema(handle);
      run(handle, join(testDir, "partial.jsonl"));
    } finally {
      handle.close();
    }
  }

  test("unchanged tails do not reread bytes or rewrite SQLite metadata", () => {
    withIndex((handle, path) => {
      const complete = JSON.stringify(entry("complete", 1)) + "\n";
      const partial = JSON.stringify(entry("partial", 2));
      fs.writeFileSync(path, complete + partial);
      expect(ingestSourceTail(handle, path, 0)).toBe(1);
      const offset = Buffer.byteLength(complete);
      const changes = () => (handle.query("SELECT total_changes() AS n").get() as { n: number }).n;
      const before = changes();
      const read = spyOn(fs, "readSync");
      try {
        for (let index = 0; index < 3; index++) expect(ingestSourceTail(handle, path, offset)).toBe(0);
        expect(read).not.toHaveBeenCalled();
        expect(changes()).toBe(before);
        expect(Number(metaValue(handle, HISTORY_META_KEYS.indexedOffset))).toBe(offset);
        fs.appendFileSync(path, "\n");
        expect(ingestSourceTail(handle, path, offset)).toBe(1);
        expect(Number(metaValue(handle, HISTORY_META_KEYS.indexedRows))).toBe(2);
      } finally {
        read.mockRestore();
      }
    });
  });

  test("same-size edits, replacements and paths invalidate an observation", () => {
    withIndex((handle, path) => {
      fs.writeFileSync(path, "partial");
      ingestSourceTail(handle, path, 0);
      const read = spyOn(fs, "readSync");
      try {
        fs.writeFileSync(path, "changed");
        const clock = new Date(Date.now() - 10_000);
        fs.utimesSync(path, clock, clock);
        ingestSourceTail(handle, path, 0);
        expect(read).toHaveBeenCalledTimes(1);
        fs.writeFileSync(`${path}.next`, "replace");
        fs.renameSync(`${path}.next`, path);
        ingestSourceTail(handle, path, 0);
        expect(read).toHaveBeenCalledTimes(2);
        const other = `${path}.other`;
        fs.writeFileSync(other, "another");
        ingestSourceTail(handle, other, 0);
        expect(read).toHaveBeenCalledTimes(3);
      } finally {
        read.mockRestore();
      }
    });
  });

  test("schema reset and a new database handle do not reuse old tail state", () => {
    withIndex((handle, path) => {
      fs.writeFileSync(path, "partial");
      ingestSourceTail(handle, path, 0);
      const read = spyOn(fs, "readSync");
      const other = new Database(":memory:");
      try {
        resetAndCreateSchema(handle);
        ingestSourceTail(handle, path, 0);
        resetAndCreateSchema(other);
        ingestSourceTail(other, path, 0);
        expect(read).toHaveBeenCalledTimes(2);
      } finally {
        read.mockRestore();
        other.close();
      }
    });
  });

  test("worker snapshot bounds and expected identity are checked before reuse", () => {
    withIndex((handle, path) => {
      const text = JSON.stringify(entry("bounded", 1)) + "\n";
      fs.writeFileSync(path, text);
      expect(ingestSourceTail(handle, path, 0, { endOffset: 5 })).toBe(0);
      expect(ingestSourceTail(handle, path, 0)).toBe(1);
      resetAndCreateSchema(handle);
      fs.writeFileSync(path, "partial");
      ingestSourceTail(handle, path, 0);
      const exact = fs.statSync(path, { bigint: true });
      expect(() => ingestSourceTail(handle, path, 0, {
        expected: { dev: exact.dev.toString(), ino: (exact.ino + 1n).toString() },
      })).toThrow(RequestHistoryIndexStaleError);
    });
  });

  test("a failed read is retried rather than cached", () => {
    withIndex((handle, path) => {
      fs.writeFileSync(path, "partial");
      const original = fs.readSync;
      let reads = 0;
      const read = spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
        if (++reads === 1) throw new Error("synthetic ledger read failure");
        return original(...args);
      });
      try {
        expect(() => ingestSourceTail(handle, path, 0)).toThrow("synthetic ledger read failure");
        expect(ingestSourceTail(handle, path, 0)).toBe(0);
        expect(ingestSourceTail(handle, path, 0)).toBe(0);
        expect(reads).toBe(2);
      } finally {
        read.mockRestore();
      }
    });
  });

  test("a source changed during its read is not cached as fully observed", () => {
    withIndex((handle, path) => {
      fs.writeFileSync(path, "partial");
      const original = fs.readSync;
      let reads = 0;
      const read = spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
        const count = original(...args);
        if (++reads === 1) fs.appendFileSync(path, "-later");
        return count;
      });
      try {
        ingestSourceTail(handle, path, 0);
        ingestSourceTail(handle, path, 0);
        ingestSourceTail(handle, path, 0);
        expect(reads).toBe(2);
      } finally {
        read.mockRestore();
      }
    });
  });
});
