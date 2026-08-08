import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import {
  appendUsageEntry,
  resetUsageReadCacheForTests,
  usageLogPath,
  type PersistedUsageEntry,
} from "../src/usage/log";
import {
  closeRequestHistoryIndex,
  queryRequestHistory,
  rebuildRequestHistoryIndex,
  requestHistoryRowById,
  REQUEST_HISTORY_MAX_RECORD_BYTES,
  REQUEST_HISTORY_MAX_PAGE_SIZE,
  REQUEST_HISTORY_READ_CHUNK_BYTES,
} from "../src/routing/history/indexer";
import { InvalidCursorError } from "../src/routing/history/cursor";
import { HISTORY_DB_FILENAME } from "../src/routing/history/schema";
import { getConfigDir } from "../src/config";
import type { OcxConfig } from "../src/types";

let testDir = "";
let previousHome: string | undefined;

function entry(
  requestId: string,
  timestamp: number,
  provider = "a",
  model = "m1",
  overrides: Partial<PersistedUsageEntry> = {},
): PersistedUsageEntry {
  return {
    requestId,
    timestamp,
    provider,
    model,
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    ...overrides,
  };
}

function seedRows(count: number, startTimestamp = 1000, provider = "a"): PersistedUsageEntry[] {
  const rows: PersistedUsageEntry[] = [];
  for (let index = 0; index < count; index++) {
    rows.push(entry(`req-${index}`, startTimestamp + index, provider, `m${index % 3}`));
  }
  return rows;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-history-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
});

afterEach(() => {
  closeRequestHistoryIndex();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: { a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] } },
  };
}

