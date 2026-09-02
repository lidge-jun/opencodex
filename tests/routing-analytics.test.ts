import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync} from "node:fs";
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
import { closeRequestHistoryIndex } from "../src/routing/history/indexer";
import { computeRoutingAnalytics } from "../src/routing/analytics";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

function entry(
  requestId: string,
  overrides: Partial<PersistedUsageEntry> & { timestamp: number; status: number; durationMs: number },
): PersistedUsageEntry {
  return {
    requestId,
    provider: "a",
    model: "m1",
    usageStatus: "reported",
    ...overrides,
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-analytics-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
});

afterEach(() => {
  closeRequestHistoryIndex();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: { a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] } },
  };
}

describe("routing analytics (RI-03)", () => {
  test("classifies success, failure, cancellation and incomplete streams", async () => {
    appendUsageEntry(entry("r1", { timestamp: 1000, status: 200, durationMs: 100, firstOutputMs: 10 }));
    appendUsageEntry(entry("r2", { timestamp: 2000, status: 200, durationMs: 200, firstOutputMs: 30 }));
    appendUsageEntry(entry("r3", { timestamp: 3000, status: 429, durationMs: 300 }));
    appendUsageEntry(entry("r4", { timestamp: 4000, status: 499, durationMs: 50, closeReason: "client_cancel" }));
    appendUsageEntry(entry("r5", { timestamp: 5000, status: 200, durationMs: 400, terminalStatus: "incomplete" }));

    const result = await computeRoutingAnalytics({});
    expect(result.totalRequests).toBe(5);
    expect(result.successRate).toBe(0.4);
    expect(result.failureRate).toBe(0.4);
    expect(result.cancelledRate).toBe(0.2);
    expect(result.incompleteStreamRate).toBe(0.2);
    expect(result.cooldownTriggeringFailures).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.historyTruncated).toBe(false);
  });

  test("computes duration and TTFT percentiles with coverage", async () => {
    appendUsageEntry(entry("r1", { timestamp: 1, status: 200, durationMs: 100, firstOutputMs: 10 }));
    appendUsageEntry(entry("r2", { timestamp: 2, status: 200, durationMs: 200, firstOutputMs: 20 }));
    appendUsageEntry(entry("r3", { timestamp: 3, status: 200, durationMs: 300, firstOutputMs: 30 }));
    appendUsageEntry(entry("r4", { timestamp: 4, status: 200, durationMs: 400 }));

    const result = await computeRoutingAnalytics({});
    // Nearest-rank percentiles over [100,200,300,400]:
    expect(result.durationMs.p50).toBe(200);
    expect(result.durationMs.p95).toBe(400);
    expect(result.durationMs.p99).toBe(400);
    expect(result.durationMs.sampleCount).toBe(4);
    expect(result.firstOutputMs.p50).toBe(20);
    expect(result.firstOutputMs.sampleCount).toBe(3);
    expect(result.firstOutputMs.coverage).toBe(0.75);
  });

  test("fallback rate counts multi-attempt requests", async () => {
    appendUsageEntry(entry("r1", {
      timestamp: 1,
      status: 200,
      durationMs: 100,
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", adapter: "openai-chat", status: 503, durationMs: 50, sendCount: 1, recoveryKinds: ["transient-5xx"], usageStatus: "unreported" },
        { ordinal: 2, provider: "a", model: "m1", adapter: "openai-chat", status: 200, durationMs: 50, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
      ],
    }));
    appendUsageEntry(entry("r2", { timestamp: 2, status: 200, durationMs: 100 }));

    const result = await computeRoutingAnalytics({});
    expect(result.fallbackRate).toBe(0.5);
    expect(result.totalAttempts).toBe(3);
    expect(result.averageAttemptsPerRequest).toBe(1.5);
  });

  test("breakdown groups by provider/model/account and profile", async () => {
    appendUsageEntry(entry("r1", {
      timestamp: 1,
      status: 200,
      durationMs: 100,
      apiKeyId: "key-a",
      routeDecision: {
        version: 1,
        decisionId: "a00000000001",
        createdAt: 1,
        requestedModel: "policy/fast",
        routeKind: "policy",
        profile: { id: "fast", revision: "abc123" },
        requirements: [],
        candidates: [{ provider: "a", model: "m1", eligible: true, exclusions: [] }],
        selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "policy" },
      },
    }));
    appendUsageEntry(entry("r2", {
      timestamp: 2,
      status: 500,
      durationMs: 200,
      apiKeyId: "key-a",
      routeDecision: {
        version: 1,
        decisionId: "a00000000002",
        createdAt: 2,
        requestedModel: "policy/fast",
        routeKind: "policy",
        profile: { id: "fast", revision: "abc123" },
        requirements: [],
        candidates: [{ provider: "a", model: "m1", eligible: true, exclusions: [] }],
        selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "policy" },
      },
    }));

    const result = await computeRoutingAnalytics({});
    expect(result.breakdown.length).toBe(1);
    expect(result.breakdown[0]).toMatchObject({
      provider: "a",
      model: "m1",
      accountRef: "key-a",
      profileId: "fast",
      requests: 2,
      successes: 1,
      failures: 1,
      successRate: 0.5,
    });
    expect(result.profileBreakdown).toEqual([
      { profileId: "fast", profileRevision: "abc123", requests: 2, successes: 1, failures: 1, fallbacks: 0, successRate: 0.5 },
    ]);
  });

  test("usage and price coverage are honest about unknown data", async () => {
    appendUsageEntry(entry("r1", { timestamp: 1, status: 200, durationMs: 100, usageStatus: "reported", usage: { inputTokens: 1000, outputTokens: 100 } }));
    appendUsageEntry(entry("r2", { timestamp: 2, status: 200, durationMs: 100, usageStatus: "unreported" }));

    const result = await computeRoutingAnalytics({});
    expect(result.usageCoverage).toBe(0.5);
    // Unknown price for provider "a": the estimate stays null, never zero.
    expect(result.estimatedCostUsdPerSuccessfulRequest).toBeNull();
    expect(result.priceCoverage).toBe(0);
  });

  test("filters scope the analysis", async () => {
    appendUsageEntry(entry("r1", { timestamp: 1, status: 200, durationMs: 100, provider: "a" }));
    appendUsageEntry(entry("r2", { timestamp: 2, status: 200, durationMs: 100, provider: "b", model: "m2" }));

    const result = await computeRoutingAnalytics({ provider: "b" });
    expect(result.totalRequests).toBe(1);
    expect(result.breakdown[0]).toMatchObject({ provider: "b", model: "m2" });
  });

  test("explicit truncated-history indicator when the cap is hit", async () => {
    for (let index = 0; index < 12; index++) {
      appendUsageEntry(entry(`r${index}`, { timestamp: index, status: 200, durationMs: 10 }));
    }
    const result = await computeRoutingAnalytics({}, { maxRows: 10 });
    expect(result.scannedRows).toBe(10);
    expect(result.historyTruncated).toBe(true);
  });

  test("API endpoint returns the analytics payload", async () => {
    appendUsageEntry(entry("r1", { timestamp: 1, status: 200, durationMs: 100 }));
    const req = new ManagementRequest("http://localhost/api/routing-analytics", { method: "GET" });
    const response = await handleManagementAPI(req, new URL(req.url), config(), { refreshCodexCatalog: async () => {} });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as { totalRequests?: number; successRate?: number | null };
    expect(body.totalRequests).toBe(1);
    expect(body.successRate).toBe(1);
  });

  test("counts cooldownTriggeringFailures for non-4xx failures with recovery attempts", async () => {
    appendUsageEntry(
      entry("r1", {
        timestamp: 1,
        status: 503,
        durationMs: 100,
        attempts: [
          {
            ordinal: 1,
            provider: "a",
            model: "m1",
            adapter: "openai-chat",
            status: 503,
            durationMs: 100,
            sendCount: 1,
            recoveryKinds: ["rate-limit-429"],
            usageStatus: "unreported",
          },
        ],
      }),
    );
    const result = await computeRoutingAnalytics({});
    expect(result.cooldownTriggeringFailures).toBe(1);
  });

  test("ignores malformed attempts while preserving explicit 429 classification", async () => {
    appendUsageEntry(entry("baseline", { timestamp: 1, status: 200, durationMs: 10 }));
    const historicalRows = [
      {
        ...entry("missing-recovery-kinds", { timestamp: 2, status: 503, durationMs: 20 }),
        attempts: [{ ordinal: 1 }],
      },
      {
        ...entry("malformed-attempts", { timestamp: 3, status: 503, durationMs: 30 }),
        attempts: { recoveryKinds: ["rate-limit-429"] },
      },
      {
        ...entry("malformed-recovery-kinds", { timestamp: 4, status: 503, durationMs: 40 }),
        attempts: [null, { recoveryKinds: "rate-limit-429" }, { recoveryKinds: [null, 42, "unknown"] }],
      },
      {
        ...entry("malformed-429", { timestamp: 5, status: 429, durationMs: 50 }),
        attempts: { recoveryKinds: ["unknown"] },
      },
    ];
    appendFileSync(usageLogPath(), `${historicalRows.map(row => JSON.stringify(row)).join("\n")}\n`);

    const result = await computeRoutingAnalytics({});
    expect(result.totalRequests).toBe(5);
    expect(result.cooldownTriggeringFailures).toBe(1);
  });

  test("routing analytics API returns 400 for invalid from/to/limit", async () => {
    const cases = [
      { query: "from=abc", code: "invalid_from" },
      { query: "to=xyz", code: "invalid_to" },
      { query: "from=10&to=5", code: "invalid_range" },
      { query: "limit=0", code: "invalid_limit" },
    ] as const;
    for (const { query, code } of cases) {
      const req = new ManagementRequest(`http://localhost/api/routing-analytics?${query}`, { method: "GET" });
      const response = await handleManagementAPI(req, new URL(req.url), config(), { refreshCodexCatalog: async () => {} });
      expect(response).not.toBeNull();
      expect(response!.status).toBe(400);
      const body = await response!.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe(code);
    }
  });
});
