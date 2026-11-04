import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePoolQuotaWriter, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { commitPoolQuotaResponse } from "../../src/codex/auth-api/pool-quota-probe";
import { resetCodexCreditsForTests } from "../../src/codex/credits";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import {
  applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, getMainPolicyQuota, isCodexQuotaExhausted,
  parseMainPolicyUsageQuota, parseUsageQuota, poolWhamPolicyObservation, setAccountQuotaFromParsed, type WhamUsageResponse,
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

describe("main observations keep their monthly retention rules", () => {
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
});

