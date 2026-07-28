import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState, notePoolRotationFailure, POOL_KEY_ANTHROPIC } from "../src/codex/pool-rotation";
import {
  anthropicSessionKeyFromParts,
  bindAnthropicSessionAffinity,
  clearAnthropicAccountPoolState,
  formatAnthropicProviderForLog,
  getEligibleAnthropicAccounts,
  isAnthropicAccountPoolEnabled,
  resolveAnthropicAccountForSession,
  resetAnthropicRoutingForManualSelection,
  rotateAnthropicAccountOn429,
} from "../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../src/providers/quota";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

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
  rmSync(home, { recursive: true, force: true });
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
  const { getAccountSet } = await import("../src/oauth/store");
  const set = getAccountSet("anthropic")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  await setActiveAccount("anthropic", a.id);
  return { aId: a.id, bId: b.id };
}

function cfg(
  enabled: boolean,
  threshold = 80,
  pool: { strategy?: OcxAccountPoolRotationStrategy; stickyLimit?: number } = {},
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
  const { getAccountSet } = await import("../src/oauth/store");
  const set = getAccountSet("anthropic")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  const c = set.accounts.find(acc => acc.credential.accountId === "uuid-cccc")!;
  await setActiveAccount("anthropic", a.id);
  return { aId: a.id, bId: b.id, cId: c.id };
}

describe("anthropic account pool", () => {
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
    const first = resolveAnthropicAccountForSession("sess-sticky", cfg(true));
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
      resolveAnthropicAccountForSession("sess-1", config).accountId,
      resolveAnthropicAccountForSession("sess-2", config).accountId,
      resolveAnthropicAccountForSession("sess-3", config).accountId,
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

    const first = resolveAnthropicAccountForSession("T", config);
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

    const first = resolveAnthropicAccountForSession("s1", config).accountId;
    expect(first).toBeTruthy();
    expect(resolveAnthropicAccountForSession("s2", config).accountId).toBe(first);
    expect(resolveAnthropicAccountForSession("s3", config).accountId).toBe(first);
    const fourth = resolveAnthropicAccountForSession("s4", config).accountId;
    expect(fourth).not.toBe(first);
  });

  test("429 / notePoolRotationFailure advances past sticky while account stays eligible", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 10 });

    const sticky = resolveAnthropicAccountForSession("sticky-1", config).accountId!;
    expect(resolveAnthropicAccountForSession("sticky-2", config).accountId).toBe(sticky);

    notePoolRotationFailure(POOL_KEY_ANTHROPIC, sticky);
    const afterClear = resolveAnthropicAccountForSession("sticky-3", config).accountId;
    expect(afterClear).toBeTruthy();
    expect(afterClear).not.toBe(sticky);

    // Re-establish sticky, then 429-cool the sticky account — failover + ring must leave it.
    clearPoolRotationState();
    const again = resolveAnthropicAccountForSession("again-1", config).accountId!;
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
    expect(new Set(picks.map(p => p.accountId)).size).toBe(3);
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
