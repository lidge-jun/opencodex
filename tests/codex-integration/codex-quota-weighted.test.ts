import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState, notePoolRotationSuccess, notePoolRotationFailure, reconcilePoolRotationState, parseAccountPoolStrategy, parseCodexAccountPoolStrategy, peekRoundRobinAccount, pickRoundRobinAccount, seedPoolRotationAccount } from "../../src/codex/pool-rotation";
import { clearThreadAccountMap, clearCodexUpstreamHealth, resolveCodexAccountForThread, previewCodexAccountForRequest } from "../../src/codex/routing";
import { clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { codexQuotaHasFreshUsage, stampCodexQuotaUsageObservation } from "../../src/codex/quota-observation-freshness";
import type { StoredAccountQuota } from "../../src/codex/quota-types";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

let home: string;
let oldHome: string | undefined;
let oldCodexHome: string | undefined;
let config: OcxConfig;
beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME; oldCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-quota-weighted-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  clearPoolRotationState(); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
  config = { providers: {}, accountPoolStrategy: "quota-weighted", activeCodexAccountId: "a", autoSwitchThreshold: 80,
    codexAccounts: ["a", "b"].map(id => ({ id, email: `${id}@example.test`, isMain: false })) } as OcxConfig;
  for (const id of ["a", "b"]) saveCodexAccountCredential(id, {
    accessToken: `fixture-${id}`, refreshToken: `fixture-refresh-${id}`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `fixture-account-${id}`,
  });
});
afterEach(() => {
  clearPoolRotationState(); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
  removeTreeWithRetry(home);
});

describe("quota-weighted new-session scheduling", () => {
  test("only Codex accepts the new opt-in strategy", () => {
    expect(parseCodexAccountPoolStrategy("quota-weighted")).toBe("quota-weighted");
    expect(parseAccountPoolStrategy("quota-weighted")).toBeNull();
  });
  test("smooth weighted rotation follows 1:3 and preview does not consume a slot", () => {
    const weights = new Map([["a", 1], ["b", 3]]);
    const picks: string[] = [];
    for (let i = 0; i < 40; i++) {
      const preview = peekRoundRobinAccount("weighted-test", ["a", "b"], 1, weights);
      expect(peekRoundRobinAccount("weighted-test", ["a", "b"], 1, weights)).toBe(preview);
      const pick = pickRoundRobinAccount("weighted-test", ["a", "b"], 1, weights)!;
      expect(pick).toBe(preview); picks.push(pick);
    }
    expect(picks.filter(id => id === "a")).toHaveLength(10);
    expect(picks.filter(id => id === "b")).toHaveLength(30);
  });
  test("the largest remaining share takes every new session without persisting active", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 75 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    const picks = Array.from({ length: 12 }, (_, i) => resolveCodexAccountForThread(`task-${i}`, config));
    expect(new Set(picks)).toEqual(new Set(["b"]));
    expect(config.activeCodexAccountId).toBe("a");
  });
  test("equal remaining shares rotate evenly", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 25 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    const picks = Array.from({ length: 10 }, (_, i) => resolveCodexAccountForThread(`tie-${i}`, config));
    expect(picks.filter(id => id === "a")).toHaveLength(5);
    expect(picks.filter(id => id === "b")).toHaveLength(5);
  });
  test("an unknown-quota account keeps its proportional probe share", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 25 });
    const picks = Array.from({ length: 76 }, (_, i) => resolveCodexAccountForThread(`probe-${i}`, config));
    expect(picks.filter(id => id === "a")).toHaveLength(75);
    expect(picks.filter(id => id === "b")).toHaveLength(1);
  });
  test("healthy bindings stay even after quotas and reset preference change", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 75 }); setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    const first = resolveCodexAccountForThread("bound", config);
    setAccountQuotaFromParsed(first!, { weeklyPercent: 85 });
    setAccountQuotaFromParsed(first === "a" ? "b" : "a", { weeklyPercent: 0, weeklyResetAt: Date.now() + 60_000 });
    expect(previewCodexAccountForRequest("bound", config)).toBe(first);
    expect(resolveCodexAccountForThread("bound", config)).toBe(first);
  });
  test("new assignments exclude threshold accounts even if reset is imminent", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 80, weeklyResetAt: Date.now() + 60_000 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    for (let i = 0; i < 8; i++) expect(resolveCodexAccountForThread(`threshold-${i}`, config)).toBe("b");
  });
  test("all threshold accounts stop new assignments rather than fall through to active", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 80 }); setAccountQuotaFromParsed("b", { weeklyPercent: 90 });
    expect(previewCodexAccountForRequest("all-drained", config)).toBeNull();
    expect(resolveCodexAccountForThread("all-drained", config)).toBeNull();
  });
  test("priority, pause and account-specific thresholds precede weighting", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 20 }); setAccountQuotaFromParsed("b", { weeklyPercent: 0 });
    config.codexAccountPriorities = { a: 10 };
    expect(resolveCodexAccountForThread("priority", config)).toBe("a");
    config.pausedCodexAccountIds = ["a"];
    expect(resolveCodexAccountForThread("pause", config)).toBe("b");
    config.pausedCodexAccountIds = []; config.codexAccountAutoSwitchThresholds = { a: 20 };
    expect(resolveCodexAccountForThread("override", config)).toBe("b");
  });
});

