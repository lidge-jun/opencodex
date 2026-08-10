import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsageEntry, resetUsageReadCacheForTests } from "../src/usage/log";
import {
  clearEconomicState,
  getEconomicQuotaSnapshot,
  reconcileEconomicState,
  selectEconomicTarget,
  setEconomicQuotaSnapshot,
} from "../src/combos";
import {
  refreshEconomicSnapshots,
  resetEconomicSnapshotRefreshForTests,
} from "../src/combos/economy-refresh";
import {
  reserveEconomicSelection,
  settleEconomicReservation,
} from "../src/combos/economy";
import type { OcxConfig } from "../src/types";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "included",
    providers: {
      included: { adapter: "openai-chat", baseUrl: "https://included.example", models: ["m"] },
      payg: { adapter: "openai-chat", baseUrl: "https://payg.example", models: ["m"] },
    },
    economicAllowances: {
      promo: {
        unit: "requests",
        capacity: 10,
        window: { kind: "rolling", durationMs: 60 * 60_000 },
        source: "usage-log",
      },
      manual: {
        unit: "requests",
        capacity: 20,
        window: { kind: "balance" },
        source: "manual",
      },
    },
    combos: {
      bulk: {
        strategy: "economy",
        targets: [
          { provider: "included", model: "m", allowances: ["promo"] },
          { provider: "payg", model: "m" },
        ],
      },
    },
    ...overrides,
  };
}

function usage(requestId: string, timestamp = NOW): Parameters<typeof appendUsageEntry>[0] {
  return {
    requestId,
    timestamp,
    provider: "included",
    model: "m",
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    totalTokens: 1,
  };
}

let testHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testHome = mkdtempSync(join(tmpdir(), "ocx-economic-refresh-"));
  process.env.OPENCODEX_HOME = testHome;
  resetEconomicSnapshotRefreshForTests();
  resetUsageReadCacheForTests();
  clearEconomicState();
});

