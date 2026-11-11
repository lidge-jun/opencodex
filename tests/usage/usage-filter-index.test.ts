import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetAppOwnedMemoryForTests } from "../../src/lib/app-owned-memory";
import { initializeConfigOwnership } from "../../src/lib/config-ownership";
import { runPassiveRead } from "../../src/lib/passive-read";
import {
  getFilteredUsageAggregate,
  resetUsageAggregateCacheForTests,
  type UsageAggregateResult,
} from "../../src/server/management/usage-aggregate-cache";
import * as ledgerScannerModule from "../../src/usage/ledger-scanner";
import {
  readUsageLedgerRowsAtOffsets,
  scanUsageLedgerCooperatively,
  USAGE_LEDGER_MAX_LINE_BYTES,
} from "../../src/usage/ledger-scanner";
import { USAGE_CLIENTS, type UsageClient } from "../../src/usage/client";
import {
  matchesUsageSource,
  USAGE_SOURCE_CLIENTS,
  type UsageSourceFilter,
} from "../../src/usage/source-filter";
import {
  setUsageFilterIndexTestHooksForTests,
  USAGE_FILTER_INDEX_INSERT_BATCH,
  usageFilterCandidatePlan,
  usageFilterIndexPath,
} from "../../src/usage/filter-index";
import {
  currentUsageLogRevision,
  resetUsageReadCacheForTests,
  usageLogIdentityKey,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import {
  createUsageSummaryAccumulator,
  type UsageSummaryAccumulator,
  type UsageSummaryFilterInput,
} from "../../src/usage/summary";
import type { UsageTimeWindow } from "../../src/usage/time-range";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import type { OcxConfig } from "../../src/types/config";
import { repoPath } from "../helpers/repo-root";

const NOW = Date.parse("2026-09-01T10:00:00.000Z");
const PROVIDERS = ["openai", "anthropic", "google", "kimi", "grok", "deepseek", "mistral", "local"] as const;
const MODELS = ["m-0", "m-1", "m-2", "m-3", "m-4"] as const;
const SYNTHETIC_ROWS = 4_000;

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

function appendRows(rows: readonly PersistedUsageEntry[]): void {
  appendFileSync(ledgerPath(), rows.map(row => `${JSON.stringify(row)}\n`).join(""));
}

/** Independent oracle: the pre-index full scan, built without the candidate index. */
async function fullScan(
  filter: UsageSummaryFilterInput,
  window?: UsageTimeWindow,
): Promise<UsageSummaryAccumulator> {
  const accumulator = createUsageSummaryAccumulator({
    filter,
    mode: "row-unique",
    ...(window ? { window } : {}),
  });
  await scanUsageLedgerCooperatively({ onEntry: entry => accumulator.add(entry) });
  return accumulator;
}

function summary(result: UsageAggregateResult) {
  return result.accumulator.summarize("all", NOW);
}

async function expectMatchesFullScan(
  filter: UsageSummaryFilterInput,
  window?: UsageTimeWindow,
): Promise<UsageAggregateResult> {
  const result = await getFilteredUsageAggregate(filter, window);
  const oracle = await fullScan(filter, window);
  expect(summary(result)).toEqual(oracle.summarize("all", NOW));
  expect(result.accumulator.snapshotWindow).toEqual(oracle.snapshotWindow);
  return result;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-filter-index-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
});