import { codexQuotaSchedulingWeight } from "../../src/codex/routing/quota-weighted";
import { accountPoolStrategyForScope, pickAlternateCodexAccount, peekAlternateCodexAccount } from "../../src/codex/routing/selection";
import { setCodexAccountPin } from "../../src/codex/account-priority";
import { resetCodexRoutingForManualSelection, recordCodexUpstreamOutcome } from "../../src/codex/routing";
const now = 1_791_775_000_000;
const hour = 3_600_000;
/** Scoring fixtures explicitly represent a measured observation, not a hydrated cache write. */
function measuredQuota(quota: StoredAccountQuota): StoredAccountQuota {
  return stampCodexQuotaUsageObservation(quota, quota);
}
describe("quota-weighted window scoring", () => {
  test("remaining share dominates and nearer long resets add at most +10%/+5%", () => {
    const base = { weeklyPercent: 25, updatedAt: now };
    expect(codexQuotaSchedulingWeight(base, "prolite", 80, now)).toBe(75);
    expect(codexQuotaSchedulingWeight(measuredQuota({ ...base, weeklyResetAt: now + hour }), "prolite", 80, now)).toBe(82.5);
    expect(codexQuotaSchedulingWeight(measuredQuota({ ...base, weeklyResetAt: now + 12 * hour }), "prolite", 80, now)).toBe(78.75);
    expect(codexQuotaSchedulingWeight(measuredQuota({ ...base, weeklyResetAt: now + 25 * hour }), "prolite", 80, now)).toBe(75);
    // A near reset never outranks a clearly larger remaining share.
    expect(codexQuotaSchedulingWeight(measuredQuota({ weeklyPercent: 60, weeklyResetAt: now + hour, updatedAt: now }), "prolite", 80, now))
      .toBeLessThan(codexQuotaSchedulingWeight(base, "prolite", 80, now));
  });
  test("short-reset urgency cannot overrule a tight unreset weekly window", () => {
    expect(codexQuotaSchedulingWeight(measuredQuota({ weeklyPercent: 75, weeklyResetAt: now + 3 * 24 * hour,
      shortPercent: 50, shortResetAt: now + 10_000, updatedAt: now }), "prolite", 80, now)).toBe(25);
    expect(codexQuotaSchedulingWeight(measuredQuota({ weeklyPercent: 10, shortPercent: 50,
      shortResetAt: now + 10_000, updatedAt: now }), "prolite", 80, now)).toBeCloseTo(55);
  });
  test("bounded reset urgency may decide near-ties, and future observations are not fresh", () => {
    const near = measuredQuota({ weeklyPercent: 50, weeklyResetAt: now + hour, updatedAt: now });
    expect(codexQuotaSchedulingWeight(near, undefined, 80, now))
      .toBeGreaterThan(codexQuotaSchedulingWeight({ weeklyPercent: 49, updatedAt: now }, undefined, 80, now));
    expect(codexQuotaSchedulingWeight(measuredQuota({ weeklyPercent: 50, weeklyResetAt: now + hour,
      updatedAt: now + 1 }), undefined, 80, now)).toBe(50);
    expect(codexQuotaSchedulingWeight(measuredQuota({ weeklyPercent: 0, shortPercent: 50, shortObservedAt: now + 1,
      shortResetAt: now + 10_000, updatedAt: now }), undefined, 80, now)).toBe(50);
  });
  test("missing, elapsed and stale reset evidence has no boost, seconds and ms agree", () => {
    const base = { weeklyPercent: 25, updatedAt: now };
    expect(codexQuotaSchedulingWeight(measuredQuota({ ...base, weeklyResetAt: now - 1 }), "prolite", 80, now)).toBe(75);
    expect(codexQuotaSchedulingWeight(measuredQuota({ ...base, updatedAt: now - 301_000, weeklyResetAt: now + hour }), "prolite", 80, now)).toBe(75);
    expect(codexQuotaSchedulingWeight(measuredQuota({ ...base, weeklyResetAt: (now + hour) / 1000 }), "prolite", 80, now)).toBe(82.5);
    expect(codexQuotaSchedulingWeight(measuredQuota({ weeklyPercent: 0, shortPercent: 50, shortObservedAt: now - 301_000,
      shortResetAt: now + 10_000, updatedAt: now }), "prolite", 80, now)).toBe(50);
  });
  test("a recent cache timestamp supplies no measured reset evidence", () => {
    const cached = { weeklyPercent: 25, weeklyResetAt: now + hour, updatedAt: now };
    expect(codexQuotaSchedulingWeight(cached, undefined, 80, now)).toBe(75);
    const measured = measuredQuota({ ...cached });
    expect(codexQuotaSchedulingWeight(measured, undefined, 80, now)).toBe(82.5);
    expect(codexQuotaSchedulingWeight(structuredClone(measured), undefined, 80, now)).toBe(75);
  });
  test.each(["weekly", "monthly", "short"] as const)("%s reset lift uses its measured clock and five-minute bound", window => {
    const quota = measuredQuota({ weeklyPercent: 0, [`${window}Percent`]: 50,
      [`${window}ResetAt`]: now + hour / 4, updatedAt: now });
    expect(codexQuotaSchedulingWeight(quota, undefined, 80, now - 1)).toBe(50);
    expect(codexQuotaSchedulingWeight(quota, undefined, 80, now + 300_000)).toBeCloseTo(55);
    expect(codexQuotaSchedulingWeight(quota, undefined, 80, now + 300_001)).toBe(50);
  });
  test("unknown is a small share, not an empty account; known spent/threshold is zero", () => {
    expect(codexQuotaSchedulingWeight(null, undefined, 80, now)).toBe(1);
    expect(codexQuotaSchedulingWeight({ shortPercent: 0, updatedAt: now }, undefined, 80, now)).toBe(1);
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 80, updatedAt: now }, undefined, 80, now)).toBe(0);
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 100, updatedAt: now }, undefined, 0, now)).toBe(0);
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 95, updatedAt: now }, undefined, 0, now)).toBe(5);
  });
  test("monthly-only plans use their monthly budget and reset", () => {
    expect(codexQuotaSchedulingWeight(measuredQuota({ monthlyPercent: 40, monthlyResetAt: now + hour, updatedAt: now }), "k12", 80, now)).toBe(66);
  });
  test("independent model quotas do not inherit shared account reset ordering", () => {
    expect(accountPoolStrategyForScope(config, "spark")).toBe("quota");
    expect(config.accountPoolStrategy).toBe("quota-weighted");
  });
  test("manual next-account seed is honored once, then weighted allocation resumes", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 75 }); setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    setCodexAccountPin(config, "a"); resetCodexRoutingForManualSelection("a");
    expect(resolveCodexAccountForThread("manual-first", config)).toBe("a");
    expect(resolveCodexAccountForThread("manual-second", config)).toBe("b");
  });
  test("failure alternates skip the failed account and preview consumes no slots", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 75 }); setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    for (let i = 0; i < 3; i++) expect(peekAlternateCodexAccount(config, "a", Date.now())).toBe("b");
    expect(pickAlternateCodexAccount(config, "a")).toBe("b");
    recordCodexUpstreamOutcome(config, "b", 429);
    expect(resolveCodexAccountForThread("after-429", config)).toBe("a");
  });
});

