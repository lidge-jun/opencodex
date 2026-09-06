import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState, notePoolRotationFailure, POOL_KEY_ANTHROPIC } from "../../../src/codex/pool-rotation";
import {
  anthropicQuotaWindow,
  anthropicSessionKeyFromParts,
  bindAnthropicSessionAffinity,
  clearAnthropicAccountPoolState,
  formatAnthropicProviderForLog,
  getEligibleAnthropicAccounts,
  isAnthropicAccountPoolEnabled,
  normalizeAccountPoolQuotaWindow,
  parseAccountPoolQuotaWindow,
  resolveAnthropicAccountForSession,
  resetAnthropicRoutingForManualSelection,
  rotateAnthropicAccountOn429,
  getAnthropicPoolAccessSnapshot,
  promoteAnthropicActiveAccount,
  anthropicSessionAffinitySizeForTests,
} from "../../../src/oauth/anthropic-routing";
import { captureOAuthAccountSelection, getAccountSet, markAccountNeedsReauth, saveCredential, saveAccountCredential, setActiveAccount } from "../../../src/oauth/store";
import { subscribeAccountSelections } from "../../../src/lib/account-selection-events";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import type { OcxAccountPoolQuotaWindow, OcxAccountPoolRotationStrategy, OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

async function admitAnthropic(sessionKey: string, config: OcxConfig) {
  const expected = captureOAuthAccountSelection("anthropic");
  const choice = resolveAnthropicAccountForSession(sessionKey, config);
  if (choice.accountId) {
    const snapshot = await getAnthropicPoolAccessSnapshot(choice.accountId);
    expect(await promoteAnthropicActiveAccount(choice.accountId, expected, {
      config, sessionKey, reason: choice.reason, expectedCredentialGeneration: snapshot.generation,
    })).not.toBeNull();
  }
  return choice;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("anthropic");
});

