import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetAppOwnedMemoryForTests } from "../../src/lib/app-owned-memory";
import {
  getFilteredUsageAggregate,
  resetUsageAggregateCacheForTests,
} from "../../src/server/management/usage-aggregate-cache";
import {
  CANDIDATE_PAGE_SIZE,
  setUsageFilterIndexTestHooksForTests,
  usageFilterCandidatePlan,
  usageFilterIndexPath,
  USAGE_FILTER_INDEX_SCHEMA_VERSION,
} from "../../src/usage/filter-index";
import * as filterIndexModule from "../../src/usage/filter-index";
import { resetUsageReadCacheForTests, type PersistedUsageEntry } from "../../src/usage/log";
import { matchesUsageSource, type UsageSourceFilter } from "../../src/usage/source-filter";
import type { UsageTimeWindow } from "../../src/usage/time-range";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import type { OcxConfig } from "../../src/types/config";

/**
 * Paging contract for the filtered usage candidate index.
 *
 * These cases live beside `usage-filter-index.test.ts` rather than inside it: that file is at the
 * repository's line ratchet, and the paging access path has enough behaviour of its own to sit in
 * its own domain file.
 *
 * The contract under test is the one a deep page depends on. Every branch is one keyset statement
 * whose index supplies `ORDER BY byte_offset`, the pager merges branch pages into one ascending,
 * de-duplicated page bounded by `CANDIDATE_PAGE_SIZE`, and a page that fails because the
 * projection is damaged asks for a rebuild instead of returning a short result. The regression
 * these guard is measured: with an index ordered by `timestamp`, each page sorted the whole
 * candidate range, so a 400k-row page cost seconds against a sub-second streaming scan.
 */

const NOW = Date.parse("2026-09-01T10:00:00.000Z");
const PROVIDERS = ["openai", "anthropic", "google", "kimi", "grok", "deepseek", "mistral", "local"] as const;
const MODELS = ["m-0", "m-1", "m-2", "m-3", "m-4"] as const;

let testDir = "";
let previousHome: string | undefined;

function ledgerPath(): string {
  return join(testDir, "usage.jsonl");
}

/** Deterministic synthetic traffic: eight providers, five models, two keys, two clients. */
function syntheticRow(index: number): PersistedUsageEntry {
  const provider = PROVIDERS[index % PROVIDERS.length]!;
  const model = MODELS[Math.floor(index / PROVIDERS.length) % MODELS.length]!;
  return {
    requestId: `req-${index}`,
    timestamp: NOW - (index % 40) * 60_000,
    provider,
    model,
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 1, outputTokens: 1 },
    totalTokens: 2,
    client: index % 2 === 0 ? "codex_cli" : "claude_code",
    ...(index % 3 === 0
      ? { apiKeyId: "key-a", admissionKind: "configured" as const }
      : index % 3 === 1 ? { apiKeyId: "key-b", admissionKind: "configured" as const } : {}),
  };
}

function writeRows(rows: readonly PersistedUsageEntry[]): void {
  writeFileSync(ledgerPath(), rows.map(row => `${JSON.stringify(row)}\n`).join(""));
}

/** The byte offset each row starts at, in the order `writeRows` writes them. */
function rowOffsets(rows: readonly PersistedUsageEntry[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const row of rows) {
    offsets.push(offset);
    offset += Buffer.byteLength(`${JSON.stringify(row)}\n`);
  }
  return offsets;
}

