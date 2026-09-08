import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import {
  applyConfirmedMainCodexAccountTransition,
  reconcileMainCodexAccountRuntimeState,
  resetMainCodexAccountIdentityTrackingForTests,
} from "../../src/codex/account-lifecycle";
import * as authCollision from "../../src/codex/auth-collision";
import {
  captureMainQuotaWriter,
  clearMainAccountInfoCache,
  getObservedMainQuotaIdentityKey,
  isMainQuotaWriterLive,
  matchesMainQuotaCredential,
  observeMainQuotaCredential,
  observeMainQuotaIdentity,
  type MainQuotaWriter,
} from "../../src/codex/main-account-cache";
import {
  applyAccountQuotaFromUpstreamHeaders,
  clearAccountQuota,
  getAccountQuota,
  getMainPolicyQuota,
  listAccountQuotas,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
  type StoredAccountQuota,
} from "../../src/codex/quota";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

let testDir: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let pendingPersist: { run: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
let timerSpy: ReturnType<typeof installPersistenceClock>;

// Exercise the real debounced serializer deterministically, without sleeping or exporting
// a production flush hook. Only quota's 250ms timeout is captured; all others stay native.
function installPersistenceClock() {
  const nativeSetTimeout = globalThis.setTimeout;
  return spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]
  ) => {
    if (delay !== 250) return nativeSetTimeout(callback, delay, ...args);
    const timer = nativeSetTimeout(() => {}, 60_000);
    pendingPersist = { run: () => callback(...args), timer };
    return timer;
  }) as typeof setTimeout);
}

function flushPersistence(): string {
  if (!pendingPersist) throw new Error("Expected a scheduled quota persistence");
  const pending = pendingPersist;
  pendingPersist = undefined;
  clearTimeout(pending.timer);
  pending.run();
  return readFileSync(join(testDir, "codex-quota-cache.json"), "utf8");
}

function writerFor(accountId = "fixture-main-a"): MainQuotaWriter {
  observeMainQuotaIdentity(accountId);
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("Expected an observed main quota writer");
  return writer;
}

function writeSnapshot(value: unknown): void {
  writeFileSync(join(testDir, "codex-quota-cache.json"), JSON.stringify(value));
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-main-provenance-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  clearMainAccountInfoCache();
  observeMainQuotaIdentity("fixture-unobserved-for-this-test");
  pendingPersist = undefined;
  timerSpy = installPersistenceClock();
});

afterEach(() => {
  if (pendingPersist) clearTimeout(pendingPersist.timer);
  pendingPersist = undefined;
  clearAccountQuota();
  clearMainAccountInfoCache();
  timerSpy.mockRestore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(testDir);
});

describe("main quota credential provenance", () => {
  test("credential observation cannot establish or switch physical identity", () => {
    const writer = writerFor();
    expect(observeMainQuotaCredential("fixture-bearer-b", "fixture-main-b")).toBeUndefined();
    expect(captureMainQuotaWriter("fixture-main-b")).toBeUndefined();
    expect(getObservedMainQuotaIdentityKey()).toBe(writer.identityKey);
    expect(observeMainQuotaCredential("", "fixture-main-a")).toBeUndefined();
  });

  test("credential equality requires exact bearer, effective workspace, and live generation", () => {
    const writer = writerFor();
    observeMainQuotaCredential("fixture-bearer-a", "fixture-main-a");
    expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a")).toBe(true);
    expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-b")).toBe(false);
    expect(matchesMainQuotaCredential("fixture-bearer-b", "fixture-main-a")).toBe(false);
    expect(matchesMainQuotaCredential("fixture-bearer-a", undefined)).toBe(false);
    observeMainQuotaIdentity("fixture-main-a");
    expect(isMainQuotaWriterLive(writer)).toBe(true);
    clearMainAccountInfoCache();
    expect(isMainQuotaWriterLive(writer)).toBe(false);
    expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a")).toBe(false);
    expect(getObservedMainQuotaIdentityKey()).toBe(writer.identityKey);
  });

  test("replacement owned token supersedes equality without changing account quota ownership", () => {
    const writer = writerFor();
    observeMainQuotaCredential("fixture-old-token", "fixture-main-a");
    observeMainQuotaCredential("fixture-new-token", "fixture-main-a");
    expect(matchesMainQuotaCredential("fixture-old-token", "fixture-main-a")).toBe(false);
    expect(matchesMainQuotaCredential("fixture-new-token", "fixture-main-a")).toBe(true);
    expect(isMainQuotaWriterLive(writer)).toBe(true);
  });

  test("policy lookup and equality matching never read physical auth", () => {
    const writer = writerFor();
    observeMainQuotaCredential("fixture-bearer-a", "fixture-main-a");
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    const physicalRead = spyOn(authCollision, "readCodexTokensResult").mockImplementation(() => {
      throw new Error("Physical auth read forbidden");
    });
    try {
      expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a")).toBe(true);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
      expect(physicalRead).not.toHaveBeenCalled();
    } finally {
      physicalRead.mockRestore();
    }
  });
});

