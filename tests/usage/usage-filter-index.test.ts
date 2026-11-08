import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetAppOwnedMemoryForTests } from "../../src/lib/app-owned-memory";
import { runPassiveRead } from "../../src/lib/passive-read";
import {
  getFilteredUsageAggregate,
  resetUsageAggregateCacheForTests,
  type UsageAggregateResult,
} from "../../src/server/management/usage-aggregate-cache";
import * as ledgerScannerModule from "../../src/usage/ledger-scanner";
import {
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
  usageFilterCandidatePlan,
  usageFilterIndexPath,
} from "../../src/usage/filter-index";
import { resetUsageReadCacheForTests, type PersistedUsageEntry } from "../../src/usage/log";
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

    // A second process has staged rows and is still ingesting.
    const db = new Database(usageFilterIndexPath(testDir));
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
    expect(indexGenerations()).toHaveLength(1);
    expect(indexRowCount(published)).toBe(0);
    expect(indexRowCount("other-writer")).toBe(0);
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
    const rows = Array.from({ length: 30_000 }, (_, index) => syntheticRow(index));
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

  test("an unwritable home degrades to the streaming read", async () => {
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