function totalIndexRows(): number {
  const db = new Database(usageFilterIndexPath(testDir), { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS c FROM usage_rows").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-filter-paging-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
});

afterEach(() => {
  setUsageFilterIndexTestHooksForTests(null);
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

/** Read every candidate page for one query and return the concatenated offsets. */
async function readAllPages(query: {
  provider: string | null;
  model: string | null;
  apiKeyId: string | null;
  sourceFilter?: UsageSourceFilter;
  configuredApiKeyIds?: readonly string[];
  window?: UsageTimeWindow;
}): Promise<{ offsets: number[]; pages: number[]; candidateRows: number }> {
  const read = await filterIndexModule.readUsageFilterCandidates(query);
  expect(read).not.toBeNull();
  try {
    const offsets: number[] = [];
    const pages: number[] = [];
    for (;;) {
      const page = read!.nextPage();
      pages.push(page.length);
      offsets.push(...page);
      if (page.length === 0) break;
    }
    return { offsets, pages, candidateRows: read!.candidateRows };
  } finally {
    read!.close();
  }
}

describe("filtered usage index paging contract", () => {
  test("no paged branch sorts its candidate range", async () => {
    // The regression this guards: with `ORDER BY byteOffset` over an index whose ordered column
    // was `timestamp`, SQLite materialized and sorted every matching row on every page. A deep
    // page therefore cost seconds on a 400k-row ledger, more than the whole streaming scan it
    // exists to replace. Each branch must now be served in cursor order by its own index.
    writeRows(Array.from({ length: 50 }, (_, index) => syntheticRow(index)));
    await getFilteredUsageAggregate({ provider: "openai" });

    const cases: Array<[string, Parameters<typeof usageFilterCandidatePlan>[0]]> = [
      ["nonselective", { provider: null, model: null, apiKeyId: null }],
      ["api key", { provider: null, model: null, apiKeyId: "key-a" }],
      ["window", { provider: null, model: null, apiKeyId: null, window: { since: NOW - 60_000, until: NOW } }],
      ["client codex", {
        provider: null,
        model: null,
        apiKeyId: null,
        sourceFilter: { client: "codex", device: { kind: "all" } },
      }],
      ["device no-key", {
        provider: null,
        model: null,
        apiKeyId: null,
        sourceFilter: { client: "all", device: { kind: "no-key" } },
      }],
      ["device unconfigured", {
        provider: null,
        model: null,
        apiKeyId: null,
        sourceFilter: { client: "all", device: { kind: "unconfigured" } },
        configuredApiKeyIds: ["key-a"],
      }],
      ["provider only", { provider: "openai", model: null, apiKeyId: null }],
      ["model only", { provider: null, model: "m-0", apiKeyId: null }],
      ["provider and model", { provider: "openai", model: "m-0", apiKeyId: null }],
      ["provider and key and window", {
        provider: "openai",
        model: null,
        apiKeyId: "key-a",
        window: { since: NOW - 60_000, until: NOW },
      }],
    ];
    for (const [label, query] of cases) {
      const details = usageFilterCandidatePlan(query, { paged: true });
      // Every branch is a labeled block; `USE TEMP B-TREE` in any of them is the defect.
      expect({ label, sorts: details.filter(detail => /TEMP B-TREE/i.test(detail)) })
        .toEqual({ label, sorts: [] });
      // A plan that reported no branches would pass the sort check vacuously.
      expect(details.filter(detail => detail.startsWith("-- ")).length).toBeGreaterThan(0);
    }
  });

  test("every branch cursor advances in byte order across page boundaries", async () => {
    // A branch set that includes the multi-label codex expansion, so a merge that dropped or
    // reordered one branch's cursor is observable.
    const rows: PersistedUsageEntry[] = [];
    for (let index = 0; index < 4_500; index += 1) {
      const base = syntheticRow(index);
      rows.push({
        ...base,
        requestId: `page-${index}`,
        // Rotate the client so every branch contributes across page boundaries.
        client: (["codex_cli", "codex_desktop", "codex_ide", "claude_code"] as const)[index % 4],
        provider: index % 5 === 0 ? "local" : "openai",
      } as PersistedUsageEntry);
    }
    writeRows(rows);
    await getFilteredUsageAggregate({});

    const filter: UsageSourceFilter = { client: "codex", device: { kind: "all" } };
    const { offsets, pages, candidateRows } = await readAllPages({
      provider: null,
      model: null,
      apiKeyId: null,
      sourceFilter: filter,
    });

    // Strictly ascending, no duplicates: an over-filled branch page read twice would show here.
    expect(offsets.length).toBeGreaterThan(2_000);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(offsets.every((offset, index) => index === 0 || offsets[index - 1]! < offset)).toBe(true);
    expect(candidateRows).toBe(offsets.length);
    // More than one page was needed, and the last one was the empty terminator.
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[pages.length - 1]).toBe(0);
    expect(pages.slice(0, -1).every(size => size <= CANDIDATE_PAGE_SIZE)).toBe(true);

    // The page set is exactly the rows `matchesUsageSource` selects, in the same order.
    const expected = rows.filter(row => matchesUsageSource(row, filter, new Set())).length;
    expect(offsets.length).toBe(expected);
  });

  test("interleaved branches carry their surplus into the next page", async () => {
    // Two client labels alternate, so every page cut leaves both branches holding rows the page
    // did not need and the merge has to interleave two live cursors. Comparing the exact offset
    // list pins the order and completeness across those cuts: a merge that dropped, duplicated
    // or reordered a carried row is visible here, which a count alone would miss.
    const rows: PersistedUsageEntry[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      rows.push({
        ...syntheticRow(index),
        requestId: `interleave-${index}`,
        provider: index % 7 === 0 ? "local" : "openai",
        client: index % 2 === 0 ? "codex_cli" : "codex_desktop",
      } as PersistedUsageEntry);
    }
    writeRows(rows);
    await getFilteredUsageAggregate({});

    const filter: UsageSourceFilter = { client: "codex", device: { kind: "all" } };
    const { offsets, pages } = await readAllPages({
      provider: null,
      model: null,
      apiKeyId: null,
      sourceFilter: filter,
    });

    const starts = rowOffsets(rows);
    const expected = rows.flatMap((row, index) =>
      matchesUsageSource(row, filter, new Set()) ? [starts[index]!] : []);
    expect(offsets).toEqual(expected);
    // 5,000 matches at two labels alternating: two full pages, then a partial, then the terminator.
    expect(pages).toEqual([CANDIDATE_PAGE_SIZE, CANDIDATE_PAGE_SIZE, 1_000, 0]);
  });

  test("a read never pages past its snapshot while a concurrent refresh appends rows", async () => {
    // Each page is its own transaction, so another request can append rows to the same
    // generation while this read is still paging. The snapshot's indexed offset is where the
    // next unindexed row starts: a candidate at that offset belongs to rows appended after the
    // snapshot, and the row reader would reject it as content_changed on every retry.
    const rows = Array.from({ length: 4_500 }, (_, index) => ({
      ...syntheticRow(index),
      requestId: `snapshot-${index}`,
      provider: "openai",
    } as PersistedUsageEntry));
    writeRows(rows);
    await getFilteredUsageAggregate({});
    let snapshotRows = rows.length;
    for (const query of [
      { provider: null, model: null, apiKeyId: null },
      { provider: "openai", model: null, apiKeyId: null },
    ]) {
      const snapshotBytes = statSync(ledgerPath()).size;
      const read = await filterIndexModule.readUsageFilterCandidates(query);
      expect(read).not.toBeNull();
      try {
        const offsets = [...read!.nextPage()];
        appendFileSync(ledgerPath(), Array.from({ length: 5 }, (_, index) =>
          `${JSON.stringify({ ...syntheticRow(index), requestId: `late-${query.provider}-${index}`, provider: "openai" })}\n`).join(""));
        resetUsageAggregateCacheForTests();
        await getFilteredUsageAggregate(query);
        for (;;) {
          const page = read!.nextPage();
          if (page.length === 0) break;
          offsets.push(...page);
        }
        expect({ provider: query.provider, beyond: offsets.filter(offset => offset >= snapshotBytes) })
          .toEqual({ provider: query.provider, beyond: [] });
        expect(offsets.length).toBe(snapshotRows);
        snapshotRows += 5;
      } finally {
        read!.close();
      }
    }
  });

  test("a page is never longer than the page size", async () => {
    // Every row matches one attribution branch, so each fetch is a full page. The returned page
    // must still be cut at the page size and the cursor must advance monotonically.
    const rows = Array.from({ length: 3 * CANDIDATE_PAGE_SIZE }, (_, index) => ({
      ...syntheticRow(index),
      requestId: `limit-${index}`,
      provider: "openai",
    } as PersistedUsageEntry));
    writeRows(rows);
    await getFilteredUsageAggregate({});

    const { offsets, pages } = await readAllPages({ provider: "openai", model: null, apiKeyId: null });
    expect(offsets.length).toBe(rows.length);
    // Every non-terminal page is exactly the page size; a merge bug would overrun it.
    expect(pages.slice(0, -1)).toEqual([
      CANDIDATE_PAGE_SIZE,
      CANDIDATE_PAGE_SIZE,
      CANDIDATE_PAGE_SIZE,
    ]);
  });

  test("a corrupt projection rebuilds instead of serving a short page", async () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => ({ ...syntheticRow(index), provider: "openai" }));
    writeRows(rows);
    await getFilteredUsageAggregate({});

    // Paging cannot repair a damaged index. The reader must ask for a rebuild, and the retried
    // aggregate must then return the complete total rather than the rows that happened to read.
    // A writable handle: dropping the table is the damage, and a read-only open cannot apply it.
    const db = new Database(usageFilterIndexPath(testDir));
    try { db.exec("DROP TABLE usage_rows"); } finally { db.close(); }
    resetUsageAggregateCacheForTests();

    const result = await getFilteredUsageAggregate({ provider: "openai" });
    expect(result.accumulator.summarize("all", NOW).summary.requests).toBe(rows.length);
    expect(result.filterIndex?.candidateRows).toBe(rows.length);
    expect(totalIndexRows()).toBe(rows.length);
  });

  test("an older schema version rebuilds its indexes instead of serving the old order", async () => {
    // The candidate indexes changed shape with the pager, so a version 4 projection carries
    // indexes that cannot deliver the page order. It is recreated and rebuilt from the ledger
    // rather than migrated; leaving it in place would silently restore the per-page sort.
    const rows = Array.from({ length: 300 }, (_, index) => ({ ...syntheticRow(index), provider: "openai" }));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "openai" });

    const db = new Database(usageFilterIndexPath(testDir));
    try {
      db.query("UPDATE usage_filter_index_meta SET value = '4' WHERE key = 'schema_version'").run();
      // A genuine version 4 projection carried this index. Recreating the schema drops it, so its
      // absence afterwards is what proves the rebuild happened rather than a version match.
      db.exec("CREATE INDEX idx_usage_rows_ts ON usage_rows(generation, timestamp, byte_offset)");
    } finally {
      db.close();
    }
    resetUsageAggregateCacheForTests();

    const result = await getFilteredUsageAggregate({ provider: "openai" });
    expect(result.accumulator.summarize("all", NOW).summary.requests).toBe(rows.length);

    // The rebuilt projection carries the current version and the offset-ordered indexes.
    const rebuilt = new Database(usageFilterIndexPath(testDir), { readonly: true });
    try {
      const version = rebuilt.query("SELECT value FROM usage_filter_index_meta WHERE key = 'schema_version'")
        .get() as { value: string } | null;
      expect(Number(version?.value)).toBe(USAGE_FILTER_INDEX_SCHEMA_VERSION);
      const names = (rebuilt.query("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>).map(row => row.name);
      expect(names).toContain("idx_usage_rows_window");
      expect(names).toContain("idx_usage_attr_provider_offset");
      expect(names).not.toContain("idx_usage_rows_ts");
    } finally {
      rebuilt.close();
    }
  });
});