afterEach(() => {
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("filtered usage candidate index", () => {
  test("synthetic ledger: distinct filters read only their candidate rows", async () => {
    const rows = Array.from({ length: SYNTHETIC_ROWS }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const providerRows = rows.filter(row => row.provider === "kimi").length;
    const modelRows = rows.filter(row => row.model === "m-3").length;
    const keyRows = rows.filter(row => row.apiKeyId === "key-b").length;

    const originalScan = ledgerScannerModule.scanUsageLedgerCooperatively;
    let scans = 0;
    const scanSpy = spyOn(ledgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scans += 1;
        return originalScan(options);
      });
    let byProvider: UsageAggregateResult;
    let byModel: UsageAggregateResult;
    let byKey: UsageAggregateResult;
    try {
      byProvider = await getFilteredUsageAggregate({ provider: "kimi" });
      byModel = await getFilteredUsageAggregate({ model: "m-3" });
      byKey = await getFilteredUsageAggregate({ apiKeyId: "key-b" });
      // Three distinct filters share one ingest. Before the candidate index this was one
      // whole-ledger scan per filter, which is the cost this test exists to keep down.
      expect(scans).toBe(1);
    } finally {
      scanSpy.mockRestore();
    }

    // Parity with the independent full-scan oracle, one filter at a time.
    expect(summary(byProvider)).toEqual((await fullScan({ provider: "kimi" })).summarize("all", NOW));
    expect(summary(byModel)).toEqual((await fullScan({ model: "m-3" })).summarize("all", NOW));
    expect(summary(byKey)).toEqual((await fullScan({ apiKeyId: "key-b" })).summarize("all", NOW));

    // The index selects exactly the rows the filter can match, and the query normalizes
    // only those; the whole-ledger scan is what this replaces.
    expect(byProvider.filterIndex).toMatchObject({
      totalRows: SYNTHETIC_ROWS,
      candidateRows: providerRows,
      ingestPasses: 1,
    });
    expect(byModel.filterIndex).toMatchObject({ candidateRows: modelRows, ingestPasses: 1 });
    expect(byKey.filterIndex).toMatchObject({ candidateRows: keyRows, ingestPasses: 1 });

    // Quantitative bound: three distinct filters together read far less than one full scan
    // each, and the shared ingest ran once for all of them.
    const scanned = providerRows + modelRows + keyRows;
    expect(scanned).toBeLessThan(SYNTHETIC_ROWS);
    expect(byProvider.filterIndex!.candidateRows).toBeLessThan(SYNTHETIC_ROWS / 4);
    expect(byProvider.filterIndex!.ingestPasses).toBe(1);
    expect(summary(byProvider).summary.requests).toBe(providerRows);
  });

  test("a window filter selects only rows inside the window", async () => {
    const rows = Array.from({ length: 600 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const window = { since: NOW - 10 * 60_000, until: NOW };
    const inside = rows.filter(row => row.timestamp >= window.since && row.timestamp <= window.until).length;
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeLessThan(rows.length);

    const result = await expectMatchesFullScan({}, window);
    expect(result.filterIndex).toMatchObject({ totalRows: rows.length, candidateRows: inside });
    expect(summary(result).summary.requests).toBe(inside);
  });

  test("an append ingests only new bytes and a retained filter folds only new matches", async () => {
    const rows = Array.from({ length: SYNTHETIC_ROWS }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const first = await getFilteredUsageAggregate({ provider: "kimi" });
    expect(first.update).toBe("rebuild");
    expect(first.filterIndex).toMatchObject({ totalRows: SYNTHETIC_ROWS, ingestPasses: 1 });

    const appended = Array.from({ length: 200 }, (_, index) => syntheticRow(SYNTHETIC_ROWS + index));
    appendRows(appended);
    const appendedKimi = appended.filter(row => row.provider === "kimi").length;
    expect(appendedKimi).toBeGreaterThan(0);

    const next = await getFilteredUsageAggregate({ provider: "kimi" });
    expect(next.update).toBe("append");
    // Only the appended bytes were ingested, and only their matching rows were folded.
    expect(next.filterIndex).toMatchObject({
      totalRows: SYNTHETIC_ROWS + appended.length,
      candidateRows: appendedKimi,
      scope: "append",
      ingestedRows: appended.length,
      ingestPasses: 1,
    });
    expect(next.accumulator.summarize("all", NOW).summary.requests)
      .toBe(rows.filter(row => row.provider === "kimi").length + appendedKimi);

    // A filter that has never been queried reads the whole candidate set, still without
    // re-ingesting the ledger.
    const fresh = await getFilteredUsageAggregate({ model: "m-1" });
    expect(fresh.update).toBe("rebuild");
    expect(fresh.filterIndex).toMatchObject({ ingestedRows: 0, ingestPasses: 1 });
    expect(fresh.filterIndex!.candidateRows).toBeLessThan(SYNTHETIC_ROWS + appended.length);
  });

  test("the index shares one ingest across concurrent distinct filters", async () => {
    const rows = Array.from({ length: 400 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const results = await Promise.all([
      getFilteredUsageAggregate({ provider: "openai" }),
      getFilteredUsageAggregate({ provider: "anthropic" }),
      getFilteredUsageAggregate({ model: "m-2" }),
      getFilteredUsageAggregate({ apiKeyId: "key-a" }),
    ]);
    for (const result of results) expect(result.filterIndex?.ingestPasses).toBe(1);
    expect(results.map(result => summary(result).summary.requests))
      .toEqual([
        rows.filter(row => row.provider === "openai").length,
        rows.filter(row => row.provider === "anthropic").length,
        rows.filter(row => row.model === "m-2").length,
        rows.filter(row => row.apiKeyId === "key-a").length,
      ]);
  });

  test("combo rows match through their attempt attributions", async () => {
    const combo: PersistedUsageEntry = {
      requestId: "combo-1",
      timestamp: NOW,
      provider: "combo",
      model: "jev-auto",
      status: 200,
      durationMs: 2,
      usageStatus: "reported",
      attempts: [
        {
          ordinal: 1,
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai-responses",
          status: 200,
          durationMs: 1,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 3, outputTokens: 4 },
        },
      ],
    };
    writeRows([combo, syntheticRow(0)]);

    const byAttempt = await expectMatchesFullScan({ provider: "openai", model: "gpt-5.5" });
    expect(byAttempt.filterIndex?.candidateRows).toBe(1);
    expect(summary(byAttempt).summary.requests).toBe(1);

    // The row-level provider is not an attribution once attempts exist, exactly as the
    // accumulator projects the row.
    const byRowProvider = await expectMatchesFullScan({ provider: "combo" });
    expect(byRowProvider.filterIndex?.candidateRows).toBe(0);
    expect(summary(byRowProvider).summary.requests).toBe(0);
  });

  test("source filters select the same rows the accumulator keeps", async () => {
    writeRows(Array.from({ length: 300 }, (_, index) => syntheticRow(index)));
    const cases: UsageSummaryFilterInput[] = [
      { sourceFilter: { client: "codex", device: { kind: "all" } } },
      { sourceFilter: { client: "claude_code", device: { kind: "no-key" } } },
      { sourceFilter: { client: "all", device: { kind: "key", id: "key-a" } } },
      { sourceFilter: { client: "all", device: { kind: "unconfigured" } }, configuredApiKeyIds: ["key-a"] },
    ];
    for (const filter of cases) {
      const result = await expectMatchesFullScan(filter);
      expect(result.filterIndex!.candidateRows).toBeGreaterThan(0);
      expect(result.filterIndex!.candidateRows).toBeLessThan(300);
    }
  });

  test("a truncated ledger rebuilds instead of extending stale rows", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const first = await getFilteredUsageAggregate({ provider: "openai" });
    expect(first.filterIndex?.totalRows).toBe(40);

    writeRows(rows.slice(0, 10));
    const rebuilt = await getFilteredUsageAggregate({ provider: "openai" });
    expect(rebuilt.update).toBe("rebuild");
    expect(rebuilt.filterIndex).toMatchObject({ totalRows: 10, ingestPasses: 2 });
    expect(summary(rebuilt).summary.requests).toBe(rows.slice(0, 10).filter(row => row.provider === "openai").length);
  });

  test("a same-size in-place rewrite rebuilds instead of serving stale keys", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "openai" });

    // Same byte length, different providers: a pure append check cannot see this.
    const rewritten = rows.map((row, index) => ({ ...row, provider: index % 2 === 0 ? "grok" : "kimi" }));
    writeFileSync(ledgerPath(), rewritten.map(row => `${JSON.stringify(row)}\n`).join(""));
    const result = await getFilteredUsageAggregate({ provider: "grok" });
    expect(result.update).toBe("rebuild");
    expect(result.filterIndex?.ingestPasses).toBe(2);
    expect(summary(result).summary.requests).toBe(10);
    expect(summary(await getFilteredUsageAggregate({ provider: "openai" })).summary.requests).toBe(0);
  });

  test("a rotated ledger rebuilds from the replacement file", async () => {
    writeRows(Array.from({ length: 20 }, (_, index) => syntheticRow(index)));
    await getFilteredUsageAggregate({ provider: "openai" });
    renameSync(ledgerPath(), `${ledgerPath()}.old`);
    writeRows([{ ...syntheticRow(0), requestId: "replacement", provider: "kimi" }]);

    const result = await getFilteredUsageAggregate({ provider: "kimi" });
    expect(result.update).toBe("rebuild");
    expect(result.filterIndex).toMatchObject({ totalRows: 1, ingestPasses: 2 });
    expect(summary(result).summary.requests).toBe(1);
  });

  test("a torn final row is not selected until its newline arrives", async () => {
    writeRows([syntheticRow(0)]);
    await getFilteredUsageAggregate({ provider: "openai" });
    const torn = { ...syntheticRow(1), requestId: "torn", provider: "kimi" };
    appendFileSync(ledgerPath(), JSON.stringify(torn));
    const before = await getFilteredUsageAggregate({ provider: "kimi" });
    expect(summary(before).summary.requests).toBe(0);
    expect(before.usageInvalidRows).toBe(true);

    appendFileSync(ledgerPath(), "\n");
    const after = await getFilteredUsageAggregate({ provider: "kimi" });
    expect(summary(after).summary.requests).toBe(1);
    expect(after.update).toBe("append");
  });

  test("whole-ledger invalid rows stay visible to a filtered query", async () => {
    writeRows([syntheticRow(0)]);
    const clean = await getFilteredUsageAggregate({ provider: "openai" });
    expect(clean.usageInvalidRows).toBe(false);
    appendFileSync(ledgerPath(), "{not json}\n");
    const dirty = await getFilteredUsageAggregate({ provider: "openai" });
    expect(dirty.usageInvalidRows).toBe(true);
    // The matching row is still reported; only the diagnostic changes.
    expect(summary(dirty).summary.requests).toBe(1);
  });

  test("a missing ledger is an empty filtered report, not a failed read", async () => {
    const result = await getFilteredUsageAggregate({ provider: "openai" });
    expect(summary(result).summary.requests).toBe(0);
    expect(result.filterIndex).toMatchObject({ totalRows: 0, candidateRows: 0 });
  });

  test("the projection survives a process restart without re-ingesting", async () => {
    writeRows(Array.from({ length: 200 }, (_, index) => syntheticRow(index)));
    const first = await getFilteredUsageAggregate({ provider: "openai" });
    expect(first.filterIndex?.ingestedRows).toBe(200);

    // A restart drops every in-memory retained projection but keeps the SQLite file.
    resetUsageAggregateCacheForTests();
    const afterRestart = await getFilteredUsageAggregate({ provider: "openai" });
    expect(afterRestart.update).toBe("rebuild");
    expect(afterRestart.filterIndex).toMatchObject({
      totalRows: 200,
      candidateRows: 25,
      ingestedRows: 0,
      ingestPasses: 0,
    });
    expect(summary(afterRestart)).toEqual(first.accumulator.summarize("all", NOW));
  });
});

function indexDatabase(): Database {
  return new Database(usageFilterIndexPath(testDir), { readonly: true });
}

function indexRowCount(generation: string): number {
  const db = indexDatabase();
  try {
    return (db.query("SELECT COUNT(*) AS c FROM usage_rows WHERE generation = ?")
      .get(generation) as { c: number }).c;
  } finally {
    db.close();
  }
}

function publishedGeneration(): string {
  const db = indexDatabase();
  try {
    return (db.query("SELECT value FROM usage_filter_index_meta WHERE key = 'generation'")
      .get() as { value: string }).value;
  } finally {
    db.close();
  }
}

function indexGenerations(): string[] {
  const db = indexDatabase();
  try {
    return (db.query("SELECT DISTINCT generation FROM usage_rows ORDER BY generation")
      .all() as Array<{ generation: string }>).map(row => row.generation);
  } finally {
    db.close();
  }
}

function totalIndexRows(): number {
  const db = indexDatabase();
  try {
    return (db.query("SELECT COUNT(*) AS c FROM usage_rows").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function publishedOffset(): number {
  const db = indexDatabase();
  try {
    return Number((db.query("SELECT value FROM usage_filter_index_meta WHERE key = 'indexed_offset'")
      .get() as { value: string }).value);
  } finally {
    db.close();
  }
}

function ledgerRowCount(): number {
  return readFileSync(ledgerPath(), "utf8").split("\n").filter(line => line.trim() !== "").length;
}

describe("filtered usage index crash and multi-writer safety", () => {
  test("a crash between staging and publish keeps the published projection", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const first = await getFilteredUsageAggregate({ provider: "openai" });
    expect(first.filterIndex?.totalRows).toBe(12);
    const published = publishedGeneration();
    expect(indexRowCount(published)).toBe(12);

    // Shrinking the ledger forces a rebuild on the next refresh.
    writeRows(rows.slice(0, 4));
    const remaining = rows.slice(0, 4).filter(row => row.provider === "openai").length;
    setUsageFilterIndexTestHooksForTests({
      beforePublish: () => { throw new Error("simulated crash before publish"); },
    });
    try {
      // The index path degrades to the authoritative streaming read for this request.
      const duringCrash = await getFilteredUsageAggregate({ provider: "openai" });
      expect(summary(duringCrash).summary.requests).toBe(remaining);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
      resetUsageAggregateCacheForTests();
    }

    // The published generation was never emptied, so no reader can see a complete-looking zero.
    expect(publishedGeneration()).toBe(published);
    expect(indexRowCount(published)).toBe(12);

    const recovered = await getFilteredUsageAggregate({ provider: "openai" });
    expect(recovered.filterIndex?.totalRows).toBe(4);
    expect(summary(recovered).summary.requests).toBe(remaining);
  });

  test("a rebuild never deletes another writer's staged rows", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "openai" });
    const published = publishedGeneration();

    // A second process has staged rows and is still ingesting: its lease records a live pid.
    const db = new Database(usageFilterIndexPath(testDir));
    db.query(
      "INSERT OR REPLACE INTO usage_filter_index_generations (generation, created_at) VALUES ('other-writer', ?)",
    ).run(NOW);
    db.query(
      "INSERT OR REPLACE INTO usage_filter_index_writers (generation, pid, started_at, heartbeat_at) VALUES ('other-writer', ?, ?, ?)",
    ).run(process.pid, NOW, NOW);
    db.query(
      "INSERT OR REPLACE INTO usage_rows (generation, byte_offset, timestamp, api_key_id, client, surface, admission_kind, unattributable) VALUES ('other-writer', 1, ?, NULL, NULL, NULL, NULL, 0)",
    ).run(NOW);
    db.close();

    writeRows(rows.slice(0, 3));
    let observedPublished = -1;
    let observedOther = -1;
    setUsageFilterIndexTestHooksForTests({
      beforePublish: ({ dbPath }) => {
        const probe = new Database(dbPath, { readonly: true });
        try {
          observedPublished = (probe.query("SELECT COUNT(*) AS c FROM usage_rows WHERE generation = ?")
            .get(published) as { c: number }).c;
          observedOther = (probe.query("SELECT COUNT(*) AS c FROM usage_rows WHERE generation = 'other-writer'")
            .get() as { c: number }).c;
        } finally {
          probe.close();
        }
      },
    });
    try {
      const rebuilt = await getFilteredUsageAggregate({ provider: "openai" });
      expect(rebuilt.filterIndex?.totalRows).toBe(3);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }

    // At the publish boundary both the published generation and the other writer's staging
    // were still intact; only the successful publish prunes them.
    expect(observedPublished).toBe(8);
    expect(observedOther).toBe(1);
    // The retired published generation is pruned; the live writer's staging is kept so its own
    // publish can fail the fence and retry instead of losing rows mid-ingest.
    expect(indexRowCount(published)).toBe(0);
    expect(indexRowCount("other-writer")).toBe(1);
    expect(indexGenerations()).toContain("other-writer");
  });

  test("a competing publish is fenced out and the loser retries", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "openai" });
    writeRows(rows.slice(0, 6));

    let publishedByOther = false;
    setUsageFilterIndexTestHooksForTests({
      beforePublish: ({ dbPath, stagedGeneration }) => {
        if (publishedByOther) return;
        publishedByOther = true;
        const other = new Database(dbPath);
        try {
          other.exec("BEGIN IMMEDIATE");
          other.query(
            "INSERT OR REPLACE INTO usage_rows SELECT 'other-writer', byte_offset, timestamp, api_key_id, client, surface, admission_kind, unattributable FROM usage_rows WHERE generation = ?",
          ).run(stagedGeneration);
          other.query(
            "INSERT OR REPLACE INTO usage_attributions SELECT 'other-writer', byte_offset, provider, model FROM usage_attributions WHERE generation = ?",
          ).run(stagedGeneration);
          other.query(
            "INSERT OR REPLACE INTO usage_filter_index_generations (generation, created_at) VALUES ('other-writer', ?)",
          ).run(Date.now());
          other.query("UPDATE usage_filter_index_meta SET value = 'other-writer' WHERE key = 'generation'").run();
          other.exec("COMMIT");
        } finally {
          other.close();
        }
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "openai" });
      expect(result.filterIndex?.totalRows).toBe(6);
      expect(summary(result).summary.requests)
        .toBe(rows.slice(0, 6).filter(row => row.provider === "openai").length);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
    expect(indexGenerations()).toHaveLength(1);
  });

  test("two processes rebuilding the same ledger both report every row", async () => {
    // Sixteen insert batches each: enough for the two ingests to interleave under the write lock
    // without making two cold Bun processes spend seconds of a loaded runner on ingest.
    // Coverage, not a reproducible regression: whether the first opens collide is up to the
    // scheduler. The deterministic regression is the still-creating case below.
    const rows = Array.from({ length: 16 * USAGE_FILTER_INDEX_INSERT_BATCH }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const expected = rows.filter(row => row.provider === "openai").length;
    const scriptPath = join(testDir, "child.ts");
    writeFileSync(scriptPath, `
import { getFilteredUsageAggregate } from ${JSON.stringify(repoPath("src/server/management/usage-aggregate-cache.ts"))};
const result = await getFilteredUsageAggregate({ provider: "openai" });
const summary = result.accumulator.summarize("all", Date.now());
console.log(JSON.stringify({ requests: summary.summary.requests, candidates: result.filterIndex?.candidateRows ?? null }));
`);
    const children = [0, 1].map(() => Bun.spawn([process.execPath, scriptPath], {
      env: { ...process.env, OPENCODEX_HOME: testDir },
      stdout: "pipe",
      stderr: "pipe",
    }));
    const outputs = await Promise.all(children.map(async child => {
      const code = await child.exited;
      const out = await new Response(child.stdout).text();
      const err = await new Response(child.stderr).text();
      return { code, out, err };
    }));
    for (const output of outputs) {
      expect(output.err).toBe("");
      expect(output.code).toBe(0);
      const line = output.out.trim().split("\n").at(-1) ?? "";
      expect(JSON.parse(line)).toEqual({ requests: expected, candidates: expected });
    }
    expect(indexGenerations()).toHaveLength(1);
    expect(indexRowCount(publishedGeneration())).toBe(rows.length);
  });

  test("a projection another process is still creating is waited for, not taken as foreign", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    // The empty file a concurrent first open leaves, held under that process's write lock.
    const creator = new Database(usageFilterIndexPath(testDir), { create: true });
    creator.exec("BEGIN EXCLUSIVE");
    // Released from the reader's own busy back-off, so the case cannot pass without the reader
    // meeting the lock. Classifying the busy file as foreign used to give up the index at once,
    // and never reached this back-off.
    const busyAttempts: number[] = [];
    setUsageFilterIndexTestHooksForTests({
      beforeBusyRetry: ({ attempt }) => {
        busyAttempts.push(attempt);
        if (creator.inTransaction) creator.exec("ROLLBACK");
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "openai" });
      expect(summary(result).summary.requests).toBe(rows.filter(row => row.provider === "openai").length);
      expect(busyAttempts).toEqual([0]);
      expect(result.filterIndex?.totalRows).toBe(rows.length);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
      if (creator.inTransaction) creator.exec("ROLLBACK");
      creator.close();
    }
  });

  test("crashed and abandoned staging never accumulates", async () => {
    const rows = Array.from({ length: 3000 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });
    expect(totalIndexRows()).toBe(ledgerRowCount());

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // A rebuild that dies before publishing must clean its own staging in the finally.
      writeRows(rows.slice(0, 1000 + attempt));
      setUsageFilterIndexTestHooksForTests({
        beforePublish: () => { throw new Error("simulated crash"); },
      });
      try {
        await getFilteredUsageAggregate({ provider: "kimi" });
      } finally {
        setUsageFilterIndexTestHooksForTests(null);
        resetUsageAggregateCacheForTests();
      }
      appendRows([{ ...syntheticRow(9_000 + attempt), requestId: `append-${attempt}` }]);
      await getFilteredUsageAggregate({ provider: "kimi" });
      expect(totalIndexRows()).toBe(ledgerRowCount());
    }

    // A writer that vanished without running its finally leaves a lease with a dead pid.
    const db = new Database(usageFilterIndexPath(testDir));
    db.query(
      "INSERT OR REPLACE INTO usage_filter_index_generations (generation, created_at) VALUES ('crashed-writer', ?)",
    ).run(NOW);
    db.query(
      "INSERT OR REPLACE INTO usage_filter_index_writers (generation, pid, started_at, heartbeat_at) VALUES ('crashed-writer', 999999, ?, ?)",
    ).run(NOW, NOW);
    db.query(
      "INSERT OR REPLACE INTO usage_rows (generation, byte_offset, timestamp, api_key_id, client, surface, admission_kind, unattributable) VALUES ('crashed-writer', 1, ?, NULL, NULL, NULL, NULL, 0)",
    ).run(NOW);
    db.close();
    expect(totalIndexRows()).toBe(ledgerRowCount() + 1);

    await getFilteredUsageAggregate({ provider: "kimi" });
    expect(totalIndexRows()).toBe(ledgerRowCount());
    expect(indexGenerations()).toHaveLength(1);
  });

  test("a stale append cannot regress the published cursor", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });
    const generation = publishedGeneration();
    const firstAppend = syntheticRow(100);
    appendRows([firstAppend]);
    const afterFirst = statSync(ledgerPath()).size;
    const secondAppend = { ...syntheticRow(101), requestId: "second-append" };

    let simulated = false;
    setUsageFilterIndexTestHooksForTests({
      beforePublish: ({ dbPath, stagedGeneration, publishedGeneration: published }) => {
        // Only the append path (staged === published) is being raced.
        if (simulated || stagedGeneration !== published) return;
        simulated = true;
        // Another appender publishes a newer watermark while this one is still in flight.
        appendRows([secondAppend]);
        const grown = statSync(ledgerPath()).size;
        const other = new Database(dbPath);
        try {
          other.exec("BEGIN IMMEDIATE");
          other.query(
            "INSERT OR REPLACE INTO usage_rows (generation, byte_offset, timestamp, api_key_id, client, surface, admission_kind, unattributable) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
          ).run(generation, afterFirst, secondAppend.timestamp, secondAppend.apiKeyId ?? null,
            secondAppend.client ?? null, secondAppend.surface ?? null, secondAppend.admissionKind ?? null);
          other.query(
            "INSERT OR REPLACE INTO usage_attributions (generation, byte_offset, provider, model) VALUES (?, ?, ?, ?)",
          ).run(generation, afterFirst, secondAppend.provider, secondAppend.model);
          other.query("UPDATE usage_filter_index_meta SET value = ? WHERE key = 'indexed_offset'").run(String(grown));
          other.query("UPDATE usage_filter_index_meta SET value = ? WHERE key = 'indexed_rows'").run("12");
          other.exec("COMMIT");
        } finally {
          other.close();
        }
      },
    });
    try {
      const result = await getFilteredUsageAggregate({});
      expect(result.filterIndex?.totalRows).toBe(12);
      expect(summary(result).summary.requests).toBe(12);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
    // The stale appender's fence rejected its older cursor; the retry kept the newer one.
    expect(publishedOffset()).toBe(statSync(ledgerPath()).size);
  });

  test("a candidate that no longer normalizes is reported unreadable", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const lines = readFileSync(ledgerPath(), "utf8").split("\n").filter(line => line !== "");
    const offsets: number[] = [];
    let cursor = 0;
    for (const line of lines) {
      offsets.push(cursor);
      cursor += Buffer.byteLength(line) + 1;
    }
    // One byte longer in row zero shifts every later offset onto the wrong row.
    const mutated = lines[0]!.replace('"req-0"', '"req-0x"');
    expect(Buffer.byteLength(mutated)).toBe(Buffer.byteLength(lines[0]!) + 1);
    writeFileSync(ledgerPath(), [mutated, ...lines.slice(1)].join("\n") + "\n");

    const read = await readUsageLedgerRowsAtOffsets({
      offsets,
      expectedIdentityKey: usageLogIdentityKey(currentUsageLogRevision()),
    });
    expect(read.entries).toHaveLength(1);
    expect(read.unreadableOffsets).toHaveLength(49);
  });