afterEach(() => {
  resetEconomicSnapshotRefreshForTests();
  resetUsageReadCacheForTests();
  clearEconomicState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe("economic snapshot refresh", () => {
  test("coalesces concurrent refreshes and publishes a complete bounded map", async () => {
    appendUsageEntry(usage("one"));
    setEconomicQuotaSnapshot("manual", { remaining: 7, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    const first = refreshEconomicSnapshots(config(), NOW);
    const second = refreshEconomicSnapshots(config(), NOW);
    expect(first).toBe(second);
    await first;
    expect(getEconomicQuotaSnapshot("promo")).toMatchObject({ remaining: 9, source: "usage-log", confidence: "estimated" });
    expect(getEconomicQuotaSnapshot("manual")).toMatchObject({ remaining: 7, source: "manual" });
    expect(getEconomicQuotaSnapshot("unconfigured")).toBeUndefined();
  });

  test("skips recomputation for an unchanged usage-log revision", async () => {
    appendUsageEntry(usage("one"));
    await refreshEconomicSnapshots(config(), NOW);
    const economy = await import("../src/combos/economy");
    const setter = spyOn(economy, "setEconomicQuotaSnapshot");
    await refreshEconomicSnapshots(config(), NOW + 1_000);
    expect(setter).not.toHaveBeenCalled();
    setter.mockRestore();
  });

  test("recomputes after the usage-log revision changes", async () => {
    appendUsageEntry(usage("one"));
    await refreshEconomicSnapshots(config(), NOW);
    appendUsageEntry(usage("two"));
    await refreshEconomicSnapshots(config(), NOW);
    expect(getEconomicQuotaSnapshot("promo")?.remaining).toBe(8);
  });

  test("retains the last snapshot and marks it estimated when refresh fails", async () => {
    appendUsageEntry(usage("one"));
    await refreshEconomicSnapshots(config(), NOW);
    const usageModule = await import("../src/usage/log");
    const usageRead = spyOn(usageModule, "readRecentUsageEntries").mockImplementation(() => {
      throw new Error("synthetic refresh failure");
    });
    appendUsageEntry(usage("two"));
    await expect(refreshEconomicSnapshots(config(), NOW + 1_000)).resolves.toBeUndefined();
    expect(getEconomicQuotaSnapshot("promo")).toMatchObject({ remaining: 9, confidence: "estimated", error: "synthetic refresh failure" });
    usageRead.mockRestore();
  });

  test("removes snapshots for allowances deleted by a config generation", () => {
    setEconomicQuotaSnapshot("promo", { remaining: 4, updatedAt: NOW, source: "usage-log", confidence: "estimated" });
    setEconomicQuotaSnapshot("removed", { remaining: 3, updatedAt: NOW, source: "usage-log", confidence: "estimated" });
    reconcileEconomicState({
      generation: 1,
      providerNames: new Set(),
      comboIds: new Set(),
      comboTargets: new Set(),
      codexAccountIds: new Set(),
      oauthAccountKeys: new Set(),
      configRoots: new Set(),
      allowanceIds: new Set(["promo"]),
    });
    expect(getEconomicQuotaSnapshot("promo")).toBeDefined();
    expect(getEconomicQuotaSnapshot("removed")).toBeUndefined();
  });

  test("selection reads cached state without refresh, provider, or usage I/O", async () => {
    const cfg = config();
    setEconomicQuotaSnapshot("promo", {
      remaining: 10,
      updatedAt: NOW,
      windowStart: NOW - 60 * 60_000 + 1,
      source: "manual",
      confidence: "authoritative",
    });
    const usageModule = await import("../src/usage/log");
    const usageRead = spyOn(usageModule, "readRecentUsageEntries");
    const provider = spyOn(globalThis, "fetch");
    const result = selectEconomicTarget(cfg, "bulk", { inputTokens: 1, outputTokens: 1, kind: "configured" }, NOW);
    expect(result.target?.provider).toBe("included");
    expect(usageRead).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    usageRead.mockRestore();
    provider.mockRestore();
  });

  test("refreshed rolling snapshot is immediately selectable", async () => {
    appendUsageEntry(usage("one", NOW - 30 * 60_000));
    appendUsageEntry(usage("two", NOW - 60_000));
    await refreshEconomicSnapshots(config(), NOW);
    const snapshot = getEconomicQuotaSnapshot("promo")!;
    expect(snapshot.windowStart).toBe(NOW);
    const result = selectEconomicTarget(config(), "bulk", { inputTokens: 1, outputTokens: 1, kind: "configured" }, NOW);
    expect(result.target?.provider).toBe("included");
  });

  test("public refresh API lives only in economy-refresh (dual-API eliminated)", async () => {
    const combosIndex = await import("../src/combos/index");
    expect("refreshEconomicSnapshots" in combosIndex).toBe(true);
    expect("refreshEconomicUsageSnapshots" in combosIndex).toBe(false);
    const economy = await import("../src/combos/economy");
    expect("refreshEconomicUsageSnapshots" in economy).toBe(false);
  });

  test("reserve then refresh same allowance: active reservation still protects headroom", async () => {
    setEconomicQuotaSnapshot("promo", { remaining: 10, updatedAt: NOW - 10_000, source: "usage-log", confidence: "estimated", windowStart: NOW - 1_000 });
    const cfg = config();
    const estimate = { inputTokens: 1, outputTokens: 1, fixedRequests: 1, kind: "configured" as const };
    const first = reserveEconomicSelection(cfg, "bulk", estimate, NOW);
    expect(first.reservationId).toBeString();
    expect(first.target?.provider).toBe("included");
    // usage-log refresh overwrites baseline remaining from the log; reservations
    // continue to protect concurrency until released — the next selection must
    // still see reserved capacity.
    appendUsageEntry(usage("nine", NOW));
    await refreshEconomicSnapshots(cfg, NOW + 1_000);
    // promo capacity is 10 and usage shows 1 row, so baseline resets to 9.
    // With one reservation held, usable headroom is 9 - 1(consumption) - 1(reserved) = 7.
    // Without subtracting reserved, headroom would be 8 incorrectly.
    const baseline = getEconomicQuotaSnapshot("promo");
    expect(baseline?.remaining).toBe(9);
    const second = reserveEconomicSelection(cfg, "bulk", estimate, NOW + 1_000);
    // Fill remaining headroom so the next call demonstrates reservation is counted:
    // 7 usable headroom remains; 7 more consumes it exactly.
    expect(second.target?.provider).toBe("included");
    for (let i = 0; i < 7; i += 1) reserveEconomicSelection(cfg, "bulk", estimate, NOW + 1_000);
    const exhausted = reserveEconomicSelection(cfg, "bulk", estimate, NOW + 1_000);
    expect(exhausted.target?.provider).toBe("payg");
    expect(exhausted.candidates.find(c => c.target.provider === "included")?.exclusions).toContain("hard-headroom");
  });

  test("settle manual then refresh different allowance does not clobber unrelated state", async () => {
    setEconomicQuotaSnapshot("promo", { remaining: 10, updatedAt: NOW - 10_000, source: "usage-log", confidence: "estimated", windowStart: NOW - 1_000 });
    setEconomicQuotaSnapshot("manual", { remaining: 20, updatedAt: NOW - 10_000, source: "manual", confidence: "authoritative" });
    const promoEstimate = { inputTokens: 1, outputTokens: 1, fixedRequests: 1, kind: "configured" as const };
    // Reserve against promo, then settle debits it: 10 + 1 - 1 = 10 (but we use input diff to check clobber).
    const promoCfg: OcxConfig = {
      ...config(),
      combos: { bulk: { strategy: "economy", targets: [{ provider: "included", model: "m", allowances: ["manual"] }] } },
    };
    const res = reserveEconomicSelection(promoCfg, "bulk", { inputTokens: 0, outputTokens: 0, fixedRequests: 1, kind: "configured" }, NOW);
    settleEconomicReservation(res.reservationId, { requests: 1 }, NOW + 100);
    const afterSettleManual = getEconomicQuotaSnapshot("manual")!;
    // Model A: baseline 20 - actual 1 request = 19
    expect(afterSettleManual.remaining).toBe(19);
    // Now refresh promo (usage-log) — it must not clobber manual.
    appendUsageEntry(usage("x", NOW));
    await refreshEconomicSnapshots(config(), NOW + 500);
    expect(getEconomicQuotaSnapshot("manual")).toEqual(afterSettleManual);
    expect(getEconomicQuotaSnapshot("promo")?.source).toBe("usage-log");
  });

  test("hot path select/reserve does not call readRecentUsageEntries", async () => {
    const cfg = config();
    setEconomicQuotaSnapshot("promo", { remaining: 10, updatedAt: NOW, windowStart: NOW, source: "usage-log", confidence: "estimated" });
    const usageModule = await import("../src/usage/log");
    const spy = spyOn(usageModule, "readRecentUsageEntries");
    selectEconomicTarget(cfg, "bulk", { inputTokens: 1, outputTokens: 1, kind: "configured" }, NOW);
    expect(spy).not.toHaveBeenCalled();
    reserveEconomicSelection(cfg, "bulk", { inputTokens: 1, outputTokens: 1, kind: "configured" }, NOW);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