async function apiGet(path: string): Promise<Response> {
  const req = new ManagementRequest(`http://localhost${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config(), {
    refreshCodexCatalog: async () => {},
  });
  expect(response).not.toBeNull();
  return response!;
}

describe("request-history index (RI-02)", () => {
  test("missing database and empty history produce an empty page", async () => {
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.meta.indexedRows).toBe(0);
    expect(page.meta.schemaVersion).toBe(1);
    expect(existsSync(join(getConfigDir(), HISTORY_DB_FILENAME))).toBe(true);
  });

  test("indexes appended rows incrementally", async () => {
    for (const row of seedRows(5)) appendUsageEntry(row);
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.length).toBe(5);
    expect(page.meta.indexedRows).toBe(5);
    const offsetAfterInitial = page.meta.indexedOffset;
    expect(page.meta.lastError).not.toMatch(/identity changed/i);
    // New appends are picked up without a rebuild.
    appendUsageEntry(entry("req-late", 9000));
    const after = await queryRequestHistory({}, undefined, 10);
    expect(after.rows.length).toBe(6);
    expect(after.meta.indexedRows).toBe(6);
    expect(after.meta.indexedOffset).toBeGreaterThan(offsetAfterInitial);
    expect(after.meta.lastError).not.toMatch(/identity changed/i);
  });

  test("appended rows are ingested as a tail, never a full rebuild", async () => {
    for (const row of seedRows(5)) appendUsageEntry(row);
    const first = await queryRequestHistory({}, undefined, 10);
    expect(first.meta.indexedRows).toBe(5);
    // A subsequent append is ingested from the indexed offset and clears the
    // rebuild marker (routing-time health reads depend on this not re-parsing
    // the whole ledger synchronously).
    appendUsageEntry(entry("late-1", 7000));
    const second = await queryRequestHistory({}, undefined, 10);
    expect(second.meta.indexedRows).toBe(6);
    expect(second.meta.lastError).toBe("");
    appendUsageEntry(entry("late-2", 8000));
    const third = await queryRequestHistory({}, undefined, 10);
    expect(third.meta.indexedRows).toBe(7);
    expect(third.meta.lastError).toBe("");
  });

  test("rows missing mandatory columns are skipped, not rejected", async () => {
    for (const row of seedRows(3)) appendUsageEntry(row);
    const { appendFileSync } = await import("node:fs");
    const { usageLogPath } = await import("../src/usage/log");
    // A complete row is indexable even with no usage details.
    appendFileSync(
      usageLogPath(),
      JSON.stringify({ requestId: "lean", timestamp: 9000, provider: "a", model: "m1", status: 200, durationMs: 5 }) + "\n",
      "utf-8",
    );
    // A row missing mandatory NOT NULL columns (model/status/durationMs) must
    // be skipped by the parser instead of throwing during the insert.
    appendFileSync(
      usageLogPath(),
      JSON.stringify({ requestId: "broken", timestamp: 9001, provider: "a" }) + "\n",
      "utf-8",
    );
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.some(row => row.requestId === "lean")).toBe(true);
    expect(page.rows.some(row => row.requestId === "broken")).toBe(false);
  });

  test("large history indexes fully and paginates without duplicates or misses", async () => {
    const rows = seedRows(1500, 10_000);
    for (const row of rows) appendUsageEntry(row);
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await queryRequestHistory({}, cursor, 100);
      for (const row of page.rows) {
        expect(seen.has(row.requestId)).toBe(false);
        seen.add(row.requestId);
      }
      pages += 1;
      cursor = page.nextCursor;
      expect(page.hasMore).toBe(cursor !== undefined);
      if (!page.hasMore) break;
    } while (pages < 100);
    expect(seen.size).toBe(1500);
    expect(pages).toBe(15);
  });

  test("corrupt database is repaired by a full rebuild without losing canonical rows", async () => {
    for (const row of seedRows(8)) appendUsageEntry(row);
    await queryRequestHistory({}, undefined, 10);
    closeRequestHistoryIndex();
    const dbFile = join(getConfigDir(), HISTORY_DB_FILENAME);
    writeFileSync(dbFile, "this is not a sqlite file at all");
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.length).toBe(8);
    expect(page.meta.lastError).toContain("rebuilt");
  });

  test("old schema version triggers a rebuild", async () => {
    for (const row of seedRows(4)) appendUsageEntry(row);
    await queryRequestHistory({}, undefined, 10);
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(getConfigDir(), HISTORY_DB_FILENAME));
    db.query("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'").run();
    db.close();
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.length).toBe(4);
    expect(page.meta.schemaVersion).toBe(1);
  });

  test("partial final JSONL line is skipped until it completes", async () => {
    for (const row of seedRows(3)) appendUsageEntry(row);
    const completeOffset = statSync(usageLogPath()).size;
    // Append a partial line without a trailing newline.
    appendFileSync(usageLogPath(), '{"requestId":"req-partial","timestamp":', "utf-8");
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.length).toBe(3);
    expect(page.meta.indexedRows).toBe(3);
    expect(page.meta.indexedOffset).toBe(completeOffset);
    // Completing the line makes it indexable on the next refresh.
    appendFileSync(usageLogPath(), '9999,"provider":"a","model":"m1","status":200,"durationMs":1,"usageStatus":"reported"}\n', "utf-8");
    const after = await queryRequestHistory({}, undefined, 10);
    expect(after.rows.length).toBe(4);
    expect(after.rows.filter(row => row.requestId === "req-partial")).toHaveLength(1);
    expect(after.meta.indexedOffset).toBe(statSync(usageLogPath()).size);
  });

  test("streaming refresh indexes a valid record that crosses a read chunk", async () => {
    const large = entry("chunk-spanning", 9998, "a", "m1", {
      apiKeyId: "x".repeat(REQUEST_HISTORY_READ_CHUNK_BYTES + 1024),
    });
    const line = `${JSON.stringify(large)}\n`;
    expect(Buffer.byteLength(line)).toBeGreaterThan(REQUEST_HISTORY_READ_CHUNK_BYTES);
    expect(Buffer.byteLength(line)).toBeLessThan(REQUEST_HISTORY_MAX_RECORD_BYTES);
    appendFileSync(usageLogPath(), line, "utf-8");

    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.map(row => row.requestId)).toEqual(["chunk-spanning"]);
    expect(page.meta.indexedOffset).toBe(statSync(usageLogPath()).size);
  });

  test("streaming refresh skips an oversized record without changing the canonical log", async () => {
    const oversized = entry("oversized", 9998, "a", "m1", {
      apiKeyId: "x".repeat(REQUEST_HISTORY_MAX_RECORD_BYTES + 1),
    });
    const oversizedLine = `${JSON.stringify(oversized)}\n`;
    expect(Buffer.byteLength(oversizedLine)).toBeGreaterThan(REQUEST_HISTORY_MAX_RECORD_BYTES);
    appendFileSync(usageLogPath(), oversizedLine, "utf-8");
    appendUsageEntry(entry("after-oversized", 9999));
    const canonical = readFileSync(usageLogPath());

    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.map(row => row.requestId)).toEqual(["after-oversized"]);
    expect(page.meta.indexedRows).toBe(1);
    expect(page.meta.indexedOffset).toBe(canonical.byteLength);
    expect(readFileSync(usageLogPath())).toEqual(canonical);
  });

  test("duplicate replay is ignored", async () => {
    for (let index = 0; index < 3; index++) appendUsageEntry(entry(`dup-${index}`, 1000 + index));
    // Re-append the same request ids (as if the file were replayed).
    for (let index = 0; index < 3; index++) appendUsageEntry(entry(`dup-${index}`, 1000 + index));
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.length).toBe(3);
    expect(page.meta.indexedRows).toBe(3);
  });

  test("JSONL truncation triggers a rebuild that mirrors the truncated ledger", async () => {
    for (const row of seedRows(10)) appendUsageEntry(row);
    await queryRequestHistory({}, undefined, 10);
    const { usageLogPath } = await import("../src/usage/log");
    truncateSync(usageLogPath(), 0);
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.length).toBe(0);
    expect(page.meta.indexedRows).toBe(0);
  });

  test("JSONL replacement (new file identity) rebuilds from the new ledger", async () => {
    for (const row of seedRows(5, 500)) appendUsageEntry(row);
    await queryRequestHistory({}, undefined, 10);
    const { usageLogPath } = await import("../src/usage/log");
    // Replace the file wholesale (new inode on most platforms).
    rmSync(usageLogPath(), { force: true });
    for (const row of seedRows(7, 7000, "b")) appendUsageEntry(row);
    const page = await queryRequestHistory({}, undefined, 10);
    expect(page.rows.length).toBe(7);
    expect(page.rows.every(row => row.provider === "b")).toBe(true);
  });

  test("filters: provider, model, status, conversationId, surface, date range", async () => {
    appendUsageEntry(entry("f1", 1000, "a", "m1", { conversationId: "conv-1", surface: "claude" }));
    appendUsageEntry(entry("f2", 2000, "b", "m2", { status: 429, conversationId: "conv-2" }));
    appendUsageEntry(entry("f3", 3000, "a", "m2", { surface: "grok" }));
    const byProvider = await queryRequestHistory({ provider: "a" }, undefined, 10);
    expect(byProvider.rows.map(row => row.requestId).sort()).toEqual(["f1", "f3"]);
    const byStatus = await queryRequestHistory({ status: 429 }, undefined, 10);
    expect(byStatus.rows.map(row => row.requestId)).toEqual(["f2"]);
    const byConversation = await queryRequestHistory({ conversationId: "conv-1" }, undefined, 10);
    expect(byConversation.rows.map(row => row.requestId)).toEqual(["f1"]);
    const bySurface = await queryRequestHistory({ surface: "grok" }, undefined, 10);
    expect(bySurface.rows.map(row => row.requestId)).toEqual(["f3"]);
    const byRange = await queryRequestHistory({ from: 1500, to: 2500 }, undefined, 10);
    expect(byRange.rows.map(row => row.requestId)).toEqual(["f2"]);
  });

  test("row-by-id returns the canonical entry and unknown ids 404 through the API", async () => {
    appendUsageEntry(entry("target-id", 1234));
    const row = await requestHistoryRowById("target-id");
    expect(row?.requestId).toBe("target-id");
    expect(await requestHistoryRowById("missing")).toBeNull();

    const found = await apiGet("/api/request-history/target-id");
    expect(found.status).toBe(200);
    const body = await found.json() as { requestId?: string };
    expect(body.requestId).toBe("target-id");

    const missing = await apiGet("/api/request-history/missing");
    expect(missing.status).toBe(404);

    const malformed = await apiGet("/api/request-history/%");
    expect(malformed.status).toBe(404);
  });

  test("API list endpoint returns entries, cursor, hasMore and index status", async () => {
    for (const row of seedRows(5)) appendUsageEntry(row);
    const response = await apiGet("/api/request-history?limit=2");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      entries: Array<{ requestId?: string }>;
      nextCursor?: string;
      hasMore: boolean;
      index: { schemaVersion: number; indexedRows: number };
    };
    expect(body.entries.length).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe("string");
    expect(body.index.schemaVersion).toBe(1);
    expect(body.index.indexedRows).toBe(5);
  });

  test("invalid cursor returns 400 invalid_cursor; invalid limit returns 400", async () => {
    for (const row of seedRows(3)) appendUsageEntry(row);
    const badCursor = await apiGet("/api/request-history?cursor=not-a-cursor");
    expect(badCursor.status).toBe(400);
    const badCursorBody = await badCursor.json() as { error?: { code?: string } };
    expect(badCursorBody.error?.code).toBe("invalid_cursor");

    const badLimit = await apiGet("/api/request-history?limit=9999");
    expect(badLimit.status).toBe(400);
    const badLimitBody = await badLimit.json() as { error?: { code?: string } };
    expect(badLimitBody.error?.code).toBe("invalid_limit");

    const badStatus = await apiGet("/api/request-history?status=42");
    expect(badStatus.status).toBe(400);
    const badStatusText = await apiGet("/api/request-history?status=abc");
    expect(badStatusText.status).toBe(400);
    const badStatusTextBody = await badStatusText.json() as { error?: { code?: string } };
    expect(badStatusTextBody.error?.code).toBe("invalid_status");

    const badFrom = await apiGet("/api/request-history?from=abc");
    expect(badFrom.status).toBe(400);

    const badRange = await apiGet("/api/request-history?from=2000&to=1000");
    expect(badRange.status).toBe(400);
    const badRangeBody = await badRange.json() as { error?: { code?: string } };
    expect(badRangeBody.error?.code).toBe("invalid_range");

    await expect(queryRequestHistory({}, "garbage-cursor", 10)).rejects.toBeInstanceOf(InvalidCursorError);
  });

  test("page size is bounded at the indexer level", async () => {
    for (const row of seedRows(120)) appendUsageEntry(row);
    const page = await queryRequestHistory({}, undefined, 9999);
    expect(page.rows.length).toBe(REQUEST_HISTORY_MAX_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
  });

  test("index rebuild equivalence: rebuilt rows match the ledger exactly", async () => {
    const rows = seedRows(25, 42);
    for (const row of rows) appendUsageEntry(row);
    await queryRequestHistory({}, undefined, 10);
    const canonicalIds = rows.map(row => row.requestId).sort();
    const rebuilt = await rebuildRequestHistoryIndex();
    expect(rebuilt.indexedRows).toBe(25);
    const page = await queryRequestHistory({}, undefined, 100);
    expect(page.rows.map(row => row.requestId).sort()).toEqual(canonicalIds);
  });

  test("cursor stays stable while appends arrive between pages", async () => {
    for (const row of seedRows(6, 1000)) appendUsageEntry(row);
    const first = await queryRequestHistory({}, undefined, 3);
    // New rows with HIGHER timestamps must not shift the keyset window.
    for (const row of seedRows(3, 9000)) appendUsageEntry(row);
    const second = await queryRequestHistory({}, first.nextCursor, 3);
    const ids = [...first.rows, ...second.rows].map(row => row.requestId);
    expect(ids).toEqual(["req-5", "req-4", "req-3", "req-2", "req-1", "req-0"]);
    expect(second.hasMore).toBe(false);
  });
});