afterEach(() => {
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("anthropic");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

async function seedTwoAccounts() {
  await saveCredential("anthropic", {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
  });
  await saveCredential("anthropic", {
    access: "access-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
  });
  // saveCredential activates the newly appended account (B). Pin A as active for predictable tests.
  const { getAccountSet } = await import("../../../src/oauth/store");
  const set = getAccountSet("anthropic")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  await setActiveAccount("anthropic", a.id);
  // Ordinary policy cases start after the initial stored selection has been admitted.
  // Restart cases explicitly clear runtime state below to exercise first admission again.
  await admitAnthropic("", cfg(false));
  return { aId: a.id, bId: b.id };
}

function cfg(
  enabled: boolean,
  threshold = 80,
  pool: {
    strategy?: OcxAccountPoolRotationStrategy;
    stickyLimit?: number;
    quotaWindow?: OcxAccountPoolQuotaWindow;
  } = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
    anthropicAccountPool: {
      enabled,
      autoSwitchThreshold: threshold,
      ...pool,
    },
  } as OcxConfig;
}

async function seedThreeAccounts() {
  await saveCredential("anthropic", {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
  });
  await saveCredential("anthropic", {
    access: "access-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
  });
  await saveCredential("anthropic", {
    access: "access-c",
    refresh: "refresh-c",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-cccc",
    email: "c@example.test",
  });
  const { getAccountSet } = await import("../../../src/oauth/store");
  const set = getAccountSet("anthropic")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  const c = set.accounts.find(acc => acc.credential.accountId === "uuid-cccc")!;
  await setActiveAccount("anthropic", a.id);
  await admitAnthropic("", cfg(false));
  return { aId: a.id, bId: b.id, cId: c.id };
}

describe("anthropic account pool", () => {
  test.each(["round-robin", "quota"] as const)("persisted manual choice survives restart before the first %s dispatch", async strategy => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 11 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 30 });
    await setActiveAccount("anthropic", bId);
    resetAnthropicRoutingForManualSelection(bId);
    const persisted = captureOAuthAccountSelection("anthropic");
    // A process restart loses both local preference and the shared RR cursor.
    clearAnthropicAccountPoolState();
    clearPoolRotationState();
    const config = cfg(true, 20, { strategy, stickyLimit: 1 });
    expect(resolveAnthropicAccountForSession("restart-first", config).accountId).toBe(bId);
    expect(resolveAnthropicAccountForSession("restart-proposal", config).accountId).toBe(bId);
    expect(captureOAuthAccountSelection("anthropic")).toEqual(persisted);
    expect((await admitAnthropic("restart-first", config)).accountId).toBe(bId);
    // Once the authoritative first selection commits, the ordinary algorithm resumes.
    expect((await admitAnthropic("restart-next", config)).accountId).toBe(aId);
    expect(resolveAnthropicAccountForSession("restart-first", config).accountId).toBe(bId);
  });

  test("pool-off 429 recovery commits the replacement and notifies before dispatch", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const config = cfg(false);
    const expected = captureOAuthAccountSelection("anthropic");
    const next = rotateAnthropicAccountOn429(config, aId, "30", "off-retry");
    expect(next).toBe(bId);
    const snapshot = await getAnthropicPoolAccessSnapshot(bId);
    let notifications = 0;
    const unsubscribe = subscribeAccountSelections(event => {
      if (event.provider === "anthropic") {
        notifications++;
        expect(captureOAuthAccountSelection("anthropic")?.accountId).toBe(bId);
      }
    });
    try {
      expect(await promoteAnthropicActiveAccount(bId, expected, {
        config, sessionKey: "off-retry", expectedCredentialGeneration: snapshot.generation,
      })).not.toBeNull();
      expect(captureOAuthAccountSelection("anthropic")?.accountId).toBe(bId);
      expect(notifications).toBe(1);
      expect(anthropicSessionAffinitySizeForTests()).toBe(0);
    } finally { unsubscribe(); }
  });

  test.each([false, true])("stale promotion cannot replace a newer manual choice (ABA=%s)", async aba => {
    const { aId, bId } = await seedTwoAccounts();
    const expected = captureOAuthAccountSelection("anthropic");
    const snapshot = await getAnthropicPoolAccessSnapshot(bId);
    await setActiveAccount("anthropic", bId);
    if (aba) await setActiveAccount("anthropic", aId);
    const manual = captureOAuthAccountSelection("anthropic");
    resetAnthropicRoutingForManualSelection(manual!.accountId);
    let notifications = 0;
    const unsubscribe = subscribeAccountSelections(() => { notifications++; });
    try {
      expect(await promoteAnthropicActiveAccount(bId, expected, {
        config: cfg(true), sessionKey: "stale", expectedCredentialGeneration: snapshot.generation,
      })).toBeNull();
      expect(captureOAuthAccountSelection("anthropic")).toEqual(manual);
      expect(anthropicSessionAffinitySizeForTests()).toBe(0);
      expect(notifications).toBe(0);
      expect(resolveAnthropicAccountForSession("next", cfg(true)).accountId).toBe(manual!.accountId);
    } finally { unsubscribe(); }
  });

  test("token rejection does not consume the manual preference or install affinity", async () => {
    const { aId, bId } = await seedTwoAccounts();
    await setActiveAccount("anthropic", aId);
    resetAnthropicRoutingForManualSelection(aId);
    const expected = captureOAuthAccountSelection("anthropic");
    const snapshot = await getAnthropicPoolAccessSnapshot(aId);
    await markAccountNeedsReauth("anthropic", aId, true);
    expect(await promoteAnthropicActiveAccount(aId, expected, {
      config: cfg(true), sessionKey: "rejected", expectedCredentialGeneration: snapshot.generation,
    })).toBeNull();
    expect(anthropicSessionAffinitySizeForTests()).toBe(0);
    await markAccountNeedsReauth("anthropic", aId, false);
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 30 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 11 });
    expect(resolveAnthropicAccountForSession("recovered", cfg(true, 20)).accountId).toBe(aId);
  });

  test("account snapshot refuses expired background local-CLI credentials without refreshing", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const account = getAccountSet("anthropic")!.accounts.find(account => account.id === bId)!;
    await saveAccountCredential("anthropic", bId, { ...account.credential, source: "local-cli", expires: 1 });
    await expect(getAnthropicPoolAccessSnapshot(bId)).rejects.toThrow("background local-cli token expired");
    expect(captureOAuthAccountSelection("anthropic")?.accountId).toBe(aId);
  });

  test("manual choice wins the next healthy quota dispatch above the automatic threshold", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 30 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 11 });
    await setActiveAccount("anthropic", aId);
    resetAnthropicRoutingForManualSelection(aId);
    expect(resolveAnthropicAccountForSession("manual-quota", cfg(true, 20)).accountId).toBe(aId);
  });

  test("uncommitted proposals neither bind affinity nor advance round-robin", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 1 });
    const first = resolveAnthropicAccountForSession("uncommitted", config);
    expect(resolveAnthropicAccountForSession("another-uncommitted", config).accountId).toBe(first.accountId);
    // A failed candidate must not capture the task's affinity before its selection commits.
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 90 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 5 });
    const quota = cfg(true);
    expect(resolveAnthropicAccountForSession("uncommitted", quota).accountId).toBe(bId);
  });

  test("default off always returns the active account", async () => {
    const { aId, bId } = await seedTwoAccounts();
    expect(isAnthropicAccountPoolEnabled(cfg(false))).toBe(false);
    const sel = resolveAnthropicAccountForSession("session-1", cfg(false));
    expect(sel.accountId).toBe(aId);
    expect(sel.reason).toBe("pool-disabled");
    expect(sel.accountId).not.toBe(bId);
  });

  test("affinity sticks across resolves until cooled", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // Force lowest-usage toward B for a cold start with high active usage.
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 95 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    const first = await admitAnthropic("sess-sticky", cfg(true));
    expect(first.accountId).toBe(bId);
    // Even if A becomes "better", affinity keeps B.
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 1 });
    const second = resolveAnthropicAccountForSession("sess-sticky", cfg(true));
    expect(second.accountId).toBe(bId);
    expect(second.reason).toBe("affinity");
  });

  test("429 cools the account and failover picks another eligible account", async () => {
    const { aId, bId } = await seedTwoAccounts();
    bindAnthropicSessionAffinity("sess-fail", aId);
    const next = rotateAnthropicAccountOn429(cfg(true), aId, "30", "sess-fail");
    expect(next).toBe(bId);
    expect(getEligibleAnthropicAccounts()).toEqual([bId]);
    const after = resolveAnthropicAccountForSession("sess-fail", cfg(true));
    expect(after.accountId).toBe(bId);
  });

  test("all cooled returns all-cooled rather than none", async () => {
    const { aId, bId } = await seedTwoAccounts();
    expect(rotateAnthropicAccountOn429(cfg(true), aId, "120")).toBe(bId);
    expect(rotateAnthropicAccountOn429(cfg(true), bId, "120")).toBeNull();
    const sel = resolveAnthropicAccountForSession("cooled-sess", cfg(true));
    expect(sel.accountId).toBeNull();
    expect(sel.reason).toBe("all-cooled");
  });

  test("unknown active usage does not force a switch", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // Only B has known usage; active A is unknown and must stay selected under threshold rules.
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 5 });
    const sel = resolveAnthropicAccountForSession("unknown-usage", cfg(true, 80));
    expect(sel.accountId).toBe(aId);
    expect(sel.reason).toBe("active");
  });

  test("new session prefers lower fiveHour usage when above threshold", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 90 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 20 });
    const sel = resolveAnthropicAccountForSession("new-sess", cfg(true, 80));
    expect(sel.accountId).toBe(bId);
    expect(sel.reason).toBe("lowest-usage");
  });

  test("session key prefers session_id over prompt_cache_key", () => {
    expect(anthropicSessionKeyFromParts({
      sessionIdHeader: "sess-a",
      promptCacheKey: "cache-b",
    })).toBe("sess-a");
  });

  test("shared Desktop cache cohort alone does not create affinity key", () => {
    expect(anthropicSessionKeyFromParts({
      promptCacheKey: "shared-cohort-hash",
      promptCacheKeyIsSharedCohort: true,
    })).toBeNull();
    expect(anthropicSessionKeyFromParts({
      promptCacheKey: "per-session-hash",
      promptCacheKeyIsSharedCohort: false,
    })).toBe("per-session-hash");
  });

  test("log label is non-PII ordinal", () => {
    const label = formatAnthropicProviderForLog("anthropic", "deadbeefdeadbeef");
    expect(label).toMatch(/^anthropic-p[a-f0-9]{6}$/);
    expect(label).not.toContain("deadbeef");
  });

  test("round-robin strategy rotates unbound new sessions", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin" });

    const picks = [
      (await admitAnthropic("sess-1", config)).accountId,
      (await admitAnthropic("sess-2", config)).accountId,
      (await admitAnthropic("sess-3", config)).accountId,
    ];
    expect(new Set(picks).size).toBe(3);
  });

  test("null/empty session key holds active under RR instead of rotating every turn", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 1 });

    const picks = Array.from({ length: 6 }, () => resolveAnthropicAccountForSession(null, config).accountId);
    expect(picks.every(id => id === aId)).toBe(true);
    expect(resolveAnthropicAccountForSession("", config).reason).toBe("active");
  });

  test("affinity still wins over round-robin", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin" });

    const first = await admitAnthropic("T", config);
    expect(first.accountId).toBeTruthy();
    const pinned = first.accountId!;
    await setActiveAccount("anthropic", pinned === aId ? bId : aId);
    expect(resolveAnthropicAccountForSession("T", config).accountId).toBe(pinned);
    expect(resolveAnthropicAccountForSession("T", config).accountId).toBe(pinned);
    expect(resolveAnthropicAccountForSession("T", config).reason).toBe("affinity");
  });

  test("omitted strategy preserves quota / active behaviour", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true);

    expect(resolveAnthropicAccountForSession(null, config).accountId).toBe(aId);
    expect(resolveAnthropicAccountForSession("new-sess", config).accountId).toBe(aId);
  });

  test("disabled pool ignores round-robin strategy", async () => {
    const { aId } = await seedThreeAccounts();
    const config = cfg(false, 80, { strategy: "round-robin" });
    const picks = [
      resolveAnthropicAccountForSession(null, config).accountId,
      resolveAnthropicAccountForSession(null, config).accountId,
      resolveAnthropicAccountForSession(null, config).accountId,
    ];
    expect(picks).toEqual([aId, aId, aId]);
    expect(resolveAnthropicAccountForSession(null, config).reason).toBe("pool-disabled");
  });

  test("fill-first keeps active under threshold", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "fill-first" });

    const picks = Array.from({ length: 8 }, () => resolveAnthropicAccountForSession("ff-sess", config).accountId);
    expect(picks.every(id => id === aId)).toBe(true);
    expect(resolveAnthropicAccountForSession("ff-sess-2", config).reason).toBe("fill-first");
    // Null session key also holds active (Desktop without sticky identity).
    expect(resolveAnthropicAccountForSession(null, config).accountId).toBe(aId);
    expect(resolveAnthropicAccountForSession(null, config).reason).toBe("active");
  });

  test("stickyLimit holds across successive unbound resolves", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 3 });

    const first = (await admitAnthropic("s1", config)).accountId;
    expect(first).toBeTruthy();
    expect((await admitAnthropic("s2", config)).accountId).toBe(first);
    expect((await admitAnthropic("s3", config)).accountId).toBe(first);
    const fourth = (await admitAnthropic("s4", config)).accountId;
    expect(fourth).not.toBe(first);
  });

  test("429 / notePoolRotationFailure advances past sticky while account stays eligible", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 10 });

    const sticky = (await admitAnthropic("sticky-1", config)).accountId!;
    expect(resolveAnthropicAccountForSession("sticky-2", config).accountId).toBe(sticky);

    notePoolRotationFailure(POOL_KEY_ANTHROPIC, sticky);
    const afterClear = (await admitAnthropic("sticky-3", config)).accountId;
    expect(afterClear).toBeTruthy();
    expect(afterClear).not.toBe(sticky);

    // Re-establish sticky, then 429-cool the sticky account — failover + ring must leave it.
    clearPoolRotationState();
    const again = (await admitAnthropic("again-1", config)).accountId!;
    expect(resolveAnthropicAccountForSession("again-2", config).accountId).toBe(again);
    const failover = rotateAnthropicAccountOn429(config, again, "30");
    expect(failover).toBeTruthy();
    expect(failover).not.toBe(again);
    // After cooldown the failed account is unusable; null key holds active only when eligible.
    await setActiveAccount("anthropic", failover!);
    const unboundAfter429 = resolveAnthropicAccountForSession("again-3", config).accountId;
    expect(unboundAfter429).not.toBe(again);
    expect([bId, cId, aId].filter(id => id !== again)).toContain(unboundAfter429);
  });

  test("fill-first skips drained successors when advancing past threshold", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    const ordered = [aId, bId, cId].sort((a, b) => a.localeCompare(b));
    setCachedProviderAccountQuotaForTests("anthropic", ordered[0]!, { fiveHourPercent: 90 });
    setCachedProviderAccountQuotaForTests("anthropic", ordered[1]!, { fiveHourPercent: 95 });
    setCachedProviderAccountQuotaForTests("anthropic", ordered[2]!, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "fill-first" });
    await setActiveAccount("anthropic", ordered[0]!);

    expect(resolveAnthropicAccountForSession("ff-drain", config).accountId).toBe(ordered[2]);
  });

  test("fill-first 429 advances next in stable order, not lowest usage", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    // Sorted ids: force usage so lowest-usage would pick cId.
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 50 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 5 });
    const config = cfg(true, 80, { strategy: "fill-first" });

    const ordered = [aId, bId, cId].sort((a, b) => a.localeCompare(b));
    // Ensure active is the first in stable order so fill-first holds it.
    await setActiveAccount("anthropic", ordered[0]!);
    expect(resolveAnthropicAccountForSession("ff-hold", config).accountId).toBe(ordered[0]);

    const failover = rotateAnthropicAccountOn429(config, ordered[0]!, "30");
    expect(failover).toBe(ordered[1]);
  });

  test("unbound strategy pick does not promote active before token validation", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    await setActiveAccount("anthropic", aId);
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 1 });

    const before = getAccountSet("anthropic")!.activeAccountId;
    const picks = Array.from({ length: 3 }, (_, i) => resolveAnthropicAccountForSession(`promo-${i}`, config));
    expect(new Set(picks.map(p => p.accountId)).size).toBe(1);
    expect(getAccountSet("anthropic")!.activeAccountId).toBe(before);
  });

  test("manual selection seeds RR so the next unbound session uses that account", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 1 });

    resolveAnthropicAccountForSession("seed-1", config);
    resolveAnthropicAccountForSession("seed-2", config);

    await setActiveAccount("anthropic", cId);
    resetAnthropicRoutingForManualSelection(cId);
    expect(resolveAnthropicAccountForSession("seed-3", config).accountId).toBe(cId);
  });
});