+
  test("a rewritten indexed row makes the next append rebuild instead of streaming forever", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "openai" });
    appendRows([syntheticRow(500)]);
    // Same-length edit of the last indexed row: the append's boundary digest no longer matches.
    const lines = readFileSync(ledgerPath(), "utf8").split("\n");
    lines[199] = lines[199]!.replace('"req-199"', '"req-1x9"');
    writeFileSync(ledgerPath(), lines.join("\n"));

    // A restart must recover through one rebuild, not fall back to a full scan forever.
    resetUsageAggregateCacheForTests();
    const result = await getFilteredUsageAggregate({ provider: "openai" });
    expect(result.filterIndex).toBeDefined();
    expect(result.filterIndex?.scope).toBe("rebuild");
    expect(summary(result).summary.requests)
      .toBe(rows.filter(row => row.provider === "openai").length);
  });

  test("a rewrite between the index refresh and the read is caught before any row is trusted", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const expected = rows.filter(row => row.provider === "openai").length;
    let rewritten = false;
    setUsageFilterIndexTestHooksForTests({
      afterPublish: () => {
        if (rewritten) return;
        rewritten = true;
        // Swap two equal-length providers in place, after the projection was published. The
        // file keeps its size, so only the snapshot revision and boundary can see it.
        const lines = readFileSync(ledgerPath(), "utf8").split("\n");
        lines[0] = lines[0]!.replace('"provider":"openai"', '"provider":"google"');
        lines[2] = lines[2]!.replace('"provider":"google"', '"provider":"openai"');
        writeFileSync(ledgerPath(), lines.join("\n"));
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "openai" });
      // The stale projection would have selected the pre-swap row and dropped it during
      // filtering, under-reporting by one. The read detects the move and rebuilds.
      expect(result.filterIndex).toBeDefined();
     expect(summary(result).summary.requests).toBe(expected);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
  });
