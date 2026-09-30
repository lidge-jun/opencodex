import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import {
  applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getMainPolicyQuota,
  parseMainPolicyUsageQuota, parseUsageQuota, setAccountQuotaFromParsed, type WhamUsageResponse,
} from "../../src/codex/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const account = "retirement-main-fixture";
const weekly = { used_percent: 0, limit_window_seconds: 604_800 };
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-main-retirement-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota();
  clearMainAccountInfoCache();
  observeMainQuotaIdentity(account);
  const writer = captureMainQuotaWriter(account)!;
  const old = Date.now() - 19 * 24 * 60 * 60_000;
  writeFileSync(join(home, "codex-quota-cache.json"), JSON.stringify({ version: 1, quotas: {},
    mainPolicyQuota: { identityKey: writer.identityKey, quota: {
      shortPercent: 100, shortObservedAt: old, shortResetAt: old / 1000 + 18_000,
      shortWindowSeconds: 18_000, weeklyPercent: 0, updatedAt: old,
    } },
  }));
  expect(getMainAccountHardLockStatus({}).state).toBe("blocked");
});

afterEach(() => {
  clearAccountQuota();
  clearMainAccountInfoCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

/** Exercise the production display/policy projections with one captured live identity writer. */
function publish(data: WhamUsageResponse): void {
  setAccountQuotaFromParsed(MAIN, parseUsageQuota(data), undefined,
    captureMainQuotaWriter(account), parseMainPolicyUsageQuota(data));
}

describe("authoritative main 5h window retirement (#6244)", () => {
  test.each([0, 35, 97.99, 98, 100])("explicit absent primary retires old 5h while weekly %s still governs", percent => {
    publish({ rate_limit: {
      primary_window: null, secondary_window: { ...weekly, used_percent: percent }, tertiary_window: null,
    } });
    const policy = getMainPolicyQuota();
    expect(policy?.weeklyPercent).toBe(percent);
    for (const field of ["shortPercent", "shortObservedAt", "shortResetAt", "shortWindowSeconds"] as const) {
      expect(policy?.[field]).toBeUndefined();
    }
    expect(policy).not.toHaveProperty("shortWindowAbsent");
    expect(getMainAccountHardLockStatus({}).state).toBe(percent < 98 ? "ready" : "blocked");
  });

  test.each<WhamUsageResponse>([
    { rate_limit: { secondary_window: weekly, tertiary_window: null } },
    { rate_limit: { primary_window: null, secondary_window: weekly } },
    { rate_limit: { primary_window: null, secondary_window: {}, tertiary_window: null } },
    { rate_limit: { primary_window: {}, secondary_window: weekly, tertiary_window: null } },
    { rate_limit: { primary_window: null, secondary_window: { used_percent: 0 }, tertiary_window: null } },
    { rate_limit: { primary_window: null, secondary_window: { ...weekly, used_percent: 101 }, tertiary_window: null } },
    { rate_limit: { primary_window: null, secondary_window: { ...weekly, used_percent: -1 }, tertiary_window: null } },
    { rate_limit: { primary_window: null, secondary_window: { ...weekly, used_percent: NaN }, tertiary_window: null } },
    { rate_limit: { primary_window: null, secondary_window: weekly, tertiary_window: { limit_window_seconds: 2_592_000 } } },
    { rate_limit: { primary_window: null, secondary_window: weekly,
      tertiary_window: { used_percent: 0, limit_window_seconds: 18_000 } } },
    { rate_limit: { primary_window: { limit_window_seconds: 18_000 }, secondary_window: weekly, tertiary_window: null } },
    { rate_limit: { primary_window: null, secondary_window: null, tertiary_window: null },
      rate_limit_reset_credits: { available_count: 2 } },
    { rate_limit_reset_credits: { available_count: 2 } },
  ])("partial or unreadable observation cannot retire 19-day blocking evidence: %j", data => {
    const before = getMainPolicyQuota()!;
    expect(parseMainPolicyUsageQuota(data)?.shortWindowAbsent).toBeUndefined();
    publish(data);
    expect(getMainPolicyQuota()).toMatchObject({
      shortPercent: 100, shortObservedAt: before.shortObservedAt,
      shortResetAt: before.shortResetAt, shortWindowSeconds: 18_000,
    });
    expect(getMainAccountHardLockStatus({}).state).toBe("blocked");
  });

  test.each(["go", "free"])("%s tertiary-only monthly usage cannot prove governing recovery", plan_type => {
    const data = { plan_type, rate_limit: { primary_window: null, secondary_window: null,
      tertiary_window: { used_percent: 0, limit_window_seconds: 2_592_000 } } };
    expect(parseMainPolicyUsageQuota(data)?.shortWindowAbsent).toBeUndefined();
    publish(data);
    expect(getMainAccountHardLockStatus({}).state).toBe("blocked");
  });

  test("weekly headers and elapsed reset clocks retain the old short block", () => {
    const before = getMainPolicyQuota()!;
    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-secondary-used-percent": "0", "x-codex-secondary-window-minutes": "10080",
    }), undefined, captureMainQuotaWriter(account));
    expect(getMainPolicyQuota()?.shortObservedAt).toBe(before.shortObservedAt);
    expect(getMainAccountHardLockStatus({}, Date.now() + 30 * 24 * 60 * 60_000).state).toBe("blocked");
  });

  test("a stale identity writer cannot publish otherwise authoritative absence", () => {
    const staleWriter = captureMainQuotaWriter(account)!;
    clearMainAccountInfoCache();
    observeMainQuotaIdentity(account);
    const data = { rate_limit: { primary_window: null, secondary_window: weekly, tertiary_window: null } };
    setAccountQuotaFromParsed(MAIN, parseUsageQuota(data), undefined, staleWriter, parseMainPolicyUsageQuota(data));
    expect(getMainPolicyQuota()?.shortPercent).toBe(100);
    expect(getMainAccountHardLockStatus({}).state).toBe("blocked");
  });

  test("fresh lower short usage releases and the next blocking reading rearms", () => {
    publish({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18_000 } } });
    expect(getMainAccountHardLockStatus({}).state).toBe("ready");
    publish({ rate_limit: { primary_window: { used_percent: 98, limit_window_seconds: 18_000 } } });
    expect(getMainAccountHardLockStatus({}).state).toBe("blocked");
  });
});
