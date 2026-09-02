import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateAccountQuota } from "../src/codex/quota";
import { setCachedProviderAccountQuotaForTests, clearAccountQuotaCache } from "../src/providers/quota";
import { quotaEvidenceForCandidate, quotaScore } from "../src/routing/quota";
import { evaluatePolicyProfile, QUOTA_UNKNOWN_PENALTY_SCORE } from "../src/routing/evaluator";
import { routeModel } from "../src/router";
import { getAccountSet, saveCredential } from "../src/oauth/store";
import { closeRequestHistoryIndex } from "../src/routing/history/indexer";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-quota-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  clearAccountQuotaCache();
  closeRequestHistoryIndex();
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
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
    },
    routingProfiles: {
      quota: {
        candidates: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
        optimize: { quota: 0.8 },
      },
    },
    ...overrides,
  };
}

describe("quota-aware scoring (RI-07)", () => {
  test("codex pool quota evidence derives headroom and exhausted state", async () => {
    updateAccountQuota("acct-1", 30, 1_800_000_000_000, 20, 1_900_000_000_000);
    const evidence = quotaEvidenceForCandidate({ provider: "openai", model: "gpt-5.6", codexAccountId: "acct-1" });
    expect(evidence.known).toBe(true);
    expect(evidence.headroom).toBeCloseTo(0.7, 2);
    expect(evidence.exhausted).toBe(false);
    expect(evidence.source).toBe("codex-pool");
    expect(quotaScore(evidence)).toBeCloseTo(0.7, 2);

    updateAccountQuota("acct-2", 100, undefined, undefined);
    const exhausted = quotaEvidenceForCandidate({ provider: "openai", model: "gpt-5.6", codexAccountId: "acct-2" });
    expect(exhausted.exhausted).toBe(true);
    expect(quotaScore(exhausted)).toBe(0);
  });

  test("anthropic account quota evidence uses the provider cache", async () => {
    setCachedProviderAccountQuotaForTests("anthropic", "acct-x", {
      fiveHourPercent: 40,
      fiveHourResetAt: 1_800_000_000_000,
      updatedAt: Date.now(),
    });
    const evidence = quotaEvidenceForCandidate({ provider: "anthropic", model: "claude-sonnet-5", accountRef: "acct-x" });
    expect(evidence.known).toBe(true);
    expect(evidence.headroom).toBeCloseTo(0.6, 2);
    expect(evidence.source).toBe("provider-report");
    expect(evidence.resetAtMs).toBe(1_800_000_000_000);
  });

  test("unknown quota stays unknown and never zero", () => {
    const evidence = quotaEvidenceForCandidate({ provider: "a", model: "m1" });
    expect(evidence.known).toBe(false);
    expect(quotaScore(evidence)).toBeNull();
  });

  test("unknown quota follows the profile policy (exclude / penalize / allow)", () => {
    const strict = config({
      routingProfiles: {
        q: {
          candidates: [{ provider: "a", model: "m1" }],
          unknownEvidence: { capability: "allow", health: "penalize", quota: "exclude", cost: "penalize" },
        },
      },
    });
    const excluded = evaluatePolicyProfile(strict, "q", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(excluded.candidates[0]!.eligible).toBe(false);
    expect(excluded.candidates[0]!.exclusions.some(exclusion => exclusion.code === "unknown-quota")).toBe(true);

    const penalizing = config({
      routingProfiles: {
        q: {
          candidates: [{ provider: "a", model: "m1" }],
          unknownEvidence: { capability: "allow", health: "penalize", quota: "penalize", cost: "penalize" },
        },
      },
    });
    const penalized = evaluatePolicyProfile(penalizing, "q", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(penalized.candidates[0]!.eligible).toBe(true);
    expect(penalized.candidates[0]!.score!.components.quota).toBe(QUOTA_UNKNOWN_PENALTY_SCORE);

    const allowing = config({
      routingProfiles: {
        q: {
          candidates: [{ provider: "a", model: "m1" }],
          unknownEvidence: { capability: "allow", health: "penalize", quota: "allow", cost: "penalize" },
        },
      },
    });
    const allowed = evaluatePolicyProfile(allowing, "q", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(allowed.candidates[0]!.eligible).toBe(true);
    expect(allowed.candidates[0]!.score!.components.quota).toBeUndefined();
  });

  test("larger headroom is preferred when quota scoring is weighted", () => {
    const result = evaluatePolicyProfile(config(), "quota", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 }, quota: { known: true, headroom: 0.2 } },
      { provider: "b", model: "m2", capability: { contextWindow: 200000 }, quota: { known: true, headroom: 0.9 } },
    ]);
    expect(result.selectedIndex).toBe(1);
    expect(result.candidates[1]!.score!.components.quota).toBeCloseTo(0.9, 2);
    expect(result.candidates[0]!.score!.components.quota).toBeCloseTo(0.2, 2);
  });

  test("minQuotaHeadroom hard requirement gates eligibility", () => {
    const gated = config({
      routingProfiles: {
        g: {
          candidates: [{ provider: "a", model: "m1" }],
          require: { minQuotaHeadroom: 0.5 },
          unknownEvidence: { capability: "allow", health: "penalize", quota: "penalize", cost: "penalize" },
        },
      },
    });
    const low = evaluatePolicyProfile(gated, "g", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 }, quota: { known: true, headroom: 0.2 } },
    ]);
    expect(low.candidates[0]!.eligible).toBe(false);
    expect(low.candidates[0]!.exclusions.some(exclusion => exclusion.code === "capability-unsatisfied")).toBe(true);

    const enough = evaluatePolicyProfile(gated, "g", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 }, quota: { known: true, headroom: 0.7 } },
    ]);
    expect(enough.candidates[0]!.eligible).toBe(true);
  });

  test("minQuotaHeadroom unknown is governed by the quota policy, not capability", () => {
    const strict = config({
      routingProfiles: {
        g: {
          candidates: [{ provider: "a", model: "m1" }],
          require: { minQuotaHeadroom: 0.5 },
          unknownEvidence: { capability: "exclude", health: "penalize", quota: "exclude", cost: "penalize" },
        },
      },
    });
    // Unknown quota at execution: the quota "exclude" policy applies and is
    // labeled `unknown-quota` - never the capability `unknown-capability` code.
    const excluded = evaluatePolicyProfile(strict, "g", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(excluded.candidates[0]!.eligible).toBe(false);
    expect(excluded.candidates[0]!.exclusions.some(exclusion => exclusion.code === "unknown-quota")).toBe(true);
    expect(excluded.candidates[0]!.exclusions.some(exclusion => exclusion.code === "unknown-capability")).toBe(false);

    // Default "penalize": unknown headroom stays eligible with the quota floor.
    const penalizing = config({
      routingProfiles: {
        g: {
          candidates: [{ provider: "a", model: "m1" }],
          require: { minQuotaHeadroom: 0.5 },
        },
      },
    });
    const penalized = evaluatePolicyProfile(penalizing, "g", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(penalized.candidates[0]!.eligible).toBe(true);
    expect(penalized.candidates[0]!.score!.components.quota).toBe(QUOTA_UNKNOWN_PENALTY_SCORE);
  });

  test("execution path does not invent Codex quota evidence from the active pool account", async () => {
    updateAccountQuota("pool-a", 30, 1_800_000_000_000, 20, 1_900_000_000_000);
    const cfg = config({
      codexAccounts: [{ id: "pool-a", email: "pool-a@example.test", isMain: false }],
      activeCodexAccountId: "pool-a",
      routingProfiles: {
        quotaRoute: { candidates: [{ provider: "openai", model: "gpt-5.6" }] },
      },
    });
    const route = routeModel(cfg, "policy/quotaRoute");
    expect(route.routeDecision!.candidates[0]!.accountRef).toBeUndefined();
    expect(route.routeDecision!.candidates[0]!.quota?.known).toBe(false);
    expect(route.routeDecision!.candidates[0]!.quota?.headroom).toBeUndefined();
  });

  test("execution path does not invent Anthropic quota evidence from the active account", async () => {
    await saveCredential("anthropic", {
      access: "access-a",
      refresh: "refresh-a",
      expires: Date.now() + 3_600_000,
      accountId: "uuid-a",
      email: "a@example.test",
    });
    const activeId = getAccountSet("anthropic")!.activeAccountId;
    setCachedProviderAccountQuotaForTests("anthropic", activeId, {
      fiveHourPercent: 40,
      updatedAt: Date.now(),
    });
    const cfg = config({
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          models: ["claude-sonnet-5"],
        },
      },
      routingProfiles: {
        quotaRoute: { candidates: [{ provider: "anthropic", model: "claude-sonnet-5" }] },
      },
    });
    const route = routeModel(cfg, "policy/quotaRoute");
    expect(route.routeDecision!.candidates[0]!.accountRef).toBeUndefined();
    expect(route.routeDecision!.candidates[0]!.quota?.known).toBe(false);
    expect(route.routeDecision!.candidates[0]!.quota?.headroom).toBeUndefined();
  });

  test("exact account selectors and pool strategies remain authoritative", () => {
    // Policy execution never invents account selection: candidates without
    // account refs get unknown quota evidence and the profile policy decides.
    const route = evaluatePolicyProfile(config(), "quota", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
      { provider: "b", model: "m2", capability: { contextWindow: 200000 } },
    ]);
    expect(route.candidates.every(candidate => candidate.quota === undefined || candidate.quota.known === false)).toBe(true);
  });
});
