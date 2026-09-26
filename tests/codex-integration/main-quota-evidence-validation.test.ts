import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import {
  applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, getMainPolicyQuota, parseMainPolicyUsageQuota,
  parseUsageQuota, setAccountQuotaFromParsed, updateAccountQuota, type WhamUsageResponse,
} from "../../src/codex/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-main-evidence-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota();
  clearMainAccountInfoCache();
});

afterEach(() => {
  clearAccountQuota();
  clearMainAccountInfoCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

/** Observe a synthetic main identity and capture the live writer used to publish its fixture quota. */
function writerFor(accountId = "fixture-main-a") {
  observeMainQuotaIdentity(accountId);
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("Expected an observed main quota writer");
  return writer;
}

describe("raw policy evidence validation", () => {
  for (const slot of ["primary_window", "secondary_window", "tertiary_window"] as const) {
    test.each([
      -1, "-1", " -0.01 ", 101, "101", 100.01, " 100.01 ",
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      "NaN", "Infinity", "-Infinity", "1e400", "-1e400",
    ])(`${slot} rejects invalid numeric %s before clamping`, value => {
      // Simulate deserialized external data, including numbers JSON serialization would erase.
      const data = { rate_limit: {
        primary_window: { used_percent: 99 }, [slot]: { used_percent: value },
      } } as WhamUsageResponse;
      expect(parseMainPolicyUsageQuota(data)).toBeNull();
      if (slot === "primary_window" && Number.isFinite(Number(value))) {
        expect(parseUsageQuota(data)?.weeklyPercent).toBe(Number(value) < 0 ? 0 : 100);
      }
      const writer = writerFor();
      const publish = (input: WhamUsageResponse) => setAccountQuotaFromParsed(
        MAIN, parseUsageQuota(input), undefined, writer, parseMainPolicyUsageQuota(input),
      );
      const cfg = { codexMainAccountHardLock: true };
      publish(data);
      expect(getMainAccountHardLockStatus(cfg).state).toBe("unknown");
      publish({ rate_limit: { primary_window: { used_percent: 99 } } });
      const retained = getMainPolicyQuota();
      publish(data);
      expect(getMainPolicyQuota()).toEqual(retained);
      publish({ rate_limit: { primary_window: { used_percent: 0 } } });
      expect(getMainAccountHardLockStatus(cfg).state).toBe("ready");
      publish({ rate_limit: { primary_window: { used_percent: 99 } } });
      expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
    });
  }

  test.each([0, "0", -0, "-0", 98.99, "98.99", 99, "99", 100, "100"])("valid boundary %s remains policy evidence", value => {
    const data = { rate_limit: { primary_window: { used_percent: value } } } as WhamUsageResponse;
    expect(parseMainPolicyUsageQuota(data)).toEqual({ weeklyPercent: Number(value) === 0 ? 0 : Number(value) });
  });

  test.each([undefined, null, "", " ", "unreadable", "99oops"])("non-numeric %s preserves unknown short shape", value => {
    const data = { rate_limit: {
      primary_window: { used_percent: value, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 99 }, tertiary_window: { used_percent: 99 },
    } } as WhamUsageResponse;
    expect(parseMainPolicyUsageQuota(data)).toEqual({ shortWindowSeconds: 18_000, weeklyPercent: 99 });
  });

  test("unknown short shape and genuine zero preserve the canonical parser contract", () => {
    const data: WhamUsageResponse = { rate_limit: {
      primary_window: { limit_window_seconds: 18_000 }, secondary_window: { used_percent: 99 },
    } };
    expect(parseMainPolicyUsageQuota(data)).toEqual({ shortWindowSeconds: 18_000, weeklyPercent: 99 });
    expect(parseMainPolicyUsageQuota({ rate_limit: { primary_window: { used_percent: 0 } } }))
      .toEqual({ weeklyPercent: 0 });
  });

  test("additional Reserve/Spark buckets neither invalidate nor supply ordinary policy usage", () => {
    const data: WhamUsageResponse = {
      rate_limit: { primary_window: { used_percent: 0 } },
      additional_rate_limits: [{ metered_feature: "codex_bengalfox", rate_limit: {
        primary_window: { used_percent: -1, limit_window_seconds: 604_800 },
      } }],
    };
    expect(parseMainPolicyUsageQuota(data)?.weeklyPercent).toBe(0);
    delete data.rate_limit;
    const quota = parseMainPolicyUsageQuota(data);
    expect(quota?.shortPercent).toBeUndefined();
    expect(quota?.weeklyPercent).toBeUndefined();
    expect(quota?.monthlyPercent).toBeUndefined();
  });

  test.each([undefined, "plus", "team"])("%s supplementary monthly cannot supply policy or erase retained evidence", plan => {
    const data: WhamUsageResponse = { plan_type: plan, rate_limit: {
      tertiary_window: { used_percent: 99, reset_at: 2_000_000_000 },
    } };
    expect(parseUsageQuota(data)).toEqual({ monthlyPercent: 99, monthlyResetAt: 2_000_000_000 });
    expect(parseMainPolicyUsageQuota(data)).toBeNull();
    // Monthly duration without a primary reading does not bless the tertiary fallback.
    data.rate_limit!.primary_window = { limit_window_seconds: 2_592_000 };
    expect(parseMainPolicyUsageQuota(data)).toBeNull();
    data.rate_limit!.primary_window = { used_percent: 0, limit_window_seconds: 18_000 };
    expect(parseMainPolicyUsageQuota(data)).toEqual({ shortPercent: 0, shortWindowSeconds: 18_000 });
  });

  test.each(["go", "free", " Go ", "FREE"])("%s monthly-only plan retains monthly evidence without fabricating primary provenance", plan => {
    const quota = parseMainPolicyUsageQuota({ plan_type: plan, rate_limit: {
      tertiary_window: { used_percent: 99, reset_at: 2_000_000_000 },
    } });
    expect(quota).toEqual({ monthlyPercent: 99, monthlyResetAt: 2_000_000_000 });
    expect(quota?.monthlyIsPrimaryWindow).toBeUndefined();
  });

  test("null policy evidence preserves only the matching owner and untagged writes invalidate", () => {
    const writer = writerFor();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    const retained = getMainPolicyQuota();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 0 }, undefined, writer, null);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(0);
    expect(getMainPolicyQuota()).toEqual(retained);
    const other = writerFor("fixture-main-b");
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 0 }, undefined, other, null);
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, other);
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 0 }, undefined, undefined, null);
    expect(getMainPolicyQuota()).toBeNull();
  });
});

