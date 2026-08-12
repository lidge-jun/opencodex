import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState, notePoolRotationFailure, POOL_KEY_COMMAND_CODE } from "../src/codex/pool-rotation";
import {
  bindCommandCodeSessionAffinity,
  clearCommandCodeAccountPoolState,
  formatCommandCodeProviderForLog,
  getEligibleCommandCodeAccounts,
  isCommandCodeAccountPoolEnabled,
  resolveCommandCodeAccountForSession,
  resetCommandCodeRoutingForManualSelection,
  rotateCommandCodeAccountOn429,
  commandCodeSessionKeyFromParts,
} from "../src/oauth/command-code-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../src/providers/quota";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-command-code-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearCommandCodeAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("command-code");
});

afterEach(() => {
  clearCommandCodeAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("command-code");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

async function seedTwoAccounts() {
  await saveCredential("command-code", {
    access: "access-a",
    refresh: "access-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
  });
  await saveCredential("command-code", {
    access: "access-b",
    refresh: "access-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
  });
  // saveCredential activates the newly appended account (B). Pin A as active for predictable tests.
  const set = getAccountSet("command-code")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  await setActiveAccount("command-code", a.id);
  return { aId: a.id, bId: b.id };
}

function cfg(
  enabled: boolean,
  threshold = 80,
  pool: { strategy?: OcxAccountPoolRotationStrategy; stickyLimit?: number } = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "command-code",
    providers: {
      "command-code": { adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth" },
    },
    commandCodeAccountPool: {
      enabled,
      autoSwitchThreshold: threshold,
      ...pool,
    },
  } as OcxConfig;
}

async function seedThreeAccounts() {
  await saveCredential("command-code", {
    access: "access-a",
    refresh: "access-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
  });
  await saveCredential("command-code", {
    access: "access-b",
    refresh: "access-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
  });
  await saveCredential("command-code", {
    access: "access-c",
    refresh: "access-c",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-cccc",
    email: "c@example.test",
  });
  const set = getAccountSet("command-code")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  const c = set.accounts.find(acc => acc.credential.accountId === "uuid-cccc")!;
  await setActiveAccount("command-code", a.id);
  return { aId: a.id, bId: b.id, cId: c.id };
}

describe("command-code account pool", () => {
  test("default off always returns the active account", async () => {
    const { aId, bId } = await seedTwoAccounts();
    expect(isCommandCodeAccountPoolEnabled(cfg(false))).toBe(false);
    const sel = resolveCommandCodeAccountForSession("session-1", cfg(false));
    expect(sel.accountId).toBe(aId);
    expect(sel.reason).toBe("pool-disabled");
    expect(sel.accountId).not.toBe(bId);
  });

  test("affinity sticks across resolves until cooled", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // Force lowest-usage toward B for a cold start with high active usage.
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 95 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 10 });
    const first = resolveCommandCodeAccountForSession("sess-sticky", cfg(true));
    expect(first.accountId).toBe(bId);
    // Even if A becomes "better", affinity keeps B.
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 1 });
    const second = resolveCommandCodeAccountForSession("sess-sticky", cfg(true));
    expect(second.accountId).toBe(bId);
    expect(second.reason).toBe("affinity");
  });

  test("429 cools the account and failover picks another eligible account", async () => {
    const { aId, bId } = await seedTwoAccounts();
    bindCommandCodeSessionAffinity("sess-fail", aId);
    const next = rotateCommandCodeAccountOn429(cfg(true), aId, "30", "sess-fail");
    expect(next).toBe(bId);
    expect(getEligibleCommandCodeAccounts()).toEqual([bId]);
    const after = resolveCommandCodeAccountForSession("sess-fail", cfg(true));
    expect(after.accountId).toBe(bId);
  });

  test("all cooled returns all-cooled rather than none", async () => {
    const { aId, bId } = await seedTwoAccounts();
    expect(rotateCommandCodeAccountOn429(cfg(true), aId, "120")).toBe(bId);
    expect(rotateCommandCodeAccountOn429(cfg(true), bId, "120")).toBeNull();
    const sel = resolveCommandCodeAccountForSession("cooled-sess", cfg(true));
    expect(sel.accountId).toBeNull();
    expect(sel.reason).toBe("all-cooled");
  });

  test("unknown active usage does not force a switch", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // Only B has known usage; active A is unknown and must stay selected under threshold rules.
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 5 });
    const sel = resolveCommandCodeAccountForSession("unknown-usage", cfg(true, 80));
    expect(sel.accountId).toBe(aId);
    expect(sel.reason).toBe("active");
  });

  test("new session prefers lower fiveHour usage when above threshold", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 90 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 20 });
    const sel = resolveCommandCodeAccountForSession("new-sess", cfg(true, 80));
    expect(sel.accountId).toBe(bId);
    expect(sel.reason).toBe("lowest-usage");
  });

  test("session key prefers session_id over prompt_cache_key", () => {
    expect(commandCodeSessionKeyFromParts({
      sessionIdHeader: "sess-a",
      promptCacheKey: "cache-b",
    })).toBe("sess-a");
  });

  test("shared Desktop cache cohort alone does not create affinity key", () => {
    expect(commandCodeSessionKeyFromParts({
      promptCacheKey: "shared-cohort-hash",
      promptCacheKeyIsSharedCohort: true,
    })).toBeNull();
    expect(commandCodeSessionKeyFromParts({
      promptCacheKey: "per-session-hash",
      promptCacheKeyIsSharedCohort: false,
    })).toBe("per-session-hash");
  });

  test("log label is non-PII ordinal", () => {
    const label = formatCommandCodeProviderForLog("command-code", "deadbeefdeadbeef");
    expect(label).toMatch(/^command-code-p[a-f0-9]{6}$/);
    expect(label).not.toContain("deadbeef");
  });

  test("round-robin strategy rotates unbound new sessions", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin" });

    const picks = [
      resolveCommandCodeAccountForSession("sess-1", config).accountId,
      resolveCommandCodeAccountForSession("sess-2", config).accountId,
      resolveCommandCodeAccountForSession("sess-3", config).accountId,
    ];
    expect(new Set(picks).size).toBe(3);
  });

  test("null/empty session key holds active under RR instead of rotating every turn", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 1 });

    const picks = Array.from({ length: 6 }, () => resolveCommandCodeAccountForSession(null, config).accountId);
    expect(picks.every(id => id === aId)).toBe(true);
    expect(resolveCommandCodeAccountForSession("", config).reason).toBe("active");
  });

  test("affinity still wins over round-robin", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin" });

    const first = resolveCommandCodeAccountForSession("T", config);
    expect(first.accountId).toBeTruthy();
    const pinned = first.accountId!;
    await setActiveAccount("command-code", pinned === aId ? bId : aId);
    expect(resolveCommandCodeAccountForSession("T", config).accountId).toBe(pinned);
    expect(resolveCommandCodeAccountForSession("T", config).reason).toBe("affinity");
  });

  test("omitted strategy preserves quota / active behaviour", async () => {
    const { aId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    const config = cfg(true);

    expect(resolveCommandCodeAccountForSession(null, config).accountId).toBe(aId);
    expect(resolveCommandCodeAccountForSession("new-sess", config).accountId).toBe(aId);
  });

  test("disabled pool ignores round-robin strategy", async () => {
    const { aId } = await seedThreeAccounts();
    const config = cfg(false, 80, { strategy: "round-robin" });
    const picks = [
      resolveCommandCodeAccountForSession(null, config).accountId,
      resolveCommandCodeAccountForSession(null, config).accountId,
      resolveCommandCodeAccountForSession(null, config).accountId,
    ];
    expect(picks).toEqual([aId, aId, aId]);
    expect(resolveCommandCodeAccountForSession(null, config).reason).toBe("pool-disabled");
  });

  test("fill-first keeps active under threshold", async () => {
    const { aId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "fill-first" });

    const picks = Array.from({ length: 8 }, () => resolveCommandCodeAccountForSession("ff-sess", config).accountId);
    expect(picks.every(id => id === aId)).toBe(true);
    expect(resolveCommandCodeAccountForSession("ff-sess-2", config).reason).toBe("fill-first");
    // Null session key also holds active (Desktop without sticky identity).
    expect(resolveCommandCodeAccountForSession(null, config).accountId).toBe(aId);
    expect(resolveCommandCodeAccountForSession(null, config).reason).toBe("active");
  });

  test("stickyLimit holds across successive unbound resolves", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 3 });

    const first = resolveCommandCodeAccountForSession("s1", config).accountId;
    expect(first).toBeTruthy();
    expect(resolveCommandCodeAccountForSession("s2", config).accountId).toBe(first);
    expect(resolveCommandCodeAccountForSession("s3", config).accountId).toBe(first);
    const fourth = resolveCommandCodeAccountForSession("s4", config).accountId;
    expect(fourth).not.toBe(first);
  });

  test("429 / notePoolRotationFailure advances past sticky while account stays eligible", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 10 });

    const sticky = resolveCommandCodeAccountForSession("sticky-1", config).accountId!;
    expect(resolveCommandCodeAccountForSession("sticky-2", config).accountId).toBe(sticky);

    notePoolRotationFailure(POOL_KEY_COMMAND_CODE, sticky);
    const afterClear = resolveCommandCodeAccountForSession("sticky-3", config).accountId;
    expect(afterClear).toBeTruthy();
    expect(afterClear).not.toBe(sticky);

    // Re-establish sticky, then 429-cool the sticky account — failover + ring must leave it.
    clearPoolRotationState();
    const again = resolveCommandCodeAccountForSession("again-1", config).accountId!;
    expect(resolveCommandCodeAccountForSession("again-2", config).accountId).toBe(again);
    const failover = rotateCommandCodeAccountOn429(config, again, "30");
    expect(failover).toBeTruthy();
    expect(failover).not.toBe(again);
    // After cooldown the failed account is unusable; null key holds active only when eligible.
    await setActiveAccount("command-code", failover!);
    const unboundAfter429 = resolveCommandCodeAccountForSession("again-3", config).accountId;
    expect(unboundAfter429).not.toBe(again);
    expect([bId, cId, aId].filter(id => id !== again)).toContain(unboundAfter429);
  });

  test("fill-first skips drained successors when advancing past threshold", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    const ordered = [aId, bId, cId].sort((a, b) => a.localeCompare(b));
    setCachedProviderAccountQuotaForTests("command-code", ordered[0]!, { fiveHourPercent: 90 });
    setCachedProviderAccountQuotaForTests("command-code", ordered[1]!, { fiveHourPercent: 95 });
    setCachedProviderAccountQuotaForTests("command-code", ordered[2]!, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "fill-first" });
    await setActiveAccount("command-code", ordered[0]!);

    expect(resolveCommandCodeAccountForSession("ff-drain", config).accountId).toBe(ordered[2]);
  });

  test("fill-first 429 advances next in stable order, not lowest usage", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    // Sorted ids: force usage so lowest-usage would pick cId.
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 50 });
    setCachedProviderAccountQuotaForTests("command-code", cId, { fiveHourPercent: 5 });
    const config = cfg(true, 80, { strategy: "fill-first" });

    const ordered = [aId, bId, cId].sort((a, b) => a.localeCompare(b));
    // Ensure active is the first in stable order so fill-first holds it.
    await setActiveAccount("command-code", ordered[0]!);
    expect(resolveCommandCodeAccountForSession("ff-hold", config).accountId).toBe(ordered[0]);

    const failover = rotateCommandCodeAccountOn429(config, ordered[0]!, "30");
    expect(failover).toBe(ordered[1]);
  });

  test("unbound strategy pick does not promote active before token validation", async () => {
    const { aId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    await setActiveAccount("command-code", aId);
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 1 });

    const before = getAccountSet("command-code")!.activeAccountId;
    const picks = Array.from({ length: 3 }, (_, i) => resolveCommandCodeAccountForSession(`promo-${i}`, config));
    expect(new Set(picks.map(p => p.accountId)).size).toBe(3);
    expect(getAccountSet("command-code")!.activeAccountId).toBe(before);
  });

  test("manual selection seeds RR so the next unbound session uses that account", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("command-code", cId, { fiveHourPercent: 10 });
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 1 });

    resolveCommandCodeAccountForSession("seed-1", config);
    resolveCommandCodeAccountForSession("seed-2", config);

    await setActiveAccount("command-code", cId);
    resetCommandCodeRoutingForManualSelection(cId);
    expect(resolveCommandCodeAccountForSession("seed-3", config).accountId).toBe(cId);
  });
});