+
  test("a same-size rewrite before the trailing boundary forces a rebuild", async () => {
    // Large enough that row zero sits far outside the trailing 64 KiB digest window.
    const rows = Array.from({ length: 4000 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    expect(statSync(ledgerPath()).size).toBeGreaterThan(64 * 1024 * 2);
    const expected = rows.filter(row => row.provider === "google").length + 1;
    let rewritten = false;
    setUsageFilterIndexTestHooksForTests({
      afterPublish: () => {
        if (rewritten) return;
        rewritten = true;
        const lines = readFileSync(ledgerPath(), "utf8").split("\n");
        // Row zero becomes a match, at the same byte length, outside the digest window.
        lines[0] = lines[0]!.replace('"provider":"openai"', '"provider":"google"');
        writeFileSync(ledgerPath(), lines.join("\n"));
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "google" });
      expect(result.filterIndex).toBeDefined();
      expect(summary(result).summary.requests).toBe(expected);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
  });

  test("a zero-candidate query still validates the snapshot", async () => {
    const rows = Array.from({ length: 4000 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    let rewritten = false;
    setUsageFilterIndexTestHooksForTests({
      afterPublish: () => {
        if (rewritten) return;
        rewritten = true;
        const lines = readFileSync(ledgerPath(), "utf8").split("\n");
        // Same length, so only the revision check can see it; row zero now matches.
        lines[0] = lines[0]!.replace('"provider":"openai"', '"provider":"zzzzzz"');
        writeFileSync(ledgerPath(), lines.join("\n"));
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "zzzzzz" });
      expect(result.filterIndex).toBeDefined();
      expect(summary(result).summary.requests).toBe(1);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
  });

  test("registry and lease become visible together", async () => {
    const rows = Array.from({ length: 600 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });
    writeRows(rows.slice(0, 400));

    const observed: string[] = [];
    setUsageFilterIndexTestHooksForTests({
      betweenStagingWrites: ({ dbPath, generation }) => {
        // A second connection sees the last committed snapshot only: the registry row and its
        // lease must never be observable apart.
        const probe = new Database(dbPath, { readonly: true });
        try {
          const registry = probe.query("SELECT 1 AS present FROM usage_filter_index_generations WHERE generation = ?")
            .get(generation) as { present: number } | null;
          const lease = probe.query("SELECT pid FROM usage_filter_index_writers WHERE generation = ?")
            .get(generation) as { pid: number } | null;
          observed.push(`${registry === null ? "none" : "registry"}/${lease === null ? "none" : "lease"}`);
        } catch (error) {
          observed.push(`busy:${(error as Error).message}`);
        } finally {
          probe.close();
        }
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "kimi" });
      expect(result.filterIndex?.totalRows).toBe(400);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
    // The uncommitted transaction is invisible to the other connection: no half-registered row.
    expect(observed.length).toBeGreaterThan(0);
    for (const seen of observed) expect(seen).toBe("none/none");
    expect(totalIndexRows()).toBe(ledgerRowCount());
  });
+
  test("a replaced ledger between the index refresh and the read is caught", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const expected = rows.filter(row => row.provider === "google").length + 1;
    let replaced = false;
    setUsageFilterIndexTestHooksForTests({
      afterPublish: () => {
        if (replaced) return;
        replaced = true;
        renameSync(ledgerPath(), `${ledgerPath()}.old`);
        writeRows(rows.map((row, index) => (index === 0 ? { ...row, provider: "google" } : row)));
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "google" });
      expect(result.filterIndex).toBeDefined();
      expect(summary(result).summary.requests).toBe(expected);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
  });

  test("a reclaimer re-reads eligibility under its write lock", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });

    // A registry row without a lease looks abandoned to the pre-check.
    const db = new Database(usageFilterIndexPath(testDir));
    db.query("INSERT OR REPLACE INTO usage_filter_index_generations (generation, created_at) VALUES ('racing-writer', ?)")
      .run(NOW);
    db.close();

    let registered = false;
    setUsageFilterIndexTestHooksForTests({
      betweenReclaimCheckAndLock: ({ dbPath }) => {
        if (registered) return;
        registered = true;
        // The live writer registers its lease between the pre-check and the lock.
        const other = new Database(dbPath);
        try {
          other.query(
            "INSERT OR REPLACE INTO usage_filter_index_writers (generation, pid, started_at, heartbeat_at) VALUES ('racing-writer', ?, ?, ?)",
          ).run(process.pid, NOW, NOW);
        } finally {
          other.close();
        }
      },
    });
    try {
      appendRows([syntheticRow(900)]);
      await getFilteredUsageAggregate({ provider: "kimi" });
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }

    const probe = new Database(usageFilterIndexPath(testDir), { readonly: true });
    try {
      expect(probe.query("SELECT 1 FROM usage_filter_index_generations WHERE generation = 'racing-writer'").get())
        .not.toBeNull();
    } finally {
      probe.close();
    }
  });

  test("a lease without a registered generation is pruned", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });
    const db = new Database(usageFilterIndexPath(testDir));
    db.query(
      "INSERT OR REPLACE INTO usage_filter_index_writers (generation, pid, started_at, heartbeat_at) VALUES ('orphan-lease', 999999, ?, ?)",
    ).run(NOW, NOW);
    db.close();

    appendRows([syntheticRow(900)]);
    await getFilteredUsageAggregate({ provider: "kimi" });

    const probe = new Database(usageFilterIndexPath(testDir), { readonly: true });
    try {
      expect(probe.query("SELECT 1 FROM usage_filter_index_writers WHERE generation = 'orphan-lease'").get())
        .toBeNull();
    } finally {
      probe.close();
    }
  });
+
  test("an unchanged retained projection still validates the ledger", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "google" });
    const expected = rows.filter(row => row.provider === "google").length + 1;
    let rewritten = false;
    setUsageFilterIndexTestHooksForTests({
      afterRefresh: () => {
        if (rewritten) return;
        rewritten = true;
        const lines = readFileSync(ledgerPath(), "utf8").split("\n");
        lines[0] = lines[0]!.replace('"provider":"openai"', '"provider":"google"');
        writeFileSync(ledgerPath(), lines.join("\n"));
      },
    });
    try {
      // The retained projection is still current, so this takes the unchanged path.
      const result = await getFilteredUsageAggregate({ provider: "google" });
      expect(summary(result).summary.requests).toBe(expected);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
  });