describe("main policy window replacement", () => {
  const cfg = { codexMainAccountHardLock: true };
  const weeklySeconds = 7 * 24 * 60 * 60;
  const monthlySeconds = 30 * 24 * 60 * 60;

  /** Publish the same fixture through display normalization and strict policy validation. */
  function publish(data: WhamUsageResponse) {
    setAccountQuotaFromParsed(MAIN, parseUsageQuota(data), undefined, writerFor(), parseMainPolicyUsageQuota(data));
  }

  /** Hydrate a sixteen-day-old short-window block and assert the replacement test's initial state. */
  function retainedShort() {
    const old = Date.now() - 16 * 24 * 60 * 60_000;
    writeColdPolicy({ shortPercent: 100, shortWindowSeconds: 18_000,
      shortObservedAt: old, shortResetAt: old / 1000 + 300, weeklyPercent: 35 });
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  }

  test.each([86_399, 86_400, 86_401])("primary duration %s follows the exact 24h parser boundary", seconds => {
    retainedShort();
    const data = { rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: seconds }, secondary_window: null, tertiary_window: null,
    } };
    const parsed = parseMainPolicyUsageQuota(data);
    expect(parsed?.shortWindowAbsent).toBe(seconds >= 86_400 ? true : undefined);
    publish(data);
    expect(getMainPolicyQuota()?.shortPercent).toBe(seconds < 86_400 ? 20 : undefined);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(seconds < 86_400 ? 35 : 20);
    expect(getMainAccountHardLockStatus(cfg).state).toBe("ready");
  });

  for (const [field, seconds] of [["weeklyPercent", weeklySeconds], ["monthlyPercent", monthlySeconds]] as const) {
    test.each([0, 35, 97.99, 98, 99, 100])(`fresh ${field}=%s replaces a retired persisted short window`, percent => {
      retainedShort();
      publish({ rate_limit: {
        primary_window: { used_percent: percent, limit_window_seconds: seconds }, secondary_window: null, tertiary_window: null,
      } });
      const policy = getMainPolicyQuota();
      expect(policy?.[field]).toBe(percent);
      for (const key of ["shortPercent", "shortResetAt", "shortObservedAt", "shortWindowSeconds"] as const) {
        expect(policy?.[key]).toBeUndefined();
      }
      // Replacement proof is per-observation, never a persisted permission to drop future evidence.
      expect(policy).not.toHaveProperty("shortWindowAbsent");
      expect(getMainAccountHardLockStatus(cfg).state).toBe(percent < 98 ? "ready" : "blocked");
      publish({ rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18_000 } } });
      expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
    });
  }

  test.each([
    { primary_window: { used_percent: 35 } },
    { primary_window: { limit_window_seconds: weeklySeconds }, secondary_window: null, tertiary_window: null },
    { primary_window: { used_percent: -1, limit_window_seconds: weeklySeconds }, secondary_window: null, tertiary_window: null },
    { primary_window: { used_percent: 101, limit_window_seconds: weeklySeconds }, secondary_window: null, tertiary_window: null },
    { primary_window: { used_percent: 35, limit_window_seconds: weeklySeconds }, secondary_window: {}, tertiary_window: null },
    { primary_window: { used_percent: 35, limit_window_seconds: weeklySeconds },
      secondary_window: { used_percent: 99, limit_window_seconds: 18_000 }, tertiary_window: null },
    { primary_window: { used_percent: 35, limit_window_seconds: weeklySeconds }, secondary_window: null,
      tertiary_window: { used_percent: 99, limit_window_seconds: 18_000 } },
  ])("partial, invalid or short-bearing metadata retains the old block: %j", rate_limit => {
    retainedShort();
    publish({ rate_limit });
    expect(getMainPolicyQuota()?.shortPercent).toBe(100);
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  });

  test("a declared long secondary cannot hide the current weekly limit", () => {
    retainedShort();
    publish({ rate_limit: {
      primary_window: { used_percent: 35, limit_window_seconds: monthlySeconds },
      secondary_window: { used_percent: 99, limit_window_seconds: weeklySeconds }, tertiary_window: null,
    } });
    expect(getMainPolicyQuota()?.shortPercent).toBeUndefined();
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  });

  test.each([
    {},
    { secondary_window: null },
    { tertiary_window: null },
    { secondary_window: { used_percent: 20, limit_window_seconds: weeklySeconds } },
    { tertiary_window: { used_percent: 20, limit_window_seconds: monthlySeconds } },
  ])("omitted secondary or tertiary windows cannot retire a short block: %j", windows => {
    retainedShort();
    const data = { rate_limit: {
      primary_window: { used_percent: 35, limit_window_seconds: weeklySeconds }, ...windows,
    } };
    expect(parseMainPolicyUsageQuota(data)?.shortWindowAbsent).toBeUndefined();
    publish(data);
    expect(getMainPolicyQuota()?.shortPercent).toBe(100);
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  });

  test("an explicit null secondary and long tertiary permit replacement", () => {
    retainedShort();
    publish({ rate_limit: {
      primary_window: { used_percent: 35, limit_window_seconds: weeklySeconds }, secondary_window: null,
      tertiary_window: { used_percent: 20, limit_window_seconds: monthlySeconds },
    } });
    expect(getMainPolicyQuota()?.shortPercent).toBeUndefined();
    expect(getMainAccountHardLockStatus(cfg).state).toBe("ready");
  });

  test.each([
    { secondary_window: { limit_window_seconds: weeklySeconds }, tertiary_window: null },
    { secondary_window: null, tertiary_window: { limit_window_seconds: monthlySeconds } },
  ])("a long auxiliary window without used_percent cannot retire a short block: %j", windows => {
    retainedShort();
    const data = { rate_limit: {
      primary_window: { used_percent: 35, limit_window_seconds: monthlySeconds }, ...windows,
    } };
    expect(parseMainPolicyUsageQuota(data)?.shortWindowAbsent).toBeUndefined();
    publish(data);
    expect(getMainPolicyQuota()?.shortPercent).toBe(100);
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  });

  test("long-window response headers alone do not retire a known short block", () => {
    retainedShort();
    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-primary-used-percent": "35", "x-codex-primary-window-minutes": "10080",
    }), undefined, writerFor());
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  });

  test("a superseded identity cannot retire the current account's short block", () => {
    const staleWriter = writerFor("fixture-main-b");
    retainedShort();
    const data = { rate_limit: {
      primary_window: { used_percent: 35, limit_window_seconds: weeklySeconds }, secondary_window: null, tertiary_window: null,
    } };
    setAccountQuotaFromParsed(MAIN, parseUsageQuota(data), undefined, staleWriter, parseMainPolicyUsageQuota(data));
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  });
});

