import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { refreshUserCostOverlays, resetPreservedDiskOnlyProvidersForTests, userCostOverlayVersion } from "../src/usage/user-cost-overlays";
import { stopUserCostOverlayReconciler } from "../src/usage/user-cost-overlay-reconciler";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { resetUsageReadCacheForTests, setManagementUsageMaxEntriesForTests, usageReadCacheStatsForTests } from "../src/usage/log";
import * as usageLogModule from "../src/usage/log";
import * as usageLedgerScannerModule from "../src/usage/ledger-scanner";
import { getUsageSummaryCacheEntry, resetUsageSummaryCacheForTests } from "../src/server/management/usage-summary-cache";
import * as usageAggregateCacheModule from "../src/server/management/usage-aggregate-cache";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
  } as OcxConfig;
}

function writeFixture(now: number): void {
  const lines = [
    JSON.stringify({
      requestId: "ocx-old",
      timestamp: now - 10 * 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 12,
      usageStatus: "reported",
      usage: { inputTokens: 100, outputTokens: 50 },
      totalTokens: 150,
    }),
    JSON.stringify({
      requestId: "ocx-recent",
      timestamp: now - 1 * 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 5 },
      totalTokens: 15,
    }),
    JSON.stringify({
      requestId: "ocx-missing",
      timestamp: now - 1 * 86_400_000,
      provider: "anthropic",
      model: "claude-x",
      surface: "claude",
      status: 200,
      durationMs: 11,
      usageStatus: "unreported",
    }),
  ];
  writeFileSync(join(testDir, "usage.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-usage-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-usage-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageSummaryCacheForTests();
  usageAggregateCacheModule.resetUsageAggregateCacheForTests();
  // The overlay registry is MODULE-level state that outlives a test file, and
  // this file asserts on `userCostOverlayVersion()` moving. A preserved
  // disk-only provider left behind by an earlier test — or by an earlier file in
  // the same process — makes a refresh byte-identical, so the version does not
  // bump and the mid-read assertion reads one version behind.
  //
  // Every other overlay suite already resets this; this file did not, which is
  // why it passed in CI's dedicated single-file job and failed locally in any
  // run that shared a process with overlay state.
  resetPreservedDiskOnlyProvidersForTests();
  saveConfig(baseConfig());
});

