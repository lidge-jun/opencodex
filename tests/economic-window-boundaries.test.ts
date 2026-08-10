import { afterEach, describe, expect, test } from "bun:test";
import {
  clearEconomicState,
  explainEconomicCombo,
  economicConsumption,
  selectEconomicTarget,
  setEconomicQuotaSnapshot,
  snapshotFreshness,
  usableHeadroom,
} from "../src/combos/economy";
import type { OcxEconomicAllowance, OcxEconomicSnapshot, OcxConfig } from "../src/types";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const DURATION = 60_000;
const allowance = (window: OcxEconomicAllowance["window"], overrides: Partial<OcxEconomicAllowance> = {}): OcxEconomicAllowance => ({
  unit: "requests",
  capacity: 100,
  window,
  ...overrides,
});
const snapshot = (overrides: Partial<OcxEconomicSnapshot> = {}): OcxEconomicSnapshot => ({
  remaining: 50,
  updatedAt: NOW,
  source: "manual",
  confidence: "authoritative",
  ...overrides,
});

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example", models: ["m"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example", models: ["m"] },
    },
    economicAllowances: {
      quota: allowance({ kind: "balance" }),
    },
    combos: {
      econ: {
        strategy: "economy",
        targets: [
          { provider: "a", model: "m", allowances: ["quota"] },
          { provider: "b", model: "m", allowances: ["quota"] },
        ],
      },
    },
    ...overrides,
  };
}

const request = { inputTokens: 0, outputTokens: 0, fixedRequests: 10, kind: "configured" as const };

afterEach(() => clearEconomicState());

describe("economic window boundaries", () => {
  test.each([
    { name: "one millisecond before stale", updatedAt: NOW - 1_001, status: "stale" },
    { name: "at stale boundary", updatedAt: NOW - 1_000, status: "fresh" },
    { name: "one millisecond after snapshot", updatedAt: NOW + 1, status: "fresh" },
  ])("classifies snapshot freshness at $name", ({ updatedAt, status }) => {
    expect(snapshotFreshness(snapshot({ updatedAt }), allowance({ kind: "balance" }, { staleAfterMs: 1_000 }), NOW).status).toBe(status);
  });

  test.each([
    { name: "before expiry", nowOffset: -1, status: "fresh" },
    { name: "at expiry", nowOffset: 0, status: "unknown" },
    { name: "after expiry", nowOffset: 1, status: "unknown" },
  ])("fixed expiry is $name", ({ nowOffset, status }) => {
    const fixed = allowance({ kind: "expiresAt", expiresAt: NOW });
    expect(snapshotFreshness(snapshot({ expiresAt: NOW }), fixed, NOW + nowOffset).status).toBe(status);
    expect(usableHeadroom(fixed, snapshot({ expiresAt: NOW }), 10, 0, NOW + nowOffset)).toBe(status === "fresh" ? 40 : null);
  });

  test.each([
    { name: "before rolling reset", nowOffset: -1, status: "fresh" },
    { name: "at rolling reset", nowOffset: 0, status: "unknown" },
    { name: "after rolling reset", nowOffset: 1, status: "unknown" },
  ])("rolling window is $name", ({ nowOffset, status }) => {
    const rolling = allowance({ kind: "rolling", durationMs: DURATION });
    const current = snapshot({ windowStart: NOW - DURATION - nowOffset });
    expect(snapshotFreshness(current, rolling, NOW).status).toBe(status);
  });

  test("balance windows have no expiry boundary", () => {
    const balance = allowance({ kind: "balance" });
    expect(snapshotFreshness(snapshot({ expiresAt: NOW - 1, resetAt: NOW - 1 }), balance, NOW).status).toBe("fresh");
    expect(usableHeadroom(balance, snapshot({ expiresAt: NOW - 1, resetAt: NOW - 1 }), 10, 0, NOW)).toBe(40);
  });

  test.each([
    { reserveAmount: 20, reserveFraction: undefined, expected: 20 },
    { reserveAmount: undefined, reserveFraction: 0.2, expected: 20 },
    { reserveAmount: 12, reserveFraction: 0.2, expected: 12 },
  ])("resolves reserve boundary $reserveAmount/$reserveFraction", ({ reserveAmount, reserveFraction, expected }) => {
    setEconomicQuotaSnapshot("quota", snapshot({ remaining: 30 }));
    const selected = selectEconomicTarget(config({
      economicAllowances: { quota: allowance({ kind: "balance" }, { reserveAmount, reserveFraction }) },
    }), "econ", request, NOW);
    expect(selected.candidates[0]?.reserveThresholds).toEqual([expected]);
    expect(selected.candidates[0]?.postRequestRemaining).toEqual([20]);
    expect(selected.candidates[0]?.exclusions).toEqual([]);
  });

  test("the tightest allowance binds while retaining stable details", () => {
    const cfg = config({
      economicAllowances: {
        wide: allowance({ kind: "balance" }),
        tight: allowance({ kind: "balance" }),
      },
      combos: {
        econ: {
          strategy: "economy",
          targets: [{ provider: "a", model: "m", allowances: ["wide", "tight"] }],
        },
      },
    });
    setEconomicQuotaSnapshot("wide", snapshot({ remaining: 100 }));
    setEconomicQuotaSnapshot("tight", snapshot({ remaining: 9 }));
    const result = selectEconomicTarget(cfg, "econ", request, NOW);
    expect(result.targetIndex).toBe(null);
    expect(result.candidates[0]?.allowances.map(item => item.id)).toEqual(["wide", "tight"]);
    expect(result.candidates[0]?.allowances.map(item => item.postRequestRemaining)).toEqual([90, -1]);
    expect(result.candidates[0]?.exclusions).toEqual(["hard-headroom"]);
    expect(result.candidates[0]?.softSignals).toEqual(["reserve"]);
  });

  test("past reset is unknown and calendar needs authoritative resetAt", () => {
    const pastReset = allowance({ kind: "expiresAt", expiresAt: NOW + DURATION });
    expect(snapshotFreshness(snapshot({ resetAt: NOW - 1 }), pastReset, NOW).status).toBe("unknown");
    const calendar = allowance({ kind: "calendar", interval: "month", timezone: "UTC" });
    expect(snapshotFreshness(snapshot(), calendar, NOW).status).toBe("unknown");
    expect(snapshotFreshness(snapshot({ resetAt: NOW + DURATION }), calendar, NOW).status).toBe("fresh");
  });

  test("unknown quota follows policy and explanations remain finite", () => {
    const cfg = config({
      economicAllowances: { quota: allowance({ kind: "calendar", interval: "day", timezone: "UTC" }) },
      combos: { econ: { strategy: "economy", economy: { unknownQuota: "reject" }, targets: [{ provider: "a", model: "m", allowances: ["quota"] }, { provider: "b", model: "m" }] } },
    });
    setEconomicQuotaSnapshot("quota", snapshot());
    const result = explainEconomicCombo(cfg, "econ", request, NOW);
    expect(result.targetIndex).toBe(1);
    expect(result.candidates[0]?.exclusions).toContain("stale-quota");
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity|-0/);
  });

  test("stable ties preserve configured order", () => {
    setEconomicQuotaSnapshot("quota", snapshot({ remaining: 100 }));
    const result = selectEconomicTarget(config(), "econ", request, NOW);
    expect(result.candidates.map(candidate => `${candidate.target.provider}/${candidate.target.model}`)).toEqual(["a/m", "b/m"]);
    expect(result.targetIndex).toBe(0);
    expect(economicConsumption(allowance({ kind: "balance" }), request)).toBe(10);
  });
});