+
  test("a torn suffix does not let a same-size rewrite masquerade as an append", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => (
      index === 0 ? { ...syntheticRow(index), provider: "kimi" } : syntheticRow(index)
    ));
    writeRows(rows);
    // A torn final row: bytes after the last LF that never form a complete row.
    appendFileSync(ledgerPath(), JSON.stringify({ ...syntheticRow(9999), requestId: "torn" }));

    const built = await getFilteredUsageAggregate({ provider: "kimi" });
    expect(built.filterIndex).toBeDefined();
    // The snapshot's physical size now exceeds its processed boundary.
    expect(publishedOffset()).toBeLessThan(statSync(ledgerPath()).size);
    expect(totalIndexRows()).toBe(1000);
    // An unchanged torn suffix settles as unchanged rather than rescanning or inflating counts.
    const settled = await getFilteredUsageAggregate({ provider: "kimi" });
    expect(settled.update).toBe("unchanged");
    expect(totalIndexRows()).toBe(1000);

    // Early row zero becomes a match at the same byte length, outside the digest window.
    const lines = readFileSync(ledgerPath(), "utf8").split("\n");
    lines[0] = lines[0]!.replace('"provider":"kimi"', '"provider":"grok"');
    writeFileSync(ledgerPath(), lines.join("\n"));

    const result = await getFilteredUsageAggregate({ provider: "grok" });
    expect(result.filterIndex).toBeDefined();
    expect(summary(result).summary.requests)
      .toBe(rows.filter(row => row.provider === "grok").length + 1);
    const again = await getFilteredUsageAggregate({ provider: "grok" });
    expect(again.update).toBe("unchanged");
    expect(totalIndexRows()).toBe(1000);
  });

  test("a same-size rewrite after the refresh is caught with a torn suffix present", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => (
      index === 0 ? { ...syntheticRow(index), provider: "kimi" } : syntheticRow(index)
    ));
    writeRows(rows);
    appendFileSync(ledgerPath(), JSON.stringify({ ...syntheticRow(9999), requestId: "torn" }));
    await getFilteredUsageAggregate({ provider: "kimi" });

    let rewritten = false;
    setUsageFilterIndexTestHooksForTests({
      afterRefresh: () => {
        if (rewritten) return;
        rewritten = true;
        const lines = readFileSync(ledgerPath(), "utf8").split("\n");
        lines[0] = lines[0]!.replace('"provider":"kimi"', '"provider":"grok"');
        writeFileSync(ledgerPath(), lines.join("\n"));
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "grok" });
      expect(result.filterIndex).toBeDefined();
      expect(summary(result).summary.requests)
        .toBe(rows.filter(row => row.provider === "grok").length + 1);
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
  });

  test("a published generation that lost its rows is rebuilt, not streamed forever", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });
    const db = new Database(usageFilterIndexPath(testDir));
    try {
      db.query("DELETE FROM usage_rows").run();
      db.query("DELETE FROM usage_attributions").run();
    } finally {
      db.close();
    }

    const result = await getFilteredUsageAggregate({ provider: "kimi" });
    // Indexed mode is restored, not merely correct streamed totals.
    expect(result.filterIndex).toBeDefined();
    expect(summary(result).summary.requests).toBe(rows.filter(row => row.provider === "kimi").length);
    expect(totalIndexRows()).toBe(rows.length);
  });

});

