import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
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
    test.each([-1, "-1", " -0.01 ", Number.NEGATIVE_INFINITY])(`${slot} rejects negative %s before clamping`, value => {
      // JSON input can carry strings despite WHAM's nominal number type.
      const data = JSON.parse(JSON.stringify({ rate_limit: {
        primary_window: { used_percent: 99 }, [slot]: { used_percent: value },
      } })) as WhamUsageResponse;
      // Infinity is not JSON-representable; exercise the typed boundary directly too.
      if (value === Number.NEGATIVE_INFINITY) data.rate_limit![slot] = { used_percent: value };
      expect(parseMainPolicyUsageQuota(data)).toBeNull();
      if (slot === "primary_window" && value !== Number.NEGATIVE_INFINITY) {
        expect(parseUsageQuota(data)?.weeklyPercent).toBe(0);
      }
    });
  }

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