describe("command-code account pool priority", () => {
  test("higher-priority account with headroom preempts active under quota strategy", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // seedTwoAccounts leaves B active; pin A as active so B's higher priority preempts.
    await setActiveAccount("command-code", aId);
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 20 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 30 });
    const config = {
      ...cfg(true, 80),
      commandCodeAccountPool: {
        enabled: true,
        autoSwitchThreshold: 80,
        accountPriorities: { [bId]: 10 },
      },
    } as OcxConfig;

    const sel = resolveCommandCodeAccountForSession("prio-new-sess", config);
    expect(sel.accountId).toBe(bId);
    expect(sel.reason).toBe("priority-preemption");
  });

  test("pinned account suppresses upward priority preemption", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 20 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 30 });
    const config = {
      ...cfg(true, 80),
      commandCodeAccountPool: {
        enabled: true,
        autoSwitchThreshold: 80,
        accountPriorities: { [bId]: 10 },
        activeAccountPinned: aId,
      },
    } as OcxConfig;

    const sel = resolveCommandCodeAccountForSession("pinned-sess", config);
    expect(sel.accountId).toBe(aId);
  });

  test("priority tier constrains round-robin and fill-first selection", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 20 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 20 });

    for (const strategy of ["round-robin", "fill-first"] as const) {
      clearCommandCodeAccountPoolState();
      clearPoolRotationState();
      const config = {
        ...cfg(true, 80, { strategy }),
        commandCodeAccountPool: {
          enabled: true,
          autoSwitchThreshold: 80,
          strategy,
          accountPriorities: { [bId]: 10 },
        },
      } as OcxConfig;
      expect(resolveCommandCodeAccountForSession(`${strategy}-priority`, config).accountId).toBe(bId);
    }
  });

  test("manual pin constrains round-robin and fill-first selection", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("command-code", aId, { fiveHourPercent: 20 });
    setCachedProviderAccountQuotaForTests("command-code", bId, { fiveHourPercent: 20 });

    for (const strategy of ["round-robin", "fill-first"] as const) {
      clearCommandCodeAccountPoolState();
      clearPoolRotationState();
      const config = {
        ...cfg(true, 80, { strategy }),
        commandCodeAccountPool: {
          enabled: true,
          autoSwitchThreshold: 80,
          strategy,
          accountPriorities: { [bId]: 10 },
          activeAccountPinned: aId,
        },
      } as OcxConfig;
      expect(resolveCommandCodeAccountForSession(`${strategy}-pin`, config).accountId).toBe(aId);
    }
  });
});
