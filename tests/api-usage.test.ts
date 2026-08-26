import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { refreshUserCostOverlays, resetPreservedDiskOnlyProvidersForTests, userCostOverlayVersion } from "../src/usage/user-cost-overlays";
import { stopUserCostOverlayReconciler } from "../src/usage/user-cost-overlay-reconciler";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { resetUsageReadCacheForTests, setManagementUsageMaxEntriesForTests, usageReadCacheStatsForTests } from "../src/usage/log";
import * as usageLogModule from "../src/usage/log";
import { getUsageSummaryCacheEntry, resetUsageSummaryCacheForTests } from "../src/server/management/usage-summary-cache";

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
  resetUsageReadCacheForTests();
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
  // Leave no overlay state for the next file, for the same reason.
  resetPreservedDiskOnlyProvidersForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("GET /api/usage", () => {
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

  test("usage route cache preserves truncation metadata and invalidates when configured byte limit changes", async () => {
    writeFixture(Date.now());
    saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 256 });
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/usage?range=all", server.url)).then(response => response.json());
      const second = await fetch(new URL("/api/usage?range=all", server.url)).then(response => response.json());
      expect(first.historyTruncated).toBe(true);
      expect(first.truncatedPrefixBytes).toBeGreaterThan(0);
      expect(second).toMatchObject({
        historyTruncated: first.historyTruncated,
        truncatedPrefixBytes: first.truncatedPrefixBytes,
        entriesTruncated: first.entriesTruncated,
        entriesDropped: first.entriesDropped,
      });
    } finally {
      await server.stop(true);
    }
  });

  // #1497: on a busy installation the newest `managementUsageMaxReadBytes` can cover far less
  // than the selected range, so `30d` and "Available history" summarize the same moving tail.
  // The response now names the window the reader actually loaded. It describes the READ, not
  // the query — usage.jsonl is appended on request completion while rows carry the request
  // start time, so the oldest loaded row does not bound what the dropped prefix contains, and
  // no field here may be read as a completeness claim.
  describe("snapshot window disclosure (#1497)", () => {
    test("a truncated read reports the loaded window, and it matches the rows that survived", async () => {
      const now = Date.now();
      writeFixture(now);
      saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 256 });
      const server = startServer(0);
      try {
        const body = await fetch(new URL("/api/usage?range=30d", server.url)).then(r => r.json());
        expect(body.historyTruncated).toBe(true);
        expect(typeof body.snapshotWindowStart).toBe("number");
        expect(typeof body.snapshotWindowEnd).toBe("number");
        expect(body.snapshotWindowStart).toBeLessThanOrEqual(body.snapshotWindowEnd);
        // The dropped prefix is the OLDEST part of the file, so a truncated read cannot still
        // start at the fixture's oldest row.
        expect(body.snapshotWindowStart).toBeGreaterThan(now - 10 * 86_400_000);
      } finally {
        await server.stop(true);
      }
    });

    test("the window describes the read, so range and surface filters do not move it", async () => {
      // A tail small enough to truncate but large enough to retain rows the filters will
      // actually discard. Retaining a single row would make every filter a no-op and the
      // assertions vacuous, which is exactly what an earlier version of this test did.
      const now = Date.now();
      const oldest = now - 200 * 86_400_000;
      const rows = [
        // Dropped by the byte limit: only here to make the read truncated.
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
        // Retained, and deliberately outside a 30d window so the range filter discards it.
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
        // Retained and inside 30d, but a Codex surface so the claude filter discards it.
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
        // Retained, inside 30d, and a claude surface: survives every filter.
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
      // Sized to keep the last three rows and drop the 40-row prefix.
      const tailBytes = rows.slice(-3).reduce((sum, r) => sum + Buffer.byteLength(`${JSON.stringify(r)}\n`), 0);
      saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: tailBytes + 8 });
      const server = startServer(0);
      try {
        const all = await fetch(new URL("/api/usage?range=all", server.url)).then(r => r.json());
        const thirty = await fetch(new URL("/api/usage?range=30d", server.url)).then(r => r.json());
        const claude = await fetch(new URL("/api/usage?range=all&surface=claude", server.url)).then(r => r.json());

        expect(all.historyTruncated).toBe(true);
        // The retained set really is what the filters will cut down.
        expect(all.summary.requests).toBe(3);
        expect(thirty.summary.requests).toBe(2);
        expect(claude.summary.requests).toBe(1);

        // Exact bounds, computed independently of the reader.
        expect(all.snapshotWindowStart).toBe(now - 90 * 86_400_000);
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
        const second = await fetch(new URL("/api/usage?range=all", server.url)).then(r => r.json());
        // Prove the second response is a cache hit rather than a second full read; otherwise
        // this asserts nothing about the cache path.
        expect(usageReadCacheStatsForTests().fullReads).toBe(1);
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
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      const second = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(second.summary).toEqual(first.summary);
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);

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
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);

      const originalNow = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(originalNow + 60_001);
      try {
        const changed = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
        expect(changed.summary.requests).toBe(first.summary.requests + 1);
        // The append is picked up by extending the retained tail, so the whole 64 MiB
        // window is NOT reparsed: a second full read here is the regression this guards.
        expect(usageReadCacheStatsForTests().fullReads).toBe(1);
        expect(usageReadCacheStatsForTests().tailReads).toBeGreaterThan(0);
      } finally {
        clock.mockRestore();
      }
    } finally {
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
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);
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
      // The ledger did not change, so the recompute reuses the retained tail rather
      // than reparsing the window; only the summary cache is invalidated.
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);
    } finally {
      // This test installs a module-level blsc overlay; clear it even when an
      // assertion or shutdown fails so later tests cannot resolve
      // user-configured prices unexpectedly.
      refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
      await server.stop(true);
    }
  });

  test("usage route does not cache a summary whose overlay version changed mid-read", async () => {
    writeFixture(Date.now());
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
    resetUsageSummaryCacheForTests();
    const versionBefore = userCostOverlayVersion();
    // Deterministically bump the overlay version DURING the snapshot read, so
    // the summary is computed under a version that is stale before the cache
    // stamp — the interleaving that previously stamped an old-price summary as
    // current. The spy must be installed before the first /api/usage request:
    // a warm request would be served from the summary cache and never reach
    // the read.
    const originalRead = usageLogModule.readUsageSnapshotForManagement;
    let bumped = false;
    const spy = spyOn(usageLogModule, "readUsageSnapshotForManagement").mockImplementation(async (maxReadBytes?: number) => {
      const snapshot = await originalRead(maxReadBytes);
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
      // The mid-read change must NOT leave a cache entry: the mixed-price
      // summary is served uncached so the next request recomputes.
      expect(getUsageSummaryCacheEntry("30d:all")).toBeUndefined();

      spy.mockRestore();
      // Once the overlay is settled, the next request recomputes and caches
      // under the new version.
      //
      // Capture the version the settled request will price under BEFORE issuing
      // it. The live counter is not a stable oracle here: the server's own
      // overlay reconciler refreshes the registry on its poll, so re-reading it
      // after the response can observe a later version than the one the summary
      // was computed with. The contract under test is "the cache is stamped with
      // the version its summary was priced under", not "the counter never moves
      // again" — asserting the latter made this test fail on any machine where a
      // poll landed inside the request.
      const settledVersion = userCostOverlayVersion();
      const settled = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(settled.summary.requests).toBe(raced.summary.requests);
      expect(getUsageSummaryCacheEntry("30d:all")?.overlayVersion).toBeGreaterThanOrEqual(settledVersion);
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
      // The cache key is `range:surface` and the warm loop writes every key on
      // a miss. If the filter reached the producer, this filtered request would
      // store a narrowed summary under "all:all" and the dashboard would then
      // be served one provider's totals as the whole window.
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

  test("repeated appends do not reparse the retained prefix", async () => {
    const now = Date.now();
    writeFixture(now);
    resetUsageReadCacheForTests();
    resetUsageSummaryCacheForTests();
    const server = startServer(0);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      const afterFirst = usageReadCacheStatsForTests();
      expect(afterFirst.fullReads).toBe(1);
      const baselineParsed = afterFirst.parsedLines;
      expect(baselineParsed).toBeGreaterThan(0);

      // Append one row at a time, stepping past the 60s freshness window each round so
      // every request is a genuine cache miss that reaches the reader.
      let requests = 0;
      for (let round = 1; round <= 5; round++) {
        appendFileSync(join(testDir, "usage.jsonl"), `${JSON.stringify({
          requestId: `ocx-append-${round}`,
          timestamp: now,
          provider: "openai",
          model: "gpt-5.5",
          status: 200,
          durationMs: 1,
          usageStatus: "reported",
          usage: { inputTokens: 1, outputTokens: 1 },
          totalTokens: 2,
        })}\n`);
        clock.mockReturnValue(now + round * 60_001);
        const body = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
        requests = body.summary.requests;
      }

      const afterAppends = usageReadCacheStatsForTests();
      // Each round parses only its own appended line, so growth equals the number of
      // appended rows. A reparse regression would instead re-add the whole grown
      // prefix every round (baselineParsed+1 ... baselineParsed+5).
      expect(afterAppends.parsedLines - baselineParsed).toBe(5);
      expect(afterAppends.fullReads).toBe(1);
      expect(afterAppends.tailReads).toBeGreaterThanOrEqual(5);
      // The rows are still correct, not merely cheap.
      expect(requests).toBe(afterFirst.parsedLines + 5);
    } finally {
      clock.mockRestore();
      await server.stop(true);
    }
  });

  test("an append burst larger than the byte window falls back to a bounded full read", async () => {
    const now = Date.now();
    const maxReadBytes = 512;
    const row = (id: string): string => `${JSON.stringify({
      requestId: id,
      timestamp: now,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    })}\n`;
    const path = join(testDir, "usage.jsonl");
    writeFileSync(path, row("seed"));

    await usageLogModule.readUsageSnapshotForManagement(maxReadBytes);
    const parsedBeforeBurst = usageReadCacheStatsForTests().parsedLines;
    appendFileSync(path, Array.from({ length: 100 }, (_, index) => row(`burst-${index}`)).join(""));

    const snapshot = await usageLogModule.readUsageSnapshotForManagement(maxReadBytes);
    const stats = usageReadCacheStatsForTests();
    expect(stats.fullReads).toBe(2);
    expect(stats.tailReads).toBe(0);
    expect(stats.parsedLines - parsedBeforeBurst).toBe(snapshot.entries.length);
    expect(snapshot.entries.length).toBeLessThan(100);
    expect(snapshot.entries.some(entry => entry.requestId === "burst-99")).toBe(true);
  });

  test("appends to an over-window ledger stay incremental and bounded", async () => {
    const now = Date.now();
    writeFixture(now);
    // A tiny window makes the bound reachable with a handful of rows.
    saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 1024 });
    resetUsageReadCacheForTests();
    resetUsageSummaryCacheForTests();
    const server = startServer(0);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);

      // Append well past the window. This is the shape of the real 245 MB ledger, and
      // the case the whole optimization exists for: a reader that refused to extend
      // whenever the retained window started earlier than the current window would do a
      // FULL reparse on every single append here, which is where the memory blow-up
      // came from in the first place.
      for (let round = 1; round <= 12; round++) {
        appendFileSync(join(testDir, "usage.jsonl"), `${JSON.stringify({
          requestId: `ocx-window-${round}`,
          timestamp: now,
          provider: "openai",
          model: "gpt-5.5",
          status: 200,
          durationMs: 1,
          usageStatus: "reported",
          usage: { inputTokens: 1, outputTokens: 1 },
          totalTokens: 2,
        })}\n`);
        clock.mockReturnValue(now + round * 60_001);
        await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      }

      const stats = usageReadCacheStatsForTests();
      // Most rounds must be served incrementally rather than reparsed.
      expect(stats.tailReads).toBeGreaterThanOrEqual(6);
      // Re-anchoring still happens, so retention cannot grow with the file forever,
      // but it is amortized rather than paid per append.
      expect(stats.fullReads).toBeLessThan(12);
      clock.mockReturnValue(now + 13 * 60_001);
      const body = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(body.historyTruncated).toBe(true);
    } finally {
      clock.mockRestore();
      await server.stop(true);
    }
  });

  test("an in-place rewrite that keeps the inode is not served from the retained tail", async () => {
    const now = Date.now();
    resetUsageReadCacheForTests();
    resetUsageSummaryCacheForTests();
    // Fixed-width request ids so the rewritten rows are byte-for-byte the same length
    // as the originals. A newline therefore still lands exactly at the previously
    // covered offset, which defeats the record-boundary check -- only re-verifying the
    // covered prefix can catch this rewrite.
    const row = (id: string): string => `${JSON.stringify({
      requestId: id,
      timestamp: now - 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    })}\n`;
    writeFileSync(join(testDir, "usage.jsonl"), `${row("aaa1")}${row("aaa2")}${row("aaa3")}`);
    const server = startServer(0);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      const first = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(first.summary.requests).toBe(3);

      // Replace all three rows in place and append a fourth. The inode, device and
      // birthtime are unchanged and the file only grew, so neither the identity check
      // nor the shrink check sees it, and the boundary check is satisfied because the
      // replacement rows have identical widths.
      writeFileSync(
        join(testDir, "usage.jsonl"),
        `${row("bbb1")}${row("bbb2")}${row("bbb3")}${row("bbb4")}`,
      );

      clock.mockReturnValue(now + 60_001);
      const after = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      // Without the prefix check this returns the three STALE rows concatenated with
      // the one newly appended row -- still 4 requests, but three of them no longer
      // exist in the file. Assert on identity, not just the count.
      expect(after.summary.requests).toBe(4);
      expect(after.models.every((model: { model: string }) => typeof model.model === "string")).toBe(true);
      // Serving this from the retained tail would have required no second full read.
      expect(usageReadCacheStatsForTests().fullReads).toBe(2);
      expect(usageReadCacheStatsForTests().tailReads).toBe(0);
    } finally {
      clock.mockRestore();
      await server.stop(true);
    }
  });

  test("an in-place edit in the middle of a large prefix is not served from the retained tail", async () => {
    const now = Date.now();
    resetUsageReadCacheForTests();
    resetUsageSummaryCacheForTests();
    // Large enough that a SAMPLED prefix digest would cover a vanishing fraction of the
    // file. The edit below is deliberately placed away from both ends, where sampled
    // probes do not reach -- the case that makes sampling unsafe for an ordinary
    // fixed-width edit rather than only an adversarial one.
    const row = (id: string): string => `${JSON.stringify({
      requestId: id,
      timestamp: now - 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    })}\n`;
    const rows = Array.from({ length: 4000 }, (_, index) => row(`old${String(index).padStart(6, "0")}`));
    const rowBytes = Buffer.byteLength(rows[0]!);
    writeFileSync(join(testDir, "usage.jsonl"), rows.join(""));
    const server = startServer(0);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);

      // Overwrite one row in the middle, byte-identical in width so the file size and
      // every record boundary are unchanged, then append.
      const replacement = row("new002500");
      expect(Buffer.byteLength(replacement)).toBe(rowBytes);
      const handle = openSync(join(testDir, "usage.jsonl"), "r+");
      try {
        writeSync(handle, Buffer.from(replacement), 0, rowBytes, 2500 * rowBytes);
      } finally {
        closeSync(handle);
      }
      appendFileSync(join(testDir, "usage.jsonl"), row("appended1"));

      clock.mockReturnValue(now + 60_001);
      await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      // The mid-prefix rewrite must invalidate the retained rows: a sampled digest would
      // miss it and serve old002500, which no longer exists in the file.
      expect(usageReadCacheStatsForTests().fullReads).toBe(2);
      expect(usageReadCacheStatsForTests().tailReads).toBe(0);
    } finally {
      clock.mockRestore();
      await server.stop(true);
    }
  });

  test("an over-window ledger reports a stable window instead of sawtoothing", async () => {
    const now = Date.now();
    const row = (id: string): string => `${JSON.stringify({
      requestId: id,
      timestamp: now - 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    })}\n`;
    // Start above the window so every append slides it forward.
    const seed = Array.from({ length: 60 }, (_, index) => row(`seed${String(index).padStart(6, "0")}`));
    writeFileSync(join(testDir, "usage.jsonl"), seed.join(""));
    saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 4096 });
    resetUsageReadCacheForTests();
    resetUsageSummaryCacheForTests();
    const server = startServer(0);
    const clock = spyOn(Date, "now");
    try {
      const counts: number[] = [];
      for (let round = 1; round <= 40; round++) {
        appendFileSync(join(testDir, "usage.jsonl"), row(`add${String(round).padStart(7, "0")}`));
        clock.mockReturnValue(now + round * 60_001);
        const body = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
        counts.push(body.summary.requests);
      }
      // Retaining a window wider than maxReadBytes and then re-anchoring made visible
      // history collapse by roughly half on a single poll of an append-only file, so
      // dashboard totals swung between refreshes. The window is now trimmed on every
      // read, so the visible count stays flat.
      const min = Math.min(...counts);
      const max = Math.max(...counts);
      expect(max - min).toBeLessThanOrEqual(1);
    } finally {
      clock.mockRestore();
      await server.stop(true);
    }
  });

  test("unparseable lines do not make the window trim lose history", async () => {
    const now = Date.now();
    const row = (id: string): string => `${JSON.stringify({
      requestId: id,
      timestamp: now - 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    })}\n`;
    // Interleave lines that parse to nothing -- a torn write, a hand-edit, a pre-schema
    // legacy row. Their bytes still occupy the file, so if the recorded row lengths omit
    // them the trim walk under-counts the byte distance and silently drops extra rows.
    const seed: string[] = [];
    for (let index = 0; index < 120; index++) {
      seed.push(row(`R${String(index).padStart(6, "0")}`));
      if (index % 5 === 0) seed.push("{ not json at all ~~~\n");
    }
    writeFileSync(join(testDir, "usage.jsonl"), seed.join(""));
    saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 4096 });
    resetUsageReadCacheForTests();
    resetUsageSummaryCacheForTests();
    const server = startServer(0);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      for (let round = 1; round <= 40; round++) {
        appendFileSync(join(testDir, "usage.jsonl"), row(`A${String(round).padStart(6, "0")}`));
        if (round % 5 === 0) appendFileSync(join(testDir, "usage.jsonl"), "{ torn write\n");
        clock.mockReturnValue(now + round * 60_001);
        await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      }
      const cached = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      // The incremental path must have stayed engaged. Without skipped-line accounting
      // the recorded lengths stop summing to the byte span, the consistency check
      // rejects every reuse, and this collapses back to a full read per poll -- correct
      // output, but the optimization is gone.
      const stats = usageReadCacheStatsForTests();
      expect(stats.tailReads).toBeGreaterThanOrEqual(20);

      // A cold read of the same window is the ground truth.
      resetUsageReadCacheForTests();
      resetUsageSummaryCacheForTests();
      clock.mockReturnValue(now + 41 * 60_001);
      const fresh = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(cached.summary.requests).toBe(fresh.summary.requests);
      expect(cached.truncatedPrefixBytes).toBe(fresh.truncatedPrefixBytes);
    } finally {
      clock.mockRestore();
      await server.stop(true);
    }
  });

  test("the entry cap re-anchors instead of reporting a window a cold read disagrees with", async () => {
    const now = Date.now();
    const row = (id: string): string => `${JSON.stringify({
      requestId: id,
      timestamp: now - 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    })}\n`;
    // Bind the ENTRY cap rather than the byte window: a generous window with a small cap
    // is the only way to reach this path without a half-million-row fixture.
    setManagementUsageMaxEntriesForTests(25);
    writeFileSync(
      join(testDir, "usage.jsonl"),
      Array.from({ length: 40 }, (_, index) => row(`R${String(index).padStart(6, "0")}`)).join(""),
    );
    saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 1024 * 1024 });
    resetUsageReadCacheForTests();
    resetUsageSummaryCacheForTests();
    const server = startServer(0);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      for (let round = 1; round <= 12; round++) {
        appendFileSync(join(testDir, "usage.jsonl"), row(`A${String(round).padStart(6, "0")}`));
        clock.mockReturnValue(now + round * 60_001);
        await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      }
      const cached = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      // A cold read applies the entry cap across the whole window and reports byte
      // truncation for the window boundary alone; an incremental read cannot reconstruct
      // that ordering, so it must re-anchor rather than report a disagreeing window.
      // This is reachable in production: real rows average ~118 bytes, so 500,000 of them
      // fit inside the 64 MiB window and both truncations can apply at once.
      expect(usageReadCacheStatsForTests().fullReads).toBeGreaterThan(1);

      resetUsageReadCacheForTests();
      resetUsageSummaryCacheForTests();
      clock.mockReturnValue(now + 13 * 60_001);
      const fresh = await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      expect(cached.summary.requests).toBe(fresh.summary.requests);
      expect(cached.truncatedPrefixBytes).toBe(fresh.truncatedPrefixBytes);
    } finally {
      setManagementUsageMaxEntriesForTests(null);
      clock.mockRestore();
      await server.stop(true);
    }
  });

  test("a CRLF ledger still uses the incremental path", async () => {
    const now = Date.now();
    const row = (id: string): string => `${JSON.stringify({
      requestId: id,
      timestamp: now - 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    })}\r\n`;
    writeFileSync(
      join(testDir, "usage.jsonl"),
      Array.from({ length: 20 }, (_, index) => row(`C${String(index).padStart(6, "0")}`)).join(""),
    );
    resetUsageReadCacheForTests();
    resetUsageSummaryCacheForTests();
    const server = startServer(0);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      for (let round = 1; round <= 5; round++) {
        appendFileSync(join(testDir, "usage.jsonl"), row(`D${String(round).padStart(6, "0")}`));
        clock.mockReturnValue(now + round * 60_001);
        await fetch(new URL("/api/usage?range=all", server.url)).then(res => res.json());
      }
      // A CRLF line owes two separator bytes. Counting one leaves the recorded lengths
      // short of the real span, the accounting self-check rejects every reuse, and the
      // reader silently falls back to a full parse on every poll.
      expect(usageReadCacheStatsForTests().tailReads).toBeGreaterThanOrEqual(5);
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);
    } finally {
      clock.mockRestore();
      await server.stop(true);
    }
  });
});
