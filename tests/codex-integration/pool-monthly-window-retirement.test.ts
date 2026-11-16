import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePoolQuotaWriter, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { commitPoolQuotaResponse } from "../../src/codex/auth-api/pool-quota-probe";
import { resetCodexCreditsForTests } from "../../src/codex/credits";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import {
  applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, getMainPolicyQuota, isCodexQuotaExhausted,
  parseMainPolicyUsageQuota, parseUsageQuota, poolWhamPolicyObservation, setAccountQuotaFromParsed, settleQuotaPersistenceForTests,
  type WhamUsageResponse,
} from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8067: a pool account that moved from a monthly-primary plan (Free) to a weekly plan
// (Pro Lite) kept the old exhausted monthly tuple forever and was never selected.
const accountId = "monthly-retire-pool";
let testDir: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let originalFetch: typeof fetch;

function savePool() {
  saveCodexAccountCredential(accountId, {
    accessToken: "fixture-pool-bearer", refreshToken: "fixture-pool-refresh",
    chatgptAccountId: "fixture-pool-identity", expiresAt: Date.now() + 3_600_000,
  });
}
function poolContext() {
  const record = readCodexAccountRecord(accountId)!;
  return { accountId, existing: null, configuredPlan: undefined,
    generation: record.generation, writerGeneration: captureConfigGeneration(),
    poolWriter: capturePoolQuotaWriter(accountId, { ...record.credential!, generation: record.generation }),
  };
}

const now = () => Math.floor(Date.now() / 1000);
const monthly = (used_percent = 100) => ({ used_percent, limit_window_seconds: 2_592_000, reset_at: now() + 2_592_000 });
const weekly = (used_percent = 0) => ({ used_percent, limit_window_seconds: 604_800, reset_at: now() + 604_800 });
const observe = (plan_type: string, rate_limit: Record<string, unknown>) => Response.json({ plan_type, rate_limit });
const freeExhausted = () => observe("free", { allowed: false, primary_window: monthly(), secondary_window: null });
const proLite = (extra: Record<string, unknown> = {}) =>
  observe("prolite", { allowed: true, primary_window: weekly(), secondary_window: null, ...extra });

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  originalFetch = globalThis.fetch;
  testDir = mkdtempSync(join(tmpdir(), "ocx-monthly-retire-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = join(testDir, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  globalThis.fetch = (async () => { throw new Error("unexpected fixture network request"); }) as typeof fetch;
  clearAccountQuota();
  clearMainAccountInfoCache();
  resetLifecycleDrainStateForTests();
  resetCodexCreditsForTests();
  resetQuotaQueryBackoffForTests();
});
afterEach(() => {
  clearAccountQuota();
  clearMainAccountInfoCache();
  resetLifecycleDrainStateForTests();
  resetCodexCreditsForTests();
  resetQuotaQueryBackoffForTests();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(testDir);
});

describe("pool WHAM monthly-window retirement (#8067)", () => {
  test("a complete weekly-only probe after a plan change retires the carried monthly tuple", async () => {
    savePool();
    const ctx = poolContext();
    const before = await commitPoolQuotaResponse(freeExhausted(), ctx);
    expect(before.quota?.monthlyPercent).toBe(100);
    expect(before.quota?.monthlyIsPrimaryWindow).toBe(true);

    const after = await commitPoolQuotaResponse(proLite(), ctx);
    expect(after.quota?.weeklyPercent).toBe(0);
    expect(after.quota?.monthlyPercent).toBeUndefined();
    expect(after.quota?.monthlyResetAt).toBeUndefined();
    expect(after.quota?.monthlyIsPrimaryWindow).toBeUndefined();
    expect(isCodexQuotaExhausted(getAccountQuota(accountId), "prolite")).toBe(false);
    expect(getAccountQuota(accountId)).not.toHaveProperty("monthlyWindowAbsent");
  });

  test("a present tertiary window replaces the monthly reading instead of retiring it", async () => {
    savePool();
    const ctx = poolContext();
    await commitPoolQuotaResponse(freeExhausted(), ctx);
    const result = await commitPoolQuotaResponse(proLite({ tertiary_window: monthly(40) }), ctx);
    expect(result.quota?.monthlyPercent).toBe(40);
  });

  test("partial, denied, header-only and writerless observations keep the carried tuple", async () => {
    savePool();
    const ctx = poolContext();
    await commitPoolQuotaResponse(freeExhausted(), ctx);
    const partial = await commitPoolQuotaResponse(Response.json({ plan_type: "prolite", rate_limit: { primary_window: weekly() } }), ctx);
    expect(partial.quota?.monthlyPercent).toBe(100);
    const denied = await commitPoolQuotaResponse(observe("prolite", {
      allowed: false, primary_window: weekly(), secondary_window: null, tertiary_window: null,
    }), ctx);
    expect(denied.quota?.monthlyPercent).toBe(100);
    applyAccountQuotaFromUpstreamHeaders(accountId, new Headers({
      "x-codex-primary-used-percent": "0", "x-codex-primary-window-minutes": "10080",
    }));
    expect(getAccountQuota(accountId)?.monthlyPercent).toBe(100);
    const writerless = await commitPoolQuotaResponse(proLite(), { ...ctx, poolWriter: undefined });
    expect(writerless.quota?.monthlyPercent).toBe(100);
    const otherAccount = await commitPoolQuotaResponse(proLite(), { ...ctx, poolWriter: { ...ctx.poolWriter!, accountId: "other-pool" } });
    expect(otherAccount.quota?.monthlyPercent).toBe(100);
  });

  test("policy evidence marks monthly absence only when no window is monthly", () => {
    const evidence = (data: WhamUsageResponse) => poolWhamPolicyObservation(data, parseUsageQuota(data));
    const weeklyOnly = { plan_type: "prolite", rate_limit: { allowed: true, primary_window: weekly(), secondary_window: null } };
    expect(evidence(weeklyOnly)?.monthlyWindowAbsent).toBe(true);
    expect(evidence({ ...weeklyOnly, rate_limit: { ...weeklyOnly.rate_limit, tertiary_window: monthly(5) } })?.monthlyWindowAbsent).toBeUndefined();
    expect(evidence({ plan_type: "team", rate_limit: { allowed: true, primary_window: monthly(5), secondary_window: weekly() } })?.monthlyWindowAbsent).toBeUndefined();
    expect(evidence({ plan_type: "prolite", rate_limit: { primary_window: weekly() } })?.monthlyWindowAbsent).toBeUndefined();
  });
});

