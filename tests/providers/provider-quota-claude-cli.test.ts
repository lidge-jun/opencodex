/**
 * The Claude Code CLI subscription publishes no quota endpoint OpenCodex may call on a
 * dashboard load, so `/api/provider-quotas` reports the admission's last observation instead.
 * It must carry the `observed` marker: a subscription row older than the 30-minute last-good
 * bound is the only measurement that exists, not a probe that went quiet. The row only ever
 * shows the signed-in account: sign-out or an account switch clears it.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentClaudeIdentityKey, setClaudeIdentityForTests } from "../../src/adapters/claude-cli/usage-admission";
import { runPassiveRead } from "../../src/lib/passive-read";
import { clearProviderQuotaCache, fetchProviderQuotaReports, flushProviderQuotaObservationsForTests } from "../../src/providers/quota";
import { setProviderQuotaBeforePublishForTests } from "../../src/providers/quota/report-cache";
import { saveClaudeUsageSnapshot } from "../../src/providers/claude-cli-usage-state";
import { setQuotaResetSink } from "../../src/quota/reset-observer";
import { resetQuotaResetStoreForTests } from "../../src/quota/reset-seen-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { ProviderQuotaResponse } from "../../src/providers/quota/report-cache";
import type { OcxConfig } from "../../src/types";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let fetchCalls: number;
/** The Claude Code sign-in the seam reports; null is signed out. */
let signedIn: string | null;

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
    identity: ACCOUNT_A,
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
  signedIn = ACCOUNT_A;
  setClaudeIdentityForTests(() => signedIn ? { key: signedIn, access: "test-access" } : null);
  fetchCalls = 0;
  // The row is cache-only: a fetch here is itself the failure.
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("no upstream call may be made for a claude-cli quota row");
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  await flushProviderQuotaObservationsForTests();
  setProviderQuotaBeforePublishForTests(null);
  setQuotaResetSink(null);
  setClaudeIdentityForTests();
  setSystemTime();
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
    identity: ACCOUNT_A, checkedAt: updatedAt,
    quota: { fiveHourPercent: 23, weeklyPercent: 64, updatedAt },
  });

  const row = (await fetchProviderQuotaReports(config(), true)).reports
    .find(report => report.provider === "claude-cli");
  expect(row?.quota.fiveHourPercent).toBe(23);
  expect(row?.quota.weeklyPercent).toBe(64);
  expect(row?.updatedAt).toBe(updatedAt);
});

test.each([false, true])("forced refresh clears the prior account's quota when the signed-in account's snapshot has no windows (%s)", async emptyQuota => {
  const observedAt = Date.now() - 60_000;
  seedObservation(observedAt);
  expect((await fetchProviderQuotaReports(config())).reports).toHaveLength(1);
  const checkedAt = observedAt + 30_000;
  signedIn = ACCOUNT_B;
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), {
    identity: ACCOUNT_B, checkedAt,
    ...(emptyQuota ? { quota: { updatedAt: checkedAt } } : {}),
  });

  const response = await fetchProviderQuotaReports(config(), true);
  expect(response.reports.some(report => report.provider === "claude-cli")).toBe(false);
});

const claudeRow = (response: ProviderQuotaResponse) => response.reports.find(report => report.provider === "claude-cli");
const transitions = [["sign-out", null], ["account switch", ACCOUNT_B]] as const;

test.each(transitions)("%s clears the previous account's report on a forced refresh", async (_, next) => {
  seedObservation(Date.now() - 60_000);
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(51);
  signedIn = next;

  expect(claudeRow(await fetchProviderQuotaReports(config(), true))).toBeUndefined();
});

test.each(transitions)("%s seen by a later sign-in read drops the cached report without a forced refresh", async (_, next) => {
  seedObservation(Date.now() - 60_000);
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(51);
  signedIn = next;
  // Stands in for the next turn's admission check, which reads the sign-in on its own.
  expect(await currentClaudeIdentityKey(true)).toBe(next);

  expect(claudeRow(await fetchProviderQuotaReports(config()))).toBeUndefined();
});

test.each(transitions)("%s drops the cached report on a plain dashboard read once the sign-in cache expires", async (_, next) => {
  const start = Date.now();
  seedObservation(start - 60_000);
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(51);
  signedIn = next;
  // Past the one-minute sign-in cache, still inside the five-minute report cache.
  setSystemTime(start + 61_000);

  expect(claudeRow(await fetchProviderQuotaReports(config()))).toBeUndefined();
});