describe("anthropic account pool quota window", () => {
  test("every valid window normalizes and strict-parses to itself", () => {
    for (const window of ["five-hour", "weekly", "max-utilization"]) {
      expect(normalizeAccountPoolQuotaWindow(window)).toBe(window);
      expect(parseAccountPoolQuotaWindow(window)).toBe(window);
    }
  });

  test("an unknown window string defaults to five-hour and fails strict parse", () => {
    expect(normalizeAccountPoolQuotaWindow("daily")).toBe("five-hour");
    expect(parseAccountPoolQuotaWindow("daily")).toBeNull();
  });

  test("undefined defaults to five-hour and fails strict parse", () => {
    expect(normalizeAccountPoolQuotaWindow(undefined)).toBe("five-hour");
    expect(parseAccountPoolQuotaWindow(undefined)).toBeNull();
  });

  test("non-string input never satisfies strict parse", () => {
    expect(parseAccountPoolQuotaWindow(5)).toBeNull();
    expect(parseAccountPoolQuotaWindow(null)).toBeNull();
    expect(parseAccountPoolQuotaWindow({})).toBeNull();
    expect(parseAccountPoolQuotaWindow(["weekly"])).toBeNull();
    expect(normalizeAccountPoolQuotaWindow(5)).toBe("five-hour");
  });

  test("accessor reads the pool config field and defaults when absent or invalid", () => {
    expect(anthropicQuotaWindow({ quotaWindow: "five-hour" })).toBe("five-hour");
    expect(anthropicQuotaWindow({ quotaWindow: "weekly" })).toBe("weekly");
    expect(anthropicQuotaWindow({ quotaWindow: "max-utilization" })).toBe("max-utilization");
    expect(anthropicQuotaWindow({})).toBe("five-hour");
    expect(anthropicQuotaWindow({ enabled: true })).toBe("five-hour");
    expect(anthropicQuotaWindow({ quotaWindow: "daily" })).toBe("five-hour");
  });
});

