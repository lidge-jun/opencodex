import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { refreshUserCostOverlays, userCostOverlayVersion } from "../src/usage/user-cost-overlays";
import { stopUserCostOverlayReconciler } from "../src/usage/user-cost-overlay-reconciler";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { resetUsageReadCacheForTests, usageReadCacheStatsForTests } from "../src/usage/log";
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
  saveConfig(baseConfig());
});

afterEach(() => {
  // Belt-and-suspenders: server.stop should release the reconciler lease, but a
  // wedged shutdown on Linux CI must not leave the 5s poll timer keeping the
  // isolate worker alive for later shard files (e.g. cli-restore-back).
  stopUserCostOverlayReconciler();
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
      const changed = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(changed.summary.requests).toBe(first.summary.requests + 1);
      expect(usageReadCacheStatsForTests().fullReads).toBe(2);
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
      expect(usageReadCacheStatsForTests().fullReads).toBe(2);
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
      const settled = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(settled.summary.requests).toBe(raced.summary.requests);
      expect(getUsageSummaryCacheEntry("30d:all")?.overlayVersion).toBe(userCostOverlayVersion());
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
});
