import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costEvidenceForCandidate, costScore } from "../src/routing/cost";
import { evaluatePolicyProfile, COST_UNKNOWN_PENALTY_SCORE } from "../src/routing/evaluator";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-cost-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1", "m2"] },
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "kan", models: ["claude-opus-5", "claude-sonnet-5"] },
    },
    routingProfiles: {
      cost: {
        candidates: [
          { provider: "anthropic", model: "claude-opus-5" },
          { provider: "anthropic", model: "claude-sonnet-5" },
        ],
        optimize: { cost: 0.8 },
      },
    },
    ...overrides,
  };
}

const USAGE = { inputTokens: 1000, outputTokens: 100, estimated: true };

describe("cost-aware scoring (RI-08)", () => {
  test("known price produces an estimate with provenance", async () => {
    const evidence = costEvidenceForCandidate({
      provider: "anthropic",
      model: "claude-opus-5",
      usage: { inputTokens: 1000, outputTokens: 100 },
      usageStatus: "reported",
    });
    expect(evidence.estimatedUsd).toBeGreaterThan(0);
    // Canonical jawcode pricing is authoritative; the expected-price overlay
    // is the fallback. Both carry a stable source code.
    expect(["jawcode", "expected"]).toContain(evidence.priceSource);
    expect(evidence.incomplete).toBe(evidence.priceSource === "expected");
    expect(costScore(evidence)).not.toBeNull();
  });

  test("unknown price and missing usage stay unknown - never zero", async () => {
    const noPrice = costEvidenceForCandidate({ provider: "a", model: "m1", usage: USAGE });
    expect(noPrice.estimatedUsd).toBeUndefined();
    expect(noPrice.priceSource).toBe("unmatched");
    expect(noPrice.incomplete).toBe(true);
    expect(costScore(noPrice)).toBeNull();

    const noUsage = costEvidenceForCandidate({ provider: "anthropic", model: "claude-opus-5" });
    expect(noUsage.estimatedUsd).toBeUndefined();
    expect(noUsage.incomplete).toBe(true);
    expect(costScore(noUsage)).toBeNull();
  });

  test("hard maximum estimated cost excludes candidates and records the limit", async () => {
    const limited = config({
      routingProfiles: {
        cost: {
          candidates: [{ provider: "anthropic", model: "claude-opus-5" }],
          optimize: { cost: 0.8 },
          limits: { maxEstimatedCostUsd: 0.000001 },
          unknownEvidence: { capability: "allow", health: "penalize", quota: "penalize", cost: "penalize" },
        },
      },
    });
    const evidence = costEvidenceForCandidate({
      provider: "anthropic",
      model: "claude-opus-5",
      usage: USAGE,
      limitUsd: 0.000001,
    });
    expect(evidence.limitUsd).toBe(0.000001);

    const result = evaluatePolicyProfile(limited, "cost", {}, [
      { provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: evidence },
    ]);
    expect(result.candidates[0]!.eligible).toBe(false);
    expect(result.candidates[0]!.exclusions.some(exclusion => exclusion.code === "cost-limit")).toBe(true);
    expect(result.selectedIndex).toBeNull();
  });

  test("unknown cost follows the profile policy (exclude / penalize / allow)", async () => {
    const strict = config({
      routingProfiles: {
        c: {
          candidates: [{ provider: "a", model: "m1" }],
          unknownEvidence: { capability: "allow", health: "penalize", quota: "penalize", cost: "exclude" },
        },
      },
    });
    const excluded = evaluatePolicyProfile(strict, "c", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(excluded.candidates[0]!.eligible).toBe(false);
    expect(excluded.candidates[0]!.exclusions.some(exclusion => exclusion.code === "unknown-price")).toBe(true);

    const penalizing = config({
      routingProfiles: {
        c: {
          candidates: [{ provider: "a", model: "m1" }],
          unknownEvidence: { capability: "allow", health: "penalize", quota: "penalize", cost: "penalize" },
        },
      },
    });
    const penalized = evaluatePolicyProfile(penalizing, "c", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(penalized.candidates[0]!.eligible).toBe(true);
    expect(penalized.candidates[0]!.score!.components.cost).toBe(COST_UNKNOWN_PENALTY_SCORE);

    const allowing = config({
      routingProfiles: {
        c: {
          candidates: [{ provider: "a", model: "m1" }],
          unknownEvidence: { capability: "allow", health: "penalize", quota: "penalize", cost: "allow" },
        },
      },
    });
    const allowed = evaluatePolicyProfile(allowing, "c", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(allowed.candidates[0]!.eligible).toBe(true);
    // Allowed-unknown cost: no cost component, and the unspent cost weight
    // folds back into priority instead of scoring unknown as zero.
    expect(allowed.candidates[0]!.score!.components.cost).toBeUndefined();
    expect(allowed.candidates[0]!.score!.total).toBeGreaterThan(0);
  });

  test("cheaper candidates win when cost is weighted", async () => {
    const expensive = costEvidenceForCandidate({
      provider: "anthropic",
      model: "claude-opus-5",
      usage: { inputTokens: 200_000, outputTokens: 20_000, estimated: true },
    });
    const cheap = costEvidenceForCandidate({
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: { inputTokens: 2_000, outputTokens: 200, estimated: true },
    });
    const result = evaluatePolicyProfile(config(), "cost", {}, [
      { provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: expensive },
      { provider: "anthropic", model: "claude-sonnet-5", capability: { contextWindow: 200000 }, cost: cheap },
    ]);
    expect(result.selectedIndex).toBe(1);
    expect(result.candidates[1]!.score!.components.cost).toBeGreaterThan(result.candidates[0]!.score!.components.cost!);
  });

  test("trace carries cost evidence and the cost component", async () => {
    const evidence = costEvidenceForCandidate({ provider: "anthropic", model: "claude-opus-5", usage: USAGE });
    const result = evaluatePolicyProfile(config(), "cost", {}, [
      { provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: evidence },
      { provider: "anthropic", model: "claude-sonnet-5", capability: { contextWindow: 200000 } },
    ]);
    expect(result.trace.candidates[0]!.cost).toBeDefined();
    expect(result.trace.candidates[0]!.score!.components.cost).toBeDefined();
  });
});
