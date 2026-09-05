import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import {
  clearAccountQuota, getAccountQuota, getMainPolicyQuota, parseMainPolicyUsageQuota,
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

describe("cold partial writers hydrate only the surviving legacy cache", () => {
  for (const writerKind of ["parsed", "legacy"] as const) {
    for (const expired of [false, true]) {
      test(`${writerKind} credits-only write ${expired ? "does not revive expired" : "retains fresh"} ordinary windows`, () => {
        const writer = writerFor();
        const quota = {
          shortPercent: 99, shortResetAt: 2_000_000_000, shortWindowSeconds: 18_000,
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