describe("cold partial writers hydrate only the surviving legacy cache", () => {
  for (const writerKind of ["parsed", "legacy"] as const) {
    for (const expired of [false, true]) {
      test(`${writerKind} credits-only write ${expired ? "does not revive expired" : "retains fresh"} ordinary windows`, () => {
        const writer = writerFor();
        const quota = {
          shortPercent: 99, shortResetAt: 2_000_000_000, shortWindowSeconds: 18_000, shortObservedAt: 1_700_000_000_000,
          weeklyPercent: 50, weeklyResetAt: 2_100_000_000,
          monthlyPercent: 25, monthlyResetAt: 2_200_000_000, resetCredits: 4,
          updatedAt: Date.now() - (expired ? 7 : 1) * 60 * 60_000,
        };
        writeFileSync(join(home, "codex-quota-cache.json"), JSON.stringify({
          version: 1, quotas: { [MAIN]: quota }, mainPolicyQuota: { identityKey: writer.identityKey, quota },
        }));
        // Do not read either cache before this first write: that would hide the cold-start defect.
        if (writerKind === "parsed") setAccountQuotaFromParsed(MAIN, { resetCredits: 0 }, undefined, writer);
        else updateAccountQuota(MAIN, undefined, undefined, undefined, undefined, 0);
        expect(getAccountQuota(MAIN)).toEqual(expired
          ? { resetCredits: 0, updatedAt: expect.any(Number) }
          : { ...quota, resetCredits: 0, updatedAt: expect.any(Number) });
        if (writerKind === "parsed") {
          expect(getMainPolicyQuota()).toEqual({ ...quota, resetCredits: 0, updatedAt: expect.any(Number) });
        } else expect(getMainPolicyQuota()).toBeNull();
      });
    }
  }
});