describe("main WHAM monthly-window retirement (#8596)", () => {
  const mainIdentity = "monthly-retire-main-fixture";
  const publish = (data: WhamUsageResponse) => setAccountQuotaFromParsed(MAIN, parseUsageQuota(data), undefined,
    captureMainQuotaWriter(mainIdentity), parseMainPolicyUsageQuota(data));
  const caches = () => [getAccountQuota(MAIN), getMainPolicyQuota()];

  test("an explicit denial with null secondary and tertiary keeps the monthly tuple in both caches", () => {
    observeMainQuotaIdentity(mainIdentity);
    publish({ plan_type: "free", rate_limit: { allowed: false, primary_window: monthly(), secondary_window: null } });
    for (const quota of caches()) expect(quota?.monthlyPercent).toBe(100);
    const denied = { plan_type: "prolite", rate_limit: {
      allowed: false, primary_window: weekly(), secondary_window: null, tertiary_window: null,
    } };
    expect(parseMainPolicyUsageQuota(denied)?.monthlyWindowAbsent).toBeUndefined();
    publish(denied);
    for (const quota of caches()) {
      expect(quota?.monthlyPercent).toBe(100);
      expect(quota?.monthlyIsPrimaryWindow).toBe(true);
    }
    expect(isCodexQuotaExhausted(getAccountQuota(MAIN), "prolite")).toBe(true);
  });

  test("an allowed snapshot with a malformed additional window keeps the monthly tuple", () => {
    observeMainQuotaIdentity(mainIdentity);
    publish({ plan_type: "free", rate_limit: { allowed: false, primary_window: monthly(), secondary_window: null } });
    const malformed = { plan_type: "prolite", rate_limit: { allowed: true, primary_window: weekly(), secondary_window: null },
      additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 101, limit_window_seconds: 604_800 } } }] };
    expect(parseMainPolicyUsageQuota(malformed)).not.toHaveProperty("monthlyWindowAbsent");
    publish(malformed);
    for (const quota of caches()) expect(quota?.monthlyPercent).toBe(100);
    expect(isCodexQuotaExhausted(getAccountQuota(MAIN), "prolite")).toBe(true);
  });

  // The #8596 payload: Plus, weekly primary, secondary_window null and no tertiary key at all.
  const plusWeeklyOnly = (rate: Record<string, unknown> = {}) => ({ plan_type: "plus",
    rate_limit: { allowed: true, limit_reached: false, primary_window: weekly(1), secondary_window: null, ...rate } });
  const exhaustMonthly = () => publish({ plan_type: "free", rate_limit: { allowed: false, primary_window: monthly(), secondary_window: null } });

  test("a complete allowed weekly-only read retires the carried monthly tuple in both caches", () => {
    observeMainQuotaIdentity(mainIdentity);
    exhaustMonthly();
    expect(isCodexQuotaExhausted(getAccountQuota(MAIN), "plus")).toBe(true);
    expect(parseMainPolicyUsageQuota(plusWeeklyOnly())?.monthlyWindowAbsent).toBe(true);
    publish(plusWeeklyOnly());
    for (const quota of caches()) {
      expect(quota?.weeklyPercent).toBe(1);
      expect(quota?.monthlyPercent).toBeUndefined();
      expect(quota?.monthlyResetAt).toBeUndefined();
      expect(quota?.monthlyIsPrimaryWindow).toBeUndefined();
      expect(quota).not.toHaveProperty("monthlyWindowAbsent");
    }
    expect(isCodexQuotaExhausted(getAccountQuota(MAIN), "plus")).toBe(false);
    // An explicit null tertiary is the same complete topology.
    exhaustMonthly();
    publish(plusWeeklyOnly({ tertiary_window: null }));
    for (const quota of caches()) expect(quota?.monthlyPercent).toBeUndefined();
  });

  test("a present monthly window replaces the reading instead of retiring it", () => {
    observeMainQuotaIdentity(mainIdentity);
    exhaustMonthly();
    publish(plusWeeklyOnly({ tertiary_window: monthly(40) }));
    expect(getAccountQuota(MAIN)?.monthlyPercent).toBe(40);
    exhaustMonthly();
    publish({ plan_type: "free", rate_limit: { allowed: true, primary_window: monthly(30), secondary_window: null } });
    for (const quota of caches()) {
      expect(quota?.monthlyPercent).toBe(30);
      expect(quota?.monthlyIsPrimaryWindow).toBe(true);
    }
    // A genuine monthly-primary plan with a weekly secondary (Team) keeps its monthly reading.
    publish({ plan_type: "team", rate_limit: { allowed: true, primary_window: monthly(5), secondary_window: weekly(2) } });
    expect(parseMainPolicyUsageQuota({ plan_type: "team", rate_limit: { allowed: true, primary_window: monthly(5), secondary_window: weekly(2) } })
      ?.monthlyWindowAbsent).toBeUndefined();
    for (const quota of caches()) expect(quota?.monthlyPercent).toBe(5);
  });

  test("partial, invalid, header-only and writerless main reads keep the carried tuple", () => {
    observeMainQuotaIdentity(mainIdentity);
    exhaustMonthly();
    publish({ plan_type: "plus", rate_limit: { primary_window: weekly(1) } });
    for (const quota of caches()) expect(quota?.monthlyPercent).toBe(100);
    publish({ plan_type: "plus", rate_limit: { primary_window: weekly(1), secondary_window: null } });
    for (const quota of caches()) expect(quota?.monthlyPercent).toBe(100);
    publish(plusWeeklyOnly({ primary_window: { ...weekly(), used_percent: -1 } }));
    for (const quota of caches()) expect(quota?.monthlyPercent).toBe(100);
    publish(plusWeeklyOnly({ primary_window: { ...weekly(), used_percent: "n/a" } }));
    for (const quota of caches()) expect(quota?.monthlyPercent).toBe(100);
    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-primary-used-percent": "1", "x-codex-primary-window-minutes": "10080",
    }));
    expect(getAccountQuota(MAIN)?.monthlyPercent).toBe(100);
    const data = plusWeeklyOnly();
    setAccountQuotaFromParsed(MAIN, parseUsageQuota(data), undefined, undefined, parseMainPolicyUsageQuota(data));
    expect(getAccountQuota(MAIN)?.monthlyPercent).toBe(100);
    expect(isCodexQuotaExhausted(getAccountQuota(MAIN), "plus")).toBe(true);
  });
});


