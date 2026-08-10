import { afterEach, describe, expect, test } from "bun:test";
import {
  clearEconomicState,
  reserveEconomicSelection,
  setEconomicQuotaSnapshot,
} from "../src/combos/economy";
import type { OcxConfig } from "../src/types";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const estimate = { inputTokens: 0, outputTokens: 0, fixedRequests: 1, kind: "configured" as const };

function config(targets: OcxConfig["combos"][string]["targets"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "primary",
    providers: {
      primary: { adapter: "openai-chat", baseUrl: "https://primary.example", models: ["m"] },
      alternate: { adapter: "openai-chat", baseUrl: "https://alternate.example", models: ["m"] },
      payg: { adapter: "openai-chat", baseUrl: "https://payg.example", models: ["m"] },
    },
    economicAllowances: {
      primaryAllowance: { unit: "requests", capacity: 1, window: { kind: "balance" }, source: "manual" },
      alternateAllowance: { unit: "requests", capacity: 1, window: { kind: "balance" }, source: "manual" },
    },
    combos: {
      c: { strategy: "economy", economy: { unknownQuota: "reject" }, targets },
    },
  };
}

afterEach(() => clearEconomicState());

describe("economic reservation races", () => {
  test("concurrent double reserve cannot both hold the same unit of headroom", async () => {
    const cfg = config([
      { provider: "primary", model: "m", allowances: ["primaryAllowance"] },
      { provider: "payg", model: "m" },
    ]);
    setEconomicQuotaSnapshot("primaryAllowance", { remaining: 1, updatedAt: NOW, source: "manual", confidence: "authoritative" });

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => reserveEconomicSelection(cfg, "c", estimate, NOW)),
      Promise.resolve().then(() => reserveEconomicSelection(cfg, "c", estimate, NOW)),
    ]);
    const allowanceResults = [first, second].filter(result => result.target?.provider === "primary");

    expect(allowanceResults).toHaveLength(1);
    expect(allowanceResults[0]?.reservationId).toBeString();
    expect([first, second].filter(result => result.target?.provider === "payg")).toHaveLength(1);
  });

  test("forced headroom race never returns an allowance target without reservationId", () => {
    const cfg = config([{ provider: "primary", model: "m", allowances: ["primaryAllowance"] }]);
    setEconomicQuotaSnapshot("primaryAllowance", { remaining: 1, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    let raced = false;

    const result = reserveEconomicSelection(cfg, "c", estimate, NOW, [], () => {
      if (!raced) {
        raced = true;
        setEconomicQuotaSnapshot("primaryAllowance", { remaining: 0, updatedAt: NOW, source: "manual", confidence: "authoritative" });
      }
      return true;
    });

    expect(result.target).toBeUndefined();
    expect(result.targetIndex).toBeNull();
    expect(result.reservationId).toBeUndefined();
    expect(result.reason).toBe("reservation-headroom-race");
  });

  test("headroom race recursively reserves an alternate target", () => {
    const cfg = config([
      { provider: "primary", model: "m", allowances: ["primaryAllowance"] },
      { provider: "alternate", model: "m", allowances: ["alternateAllowance"] },
    ]);
    setEconomicQuotaSnapshot("primaryAllowance", { remaining: 1, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    setEconomicQuotaSnapshot("alternateAllowance", { remaining: 1, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    let raced = false;

    const result = reserveEconomicSelection(cfg, "c", estimate, NOW, [], () => {
      if (!raced) {
        raced = true;
        setEconomicQuotaSnapshot("primaryAllowance", { remaining: 0, updatedAt: NOW, source: "manual", confidence: "authoritative" });
      }
      return true;
    });

    expect(result.target?.provider).toBe("alternate");
    expect(result.reservationId).toBeString();
  });
});