/** Write external disk input without priming either cache through a getter or setter. */
function writeColdPolicy(fields: Record<string, unknown>) {
  clearAccountQuota();
  const writer = writerFor();
  const quota = { updatedAt: Date.now(), ...fields };
  const body = JSON.stringify({
    version: 1, quotas: { [MAIN]: quota }, mainPolicyQuota: { identityKey: writer.identityKey, quota },
  }, (_key, value: unknown) => value === Infinity ? "positive-overflow"
    : value === -Infinity ? "negative-overflow" : value)
    .replaceAll('"positive-overflow"', "1e400").replaceAll('"negative-overflow"', "-1e400");
  writeFileSync(join(home, "codex-quota-cache.json"), body);
  return quota;
}

describe("cold persisted policy percentage ranges", () => {
  const cfg = { codexMainAccountHardLock: true };
  for (const field of ["shortPercent", "weeklyPercent", "monthlyPercent"] as const) {
    test.each([-1, -0.01, 101, 100.01, Infinity, -Infinity, null, "99", "101", "NaN", "Infinity", false, {}, []]
      .map(value => ({ value })))(
      `${field}=%j cannot shadow a valid blocking window or invent a window`, ({ value }) => {
        const blocking = field === "weeklyPercent"
          ? { monthlyPercent: 99, monthlyIsPrimaryWindow: true }
          : { weeklyPercent: 99 };
        const disk = writeColdPolicy({ ...blocking, [field]: value });
        expect(getMainAccountHardLockStatus(cfg)).toEqual({ enabled: true, state: "blocked" });
        expect(getMainPolicyQuota()).toEqual({ updatedAt: disk.updatedAt, ...blocking });
        // The ordinary disk cache is intentionally not sanitized by the policy parser.
        expect(getAccountQuota(MAIN)).toEqual(disk);

        const isolated = writeColdPolicy({ [field]: value, monthlyIsPrimaryWindow: true });
        expect(getMainPolicyQuota()).toEqual({ updatedAt: isolated.updatedAt });
        expect(getMainAccountHardLockStatus(cfg)).toEqual({ enabled: true, state: "unknown" });
      },
    );

    test.each([0, 97.99, 98, 99, 100])(`${field}=%s survives disk hydration without clamping`, value => {
      const disk = writeColdPolicy({ [field]: value });
      expect(getMainPolicyQuota()).toEqual(disk);
      expect(getMainAccountHardLockStatus(cfg).state).toBe(value < 98 ? "ready" : "blocked");
    });
  }

  test("valid short zero cannot release a weekly99 block after hydration", () => {
    const disk = writeColdPolicy({ weeklyPercent: 99, shortPercent: 0 });
    expect(getMainPolicyQuota()).toEqual(disk);
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  });

  test("rejected short usage retains independently valid unknown-window metadata", () => {
    const disk = writeColdPolicy({ weeklyPercent: 99, shortPercent: 101,
      shortWindowSeconds: 18_000, shortResetAt: 2_000_000_000, shortObservedAt: 1_700_000_000_000, resetCredits: 150 });
    expect(getMainPolicyQuota()).toEqual({ updatedAt: disk.updatedAt, weeklyPercent: 99,
      shortWindowSeconds: 18_000, shortResetAt: 2_000_000_000, shortObservedAt: 1_700_000_000_000, resetCredits: 150 });
    // The rejected 5h reading is unknown, but it cannot mask the valid weekly99 block.
    expect(getMainAccountHardLockStatus(cfg)).toEqual({ enabled: true, state: "blocked" });
  });

  test.each([0, 150, 2_000_000_000])("metadata and credits retain nonnegative %s independently of usage ranges", value => {
    const disk = writeColdPolicy({ shortPercent: 100, weeklyPercent: 99, monthlyPercent: 0,
      shortResetAt: value, weeklyResetAt: value, monthlyResetAt: value,
      shortWindowSeconds: value, shortObservedAt: value, resetCredits: value, monthlyIsPrimaryWindow: true });
    expect(getMainPolicyQuota()).toEqual(disk);
  });

  test.each([-1, Infinity, -Infinity, "150", null])("invalid metadata %s cannot erase valid percentage evidence", value => {
    const disk = writeColdPolicy({ weeklyPercent: 99, shortResetAt: value, weeklyResetAt: value,
      monthlyResetAt: value, shortWindowSeconds: value, shortObservedAt: value, resetCredits: value });
    expect(getMainPolicyQuota()).toEqual({ updatedAt: disk.updatedAt, weeklyPercent: 99 });
    expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  });

  test.each([-1, Infinity, -Infinity, "0", null])("invalid updatedAt %s still rejects the entire policy record", value => {
    writeColdPolicy({ weeklyPercent: 99, updatedAt: value });
    expect(getMainPolicyQuota()).toBeNull();
    expect(getMainAccountHardLockStatus(cfg).state).toBe("unknown");
  });
});