describe("main monthly retirement survives saves, restarts and stale writers (#8596)", () => {
  const identityA = "monthly-retire-main-a";
  const identityB = "monthly-retire-main-b";
  const exhausted = { plan_type: "free", rate_limit: { allowed: false, primary_window: monthly(), secondary_window: null } };
  const weeklyOnly = { plan_type: "plus", rate_limit: { allowed: true, primary_window: weekly(1), secondary_window: null } };
  const publishWith = (writer: ReturnType<typeof captureMainQuotaWriter>, data: WhamUsageResponse) =>
    setAccountQuotaFromParsed(MAIN, parseUsageQuota(data), undefined, writer, parseMainPolicyUsageQuota(data));
  const writerFor = (identity: string) => {
    observeMainQuotaIdentity(identity);
    const writer = captureMainQuotaWriter(identity);
    if (!writer) throw new Error("Expected an observed main quota writer");
    return writer;
  };
  const monthlyFields = (quota: Record<string, unknown> | null | undefined) =>
    ["monthlyPercent", "monthlyResetAt", "monthlyIsPrimaryWindow", "monthlyWindowAbsent"].filter(key => quota?.[key] !== undefined);

  // Capture quota's debounced persistence callback so the real serializer runs without a sleep.
  let pendingPersist: { run: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let timerSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    const nativeSetTimeout = globalThis.setTimeout;
    pendingPersist = undefined;
    timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]
    ) => {
      if (delay !== 250) return nativeSetTimeout(callback, delay, ...args);
      const timer = nativeSetTimeout(() => {}, 60_000);
      pendingPersist = { run: () => callback(...args), timer };
      return timer;
    }) as typeof setTimeout);
  });
  afterEach(() => {
    if (pendingPersist) clearTimeout(pendingPersist.timer);
    pendingPersist = undefined;
    timerSpy.mockRestore();
  });
  async function flushPersistence(): Promise<{ quotas: Record<string, Record<string, unknown>>; mainPolicyQuota?: { quota: Record<string, unknown> } }> {
    if (!pendingPersist) throw new Error("Expected a scheduled quota persistence");
    const pending = pendingPersist;
    pendingPersist = undefined;
    clearTimeout(pending.timer);
    pending.run();
    await settleQuotaPersistenceForTests();
    return JSON.parse(readFileSync(join(testDir, "codex-quota-cache.json"), "utf8"));
  }

  test("the retirement is saved for both caches and a restart does not bring the tuple back", async () => {
    const writer = writerFor(identityA);
    publishWith(writer, exhausted);
    const before = await flushPersistence();
    expect(before.quotas[MAIN].monthlyPercent).toBe(100);
    expect(before.mainPolicyQuota?.quota.monthlyPercent).toBe(100);
    publishWith(writer, weeklyOnly);
    const saved = await flushPersistence();
    expect(monthlyFields(saved.quotas[MAIN])).toEqual([]);
    expect(monthlyFields(saved.mainPolicyQuota?.quota)).toEqual([]);
    expect(saved.quotas[MAIN].weeklyPercent).toBe(1);
    // Restart: drop the process state, then hydrate from exactly the saved bytes.
    const bytes = readFileSync(join(testDir, "codex-quota-cache.json"), "utf8");
    clearAccountQuota();
    writeFileSync(join(testDir, "codex-quota-cache.json"), bytes);
    observeMainQuotaIdentity(identityA);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(1);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(1);
    for (const quota of [getAccountQuota(MAIN), getMainPolicyQuota()]) expect(monthlyFields(quota as never)).toEqual([]);
    expect(isCodexQuotaExhausted(getAccountQuota(MAIN), "plus")).toBe(false);
  });

  test("later partial, header-only and credits-only saves cannot reintroduce the retired tuple", async () => {
    const writer = writerFor(identityA);
    publishWith(writer, exhausted);
    publishWith(writer, weeklyOnly);
    await flushPersistence();
    publishWith(writer, { plan_type: "plus", rate_limit: { primary_window: weekly(2) } });
    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-primary-used-percent": "3", "x-codex-primary-window-minutes": "10080",
    }));
    setAccountQuotaFromParsed(MAIN, { resetCredits: 0 }, undefined, writer);
    const saved = await flushPersistence();
    expect(monthlyFields(saved.quotas[MAIN])).toEqual([]);
    expect(monthlyFields(saved.mainPolicyQuota?.quota)).toEqual([]);
    for (const quota of [getAccountQuota(MAIN), getMainPolicyQuota()]) expect(monthlyFields(quota as never)).toEqual([]);
    expect(isCodexQuotaExhausted(getAccountQuota(MAIN), "plus")).toBe(false);
  });

  test("a stale-identity writer can neither retire the tuple nor restore it after a live retirement", async () => {
    const stale = writerFor(identityA);
    publishWith(stale, exhausted);
    // A -> B -> A: the writer captured before the transition is no longer live.
    writerFor(identityB);
    const live = writerFor(identityA);
    publishWith(live, exhausted);
    publishWith(stale, weeklyOnly);
    for (const quota of [getAccountQuota(MAIN), getMainPolicyQuota()]) expect(quota?.monthlyPercent).toBe(100);
    expect(isCodexQuotaExhausted(getAccountQuota(MAIN), "plus")).toBe(true);
    publishWith(live, weeklyOnly);
    for (const quota of [getAccountQuota(MAIN), getMainPolicyQuota()]) expect(quota?.monthlyPercent).toBeUndefined();
    // A delayed commit of the old exhausted reading from the stale writer is refused.
    publishWith(stale, exhausted);
    for (const quota of [getAccountQuota(MAIN), getMainPolicyQuota()]) expect(monthlyFields(quota as never)).toEqual([]);
    const saved = await flushPersistence();
    expect(monthlyFields(saved.quotas[MAIN])).toEqual([]);
    expect(monthlyFields(saved.mainPolicyQuota?.quota)).toEqual([]);
  });
});