test("after an account switch the report shows only the new account's own windows", async () => {
  const statePath = join(home, "claude-usage-admission.json");
  seedObservation(Date.now() - 60_000);
  await fetchProviderQuotaReports(config());
  signedIn = ACCOUNT_B;
  const checkedAt = Date.now();
  saveClaudeUsageSnapshot(statePath, { identity: ACCOUNT_B, checkedAt, quota: { weeklyPercent: 7, updatedAt: checkedAt } });
  expect(claudeRow(await fetchProviderQuotaReports(config(), true))?.quota.weeklyPercent).toBe(7);

  // Back on A, whose snapshot the B check replaced: B's windows must not be shown as A's.
  signedIn = ACCOUNT_A;
  expect(claudeRow(await fetchProviderQuotaReports(config(), true))).toBeUndefined();
});

test.each([ACCOUNT_A, ACCOUNT_B])("display-only Claude CLI snapshots never trigger resets across identity %#", async identity => {
  const resets: unknown[] = [];
  setQuotaResetSink(event => resets.push(event));
  const checkedAt = Date.now();
  const statePath = join(home, "claude-usage-admission.json");
  saveClaudeUsageSnapshot(statePath, {
    identity: ACCOUNT_A, checkedAt,
    quota: { fiveHourPercent: 90, fiveHourResetAt: checkedAt + 3_600_000, updatedAt: checkedAt },
  });
  await fetchProviderQuotaReports(config(), true);
  await flushProviderQuotaObservationsForTests();
  signedIn = identity;
  saveClaudeUsageSnapshot(statePath, {
    identity, checkedAt: checkedAt + 1000,
    quota: { fiveHourPercent: 10, fiveHourResetAt: checkedAt + 3_600_000, updatedAt: checkedAt + 1000 },
  });
  const response = await fetchProviderQuotaReports(config(), true);
  await flushProviderQuotaObservationsForTests();
  expect(response.reports[0]?.quota.fiveHourPercent).toBe(10);
  expect(resets).toEqual([]);
});

test("overlapping sign-in reads publish the newer account after an older sign-out finishes", async () => {
  let release!: (value: null) => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let mode: "a" | "wait" | "b" = "a";
  setClaudeIdentityForTests(() => {
    if (mode === "wait") { started(); return new Promise<null>(resolve => { release = resolve; }); }
    return { key: mode === "a" ? ACCOUNT_A : ACCOUNT_B, access: "synthetic" };
  });
  seedObservation(Date.now() - 60_000);
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(51);
  mode = "wait";
  const older = fetchProviderQuotaReports(config(), true);
  await waiting;
  mode = "b";
  const now = Date.now();
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), { identity: ACCOUNT_B, checkedAt: now, quota: { weeklyPercent: 7, updatedAt: now } });
  expect(await currentClaudeIdentityKey(true)).toBe(ACCOUNT_B);
  release(null);
  await older;
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(7);
});

test("publication uses the identity recorded after collection", async () => {
  seedObservation(Date.now() - 60_000);
  setProviderQuotaBeforePublishForTests(async () => {
    signedIn = ACCOUNT_B;
    const now = Date.now();
    saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), { identity: ACCOUNT_B, checkedAt: now, quota: { weeklyPercent: 7, updatedAt: now } });
    await currentClaudeIdentityKey(true);
  });
  expect(claudeRow(await fetchProviderQuotaReports(config(), true))?.quota.weeklyPercent).toBe(7);
});

test("a cached empty report becomes the newly recorded account without a forced refresh", async () => {
  signedIn = null;
  expect(claudeRow(await fetchProviderQuotaReports(config(), true))).toBeUndefined();
  signedIn = ACCOUNT_B;
  const now = Date.now();
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), { identity: ACCOUNT_B, checkedAt: now, quota: { weeklyPercent: 7, updatedAt: now } });
  await currentClaudeIdentityKey(true);
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(7);
});

