// Carried from PR #6185 by yxr1995-maker and PR #6275 by codingbooo.
import { describe, expect, test } from "bun:test";
import {
  isDecisionModelCandidate,
  systemOneEndpoint,
  uniqueDiscoveryCandidates,
  type DiscoveryModelRow,
} from "../../src/server/management/decision-discovery";

const row = (overrides: Partial<DiscoveryModelRow> & { id: string }): DiscoveryModelRow => ({
  provider: "gateway",
  ...overrides,
});

describe("decision model discovery", () => {
  test("recognizes the spellings a resold decision model ships under", () => {
    for (const id of ["jev", "jev-1.13-free", "typesafe-ai/jev", "systemone-probe", "system-one", "decision-router"]) {
      expect(isDecisionModelCandidate(row({ id }))).toBeTrue();
    }
  });

  test("does not treat a generating model as a decision candidate", () => {
    for (const id of ["jeveux", "gpt-6-astra", "mimo-v2.6-pro", "claude-fable-5.1"]) {
      expect(isDecisionModelCandidate(row({ id }))).toBeFalse();
    }
  });

  test("an explicit query replaces the heuristic", () => {
    expect(isDecisionModelCandidate(row({ id: "mimo-v2.6-pro", owned_by: "xiaomi" }), "mimo")).toBeTrue();
    // The built-in hint must not widen a query the operator narrowed themselves.
    expect(isDecisionModelCandidate(row({ id: "jev-1.13" }), "mimo")).toBeFalse();
  });

  test("deduplicates by provider and model and drops rows without a provider", () => {
    const rows = [
      row({ id: "jev-1.13" }),
      row({ id: "jev-1.13" }),
      row({ id: "jev-1.13", provider: "other" }),
      { id: "jev-1.13" },
    ];
    expect(uniqueDiscoveryCandidates(rows).map(candidate => `${candidate.provider}/${candidate.id}`))
      .toEqual(["gateway/jev-1.13", "other/jev-1.13"]);
  });

  test("derives the System One endpoint from the provider's own prefix", () => {
    expect(systemOneEndpoint("https://api.typesafe.ai/v1")).toBe("https://api.typesafe.ai/v1/systemone");
    expect(systemOneEndpoint("https://opencode.ai/zen/v1")).toBe("https://opencode.ai/zen/v1/systemone");
    expect(systemOneEndpoint("https://gateway.example/v1/")).toBe("https://gateway.example/v1/systemone");
    expect(systemOneEndpoint("https://api.typesafe.ai/v1/systemone")).toBe("https://api.typesafe.ai/v1/systemone");
  });

  test("refuses to guess an endpoint it cannot build", () => {
    expect(systemOneEndpoint(undefined)).toBeNull();
    expect(systemOneEndpoint("")).toBeNull();
    expect(systemOneEndpoint("/v1")).toBeNull();
  });
});
