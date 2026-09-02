import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsageEntry, resetUsageReadCacheForTests, type PersistedUsageEntry } from "../src/usage/log";
import { closeRequestHistoryIndex } from "../src/routing/history/indexer";
import {
  clearHealthHistoryCacheForTests,
  codexPoolHealthEvidence,
  healthEvidenceForCandidate,
  healthScore,
  HEALTH_SCORE_CONSTANTS,
} from "../src/routing/health";
import { evaluatePolicyProfile } from "../src/routing/evaluator";
import { NoEligiblePolicyCandidateError, routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

function row(
  requestId: string,
  status: number,
  durationMs: number,
  overrides: Partial<PersistedUsageEntry> = {},
): PersistedUsageEntry {
  return {
    requestId,
    timestamp: Date.now() - 60_000,
    provider: "a",
    model: "m1",
    status,
    durationMs,
    usageStatus: "reported",
    ...overrides,
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-health-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  clearHealthHistoryCacheForTests();
  closeRequestHistoryIndex();
});

afterEach(() => {
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
    },
    routingProfiles: {
      healthy: {
        candidates: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    ...overrides,
  };
}

describe("health-aware scoring (RI-06)", () => {
  test("historical evidence derives success rate, consecutive failures, latency, samples", async () => {
    for (let index = 0; index < 23; index++) {
      appendUsageEntry(row(`ok-${index}`, 200, 1000 + index));
    }
    appendUsageEntry(row("fail-1", 503, 4000, { timestamp: Date.now() - 5_000 }));
    appendUsageEntry(row("fail-2", 503, 4000, { timestamp: Date.now() - 4_000 }));
    const evidence = healthEvidenceForCandidate({ provider: "a", model: "m1" });
    expect(evidence.sampleCount).toBe(25);
    expect(evidence.failures).toBe(2);
    expect(evidence.successRate).toBeCloseTo(23 / 25, 2);
    expect(evidence.recentLatencyMs).toBeDefined();
    expect(evidence.incompleteStreamRate).toBeUndefined();
    const score = healthScore(evidence)!;
    expect(score).toBeGreaterThan(0.5);
  });

  test("client cancellations and invalid requests never damage health", async () => {
    for (let index = 0; index < 5; index++) appendUsageEntry(row(`ok-${index}`, 200, 1000));
    appendUsageEntry(row("cancel", 499, 500, { closeReason: "client_cancel" }));
    appendUsageEntry(row("invalid", 400, 500, { closeReason: "non_stream" }));
    appendUsageEntry(row("refused", 404, 500));
    const evidence = healthEvidenceForCandidate({ provider: "a", model: "m1" });
    expect(evidence.sampleCount).toBe(5);
    expect(evidence.successRate).toBe(1);
  });

  test("incomplete streams lower the health score", async () => {
    for (let index = 0; index < 10; index++) appendUsageEntry(row(`ok-${index}`, 200, 1000));
    appendUsageEntry(row("inc", 200, 1000, { terminalStatus: "incomplete" }));
    const evidence = healthEvidenceForCandidate({ provider: "a", model: "m1" });
    expect(evidence.incompleteStreamRate).toBeCloseTo(1 / 11, 2);
    const score = healthScore(evidence)!;
    expect(score).toBeLessThan(0.99);
  });

  test("low sample counts reduce confidence", async () => {
    appendUsageEntry(row("only", 200, 1000));
    const evidence = healthEvidenceForCandidate({ provider: "a", model: "m1" });
    const score = healthScore(evidence)!;
    const full = healthScore({ ...evidence, sampleCount: HEALTH_SCORE_CONSTANTS.MIN_CONFIDENCE_SAMPLES })!;
    expect(score).toBeLessThan(full);
  });

  test("hard cooldown is authoritative: score 0 and evaluator exclusion", async () => {
    const { clearCodexUpstreamHealth } = await import("../src/codex/routing");
    clearCodexUpstreamHealth();
    const now = Date.now();
    const evidence = {
      sampleCount: 50,
      successRate: 0.95,
      cooldownUntilMs: now + 60_000,
    };
    expect(healthScore(evidence, now)).toBe(0);

    const result = evaluatePolicyProfile(config(), "healthy", {}, [
      { provider: "a", model: "m1", health: { sampleCount: 50, successRate: 0.95, cooldownUntilMs: now + 60_000 } },
      { provider: "b", model: "m2", health: { sampleCount: 50, successRate: 0.95 } },
    ]);
    expect(result.candidates[0]!.eligible).toBe(false);
    expect(result.candidates[0]!.exclusions.some(exclusion => exclusion.code === "cooldown")).toBe(true);
    expect(result.selectedIndex).toBe(1);
  });

  test("unknown health follows the profile unknownEvidence policy", async () => {
    const strict = config({
      routingProfiles: {
        h: {
          candidates: [{ provider: "a", model: "m1" }],
          unknownEvidence: { capability: "allow", health: "exclude", quota: "penalize", cost: "penalize" },
        },
      },
    });
    const excluded = evaluatePolicyProfile(strict, "h", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(excluded.candidates[0]!.eligible).toBe(false);
    expect(excluded.candidates[0]!.exclusions.some(exclusion => exclusion.code === "unknown-health")).toBe(true);
    expect(excluded.selectedIndex).toBeNull();

    const penalizing = config({
      routingProfiles: {
        h: {
          candidates: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          unknownEvidence: { capability: "allow", health: "penalize", quota: "penalize", cost: "penalize" },
        },
      },
    });
    const penalized = evaluatePolicyProfile(penalizing, "h", {}, []);
    // Both candidates have unknown health; penalize keeps them eligible with
    // the penalized health floor folded into the score.
    expect(penalized.candidates.every(candidate => candidate.eligible)).toBe(true);
    expect(penalized.candidates[0]!.score!.components.health).toBe(0.3);
  });

  test("known health evidence feeds the score component and trace", async () => {
    for (let index = 0; index < 30; index++) appendUsageEntry(row(`ok-${index}`, 200, 800));
    const healthA = healthEvidenceForCandidate({ provider: "a", model: "m1" });
    const healthB = healthEvidenceForCandidate({ provider: "b", model: "m2" });
    const result = evaluatePolicyProfile(config(), "healthy", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 }, health: healthA },
      { provider: "b", model: "m2", capability: { contextWindow: 200000 }, health: healthB },
    ]);
    const a = result.candidates[0]!;
    expect(a.score!.components.health).toBeGreaterThan(0);
    expect(a.score!.components.configuredPriority).toBe(1);
    // Health evidence reaches the trace candidate.
    expect(result.trace.candidates[0]!.health).toBeDefined();
  });

  test("historical health moves selection between two eligible candidates", async () => {
    // "a" has a bad recent streak; "b" is clean.
    for (let index = 0; index < 20; index++) appendUsageEntry(row(`afail-${index}`, 503, 4000));
    for (let index = 0; index < 20; index++) {
      appendUsageEntry({
        requestId: `bok-${index}`,
        timestamp: Date.now() - 60_000,
        provider: "b",
        model: "m2",
        status: 200,
        durationMs: 900,
        usageStatus: "reported",
      });
    }
    const healthA = healthEvidenceForCandidate({ provider: "a", model: "m1" });
    const healthB = healthEvidenceForCandidate({ provider: "b", model: "m2" });
    const healthDominant = config({
      routingProfiles: {
        healthy: {
          candidates: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          optimize: { health: 0.9 },
        },
      },
    });
    const result = evaluatePolicyProfile(healthDominant, "healthy", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 }, health: healthA },
      { provider: "b", model: "m2", capability: { contextWindow: 200000 }, health: healthB },
    ]);
    // With equal priority weights, the healthier candidate wins.
    expect(result.selectedIndex).toBe(1);
  });

  test("execution path includes health evidence and can exclude on cooldown", async () => {
    for (let index = 0; index < 5; index++) appendUsageEntry(row(`ok-${index}`, 200, 800));
    const route = routeModel(config(), "policy/healthy");
    expect(route.routeKind).toBe("policy");
    expect(route.routeDecision!.candidates[0]!.health).toBeDefined();
  });

  test("combo attempt failures contribute samples to the failed target", async () => {
    for (let index = 0; index < 10; index++) appendUsageEntry(row(`ok-${index}`, 200, 800));
    // Combo request: a/m1 failed as the non-final attempt, b/m2 succeeded.
    appendUsageEntry({
      ...row("combo-1", 200, 1500, { provider: "b", model: "m2", timestamp: Date.now() - 1_000 }),
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", adapter: "openai-chat", status: 503, durationMs: 4000, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
        { ordinal: 2, provider: "b", model: "m2", adapter: "openai-chat", status: 200, durationMs: 1500, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
      ],
    });
    const failedTarget = healthEvidenceForCandidate({ provider: "a", model: "m1" });
    expect(failedTarget.sampleCount).toBe(11);
    expect(failedTarget.failures).toBe(1);
    const finalTarget = healthEvidenceForCandidate({ provider: "b", model: "m2" });
    expect(finalTarget.sampleCount).toBe(1);
    expect(finalTarget.failures).toBeUndefined();
    expect(finalTarget.successRate).toBe(1);
  });

  test("execution path applies live codex account cooldown to openai candidates", async () => {
    const { clearCodexUpstreamHealth, recordCodexUpstreamOutcome } = await import("../src/codex/routing");
    clearCodexUpstreamHealth();
    const now = Date.now();
    const cfg = config({
      providers: {
        ...config().providers,
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      codexAccounts: [{ id: "pool-a", email: "pool-a@example.test", isMain: false }],
      activeCodexAccountId: "pool-a",
      routingProfiles: {
        mixed: {
          candidates: [
            { provider: "openai", model: "gpt-5.6" },
            { provider: "b", model: "m2" },
          ],
        },
      },
    });
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { retryAfter: "3600", now });
    const route = routeModel(cfg, "policy/mixed");
    expect(route.routeDecision!.candidates[0]!.health?.cooldownUntilMs).toBeDefined();
    expect(route.routeDecision!.candidates[0]!.exclusions.some(exclusion => exclusion.code === "cooldown")).toBe(true);
    expect(route.providerName).toBe("b");
    expect(route.modelId).toBe("m2");
  });

  test("mixed pool cooldown/soft-avoid states degrade to soft-avoid", async () => {
    const { clearCodexUpstreamHealth, recordCodexUpstreamOutcome } = await import("../src/codex/routing");
    clearCodexUpstreamHealth();
    const now = Date.now();
    const cfg = config({
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.test", isMain: false },
        { id: "pool-b", email: "pool-b@example.test", isMain: false },
      ],
    });
    // pool-a hard-cooled (429); pool-b soft-avoided (transient 503s). No
    // single account is usable, so the aggregate must degrade to soft-avoid.
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { retryAfter: "3600", now });
    recordCodexUpstreamOutcome(cfg, "pool-b", 503, { now });
    recordCodexUpstreamOutcome(cfg, "pool-b", 503, { now: now + 1 });
    recordCodexUpstreamOutcome(cfg, "pool-b", 503, { now: now + 2 });
    const evidence = codexPoolHealthEvidence(cfg, now + 3);
    expect(evidence?.softAvoidUntilMs).toBeDefined();
    expect(evidence?.cooldownUntilMs).toBeUndefined();
  });

  test("unknown health under allow blends neutrally instead of outranking measured health", () => {
    const cfg = config({
      routingProfiles: {
        ranking: {
          candidates: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          optimize: { latency: 0, health: 0.8, cost: 0, quota: 0 },
          unknownEvidence: { capability: "allow", health: "allow", quota: "penalize", cost: "penalize" },
        },
      },
    });
    const result = evaluatePolicyProfile(cfg, "ranking", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
      {
        provider: "b",
        model: "m2",
        capability: { contextWindow: 200000 },
        health: { sampleCount: 50, successRate: 1, recentLatencyMs: 100 },
      },
    ]);
    // a (priority 1.0, unknown -> neutral 0.5) blends to 0.5; b (priority
    // 0.5, near-perfect health) blends above it. Without the neutral blend the
    // unknown candidate would outrank the measured one.
    expect(result.selectedIndex).toBe(1);
    expect(result.candidates[0]!.score!.components.health).toBe(0.5);
  });
});