describe("quota-weighted carried reset freshness", () => {
  function checkCarriedWindow(window: "weekly" | "monthly", publish: () => void): void {
    let observedAt = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => observedAt);
    const percent = `${window}Percent` as const;
    const reset = `${window}ResetAt` as const;
    const plan = window === "monthly" ? "free" : "plus";
    for (const account of config.codexAccounts!) account.plan = plan;
    const observation = { [percent]: 50, [reset]: observedAt + 2 * hour };
    try {
      setAccountQuotaFromParsed("a", observation);
      setAccountQuotaFromParsed("b", { [percent]: 49 });
      expect(codexQuotaSchedulingWeight(getAccountQuota("a"), plan, 80, observedAt)).toBeCloseTo(55);
      expect(previewCodexAccountForRequest("fresh-reset", config, observedAt)).toBe("a");
      observedAt += 6 * 60_000;
      expect(codexQuotaSchedulingWeight(getAccountQuota("a"), plan, 80, observedAt)).toBe(50);
      expect(previewCodexAccountForRequest("stale-reset", config, observedAt)).toBe("b");
      expect(resolveCodexAccountForThread("stale-reset", config, observedAt)).toBe("b");
      publish();
      const carried = getAccountQuota("a")!;
      expect(carried).toMatchObject({ ...observation, updatedAt: observedAt });
      expect(codexQuotaHasFreshUsage(carried, plan, observedAt, 300_000)).toBe(false);
      expect(codexQuotaSchedulingWeight(carried, plan, 80, observedAt)).toBe(50);
      expect(previewCodexAccountForRequest("partial-reset", config, observedAt)).toBe("b");
      expect(resolveCodexAccountForThread("partial-reset", config, observedAt)).toBe("b");
      // Re-observing this window itself restores its legitimate near-reset lift.
      setAccountQuotaFromParsed("a", observation);
      expect(codexQuotaSchedulingWeight(getAccountQuota("a"), plan, 80, observedAt)).toBeCloseTo(55);
      expect(previewCodexAccountForRequest("renewed-reset", config, observedAt)).toBe("a");
      expect(resolveCodexAccountForThread("renewed-reset", config, observedAt)).toBe("a");
    } finally { clock.mockRestore(); }
  }

  for (const window of ["weekly", "monthly"] as const) {
    test(`${window} usage is not renewed by reset-credit-only publication`, () => {
      checkCarriedWindow(window, () => setAccountQuotaFromParsed("a", { resetCredits: 1 }));
    });
    test(`${window} usage is not renewed by spendable-credit-only publication`, () => {
      checkCarriedWindow(window, () => setAccountQuotaFromParsed("a", {
        credits: { hasCredits: true, balance: 1, observedAt: Date.now() },
      }));
    });
    test(`${window} usage is not renewed by credit retraction`, () => {
      checkCarriedWindow(window, () => setAccountQuotaFromParsed("a", { credits: null }));
    });
    test(`${window} usage is not renewed by legacy reset-credit-only publication`, () => {
      checkCarriedWindow(window, () => updateAccountQuota("a", undefined, undefined, undefined, undefined, 1));
    });
  }
  test("short-only observations do not renew a carried weekly reset lift", () => {
    checkCarriedWindow("weekly", () => setAccountQuotaFromParsed("a", { shortPercent: 0 }));
  });
  test("weekly-only observations do not renew a carried monthly reset lift", () => {
    checkCarriedWindow("monthly", () => setAccountQuotaFromParsed("a", { weeklyPercent: 0 }));
  });
  test("legacy weekly observations do not renew a carried monthly reset lift", () => {
    checkCarriedWindow("monthly", () => updateAccountQuota("a", 0));
  });
});