describe("filtered usage index availability", () => {
  test("a foreign file at the index path is never modified", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const expected = rows.filter(row => row.provider === "openai").length;
    const indexPath = usageFilterIndexPath(testDir);
    const foreign = "this is not a sqlite database\n";
    writeFileSync(indexPath, foreign);

    const result = await getFilteredUsageAggregate({ provider: "openai" });
    expect(summary(result).summary.requests).toBe(expected);
    expect(result.filterIndex).toBeUndefined();
    expect(readFileSync(indexPath, "utf8")).toBe(foreign);
    expect(existsSync(`${indexPath}-wal`)).toBe(false);
  });

  // chmod cannot make a Windows directory unwritable, so there this would build the index and
  // assert nothing about permissions. The degrade itself is the platform-neutral catch-all in
  // readUsageFilterCandidates, which the vanishing-after-refresh case below reaches on every
  // platform; contention and the foreign file cover the busy and explicit fallbacks.
  test.skipIf(process.platform === "win32")("an unwritable home degrades to the streaming read", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const expected = rows.filter(row => row.provider === "openai").length;
    chmodSync(testDir, 0o555);
    try {
      const result = await getFilteredUsageAggregate({ provider: "openai" });
      expect(summary(result).summary.requests).toBe(expected);
      expect(result.filterIndex).toBeUndefined();
    } finally {
      chmodSync(testDir, 0o755);
    }
  });

  test("filtered queries after the first leave the config directory's entries unchanged", async () => {
    // On Windows a changed config directory re-runs its ACL harden, which moves usage.jsonl's
    // ChangeTime and forces whole-ledger rebuilds; SQLite deleting its WAL sidecars on every
    // close changed the directory on each filtered query.
    // Discriminates only on stock SQLite (Linux, Windows): macOS's system SQLite already keeps
    // the sidecars, so a local macOS pass is not evidence for this guard.
    writeRows(Array.from({ length: 20 }, (_, index) => syntheticRow(index)));
    const first = await getFilteredUsageAggregate({ provider: "openai" });
    const observeHome = () => {
      const stat = statSync(testDir);
      return { entries: readdirSync(testDir).sort(), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    };
    const before = observeHome();
    const other = await getFilteredUsageAggregate({ provider: "kimi" });
    // An append makes the refresh open the index for writing again.
    appendRows([{ ...syntheticRow(99), requestId: "late" }]);
    const appended = await getFilteredUsageAggregate({ provider: "openai" });
    expect(observeHome()).toEqual(before);
    for (const result of [first, other, appended]) expect(result.filterIndex).toBeDefined();
    // The append really went through a writable refresh, not a retained answer.
    expect(appended.filterIndex?.totalRows).toBe(21);
    // The kept WAL is empty after the writer's clean close.
    expect(statSync(`${usageFilterIndexPath(testDir)}-wal`).size).toBe(0);
  });

  test("a projection whose sidecars are not in the uninstall manifest is repaired on the next write", async () => {
    // Sidecars now persist, so any that exist beside this projection must be owned, or uninstall
    // leaves them behind.
    expect(initializeConfigOwnership(testDir)).toBe(true);
    writeRows(Array.from({ length: 20 }, (_, index) => syntheticRow(index)));
    await getFilteredUsageAggregate({ provider: "openai" });
    const indexPath = usageFilterIndexPath(testDir);
    const manifestPath = join(testDir, ".opencodex-uninstall.json");
    const owned = () => (JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] }).paths;
    const sidecars = ["usage-filter-index.sqlite-wal", "usage-filter-index.sqlite-shm"];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, paths: manifest.paths.filter(path => !sidecars.includes(path)) }, null, 2));
    for (const suffix of ["-wal", "-shm"]) rmSync(`${indexPath}${suffix}`, { force: true });
    resetUsageAggregateCacheForTests();
    resetAppOwnedMemoryForTests();
    expect(owned().filter(path => sidecars.includes(path))).toEqual([]);

    appendRows([{ ...syntheticRow(99), requestId: "after-upgrade" }]);
    expect((await getFilteredUsageAggregate({ provider: "openai" })).filterIndex).toBeDefined();
    expect(owned().filter(path => sidecars.includes(path)).sort()).toEqual([...sidecars].sort());
  });

  test("a 0-byte projection left by a crash and its sidecars are registered once they appear", async () => {
    // A crash between the private create and the first open leaves an empty file, so the next open
    // sees an existing projection and skips creation-time registration. The sidecars only appear
    // once SQLite uses the WAL, after this open checked, so a later open in the same process must
    // still register them.
    expect(initializeConfigOwnership(testDir)).toBe(true);
    writeRows(Array.from({ length: 20 }, (_, index) => syntheticRow(index)));
    const indexPath = usageFilterIndexPath(testDir);
    writeFileSync(indexPath, "", { mode: 0o600 });
    const manifestPath = join(testDir, ".opencodex-uninstall.json");
    const projection = ["usage-filter-index.sqlite", "usage-filter-index.sqlite-wal", "usage-filter-index.sqlite-shm"];
    const ownedSidecars = () => (JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] }).paths
      .filter(path => projection.includes(path)).sort();
    expect((await getFilteredUsageAggregate({ provider: "openai" })).filterIndex).toBeDefined();
    appendRows([{ ...syntheticRow(99), requestId: "after-crash" }]);
    expect((await getFilteredUsageAggregate({ provider: "openai" })).filterIndex).toBeDefined();
    expect(ownedSidecars()).toEqual([...projection].sort());
  });

  test("a passive read never creates or writes index files", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const expected = rows.filter(row => row.provider === "openai").length;
    const indexPath = usageFilterIndexPath(testDir);

    const cold = await runPassiveRead(async () => getFilteredUsageAggregate({ provider: "openai" }));
    expect(summary(cold).summary.requests).toBe(expected);
    expect(cold.filterIndex).toBeUndefined();
    expect(existsSync(indexPath)).toBe(false);
    expect(existsSync(`${indexPath}-wal`)).toBe(false);

    await getFilteredUsageAggregate({ provider: "openai" });
    const before = statSync(indexPath).mtimeMs;
    const warm = await runPassiveRead(async () => getFilteredUsageAggregate({ provider: "openai" }));
    expect(warm.filterIndex?.totalRows).toBe(rows.length);
    expect(statSync(indexPath).mtimeMs).toBe(before);
  });

  test("index write contention degrades to the streaming read", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });
    resetUsageAggregateCacheForTests();

    // Force the next refresh to write, then hold the index write lock from another connection.
    appendRows([{ ...syntheticRow(99), requestId: "late", provider: "kimi" }]);
    const lock = new Database(usageFilterIndexPath(testDir));
    lock.exec("BEGIN IMMEDIATE");
    try {
      const result = await getFilteredUsageAggregate({ provider: "openai" });
      expect(summary(result).summary.requests)
        .toBe(rows.filter(row => row.provider === "openai").length);
      // Contention is an index problem, not a ledger failure: the request still answers.
      expect(result.filterIndex).toBeUndefined();
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  });

  /** Delete the projection at one point of a filtered query and expect a streaming answer. */
  async function expectVanishedProjectionNotRecreated(hooks: (remove: (dbPath: string) => void) =>
    Parameters<typeof setUsageFilterIndexTestHooksForTests>[0]): Promise<void> {
    const rows = Array.from({ length: 5 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const indexPath = usageFilterIndexPath(testDir);
    let removed = false;
    setUsageFilterIndexTestHooksForTests(hooks(dbPath => {
      const existed = existsSync(dbPath);
      // A scanner can hold a just-closed file on Windows for a moment; that is not the subject.
      for (let attempt = 0; ; attempt += 1) {
        try { rmSync(dbPath, { force: true }); break; } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 4 || (code !== "EBUSY" && code !== "EPERM")) throw error;
          Bun.sleepSync(25);
        }
      }
      removed = existed && !existsSync(dbPath);
    }));
    try {
      const result = await getFilteredUsageAggregate({ provider: "openai" });
      expect(summary(result).summary.requests)
        .toBe(rows.filter(row => row.provider === "openai").length);
      expect(result.filterIndex).toBeUndefined();
    } finally {
      setUsageFilterIndexTestHooksForTests(null);
    }
    // Without this the streaming fallback would satisfy every assertion even if the hook never ran.
    expect(removed).toBe(true);
    expect(existsSync(indexPath)).toBe(false);
  }

  // Windows refuses to delete a file SQLite holds open: there the projection can only vanish once
  // the refresh has closed it, which the next case covers on every platform.
  test.skipIf(process.platform === "win32")("a projection that vanishes before the read is not recreated", async () => {
    await expectVanishedProjectionNotRecreated(remove => ({ afterPublish: ({ dbPath }) => remove(dbPath) }));
  });

  test("a projection that vanishes after the refresh closed it is not recreated by the read", async () => {
    await expectVanishedProjectionNotRecreated(remove => ({ afterRefresh: ({ dbPath }) => remove(dbPath) }));
  });

  test("a home change during a refresh never mixes installations", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });
    const offsetBefore = publishedOffset();
    appendRows([syntheticRow(50)]);

    const otherHome = mkdtempSync(join(tmpdir(), "ocx-other-home-"));
    let changed = false;
    setUsageFilterIndexTestHooksForTests({
      beforePublish: () => {
        if (changed) return;
        changed = true;
        process.env.OPENCODEX_HOME = otherHome;
      },
    });
    try {
      const result = await getFilteredUsageAggregate({ provider: "openai" });
      // The fallback reads the new home, which has no ledger at all.
      expect(summary(result).summary.requests).toBe(0);
      expect(result.filterIndex).toBeUndefined();
    } finally {
      process.env.OPENCODEX_HOME = testDir;
      setUsageFilterIndexTestHooksForTests(null);
      rmSync(otherHome, { recursive: true, force: true });
    }
    // The original home's projection was not advanced with another home's ledger.
    expect(publishedOffset()).toBe(offsetBefore);
  });