afterEach(() => {
  // Belt-and-suspenders: server.stop should release the reconciler lease, but a
  // wedged shutdown on Linux CI must not leave the 5s poll timer keeping the
  // isolate worker alive for later shard files (e.g. cli-restore-back).
  stopUserCostOverlayReconciler();
  usageAggregateCacheModule.resetUsageAggregateCacheForTests();
  // Leave no overlay state for the next file, for the same reason.
  resetPreservedDiskOnlyProvidersForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("GET /api/usage", () => {
  test("concurrent cold requests share one base-ledger scan", async () => {
    writeFixture(Date.now());
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    const originalGetAggregate = usageAggregateCacheModule.getUsageAggregate;
    let releaseScan!: () => void;
    const scanGate = new Promise<void>(resolve => { releaseScan = resolve; });
    let scannerEntered!: () => void;
    const scannerStarted = new Promise<void>(resolve => { scannerEntered = resolve; });
    let aggregateCalls = 0;
    let secondAggregateCall!: () => void;
    const bothRequestsEntered = new Promise<void>(resolve => { secondAggregateCall = resolve; });
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scannerEntered();
        await scanGate;
        return originalScan(options);
      });
    const aggregateSpy = spyOn(usageAggregateCacheModule, "getUsageAggregate")
      .mockImplementation(options => {
        aggregateCalls += 1;
        if (aggregateCalls === 2) secondAggregateCall();
        return originalGetAggregate(options);
      });
    const server = startServer(0);
    try {
      const first = fetch(new URL("/api/usage?range=30d", server.url));
      await scannerStarted;
      const second = fetch(new URL("/api/usage?range=7d", server.url));
      await bothRequestsEntered;
      expect(aggregateCalls).toBe(2);
      expect(scanSpy).toHaveBeenCalledTimes(1);
      releaseScan();

      const [firstBody, secondBody] = await Promise.all([
        first.then(response => response.json()),
        second.then(response => response.json()),
      ]);
      expect(firstBody.summary.requests).toBe(3);
      expect(secondBody.summary.requests).toBe(2);
      expect(scanSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseScan();
      aggregateSpy.mockRestore();
      scanSpy.mockRestore();
      await server.stop(true);
    }
  });

  test("returns documented shape with summary, days, models, providers, and accounts", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("range");
      expect(body.surface).toBe("all");
      expect(body).toHaveProperty("summary");
      expect(body).toHaveProperty("days");
      expect(body).toHaveProperty("models");
      expect(body).toHaveProperty("providers");
      expect(body).toHaveProperty("accounts");
      expect(body).toMatchObject({ historyTruncated: false, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0 });
      expect(Array.isArray(body.days)).toBe(true);
      expect(Array.isArray(body.models)).toBe(true);
      expect(Array.isArray(body.providers)).toBe(true);
      expect(Array.isArray(body.accounts)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("a former byte limit no longer drops history and complete metadata is cached", async () => {
    const now = Date.now();
    writeFixture(now);
    saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 256 });
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/usage?range=all", server.url)).then(response => response.json());
      const second = await fetch(new URL("/api/usage?range=all", server.url)).then(response => response.json());
      expect(first.summary).toMatchObject({ requests: 3, totalTokens: 165 });
      expect(second).toMatchObject({
        historyTruncated: false,
        truncatedPrefixBytes: 0,
        entriesTruncated: false,
        entriesDropped: 0,
        snapshotWindowStart: now - 10 * 86_400_000,
        snapshotWindowEnd: now - 1 * 86_400_000,
      });
      expect(getUsageSummaryCacheEntry("all:all")?.summary.summary.requests).toBe(3);
    } finally {
      await server.stop(true);
    }
  });

  // #1497: the scanner reads every complete row while retaining only aggregate
  // state, so the response window now spans the complete valid ledger rather
  // than a bounded tail.
  describe("snapshot window disclosure (#1497)", () => {
    test("a former tail-sized read reports the complete fixture window", async () => {
      const now = Date.now();
      writeFixture(now);
      saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 256 });
      const server = startServer(0);
      try {
        const body = await fetch(new URL("/api/usage?range=30d", server.url)).then(r => r.json());
        expect(body.historyTruncated).toBe(false);
        expect(body.truncatedPrefixBytes).toBe(0);
        expect(body.summary.requests).toBe(3);
        expect(body.snapshotWindowStart).toBe(now - 10 * 86_400_000);
        expect(body.snapshotWindowEnd).toBe(now - 1 * 86_400_000);
      } finally {
        await server.stop(true);
      }
    });

    test("the complete window is independent of range and surface filters", async () => {
      const now = Date.now();
      const oldest = now - 200 * 86_400_000;
      const rows = [
        ...Array.from({ length: 40 }, (_, i) => ({
          requestId: `ocx-prefix-${i}`,
          timestamp: oldest,
          provider: "openai",
          model: "gpt-5.5",
          status: 200,
          durationMs: 5,
          usageStatus: "reported" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          totalTokens: 2,
        })),
        // Outside a 30d window, so only the range filter discards it.
        {
          requestId: "ocx-window-old",
          timestamp: now - 90 * 86_400_000,
          provider: "openai",
          model: "gpt-5.5",
          status: 200,
          durationMs: 5,
          usageStatus: "reported" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
          totalTokens: 15,
        },
        // Inside 30d, but a Codex surface so the claude filter discards it.
        {
          requestId: "ocx-window-codex",
          timestamp: now - 2 * 86_400_000,
          provider: "openai",
          model: "gpt-5.5",
          status: 200,
          durationMs: 5,
          usageStatus: "reported" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
          totalTokens: 15,
        },
        // Inside 30d and on the Claude surface.
        {
          requestId: "ocx-window-claude",
          timestamp: now - 1 * 86_400_000,
          provider: "anthropic",
          model: "claude-x",
          surface: "claude",
          status: 200,
          durationMs: 5,
          usageStatus: "reported" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
          totalTokens: 15,
        },
      ];
      writeFileSync(join(testDir, "usage.jsonl"), `${rows.map(r => JSON.stringify(r)).join("\n")}\n`);
      const tailBytes = rows.slice(-3).reduce((sum, r) => sum + Buffer.byteLength(`${JSON.stringify(r)}\n`), 0);
      saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: tailBytes + 8 });
      const server = startServer(0);
      try {
        const all = await fetch(new URL("/api/usage?range=all", server.url)).then(r => r.json());
        const thirty = await fetch(new URL("/api/usage?range=30d", server.url)).then(r => r.json());
        const claude = await fetch(new URL("/api/usage?range=all&surface=claude", server.url)).then(r => r.json());

        expect(all.historyTruncated).toBe(false);
        expect(all.summary.requests).toBe(43);
        expect(thirty.summary.requests).toBe(2);
        expect(claude.summary.requests).toBe(1);

        expect(all.snapshotWindowStart).toBe(oldest);
        expect(all.snapshotWindowEnd).toBe(now - 1 * 86_400_000);

        for (const body of [thirty, claude]) {
          expect(typeof body.snapshotWindowStart).toBe("number");
          expect(typeof body.snapshotWindowEnd).toBe("number");
          expect(body.snapshotWindowStart).toBe(all.snapshotWindowStart);
          expect(body.snapshotWindowEnd).toBe(all.snapshotWindowEnd);
        }
      } finally {
        await server.stop(true);
      }
    });

    test("an untruncated read spans the whole fixture and reports no truncation", async () => {
      const now = Date.now();
      writeFixture(now);
      const server = startServer(0);
      try {
        const body = await fetch(new URL("/api/usage?range=all", server.url)).then(r => r.json());
        expect(body.historyTruncated).toBe(false);
        // The oldest fixture row is 10 days back; an unbounded read must include it.
        expect(body.snapshotWindowStart).toBeLessThanOrEqual(now - 10 * 86_400_000 + 1000);
        expect(body.snapshotWindowEnd).toBeGreaterThanOrEqual(body.snapshotWindowStart);
      } finally {
        await server.stop(true);
      }
    });

    test("an empty ledger reports null bounds rather than NaN or Infinity", async () => {
      writeFileSync(join(testDir, "usage.jsonl"), "");
      const server = startServer(0);
      try {
        const body = await fetch(new URL("/api/usage?range=all", server.url)).then(r => r.json());
        expect(body.snapshotWindowStart).toBeNull();
        expect(body.snapshotWindowEnd).toBeNull();
      } finally {
        await server.stop(true);
      }
    });

    test("a cached response carries the window through unchanged", async () => {
      writeFixture(Date.now());
      saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 256 });
      const server = startServer(0);
      try {
        const first = await fetch(new URL("/api/usage?range=all", server.url)).then(r => r.json());
        expect(getUsageSummaryCacheEntry("all:all")).toBeDefined();
        const second = await fetch(new URL("/api/usage?range=all", server.url)).then(r => r.json());
        expect(typeof first.snapshotWindowStart).toBe("number");
        expect(typeof first.snapshotWindowEnd).toBe("number");
        expect(second.snapshotWindowStart).toBe(first.snapshotWindowStart);
        expect(second.snapshotWindowEnd).toBe(first.snapshotWindowEnd);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("reuses only a compact summary for an unchanged revision", async () => {
    writeFixture(Date.now());
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    const scanStarts: number[] = [];
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively").mockImplementation(async options => {
      scanStarts.push(options.startAtBytes ?? 0);
      return originalScan(options);
    });
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      const second = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(second.summary).toEqual(first.summary);
      expect(getUsageSummaryCacheEntry("30d:all")?.summary.summary).toEqual(first.summary);

      appendFileSync(join(testDir, "usage.jsonl"), `${JSON.stringify({
        requestId: "ocx-appended",
        timestamp: Date.now(),
        provider: "openai",
        model: "gpt-5.5",
        status: 200,
        durationMs: 1,
        usageStatus: "reported",
        usage: { inputTokens: 1, outputTokens: 1 },
        totalTokens: 2,
      })}\n`);
      const stale = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(stale.summary.requests).toBe(first.summary.requests);

      const originalNow = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(originalNow + 60_001);
      try {
        const changed = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
        expect(changed.summary.requests).toBe(first.summary.requests + 1);
        expect(scanStarts).toHaveLength(2);
        expect(scanStarts[0]).toBe(0);
        expect(scanStarts[1]).toBeGreaterThan(0);
      } finally {
        clock.mockRestore();
      }
    } finally {
      scanSpy.mockRestore();
      await server.stop(true);
    }
  });

  test("usage route cache invalidates when the user cost overlay version changes", async () => {
    writeFixture(Date.now());
    // Start from a known overlay version so a leftover entry from an earlier
    // test cannot satisfy the first request. This must run BEFORE startServer:
    // the server boot loads the config and refreshes the overlay registry, and
    // the version has to be settled by the time the first request caches.
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      const second = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(second.summary).toEqual(first.summary);
      const cachedOverlayVersion = getUsageSummaryCacheEntry("30d:all")?.overlayVersion ?? -1;
      // A modelCosts save refreshes the overlay registry and bumps its version;
      // the cached summary must not be reused even though the usage log is unchanged.
      refreshUserCostOverlays({
        providers: {
          blsc: {
            modelCosts: {
              "deepseek-v4-flash": { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.25 },
            },
          },
        },
      } as unknown as OcxConfig);
      const changed = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(changed.summary.requests).toBe(first.summary.requests);
      expect(getUsageSummaryCacheEntry("30d:all")?.overlayVersion).toBeGreaterThan(cachedOverlayVersion);
    } finally {
      // This test installs a module-level blsc overlay; clear it even when an
      // assertion or shutdown fails so later tests cannot resolve
      // user-configured prices unexpectedly.
      refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
      await server.stop(true);
    }
  });

  test("usage route cache invalidates when the local calendar time zone changes", async () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = "UTC";
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(getUsageSummaryCacheEntry("30d:all")?.timeZone).toBe("UTC");

      process.env.TZ = "America/Los_Angeles";
      await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(getUsageSummaryCacheEntry("30d:all")?.timeZone).toBe("America/Los_Angeles");
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
      await server.stop(true);
    }
  });

  test("usage route retries an overlay change and caches only the settled rebuild", async () => {
    writeFixture(Date.now());
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
    resetUsageSummaryCacheForTests();
    const versionBefore = userCostOverlayVersion();
    // Deterministically bump the overlay version DURING the ledger scan, so
    // the summary is computed under a version that is stale before the cache
    // stamp — the interleaving that previously stamped an old-price summary as
    // current. The spy must be installed before the first /api/usage request:
    // a warm request would be served from the summary cache and never reach
    // the read.
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    let bumped = false;
    let scans = 0;
    const scanOverlayVersions: number[] = [];
    const spy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively").mockImplementation(async options => {
      scans += 1;
      scanOverlayVersions.push(userCostOverlayVersion());
      const snapshot = await originalScan(options);
      if (!bumped) {
        bumped = true;
        refreshUserCostOverlays({
          providers: {
            blsc: {
              modelCosts: {
                "deepseek-v4-flash": { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.25 },
              },
            },
          },
        } as unknown as OcxConfig);
      }
      return snapshot;
    });
    const server = startServer(0);
    try {
      const raced = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(bumped).toBe(true);
      expect(userCostOverlayVersion()).toBeGreaterThan(versionBefore);
      // The retained rebuild detects the changed pricing input and retries the
      // full scan before publishing. No mixed-version aggregate is visible;
      // the one route response and its cache entry both come from the settled
      // second scan.
      expect(scans).toBe(2);
      expect(getUsageSummaryCacheEntry("30d:all")?.overlayVersion)
        .toBe(scanOverlayVersions[1]);

      spy.mockRestore();
      // The process-global overlay may move again after the response (for
      // example when the config poller reloads disk). That cannot retroactively
      // change the version the settled scan used; the next request must either
      // reuse that exact version or rebuild under a newer one.
      const nextRequestVersion = userCostOverlayVersion();
      const settled = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(settled.summary).toEqual(raced.summary);
      expect(getUsageSummaryCacheEntry("30d:all")?.overlayVersion)
        .toBeGreaterThanOrEqual(nextRequestVersion);
    } finally {
      spy.mockRestore();
      // Clear the module-level overlay and summary cache even when an
      // assertion or shutdown fails so later tests start clean.
      refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
      resetUsageSummaryCacheForTests();
      await server.stop(true);
    }
  });

  test("range=7d drops entries older than 7 days", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?range=7d", server.url));
      const body = await res.json();
      expect(body.range).toBe("7d");
      expect(body.summary.requests).toBe(2);
      expect(body.summary.totalTokens).toBe(15);
    } finally {
      await server.stop(true);
    }
  });

  test("default range is 30d and includes the older entry", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      const body = await res.json();
      expect(body.range).toBe("30d");
      expect(body.summary.requests).toBe(3);
      expect(body.summary.measuredRequests).toBe(2);
      expect(body.summary.reportedRequests).toBe(2);
      expect(body.summary.unreportedRequests).toBe(1);
      expect(body.summary.totalTokens).toBe(165);
    } finally {
      await server.stop(true);
    }
  });

  test("unknown range falls back to 30d", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?range=quarter", server.url));
      const body = await res.json();
      expect(body.range).toBe("30d");
    } finally {
      await server.stop(true);
    }
  });

  test("today narrows the window to the current local day", async () => {
    const now = Date.now();
    writeFixture(now);
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/usage?range=today", server.url)).then(res => res.json());
      expect(body.range).toBe("today");
      // A range that missed its rangeWindow branch would fall through to the
      // all-history window and report since: null while looking plausible.
      expect(body.since).not.toBeNull();
      expect(body.days).toHaveLength(1);
      const thirtyDay = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(body.summary.requests).toBeLessThan(thirtyDay.summary.requests);
    } finally {
      await server.stop(true);
    }
  });

  test("1d is an alias for today, not a separate range", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/usage?range=1d", server.url)).then(res => res.json());
      expect(body.range).toBe("today");
    } finally {
      await server.stop(true);
    }
  });

  test("provider filter narrows the rows and echoes what it matched", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/usage?range=all&provider=openai", server.url)).then(res => res.json());
      expect(body.filter).toMatchObject({ provider: "openai", model: null, matched: true });
      expect(body.models.every((row: { provider: string }) => row.provider === "openai")).toBe(true);
      expect(body.providers.every((row: { provider: string }) => row.provider === "openai")).toBe(true);
      const providerCost = body.providers.reduce((acc: number, row: { estimatedCostUsd?: number }) => acc + (row.estimatedCostUsd ?? 0), 0);
      expect(body.summary.estimatedCostUsd).toBeCloseTo(providerCost, 8);
      // Account rows are not provider-partitioned in a way the projection can
      // honestly re-derive, so they are dropped rather than shown unfiltered
      // beside filtered totals.
      expect(body.accounts).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("provider matching is case-insensitive", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const upper = await fetch(new URL("/api/usage?range=all&provider=OPENAI", server.url)).then(res => res.json());
      expect(upper.filter.matched).toBe(true);
      expect(upper.models.length).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a model filter remains active when the provider parameter is empty", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/usage?range=all&provider=&model=gpt-5.5", server.url)).then(res => res.json());
      expect(body.filter).toMatchObject({ provider: null, model: "gpt-5.5", matched: true });
      expect(body.summary.requests).toBe(2);
      expect(body.models.every((row: { model: string }) => row.model === "gpt-5.5")).toBe(true);
      expect(body.accounts).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("a filter that matches nothing reports an empty window, not the unfiltered one", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/usage?range=all&provider=no-such-provider", server.url)).then(res => res.json());
      expect(body.filter).toMatchObject({ provider: "no-such-provider", matched: false });
      expect(body.models).toEqual([]);
      expect(body.providers).toEqual([]);
      expect(body.summary.requests).toBe(0);
      expect(body.summary.estimatedCostUsd).toBe(0);
      expect(body.days.every((day: { requests: number }) => day.requests === 0)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("a filtered request never poisons the cache for the next unfiltered one", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      // A filtered scan never writes the range:surface cache. Otherwise the
      // dashboard could be served one provider's totals as the whole window.
      const filtered = await fetch(new URL("/api/usage?range=all&provider=no-such-provider", server.url)).then(res => res.json());
      expect(filtered.summary.requests).toBe(0);

      const unfiltered = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(unfiltered.filter).toBeUndefined();
      expect(unfiltered.summary.requests).toBeGreaterThan(0);
      expect(unfiltered.models.length).toBeGreaterThan(0);
      expect(unfiltered.accounts.length).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });

  test("apiKeyId is an exact projection and composes with provider and model filters", async () => {
    const now = Date.now();
    const rows = [
      { requestId: "a-openai", timestamp: now, apiKeyId: "Key-A", provider: "openai", model: "gpt-5.5", status: 200, durationMs: 1, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 2 }, totalTokens: 12 },
      { requestId: "a-anthropic", timestamp: now, apiKeyId: "Key-A", provider: "anthropic", model: "claude-x", status: 200, durationMs: 1, usageStatus: "reported", usage: { inputTokens: 20, outputTokens: 3 }, totalTokens: 23 },
      { requestId: "b", timestamp: now, apiKeyId: "key-a", provider: "openai", model: "gpt-5.5", status: 200, durationMs: 1, usageStatus: "reported", usage: { inputTokens: 30, outputTokens: 4 }, totalTokens: 34 },
      { requestId: "legacy", timestamp: now, provider: "openai", model: "gpt-5.5", status: 200, durationMs: 1, usageStatus: "reported", usage: { inputTokens: 40, outputTokens: 5 }, totalTokens: 45 },
    ];
    writeFileSync(join(testDir, "usage.jsonl"), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    const server = startServer(0);
    try {
      const own = await fetch(new URL("/api/usage?range=all&apiKeyId=Key-A", server.url)).then(res => res.json());
      expect(own.filter).toMatchObject({ apiKeyId: "Key-A", provider: null, model: null, matched: true });
      expect(own.summary.requests).toBe(2);

      const combined = await fetch(new URL("/api/usage?range=all&apiKeyId=Key-A&provider=openai&model=gpt-5.5", server.url)).then(res => res.json());
      expect(combined.summary.requests).toBe(1);
      expect(combined.models).toHaveLength(1);

      const exactCase = await fetch(new URL("/api/usage?range=all&apiKeyId=key-a", server.url)).then(res => res.json());
      expect(exactCase.summary.requests).toBe(1);

      const missing = await fetch(new URL("/api/usage?range=all&apiKeyId=missing", server.url)).then(res => res.json());
      expect(missing.filter).toMatchObject({ apiKeyId: "missing", matched: false });
      expect(missing.summary.requests).toBe(0);

      const unfiltered = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(unfiltered.filter).toBeUndefined();
      expect(unfiltered.summary.requests).toBe(4);
    } finally {
      await server.stop(true);
    }
  });

  test("the filter is applied on the cache-hit path too", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      // Warm the cache first, then filter. A projection wired only into the
      // fresh-compute path would work until the cache warmed and then silently
      // return unfiltered rows.
      await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(getUsageSummaryCacheEntry("all:all")).toBeDefined();

      const filtered = await fetch(new URL("/api/usage?range=all&provider=openai", server.url)).then(res => res.json());
      expect(filtered.filter).toMatchObject({ provider: "openai", matched: true });
      expect(filtered.models.every((row: { provider: string }) => row.provider === "openai")).toBe(true);
      expect(filtered.accounts).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("filters by surface and normalizes unknown values to all", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const codex = await fetch(new URL("/api/usage?range=all&surface=codex", server.url)).then(res => res.json());
      expect(codex.surface).toBe("codex");
      expect(codex.summary).toMatchObject({ requests: 2, totalTokens: 165 });
      expect(codex.models.map((model: { model: string }) => model.model)).toEqual(["gpt-5.5"]);
      expect(codex.providers.map((provider: { provider: string }) => provider.provider)).toEqual(["openai"]);

      const claude = await fetch(new URL("/api/usage?range=all&surface=claude", server.url)).then(res => res.json());
      expect(claude.surface).toBe("claude");
      expect(claude.summary).toMatchObject({ requests: 1, totalTokens: 0 });
      expect(claude.models.map((model: { model: string }) => model.model)).toEqual(["claude-x"]);
      expect(claude.providers.map((provider: { provider: string }) => provider.provider)).toEqual(["anthropic"]);

      const fallback = await fetch(new URL("/api/usage?range=all&surface=unknown", server.url)).then(res => res.json());
      expect(fallback.surface).toBe("all");
      expect(fallback.summary).toMatchObject({ requests: 3, totalTokens: 165 });
    } finally {
      await server.stop(true);
    }
  });

  test("read failure keeps the normalized surface in the fallback response", async () => {
    mkdirSync(join(testDir, "usage.jsonl"));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?surface=claude", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.surface).toBe("claude");
      expect(body.summary.requests).toBe(0);
      expect(body.accounts).toEqual([]);
      expect(body.error).toBe("read_failed");
    } finally {
      await server.stop(true);
    }
  });

  test("an oversized row fails closed instead of caching a partial aggregate", async () => {
    const now = Date.now();
    const oversized = {
      requestId: "ocx-oversized",
      timestamp: now,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 100, outputTokens: 50 },
      totalTokens: 150,
      padding: "x".repeat(usageLedgerScannerModule.USAGE_LEDGER_MAX_LINE_BYTES),
    };
    const valid = {
      requestId: "ocx-valid-after-oversized",
      timestamp: now,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    };
    writeFileSync(join(testDir, "usage.jsonl"), `${JSON.stringify(oversized)}\n${JSON.stringify(valid)}\n`);
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(body.error).toBe("read_failed");
      expect(body.summary.requests).toBe(0);
      expect(body.historyTruncated).toBe(false);
      expect(getUsageSummaryCacheEntry("all:all")).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("missing usage.jsonl returns zeroed summary, not 500", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.requests).toBe(0);
      expect(body.summary.measuredRequests).toBe(0);
      expect(body.summary.totalTokens).toBe(0);
      expect(body.summary.coverageRatio).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("one complete scan warms every unfiltered range and surface cache slot", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      await fetch(new URL("/api/usage?range=7d&surface=claude", server.url)).then(res => res.json());
      for (const range of ["today", "7d", "30d", "all"]) {
        for (const surface of ["all", "codex", "claude", "grok"]) {
          expect(getUsageSummaryCacheEntry(`${range}:${surface}`)).toBeDefined();
        }
      }
      const aggregateStats = usageAggregateCacheModule.usageAggregateRetainedStats();
      expect(aggregateStats).toMatchObject({ count: 1, pinnedBytes: 0 });
      expect(aggregateStats.bytes).toBeGreaterThan(0);
      const memory = await fetch(new URL("/api/system/memory", server.url)).then(res => res.json());
      expect(memory.appOwnedBytes.stores.usage_snapshot).toMatchObject({
        count: 1,
        bytes: aggregateStats.bytes,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("large daily token totals stay exact beyond 32-bit counters", async () => {
    const now = Date.now();
    const perDayTokens = 4_000_000_000;
    const rows = Array.from({ length: 30 }, (_, index) => ({
      requestId: `ocx-large-${index}`,
      timestamp: now - index * 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: perDayTokens, outputTokens: 0 },
      totalTokens: perDayTokens,
    }));
    writeFileSync(join(testDir, "usage.jsonl"), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      const expectedTokens = 120_000_000_000;
      expect(body.summary).toMatchObject({ requests: 30, totalTokens: expectedTokens });
      expect(body.models[0].totalTokens).toBe(expectedTokens);
      expect(body.providers[0].totalTokens).toBe(expectedTokens);
      expect(body.days.reduce((sum: number, day: { totalTokens: number }) => sum + day.totalTokens, 0)).toBe(expectedTokens);
      expect(body.historyTruncated).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});