describe("main policy quota writes", () => {
  test("legacy data remains public but cannot be blessed by a tagged credits-only write", () => {
    const writer = writerFor();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99, shortPercent: 100, resetCredits: 8 });
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { resetCredits: 2 }, undefined, writer);
    expect(getMainPolicyQuota()).toEqual({ resetCredits: 2, updatedAt: expect.any(Number) });
    expect(getAccountQuota(MAIN)).toMatchObject({ weeklyPercent: 99, shortPercent: 100, resetCredits: 2 });
  });

  test("different identity cannot inherit old windows and ABA writers are rejected", () => {
    const oldA = writerFor();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99, monthlyPercent: 100 }, undefined, oldA);
    const writerB = writerFor("fixture-main-b");
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { resetCredits: 1 }, undefined, writerB);
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
    const newA = writerFor();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 10 }, undefined, newA);
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 100 }, undefined, oldA);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(10);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(10);
    expect(isMainQuotaWriterLive(oldA)).toBe(false);
  });

  test("shared merger preserves partial fields, explicit zero, and monthly-only weekly clearing", () => {
    const writer = writerFor();
    setAccountQuotaFromParsed(MAIN, {
      weeklyPercent: 99, shortPercent: 98, shortWindowSeconds: 18_000, resetCredits: 4,
    }, undefined, writer);
    setAccountQuotaFromParsed(MAIN, { resetCredits: 0 }, undefined, writer);
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99, shortPercent: 98, resetCredits: 0 });
    setAccountQuotaFromParsed(MAIN, { monthlyPercent: 15, monthlyIsPrimaryWindow: true }, undefined, writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
    expect(getMainPolicyQuota()).toMatchObject({ monthlyPercent: 15, monthlyIsPrimaryWindow: true, shortPercent: 98 });
    expect(getAccountQuota(MAIN)).toEqual(getMainPolicyQuota());
  });

  test("tertiary-only monthly headers preserve weekly99 policy; monthly-primary can replace it", () => {
    const writer = writerFor();
    const enabled = { codexMainAccountHardLock: true };
    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-primary-used-percent": "99",
      "x-codex-primary-window-minutes": "10080",
    }), undefined, writer);
    expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");

    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-tertiary-used-percent": "5",
    }), undefined, writer);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBeUndefined();
    expect(getAccountQuota(MAIN)?.monthlyPercent).toBe(5);
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99 });
    expect(getMainPolicyQuota()?.monthlyPercent).toBeUndefined();
    expect(getMainPolicyQuota()?.monthlyIsPrimaryWindow).toBeUndefined();
    expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");

    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-primary-used-percent": "6",
      "x-codex-primary-window-minutes": "43200",
    }), undefined, writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
    expect(getMainPolicyQuota()).toMatchObject({ monthlyPercent: 6, monthlyIsPrimaryWindow: true });
    expect(getMainAccountHardLockStatus(enabled).state).toBe("ready");
  });

  for (const plan of ["go", "free"]) {
    for (const [weekly, monthly, state] of [[98, 99, "blocked"], [99, 20, "ready"]] as const) {
      test(`${plan} monthly-primary ${monthly} replaces same-owner weekly ${weekly}`, () => {
        const writer = writerFor();
        setAccountQuotaFromParsed(MAIN, parseUsageQuota({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: weekly, limit_window_seconds: 604_800 } },
        }), undefined, writer);
        expect(getMainPolicyQuota()?.weeklyPercent).toBe(weekly);
        const monthlyQuota = parseUsageQuota({
          plan_type: plan,
          rate_limit: { primary_window: { used_percent: monthly, limit_window_seconds: 2_592_000 } },
        });
        expect(monthlyQuota).toEqual({ monthlyPercent: monthly, monthlyIsPrimaryWindow: true });
        setAccountQuotaFromParsed(MAIN, monthlyQuota, undefined, writer);
        expect(getMainPolicyQuota()).toEqual({
          monthlyPercent: monthly, monthlyIsPrimaryWindow: true, updatedAt: expect.any(Number),
        });
        expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe(state);
      });
    }

    test(`${plan} supplementary monthly is not a monthly-primary replacement`, () => {
      const writer = writerFor();
      setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
      const monthlyQuota = parseUsageQuota({ plan_type: plan, rate_limit: {
        primary_window: { limit_window_seconds: 2_592_000 },
        tertiary_window: { used_percent: 20 },
      } });
      expect(monthlyQuota).toEqual({ monthlyPercent: 20 });
      setAccountQuotaFromParsed(MAIN, monthlyQuota, undefined, writer);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
      expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
    });
  }

  test("header writer carries provenance and untagged main writes invalidate it", () => {
    const writer = writerFor();
    const headers = new Headers({ "x-codex-primary-used-percent": "99" });
    applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    setAccountQuotaFromParsed("fixture-pool", { weeklyPercent: 7 });
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    applyAccountQuotaFromUpstreamHeaders(MAIN, headers);
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    updateAccountQuota(MAIN, 20);
    expect(getMainPolicyQuota()).toBeNull();
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(20);
    expect(JSON.parse(flushPersistence()).mainPolicyQuota).toBeUndefined();
  });

  test("public quota mutation and serializers cannot expose or mutate policy provenance", () => {
    const writer = writerFor();
    observeMainQuotaCredential("fixture-private-bearer", "fixture-main-a");
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    getAccountQuota(MAIN)!.weeklyPercent = 0;
    getMainPolicyQuota()!.weeklyPercent = 0;
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    const publicJson = JSON.stringify(Object.fromEntries(listAccountQuotas()));
    expect(publicJson).not.toContain("identityKey");
    const disk = flushPersistence();
    expect(disk).not.toContain("fixture-private-bearer");
    expect(disk).not.toContain("fixture-main-a");
    expect(disk).not.toContain("bearerHmac");
    expect(disk).not.toContain("identityGeneration");
    expect(Object.keys(JSON.parse(disk).mainPolicyQuota).sort()).toEqual(["identityKey", "quota"]);
  });
});