+
  test("a passive read does not report a published generation that lost its rows", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    await getFilteredUsageAggregate({ provider: "kimi" });
    const db = new Database(usageFilterIndexPath(testDir));
    try {
      db.query("DELETE FROM usage_rows").run();
      db.query("DELETE FROM usage_attributions").run();
    } finally {
      db.close();
    }
    const passive = await runPassiveRead(async () => getFilteredUsageAggregate({ provider: "openai" }));
    expect(passive.filterIndex).toBeUndefined();
    expect(summary(passive).summary.requests)
      .toBe(rows.filter(row => row.provider === "openai").length);
  });
+
  test("a foreign SQLite file with a coincidental meta table is not adopted", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => syntheticRow(index));
    writeRows(rows);
    const foreign = new Database(usageFilterIndexPath(testDir));
    try {
      foreign.exec("CREATE TABLE usage_filter_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      foreign.query("INSERT INTO usage_filter_index_meta (key, value) VALUES ('schema_version', '4')").run();
      foreign.query("INSERT INTO usage_filter_index_meta (key, value) VALUES ('generation', 'x')").run();
    } finally {
      foreign.close();
    }
    const passive = await runPassiveRead(async () => getFilteredUsageAggregate({ provider: "openai" }));
    expect(passive.filterIndex).toBeUndefined();
    expect(summary(passive).summary.requests)
      .toBe(rows.filter(row => row.provider === "openai").length);
  });

});

