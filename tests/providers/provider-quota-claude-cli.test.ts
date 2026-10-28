/**
 * The Claude Code CLI subscription publishes no quota endpoint OpenCodex may call on a
 * dashboard load, so `/api/provider-quotas` reports the admission's last observation instead.
 * It must carry the `observed` marker: a subscription row older than the 30-minute last-good
 * bound is the only measurement that exists, not a probe that went quiet.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderQuotaCache, fetchProviderQuotaReports, flushProviderQuotaObservationsForTests } from "../../src/providers/quota";
import { saveClaudeUsageSnapshot } from "../../src/providers/claude-cli-usage-state";
import { setQuotaResetSink } from "../../src/quota/reset-observer";
import { resetQuotaResetStoreForTests } from "../../src/quota/reset-seen-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let fetchCalls: number;

function config(): OcxConfig {
  return {
    defaultProvider: "claude-cli",
    providers: {
      "claude-cli": {
        adapter: "claude-cli",
        authMode: "key",
        baseUrl: "https://api.anthropic.com",
      },
    },
  } as unknown as OcxConfig;
}

function seedObservation(observedAt: number): void {
  writeFileSync(join(home, "claude-usage-admission.json"), JSON.stringify({
    identity: "a".repeat(64),
    checkedAt: observedAt,
    quota: {
      fiveHourPercent: 1,
      fiveHourResetAt: observedAt + 3_600_000,
      weeklyPercent: 51,
      weeklyResetAt: observedAt + 86_400_000,
      customWindows: [{ label: "Fable", scope: "model", percent: 48, resetAt: observedAt + 86_400_000 }],
      updatedAt: observedAt,
    },
  }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-claude-cli-quota-"));
  process.env.OPENCODEX_HOME = home;
  clearProviderQuotaCache();
  resetQuotaResetStoreForTests();
  fetchCalls = 0;
  // The row is cache-only: a fetch here is itself the failure.
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("no upstream call may be made for a claude-cli quota row");
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  await flushProviderQuotaObservationsForTests();
  setQuotaResetSink(null);
  resetQuotaResetStoreForTests();
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
  expect(fetchCalls).toBe(0);
});

test("publishes the admission's subscription windows as an observed row", async () => {
  const observedAt = Date.now() - 5 * 60_000;
  seedObservation(observedAt);

  const row = (await fetchProviderQuotaReports(config())).reports
    .find(report => report.provider === "claude-cli");

  expect(row).toBeDefined();
  expect(row?.observed).toBe(true);
  expect(row?.source).toBe("claude-cli:subscription-observation");
  expect(row?.updatedAt).toBe(observedAt);
  expect(row?.quota.fiveHourPercent).toBe(1);
  expect(row?.quota.weeklyPercent).toBe(51);
  expect(row?.quota.customWindows).toEqual([
    { label: "Fable", scope: "model", percent: 48, resetAt: observedAt + 86_400_000 },
  ]);
});

test("keeps an observation past the last-good bound instead of deleting it", async () => {
  const observedAt = Date.now() - 5.39 * 60 * 60_000;
  seedObservation(observedAt);

  await fetchProviderQuotaReports(config(), true);
  const again = await fetchProviderQuotaReports(config(), true);
  const row = again.reports.find(report => report.provider === "claude-cli");

  expect(row).toBeDefined();
  // The age is reported, never re-stamped as now.
  expect(row?.updatedAt).toBe(observedAt);
});

test("reports nothing and probes nothing without an admission snapshot", async () => {
  const response = await fetchProviderQuotaReports(config());

  expect(response.reports.some(report => report.provider === "claude-cli")).toBe(false);
});

test("forced refresh publishes newer percentages and their observation time", async () => {
  const observedAt = Date.now() - 60_000;
  seedObservation(observedAt);
  await fetchProviderQuotaReports(config());
  const updatedAt = observedAt + 30_000;
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), {
    identity: "a".repeat(64), checkedAt: updatedAt,
    quota: { fiveHourPercent: 23, weeklyPercent: 64, updatedAt },
  });

  const row = (await fetchProviderQuotaReports(config(), true)).reports
    .find(report => report.provider === "claude-cli");
  expect(row?.quota.fiveHourPercent).toBe(23);
  expect(row?.quota.weeklyPercent).toBe(64);
  expect(row?.updatedAt).toBe(updatedAt);
});

test.each([false, true])("forced refresh clears the prior account's quota when the new snapshot has no windows (%s)", async emptyQuota => {
  const observedAt = Date.now() - 60_000;
  seedObservation(observedAt);
  expect((await fetchProviderQuotaReports(config())).reports).toHaveLength(1);
  const checkedAt = observedAt + 30_000;
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), {
    identity: "b".repeat(64), checkedAt,
    ...(emptyQuota ? { quota: { updatedAt: checkedAt } } : {}),
  });

  const response = await fetchProviderQuotaReports(config(), true);
  expect(response.reports.some(report => report.provider === "claude-cli")).toBe(false);
});

test.each(["a", "b"])("display-only Claude CLI snapshots never trigger resets across identity %s", async identity => {
  const resets: unknown[] = [];
  setQuotaResetSink(event => resets.push(event));
  const checkedAt = Date.now();
  const statePath = join(home, "claude-usage-admission.json");
  saveClaudeUsageSnapshot(statePath, {
    identity: "a".repeat(64), checkedAt,
    quota: { fiveHourPercent: 90, fiveHourResetAt: checkedAt + 3_600_000, updatedAt: checkedAt },
  });
  await fetchProviderQuotaReports(config(), true);
  await flushProviderQuotaObservationsForTests();
  saveClaudeUsageSnapshot(statePath, {
    identity: identity.repeat(64), checkedAt: checkedAt + 1000,
    quota: { fiveHourPercent: 10, fiveHourResetAt: checkedAt + 3_600_000, updatedAt: checkedAt + 1000 },
  });
  const response = await fetchProviderQuotaReports(config(), true);
  await flushProviderQuotaObservationsForTests();
  expect(response.reports[0]?.quota.fiveHourPercent).toBe(10);
  expect(resets).toEqual([]);
});