describe("main policy quota durability and lifecycle", () => {
  for (const resetAt of [undefined, 4_000_000_000]) {
    test(`restart beyond six hours retains ${resetAt ? "future-reset" : "missing-reset"} policy evidence only for observed A`, () => {
      const writer = writerFor();
      const quota: StoredAccountQuota = {
        weeklyPercent: 99, updatedAt: Date.now() - 7 * 60 * 60_000,
        ...(resetAt ? { weeklyResetAt: resetAt } : {}),
      };
      writeSnapshot({ version: 1, quotas: { [MAIN]: quota }, mainPolicyQuota: { identityKey: writer.identityKey, quota } });
      const script = `
        import { getAccountQuota, getMainPolicyQuota } from ${JSON.stringify(repoPath("src/codex/quota.ts"))};
        import { observeMainQuotaIdentity, matchesMainQuotaCredential } from ${JSON.stringify(repoPath("src/codex/main-account-cache.ts"))};
        const before = getMainPolicyQuota();
        observeMainQuotaIdentity("fixture-main-b");
        const other = getMainPolicyQuota();
        observeMainQuotaIdentity("fixture-main-a");
        console.log(JSON.stringify({ before, other, legacy: getAccountQuota("__main__"), policy: getMainPolicyQuota(),
          credentialMatches: matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a") }));
      `;
      // The fresh process is the restart oracle, including its module startup.
      // Probe 34053484372 retained all assertions and caught an identity-guard
      // mutation with this Windows budget; the previous 10s killed a healthy 12s delay.
      const child = Bun.spawnSync({
        cmd: [process.execPath, "--eval", script], cwd: repoRoot(), env: process.env,
        timeout: process.platform === "win32" ? SPAWN_BUDGET_MS - INTERNAL_DEADLINE_MS : 10_000,
      });
      expect(child.exitCode).toBe(0);
      const result = JSON.parse(child.stdout.toString());
      expect(result.before).toBeNull();
      expect(result.other).toBeNull();
      expect(result.legacy).toBeNull();
      expect(result.policy).toEqual(quota);
      expect(result.credentialMatches).toBe(false);
    }, SPAWN_BUDGET_MS);
  }

  test("unrelated persistence hydrates and retains policy after legacy TTL expiry", () => {
    const writer = writerFor();
    const quota = { weeklyPercent: 99, updatedAt: Date.now() - 7 * 60 * 60_000 };
    writeSnapshot({ version: 1, quotas: { [MAIN]: quota }, mainPolicyQuota: { identityKey: writer.identityKey, quota } });
    setAccountQuotaFromParsed("fixture-pool", { weeklyPercent: 12 });
    const saved = JSON.parse(flushPersistence());
    expect(saved.quotas[MAIN]).toBeUndefined();
    expect(saved.mainPolicyQuota.quota).toEqual(quota);
    expect(getMainPolicyQuota()).toEqual(quota);
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: false }).state).toBe("off");
    expect(getAccountQuota(MAIN)).toBeNull();
    setAccountQuotaFromParsed(MAIN, { resetCredits: 0 }, undefined, writer);
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99, resetCredits: 0 });
    expect(getAccountQuota(MAIN)).toEqual({ resetCredits: 0, updatedAt: expect.any(Number) });
    const afterCredits = JSON.parse(flushPersistence());
    expect(afterCredits.quotas[MAIN].weeklyPercent).toBeUndefined();
    expect(afterCredits.mainPolicyQuota.quota.weeklyPercent).toBe(99);
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
    clearAccountQuota("fixture-pool");
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    clearAccountQuota(MAIN);
    expect(getMainPolicyQuota()).toBeNull();
    expect(JSON.parse(flushPersistence()).mainPolicyQuota).toBeUndefined();
  });

  test("clear before first hydration cannot resurrect disk policy", () => {
    const writer = writerFor();
    writeSnapshot({ version: 1, quotas: {}, mainPolicyQuota: {
      identityKey: writer.identityKey, quota: { weeklyPercent: 99, updatedAt: Date.now() },
    } });
    clearAccountQuota(MAIN);
    expect(getMainPolicyQuota()).toBeNull();
  });

  test("legacy untagged disk quota remains untrusted after owned identity observation", () => {
    const writer = writerFor();
    writeSnapshot({ version: 1, quotas: { [MAIN]: { weeklyPercent: 99, updatedAt: Date.now() } } });
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { resetCredits: 1 }, undefined, writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
  });

  test("disk policy accepts only bounded known fields and valid owner keys", () => {
    const writer = writerFor();
    writeSnapshot({ version: 1, quotas: {}, mainPolicyQuota: { identityKey: writer.identityKey, quota: {
      weeklyPercent: 99, monthlyPercent: "100", shortPercent: null, shortResetAt: -1,
      updatedAt: 1, shortObservedAt: 1234, bearerHmac: "must-not-load", customWindows: [{ label: "untrusted", percent: 100 }],
    } } });
    expect(getMainPolicyQuota()).toEqual({ weeklyPercent: 99, shortObservedAt: 1234, updatedAt: 1 });
    clearAccountQuota();
    writeSnapshot({ version: 1, quotas: {}, mainPolicyQuota: {
      identityKey: "not-an-identity-key", quota: { weeklyPercent: 99, updatedAt: 1 },
    } });
    expect(getMainPolicyQuota()).toBeNull();
  });

  test("owned reconciliation publishes identity and confirmed transitions purge policy and equality", () => {
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({ tokens: {
      access_token: "fixture-bearer-a", account_id: "fixture-main-a",
    } }));
    expect(reconcileMainCodexAccountRuntimeState()).toBe(false);
    const writer = observeMainQuotaCredential("fixture-bearer-a", "fixture-main-a");
    expect(writer).toBeDefined();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    writeFileSync(join(testDir, "auth.json"), "{");
    expect(reconcileMainCodexAccountRuntimeState()).toBe(false);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    expect(applyConfirmedMainCodexAccountTransition("fixture-main-a", "fixture-main-b")).toBe(true);
    expect(captureMainQuotaWriter("fixture-main-b")).toBeDefined();
    expect(getMainPolicyQuota()).toBeNull();
    expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a")).toBe(false);
  });
});