describe("filtered usage index row tolerance", () => {
  test("a row without a usable timestamp matches the streaming semantics", async () => {
    const broken = { ...syntheticRow(1), requestId: "no-timestamp", timestamp: null as unknown as number };
    writeRows([syntheticRow(0), broken]);

    const all = await getFilteredUsageAggregate({});
    expect(summary(all).summary.requests).toBe(2);
    expect(summary(all)).toEqual((await fullScan({})).summarize("all", NOW));

    const window = { since: NOW - 60_000, until: NOW };
    const bounded = await getFilteredUsageAggregate({}, window);
    expect(summary(bounded).summary.requests).toBe(1);
    expect(summary(bounded)).toEqual((await fullScan({}, window)).summarize("all", NOW));
  });

  test("a row with no model fails a provider filter exactly as the streaming read does", async () => {
    const broken = { ...syntheticRow(0), requestId: "no-model" } as Record<string, unknown>;
    delete broken.model;
    writeFileSync(ledgerPath(), `${JSON.stringify(broken)}\n`);

    await expect(fullScan({ provider: "openai" })).rejects.toThrow();
    await expect(getFilteredUsageAggregate({ provider: "openai" })).rejects.toThrow();
    // A provider that cannot match never reaches the model comparison, in either path.
    const other = await getFilteredUsageAggregate({ provider: "kimi" });
    expect(summary(other).summary.requests).toBe(0);
  });

  test("a row at the scanner's exact row ceiling is readable by the offset index", async () => {
    const base = syntheticRow(0);
    const empty = JSON.stringify({ ...base, padding: "" });
    const padding = "x".repeat(USAGE_LEDGER_MAX_LINE_BYTES - empty.length);
    const line = JSON.stringify({ ...base, padding });
    expect(Buffer.byteLength(line)).toBe(USAGE_LEDGER_MAX_LINE_BYTES);
    writeFileSync(ledgerPath(), `${line}\n`);

    const result = await getFilteredUsageAggregate({ provider: "openai" });
    expect(result.filterIndex?.candidateRows).toBe(1);
    expect(summary(result).summary.requests).toBe(1);
  });
});

describe("filtered usage index selection evidence", () => {
  test("selective filters use the candidate indexes", async () => {
    writeRows(Array.from({ length: 50 }, (_, index) => syntheticRow(index)));
    await getFilteredUsageAggregate({ provider: "openai" });

    const plan = (query: Parameters<typeof usageFilterCandidatePlan>[0]) =>
      usageFilterCandidatePlan(query).join("\n");
    expect(plan({ provider: "openai", model: "m-0", apiKeyId: null }))
      .toContain("idx_usage_attr_provider");
    // Both UNION branches are index-driven: the attribution side and the unattributable rows.
    expect(plan({ provider: "openai", model: "m-0", apiKeyId: null }))
      .toContain("idx_usage_rows_unattributable");
    expect(plan({ provider: null, model: null, apiKeyId: "key-a" }))
      .toContain("idx_usage_rows_key");
    expect(plan({
      provider: null,
      model: null,
      apiKeyId: null,
      sourceFilter: { client: "codex", device: { kind: "all" } },
    })).toContain("idx_usage_rows_client");
    expect(plan({
      provider: null,
      model: null,
      apiKeyId: null,
      sourceFilter: { client: "all", device: { kind: "unconfigured" } },
      configuredApiKeyIds: [],
    })).toContain("idx_usage_rows_admission");
    expect(plan({ provider: null, model: null, apiKeyId: null, window: { since: NOW - 60_000, until: NOW } }))
      .toContain("idx_usage_rows_ts");
  });

  test("every source filter selects exactly the rows matchesUsageSource keeps", async () => {
    const rows: PersistedUsageEntry[] = [];
    let ordinal = 0;
    const bare = (): PersistedUsageEntry => {
      const row = syntheticRow(ordinal) as Record<string, unknown>;
      delete row.client;
      delete row.apiKeyId;
      delete row.admissionKind;
      return row as unknown as PersistedUsageEntry;
    };
    for (const client of [...USAGE_CLIENTS, undefined] as Array<UsageClient | undefined>) {
      for (const surface of [undefined, "claude", "claude-desktop", "grok"] as const) {
        for (const admissionKind of [undefined, "configured", "environment", "loopback"] as const) {
          for (const apiKeyId of [undefined, "key-a", "key-b"] as const) {
            ordinal += 1;
            rows.push({
              ...bare(),
              requestId: `combo-${ordinal}`,
              ...(client ? { client } : {}),
              ...(surface ? { surface } : {}),
              ...(admissionKind ? { admissionKind } : {}),
              ...(apiKeyId ? { apiKeyId } : {}),
            });
          }
        }
      }
    }
    writeRows(rows);

    const devices: Array<UsageSourceFilter["device"]> = [
      { kind: "all" },
      { kind: "no-key" },
      { kind: "key", id: "key-a" },
      { kind: "unconfigured" },
    ];
    for (const client of USAGE_SOURCE_CLIENTS) {
      for (const device of devices) {
        const filter: UsageSourceFilter = { client, device };
        const expected = rows.filter(row => matchesUsageSource(row, filter, new Set())).length;
        const result = await getFilteredUsageAggregate({ sourceFilter: filter, configuredApiKeyIds: [] });
        expect({
          client,
          device,
          candidates: result.filterIndex?.candidateRows,
          requests: summary(result).summary.requests,
        }).toEqual({ client, device, candidates: expected, requests: expected });
      }
    }
  });
});