describe("anthropic account pool quota window scoring", () => {
  test("weekly mode picks lowest weekly usage", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10, weeklyPercent: 90, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 90, weeklyPercent: 10, updatedAt });

    expect(resolveAnthropicAccountForSession("weekly-lowest", cfg(true, 80, { quotaWindow: "weekly" })).accountId).toBe(bId);
  });

  test("weekly mode excludes 5h-exhausted candidate", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 30, weeklyPercent: 90, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 100, weeklyPercent: 5, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 40, weeklyPercent: 50, updatedAt });

    expect(resolveAnthropicAccountForSession("weekly-exhausted-candidate", cfg(true, 80, { quotaWindow: "weekly" })).accountId).toBe(cId);
  });

  test("weekly mode keeps 5h-exhausted candidate when it is the only alternative", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", bId, {
      fiveHourPercent: 100,
      weeklyPercent: 80,
      updatedAt: Date.now(),
    });

    expect(rotateAnthropicAccountOn429(cfg(true, 80, { quotaWindow: "weekly" }), aId, "30", "weekly-only-exhausted")).toBe(bId);
  });

  test("weekly mode does not exclude a candidate whose 5h is merely unknown", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 20, weeklyPercent: 90, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { weeklyPercent: 60, updatedAt });

    expect(resolveAnthropicAccountForSession("weekly-unknown-five-hour", cfg(true, 80, { quotaWindow: "weekly" })).accountId).toBe(bId);
  });

  test("weekly mode ranks unknown weekly last", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 90, weeklyPercent: 85, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10, updatedAt });

    expect(resolveAnthropicAccountForSession("weekly-unknown-last", cfg(true, 80, { quotaWindow: "weekly" })).accountId).toBe(aId);
  });

  test("weekly mode ranks known 100% before unknown weekly usage", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 90, weeklyPercent: 100, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 0, updatedAt });

    expect(resolveAnthropicAccountForSession("weekly-known-100-before-unknown", cfg(true, 80, { quotaWindow: "weekly" })).accountId).toBe(aId);
  });

  test("weekly tie breaks by lower five-hour usage", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 50, weeklyPercent: 85, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 20, weeklyPercent: 85, updatedAt });

    expect(resolveAnthropicAccountForSession("weekly-five-hour-tie", cfg(true, 80, { quotaWindow: "weekly" })).accountId).toBe(bId);
  });

  test("weekly mode treats 5h-exhausted active as over threshold", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 100, weeklyPercent: 10, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 30, weeklyPercent: 60, updatedAt });

    expect(resolveAnthropicAccountForSession("weekly-exhausted-active", cfg(true, 80, { quotaWindow: "weekly" })).accountId).toBe(bId);
  });

  test("max-utilization scores by the hotter window", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 20, weeklyPercent: 95, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 60, weeklyPercent: 30, updatedAt });

    expect(resolveAnthropicAccountForSession("max-hotter", cfg(true, 80, { quotaWindow: "max-utilization" })).accountId).toBe(bId);
  });

  test("max-utilization tie breaks by lower five-hour usage", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 90, weeklyPercent: 20, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 40, weeklyPercent: 90, updatedAt });

    expect(resolveAnthropicAccountForSession("max-five-hour-tie", cfg(true, 80, { quotaWindow: "max-utilization" })).accountId).toBe(bId);
  });

  test("max-utilization ranks known 100% before fully unknown usage", async () => {
    const { bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", bId, {
      fiveHourPercent: 100,
      updatedAt: Date.now(),
    });

    expect(rotateAnthropicAccountOn429(
      cfg(true, 80, { quotaWindow: "max-utilization" }),
      cId,
      "30",
      "max-known-100-before-unknown",
    )).toBe(bId);
  });

  test("five-hour default does not adopt known-before-unknown ranking", async () => {
    // The known-first rule belongs to the opt-in windows. Under the legacy five-hour default
    // a measured 100% account must NOT outrank an unmeasured one just for having a reading —
    // that would change routing for operators who never opted into anything.
    const { bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", bId, {
      fiveHourPercent: 100,
      updatedAt: Date.now(),
    });

    // Omitted window (legacy default) and the explicit five-hour spelling must agree, and
    // neither may promote the exhausted-but-measured account the way max-utilization does.
    expect(rotateAnthropicAccountOn429(cfg(true, 80), cId, "30", "five-hour-default-known"))
      .not.toBe(bId);
    expect(rotateAnthropicAccountOn429(
      cfg(true, 80, { quotaWindow: "five-hour" }),
      cId,
      "30",
      "five-hour-explicit-known",
    )).not.toBe(bId);
  });

  test("omitted quotaWindow equals explicit five-hour", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10, weeklyPercent: 90, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 90, weeklyPercent: 10, updatedAt });

    expect(resolveAnthropicAccountForSession("window-omitted", cfg(true)).accountId).toBe(aId);
    expect(resolveAnthropicAccountForSession("window-five-hour", cfg(true, 80, { quotaWindow: "five-hour" })).accountId).toBe(aId);
    expect(resolveAnthropicAccountForSession("window-weekly-control", cfg(true, 80, { quotaWindow: "weekly" })).accountId).toBe(bId);
  });

  test("threshold 0 keeps the active account regardless of quotaWindow", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt });

    for (const quotaWindow of ["five-hour", "weekly", "max-utilization"] as const) {
      const sessionKey = `threshold-zero-${quotaWindow}`;
      expect(resolveAnthropicAccountForSession(sessionKey, cfg(true, 0, { quotaWindow })).accountId).toBe(aId);
    }
  });

  test("threshold 0 still applies quotaWindow on 429 failover", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10, weeklyPercent: 90, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 90, weeklyPercent: 10, updatedAt });

    expect(rotateAnthropicAccountOn429(cfg(true, 0, { quotaWindow: "weekly" }), aId, "30", "threshold-zero-weekly")).toBe(cId);

    clearAnthropicAccountPoolState();
    expect(rotateAnthropicAccountOn429(cfg(true, 0, { quotaWindow: "five-hour" }), aId, "30", "threshold-zero-five-hour")).toBe(bId);
  });

  test("429 failover never returns null while any eligible account remains", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", bId, {
      fiveHourPercent: 100,
      weeklyPercent: 100,
      updatedAt: Date.now(),
    });

    expect(rotateAnthropicAccountOn429(cfg(true, 80, { quotaWindow: "weekly" }), aId, "30", "weekly-never-null")).toBe(bId);
  });

  test("fill-first threshold uses configured window", async () => {
    const { aId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, {
      fiveHourPercent: 90,
      weeklyPercent: 10,
      updatedAt: Date.now(),
    });

    expect(resolveAnthropicAccountForSession(
      "fill-first-weekly-threshold",
      cfg(true, 80, { strategy: "fill-first", quotaWindow: "weekly" }),
    ).accountId).toBe(aId);
    expect(resolveAnthropicAccountForSession(
      "fill-first-five-hour-threshold",
      cfg(true, 80, { strategy: "fill-first", quotaWindow: "five-hour" }),
    ).accountId).not.toBe(aId);
  });

  test("fill-first at threshold 0 keeps a 5h-exhausted active under weekly", async () => {
    const { aId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, {
      fiveHourPercent: 100,
      weeklyPercent: 100,
      updatedAt: Date.now(),
    });

    expect(resolveAnthropicAccountForSession(
      "fill-first-zero-weekly",
      cfg(true, 0, { strategy: "fill-first", quotaWindow: "weekly" }),
    ).accountId).toBe(aId);
  });

  test("weekly mode skips a 5h-exhausted successor under fill-first", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    expect([aId, bId, cId].sort((a, b) => a.localeCompare(b))).toEqual([aId, bId, cId]);
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10, weeklyPercent: 90, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 100, weeklyPercent: 10, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 20, weeklyPercent: 30, updatedAt });

    expect(resolveAnthropicAccountForSession(
      "fill-first-skip-exhausted",
      cfg(true, 80, { strategy: "fill-first", quotaWindow: "weekly" }),
    ).accountId).toBe(cId);
  });

  test("weekly fill-first fallback prefers a non-exhausted successor above threshold", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    expect([aId, bId, cId].sort((a, b) => a.localeCompare(b))).toEqual([aId, bId, cId]);
    const updatedAt = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10, weeklyPercent: 90, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 100, weeklyPercent: 10, updatedAt });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 20, weeklyPercent: 90, updatedAt });

    expect(resolveAnthropicAccountForSession(
      "fill-first-non-exhausted-fallback",
      cfg(true, 80, { strategy: "fill-first", quotaWindow: "weekly" }),
    ).accountId).toBe(cId);
  });

  test("weekly mode with empty quota cache falls back to stable order", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const config = cfg(true, 80, { quotaWindow: "weekly" });

    expect(resolveAnthropicAccountForSession("weekly-empty-keep", config).accountId).toBe(aId);
    expect(rotateAnthropicAccountOn429(config, aId, "30", "weekly-empty-failover")).toBe(bId);
  });
});