test("an identity switch refreshes only the Claude row in a cached multi-provider response", async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ data: { limit: 20, limit_remaining: 10 } }); }) as typeof fetch;
  const multi = config();
  multi.providers.openrouter = { adapter: "openai-chat", authMode: "key", baseUrl: "https://openrouter.ai/api/v1", apiKey: "synthetic-key" } as never;
  seedObservation(Date.now() - 60_000);
  const first = await fetchProviderQuotaReports(multi, true);
  const other = first.reports.find(row => row.provider === "openrouter");
  expect(other).toBeDefined();
  expect(requests).toBe(1);
  signedIn = ACCOUNT_B;
  const now = Date.now();
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), { identity: ACCOUNT_B, checkedAt: now, quota: { weeklyPercent: 7, updatedAt: now } });
  await currentClaudeIdentityKey(true);
  const second = await fetchProviderQuotaReports(multi);
  expect(claudeRow(second)?.quota.weeklyPercent).toBe(7);
  expect(second.reports.find(row => row.provider === "openrouter")).toEqual(other);
  expect(requests).toBe(1);
});

test("passive and normal reports follow a recorded account switch without passive probes", async () => {
  let identityReads = 0;
  setClaudeIdentityForTests(() => { identityReads++; return signedIn ? { key: signedIn, access: "synthetic" } : null; });
  seedObservation(Date.now() - 60_000);
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(51);
  signedIn = ACCOUNT_B;
  const now = Date.now();
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), { identity: ACCOUNT_B, checkedAt: now, quota: { weeklyPercent: 7, updatedAt: now } });
  await currentClaudeIdentityKey(true);
  const before = identityReads;
  expect(claudeRow(await runPassiveRead(() => fetchProviderQuotaReports(config())))?.quota.weeklyPercent).toBe(7);
  expect(identityReads).toBe(before);
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(7);
  expect(claudeRow(await runPassiveRead(() => fetchProviderQuotaReports(config())))?.quota.weeklyPercent).toBe(7);
  expect(identityReads).toBe(before);
});

test("passive reports use a recorded observation even before the report cache is populated", async () => {
  let identityReads = 0;
  setClaudeIdentityForTests(() => { identityReads++; return { key: ACCOUNT_A, access: "synthetic" }; });
  seedObservation(Date.now() - 60_000);
  await currentClaudeIdentityKey(true);
  expect(claudeRow(await runPassiveRead(() => fetchProviderQuotaReports(config(), true)))?.quota.weeklyPercent).toBe(51);
  expect(identityReads).toBe(1);
});

test.each(["updated", "empty", "missing"] as const)("passive and normal reports reflect a same-account %s snapshot", async kind => {
  const now = Date.now();
  seedObservation(now - 60_000);
  expect(claudeRow(await fetchProviderQuotaReports(config()))?.quota.weeklyPercent).toBe(51);
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), {
    identity: ACCOUNT_A, checkedAt: now,
    ...(kind === "missing" ? {} : { quota: kind === "empty" ? { updatedAt: now } : { weeklyPercent: 23, updatedAt: now } }),
  });
  for (const read of [() => runPassiveRead(() => fetchProviderQuotaReports(config())), () => fetchProviderQuotaReports(config())]) {
    const row = claudeRow(await read());
    if (kind === "updated") { expect(row?.quota.weeklyPercent).toBe(23); expect(row?.updatedAt).toBe(now); }
    else expect(row).toBeUndefined();
  }
});

test("passive reconciliation preserves other held reports without probing", async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ data: { limit: 20, limit_remaining: 10 } }); }) as typeof fetch;
  const multi = config();
  multi.providers.openrouter = { adapter: "openai-chat", authMode: "key", baseUrl: "https://openrouter.ai/api/v1", apiKey: "synthetic-key" } as never;
  seedObservation(Date.now() - 60_000);
  const first = await fetchProviderQuotaReports(multi, true);
  const other = first.reports.find(row => row.provider === "openrouter");
  expect(other).toBeDefined();
  signedIn = ACCOUNT_B;
  const now = Date.now();
  saveClaudeUsageSnapshot(join(home, "claude-usage-admission.json"), { identity: ACCOUNT_B, checkedAt: now, quota: { weeklyPercent: 7, updatedAt: now } });
  await currentClaudeIdentityKey(true);
  const held = await runPassiveRead(() => fetchProviderQuotaReports(multi, true));
  expect(claudeRow(held)?.quota.weeklyPercent).toBe(7);
  expect(held.reports.find(row => row.provider === "openrouter")).toEqual(other);
  expect(requests).toBe(1);
});