test("mode changes drop automatic sticky debt without consuming preview or manual seeds", () => {
  const weights = new Map([["a", 1], ["b", 3]]);
  expect(pickRoundRobinAccount("mode-change", ["a", "b"], 10)).toBe("a");
  expect(peekRoundRobinAccount("mode-change", ["a", "b"], 1, weights)).toBe("b");
  expect(pickRoundRobinAccount("mode-change", ["a", "b"], 1, weights)).toBe("b");
  seedPoolRotationAccount("mode-change", "a");
  expect(peekRoundRobinAccount("mode-change", ["a", "b"], 1, weights)).toBe("a");
  expect(pickRoundRobinAccount("mode-change", ["a", "b"], 1, weights)).toBe("a");
});

describe("quota-weighted transitions", () => {
  test("continuously updated known quota keeps an unknown account's probe share", () => {
    const picks = Array.from({ length: 500 }, (_, i) => pickRoundRobinAccount("continuous", ["a", "b"], 1,
      new Map([["a", 75 - i / 100], ["b", 1]])));
    expect(picks.filter(id => id === "b").length).toBeGreaterThanOrEqual(6);
    expect(picks.filter(id => id === "b").length).toBeLessThanOrEqual(8);
  });

  test("an invalidated manual seed cannot preserve an automatic sticky account on a mode change", () => {
    seedPoolRotationAccount("failed-seed", "a");
    notePoolRotationFailure("failed-seed", "a");
    expect(pickRoundRobinAccount("failed-seed", ["a", "b"], 10)).toBe("a");
    notePoolRotationSuccess("failed-seed", "a", 10);
    expect(pickRoundRobinAccount("failed-seed", ["a", "b"], 1, new Map([["a", 0], ["b", 1]]))).toBe("b");
  });

  test("a generation sweep retires a removed seed before ordinary sticky allocation", () => {
    seedPoolRotationAccount("codex", "gone");
    reconcilePoolRotationState({ generation: 90_000_001, providerNames: new Set(), comboIds: new Set(), comboTargets: new Set(),
      codexAccountIds: new Set(["a", "b"]), oauthAccountKeys: new Set(), configRoots: new Set() });
    expect(pickRoundRobinAccount("codex", ["a", "b"], 10)).toBe("a");
    notePoolRotationSuccess("codex", "a", 10);
    expect(pickRoundRobinAccount("codex", ["a", "b"], 1, new Map([["a", 0], ["b", 1]]))).toBe("b");
  });

  test("a fully spent priority tier cannot hide healthy accounts with the threshold disabled", () => {
    config.autoSwitchThreshold = 0;
    config.codexAccountPriorities = { a: 10, b: 0 };
    setAccountQuotaFromParsed("a", { weeklyPercent: 100 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    expect(previewCodexAccountForRequest("spent-tier", config)).toBe("b");
    expect(resolveCodexAccountForThread("spent-tier", config)).toBe("b");
  });

  test("75:1 debt is discarded when the unknown account becomes a zero-weight candidate", () => {
    const pool = "transition";
    for (let i = 0; i < 38; i++) pickRoundRobinAccount(pool, ["a", "b"], 1, new Map([["a", 75], ["b", 1]]));
    const known = new Map([["a", 1], ["b", 0]]);
    for (let i = 0; i < 40; i++) {
      expect(peekRoundRobinAccount(pool, ["a", "b"], 1, known)).toBe("a");
      expect(pickRoundRobinAccount(pool, ["a", "b"], 1, known)).toBe("a");
    }
  });

  test("zero weights never win automatic allocation, including an all-zero map", () => {
    const weights = new Map([["a", 0], ["b", 1]]);
    for (let i = 0; i < 4; i++) expect(pickRoundRobinAccount("zeros", ["a", "b"], 1, weights)).toBe("b");
    const empty = new Map([["a", 0], ["b", 0]]);
    expect(peekRoundRobinAccount("zeros", ["a", "b"], 1, empty)).toBeNull();
    expect(pickRoundRobinAccount("zeros", ["a", "b"], 1, empty)).toBeNull();
  });

  test("removing and restoring a candidate starts with current weights instead of banked debt", () => {
    const weights = new Map([["a", 75], ["b", 1]]);
    for (let i = 0; i < 38; i++) pickRoundRobinAccount("recovery", ["a", "b"], 1, weights);
    expect(pickRoundRobinAccount("recovery", ["b"], 1, weights)).toBe("b");
    expect(peekRoundRobinAccount("recovery", ["a", "b"], 1, weights)).toBe("a");
    expect(pickRoundRobinAccount("recovery", ["a", "b"], 1, weights)).toBe("a");
  });

  test("preview across a weight change does not reset the live allocation sequence", () => {
    const original = new Map([["a", 3], ["b", 1]]);
    expect(pickRoundRobinAccount("preview-change", ["a", "b"], 1, original)).toBe("a");
    for (let i = 0; i < 3; i++) expect(peekRoundRobinAccount("preview-change", ["a", "b"], 1,
      new Map([["a", 0], ["b", 1]]))).toBe("b");
    expect(pickRoundRobinAccount("preview-change", ["a", "b"], 1, original)).toBe("a");
    expect(pickRoundRobinAccount("preview-change", ["a", "b"], 1, original)).toBe("b");
  });

  test("an empty candidate interval clears debt and a mutated weight map is observed", () => {
    const weights = new Map([["a", 75], ["b", 1]]);
    for (let i = 0; i < 38; i++) pickRoundRobinAccount("empty", ["a", "b"], 1, weights);
    expect(pickRoundRobinAccount("empty", [], 1, weights)).toBeNull();
    expect(pickRoundRobinAccount("empty", ["a", "b"], 1, weights)).toBe("a");
    weights.set("a", 0); weights.set("b", 1);
    expect(pickRoundRobinAccount("empty", ["a", "b"], 1, weights)).toBe("b");
  });

  test("weight changes preserve manual seeds but switching back restores ordinary RR", () => {
    const ids = ["a", "b"];
    pickRoundRobinAccount("manual-change", ids, 1, new Map([["a", 75], ["b", 1]]));
    seedPoolRotationAccount("manual-change", "b");
    const known = new Map([["a", 1], ["b", 0]]);
    expect(peekRoundRobinAccount("manual-change", ids, 1, known)).toBe("b");
    expect(pickRoundRobinAccount("manual-change", ids, 1, known)).toBe("b");
    // The routing caller records each committed new-session bind.
    notePoolRotationSuccess("manual-change", "b", 1);
    expect(pickRoundRobinAccount("manual-change", ids, 1, known)).toBe("a");
    expect(pickRoundRobinAccount("manual-change", ids, 1)).toBe("a");
    expect(pickRoundRobinAccount("manual-change", ids, 1)).toBe("b");
  });

  test.each([75, 0])("unknown becomes known at %s%% usage and immediately follows the highest score", usage => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 25 });
    for (let i = 0; i < 38; i++) resolveCodexAccountForThread(`unknown-${i}`, config);
    setAccountQuotaFromParsed("b", { weeklyPercent: usage });
    const expected = usage === 0 ? "b" : "a";
    for (let i = 0; i < 8; i++) {
      expect(previewCodexAccountForRequest(`known-${i}`, config)).toBe(expected);
      expect(resolveCodexAccountForThread(`known-${i}`, config)).toBe(expected);
    }
    setAccountQuotaFromParsed(expected, { weeklyPercent: 70 });
    setAccountQuotaFromParsed(expected === "a" ? "b" : "a", { weeklyPercent: 10 });
    expect(resolveCodexAccountForThread("new-leader", config)).toBe(expected === "a" ? "b" : "a");
  });

  test("a restored candidate immediately rejoins its current dominant tier", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 25 });
    for (let i = 0; i < 38; i++) resolveCodexAccountForThread(`recover-probe-${i}`, config);
    config.pausedCodexAccountIds = ["a"];
    expect(resolveCodexAccountForThread("a-paused", config)).toBe("b");
    setAccountQuotaFromParsed("b", { weeklyPercent: 70 });
    config.pausedCodexAccountIds = [];
    expect(previewCodexAccountForRequest("a-restored", config)).toBe("a");
    expect(resolveCodexAccountForThread("a-restored", config)).toBe("a");
  });
});
