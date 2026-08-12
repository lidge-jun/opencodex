/**
 * Regression coverage for issue #1181 — "Routing: define hard cost-cap behavior
 * when runtime cost evidence is unknown".
 *
 * The hard ceiling `limits.maxEstimatedCostUsd` is documented as a hard
 * per-request cap. In the live routing path it never fires by itself, because
 * `router.ts` assembles cost evidence WITHOUT usage:
 *
 *   costEvidenceForCandidate({ provider, model, limitUsd })   // no `usage`
 *
 * `costEvidenceForCandidate` then returns `{ limitUsd, incomplete: true }`
 * with no `estimatedUsd`, and the evaluator's known-over-cap check requires a
 * finite estimate. These tests pin both sides of `limits.onUnknownCost`:
 *
 *   - default `"allow"` — candidate stays eligible and the trace stamps
 *     `cost.capOutcome: "unknown-allowed"` (not an exclusion)
 *   - opt-in `"exclude"` — ineligible with `cost-limit-unknown` and
 *     `capOutcome: "unknown-excluded"`
 *
 * Coverage includes the evaluator unit surface plus dry-run API and live
 * `routeModel` acceptance paths so the operator-visible outcome stays
 * consistent end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costEvidenceForCandidate } from "../src/routing/cost";
import { evaluatePolicyProfile } from "../src/routing/evaluator";
import { normalizeRouteDecisionTrace } from "../src/routing/trace";
import { NoEligiblePolicyCandidateError, routeModel } from "../src/router";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-cost-cap-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (!testDir) return;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Windows may keep a handle briefly after management/router I/O.
  }
});

/** Mirrors the live routing path: a cap is configured, usage is NOT available. */
function configWithCap(capUsd: number, overrides: Record<string, unknown> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "kan",
        models: ["claude-opus-5"],
      },
    },
    routingProfiles: {
      cost: {
        candidates: [{ provider: "anthropic", model: "claude-opus-5" }],
        optimize: { cost: 0.8 },
        limits: { maxEstimatedCostUsd: capUsd },
        unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "allow" },
        ...overrides,
      },
    },
  } as OcxConfig;
}

function livePathEvidence(capUsd: number) {
  return costEvidenceForCandidate({
    provider: "anthropic",
    model: "claude-opus-5",
    limitUsd: capUsd,
  });
}

describe("issue #1181 — hard cost cap under unknown evidence", () => {
  test("default allow: live-path evidence stays eligible with unknown-allowed capOutcome", () => {
    const evidence = livePathEvidence(0.000001);
    expect(evidence.estimatedUsd).toBeUndefined();
    expect(evidence.incomplete).toBe(true);
    expect(evidence.limitUsd).toBe(0.000001);

    const result = evaluatePolicyProfile(configWithCap(0.000001), "cost", {}, [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        capability: { contextWindow: 200000 },
        cost: evidence,
      },
    ]);

    const candidate = result.candidates[0]!;
    expect(candidate.eligible).toBe(true);
    expect(candidate.exclusions.some(e => e.code === "cost-limit")).toBe(false);
    expect(candidate.exclusions.some(e => e.code === "cost-limit-unknown")).toBe(false);
    expect(candidate.cost?.capOutcome).toBe("unknown-allowed");
    expect(result.selectedIndex).toBe(0);
    expect(result.trace.candidates[0]?.cost?.capOutcome).toBe("unknown-allowed");
    expect(normalizeRouteDecisionTrace(result.trace)?.candidates[0]?.cost?.capOutcome)
      .toBe("unknown-allowed");
  });

  test("opt-in exclude: fail-closed cap excludes unknown-cost candidates", () => {
    const evidence = livePathEvidence(0.000001);
    const result = evaluatePolicyProfile(
      configWithCap(0.000001, { limits: { maxEstimatedCostUsd: 0.000001, onUnknownCost: "exclude" } }),
      "cost",
      {},
      [
        {
          provider: "anthropic",
          model: "claude-opus-5",
          capability: { contextWindow: 200000 },
          cost: evidence,
        },
      ],
    );

    const candidate = result.candidates[0]!;
    expect(candidate.eligible).toBe(false);
    expect(candidate.exclusions.some(e => e.code === "cost-limit-unknown")).toBe(true);
    expect(candidate.cost?.capOutcome).toBe("unknown-excluded");
    expect(result.selectedIndex).toBeNull();
  });

  test("known estimate under the cap stamps satisfied without exclusions", () => {
    const result = evaluatePolicyProfile(configWithCap(1), "cost", {}, [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        capability: { contextWindow: 200000 },
        cost: { estimatedUsd: 0.01, incomplete: false, limitUsd: 1 },
      },
    ]);
    const candidate = result.candidates[0]!;
    expect(candidate.eligible).toBe(true);
    expect(candidate.exclusions).toEqual([]);
    expect(candidate.cost?.capOutcome).toBe("satisfied");
  });

  test("cap policy and unknownEvidence.cost are distinct mechanisms", () => {
    const evidence = livePathEvidence(0.000001);
    const scoringExcluded = evaluatePolicyProfile(
      configWithCap(0.000001, {
        unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "exclude" },
      }),
      "cost",
      {},
      [{ provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: evidence }],
    );

    const codes = scoringExcluded.candidates[0]!.exclusions.map(e => e.code);
    expect(codes).toContain("unknown-price");
    expect(codes).not.toContain("cost-limit-unknown");
    expect(scoringExcluded.candidates[0]!.eligible).toBe(false);
    // Cap policy still stamps the allow-path outcome; scoring exclusion is separate.
    expect(scoringExcluded.candidates[0]!.cost?.capOutcome).toBe("unknown-allowed");
  });

  test("no cap configured — onUnknownCost is inert", () => {
    const evidence = costEvidenceForCandidate({ provider: "anthropic", model: "claude-opus-5" });
    const noCap = {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "kan", models: ["claude-opus-5"] },
      },
      routingProfiles: {
        cost: {
          candidates: [{ provider: "anthropic", model: "claude-opus-5" }],
          optimize: { cost: 0.8 },
          limits: { onUnknownCost: "exclude" },
          unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "allow" },
        },
      },
    } as unknown as OcxConfig;

    const result = evaluatePolicyProfile(noCap, "cost", {}, [
      { provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: evidence },
    ]);

    expect(result.candidates[0]!.eligible).toBe(true);
    expect(result.candidates[0]!.exclusions.some(e => e.code === "cost-limit-unknown")).toBe(false);
    expect(result.candidates[0]!.cost?.capOutcome).toBeUndefined();
  });

  test("trace stamps the profile cap even when evidence carries a different limitUsd", () => {
    const result = evaluatePolicyProfile(configWithCap(0.000001), "cost", {}, [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        capability: { contextWindow: 200000 },
        cost: { estimatedUsd: 0.01, incomplete: false, limitUsd: 1 },
      },
    ]);
    const candidate = result.candidates[0]!;
    expect(candidate.eligible).toBe(false);
    expect(candidate.exclusions.some(e => e.code === "cost-limit")).toBe(true);
    expect(candidate.cost?.limitUsd).toBe(0.000001);
    expect(candidate.cost?.capOutcome).toBe("exceeded");
    expect(result.trace.candidates[0]?.cost?.limitUsd).toBe(0.000001);
  });

  test("trace limitUsd normalization does not change costScore for eligible candidates", () => {
    // Profile cap 0.5; caller evidence carries limitUsd 1. Scoring must keep
    // the caller's reference (1 - 0.4/1 = 0.6), not the stamped profile cap
    // (1 - 0.4/0.5 = 0.2).
    const result = evaluatePolicyProfile(configWithCap(0.5), "cost", {}, [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        capability: { contextWindow: 200000 },
        cost: { estimatedUsd: 0.4, incomplete: false, limitUsd: 1 },
      },
    ]);
    const candidate = result.candidates[0]!;
    expect(candidate.eligible).toBe(true);
    expect(candidate.cost?.limitUsd).toBe(0.5);
    expect(candidate.cost?.capOutcome).toBe("satisfied");
    expect(candidate.score?.components.cost).toBeCloseTo(0.6, 5);
  });

  test("synthesized cost evidence from missing input marks incomplete", () => {
    const result = evaluatePolicyProfile(configWithCap(0.5), "cost", {}, [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        capability: { contextWindow: 200000 },
      },
    ]);
    const candidate = result.candidates[0]!;
    expect(candidate.eligible).toBe(true);
    expect(candidate.cost).toEqual({
      incomplete: true,
      limitUsd: 0.5,
      capOutcome: "unknown-allowed",
    });
  });

  test("non-finite estimatedUsd is stamped as incomplete unknown, not Infinity", () => {
    const result = evaluatePolicyProfile(configWithCap(0.5), "cost", {}, [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        capability: { contextWindow: 200000 },
        cost: { estimatedUsd: Number.POSITIVE_INFINITY, incomplete: false, priceSource: "registry" },
      },
    ]);
    const candidate = result.candidates[0]!;
    expect(candidate.eligible).toBe(true);
    expect(candidate.exclusions.some(e => e.code === "cost-limit")).toBe(false);
    expect(candidate.cost?.estimatedUsd).toBeUndefined();
    expect(candidate.cost).toEqual({
      incomplete: true,
      priceSource: "registry",
      limitUsd: 0.5,
      capOutcome: "unknown-allowed",
    });
    expect(result.trace.candidates[0]?.cost?.estimatedUsd).toBeUndefined();
  });

  test("normalizeRouteDecisionTrace drops capOutcome without a finite limitUsd", () => {
    const dirty = {
      version: 1 as const,
      decisionId: "abcdef012345",
      createdAt: 1,
      requestedModel: "policy/cost",
      routeKind: "policy" as const,
      requirements: [],
      candidates: [{
        provider: "anthropic",
        model: "claude-opus-5",
        eligible: true,
        exclusions: [],
        cost: { incomplete: true, capOutcome: "unknown-allowed" as const },
      }],
      selected: {
        candidateIndex: 0,
        provider: "anthropic",
        model: "claude-opus-5",
        reason: "policy-selected",
      },
    };
    const normalized = normalizeRouteDecisionTrace(dirty);
    expect(normalized).not.toBeNull();
    expect(normalized?.candidates[0]?.cost?.capOutcome).toBeUndefined();
    expect(normalized?.candidates[0]?.cost?.incomplete).toBe(true);
  });

  test("explicit onUnknownCost allow matches omitted default", () => {
    const evidence = livePathEvidence(0.000001);
    const omitted = evaluatePolicyProfile(configWithCap(0.000001), "cost", {}, [
      { provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: evidence },
    ]);
    const explicit = evaluatePolicyProfile(
      configWithCap(0.000001, { limits: { maxEstimatedCostUsd: 0.000001, onUnknownCost: "allow" } }),
      "cost",
      {},
      [{ provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: evidence }],
    );

    expect(omitted.candidates[0]!.eligible).toBe(true);
    expect(explicit.candidates[0]!.eligible).toBe(true);
    expect(omitted.candidates[0]!.cost?.capOutcome).toBe("unknown-allowed");
    expect(explicit.candidates[0]!.cost?.capOutcome).toBe("unknown-allowed");
    expect(omitted.selectedIndex).toBe(0);
    expect(explicit.selectedIndex).toBe(0);
  });

  test("dry-run API and live routeModel share allow/exclude cap outcomes", async () => {
    const allowConfig = configWithCap(0.000001);
    const excludeConfig = configWithCap(0.000001, {
      limits: { maxEstimatedCostUsd: 0.000001, onUnknownCost: "exclude" },
    });

    const allowDry = await handleManagementAPI(
      new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "cost" }),
      }),
      new URL("http://localhost/api/routing-profiles/dry-run"),
      allowConfig,
      { refreshCodexCatalog: async () => {} },
    );
    expect(allowDry!.status).toBe(200);
    const allowBody = await allowDry!.json() as {
      candidates: Array<{
        eligible: boolean;
        exclusions: Array<{ code: string }>;
        cost?: { capOutcome?: string };
      }>;
      selectedIndex: number | null;
      trace: { candidates: Array<{ cost?: { capOutcome?: string }; exclusions: Array<{ code: string }> }> };
    };
    expect(allowBody.candidates[0]!.eligible).toBe(true);
    expect(allowBody.candidates[0]!.cost?.capOutcome).toBe("unknown-allowed");
    expect(allowBody.trace.candidates[0]?.cost?.capOutcome).toBe("unknown-allowed");
    expect(allowBody.candidates[0]!.exclusions.some(e => e.code === "cost-limit-unknown")).toBe(false);

    const allowLive = routeModel(allowConfig, "policy/cost");
    expect(allowLive.routeKind).toBe("policy");
    expect(allowLive.routeDecision?.candidates[0]?.eligible).toBe(true);
    expect(allowLive.routeDecision?.candidates[0]?.cost?.capOutcome).toBe("unknown-allowed");
    expect(allowLive.routeDecision?.candidates[0]?.exclusions.some(e => e.code === "cost-limit-unknown")).toBe(false);

    const excludeDry = await handleManagementAPI(
      new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "cost" }),
      }),
      new URL("http://localhost/api/routing-profiles/dry-run"),
      excludeConfig,
      { refreshCodexCatalog: async () => {} },
    );
    expect(excludeDry!.status).toBe(200);
    const excludeBody = await excludeDry!.json() as {
      candidates: Array<{
        eligible: boolean;
        exclusions: Array<{ code: string }>;
        cost?: { capOutcome?: string };
      }>;
      selectedIndex: number | null;
    };
    expect(excludeBody.candidates[0]!.eligible).toBe(false);
    expect(excludeBody.candidates[0]!.cost?.capOutcome).toBe("unknown-excluded");
    expect(excludeBody.candidates[0]!.exclusions.some(e => e.code === "cost-limit-unknown")).toBe(true);
    expect(excludeBody.selectedIndex).toBeNull();

    expect(() => routeModel(excludeConfig, "policy/cost")).toThrow(NoEligiblePolicyCandidateError);
  });

  test("unknownEvidence.cost exclude stays distinguishable on the dry-run path", async () => {
    const config = configWithCap(0.000001, {
      unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "exclude" },
    });
    const res = await handleManagementAPI(
      new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "cost" }),
      }),
      new URL("http://localhost/api/routing-profiles/dry-run"),
      config,
      { refreshCodexCatalog: async () => {} },
    );
    expect(res!.status).toBe(200);
    const body = await res!.json() as {
      candidates: Array<{ exclusions: Array<{ code: string }>; cost?: { capOutcome?: string } }>;
    };
    const codes = body.candidates[0]!.exclusions.map(e => e.code);
    expect(codes).toContain("unknown-price");
    expect(codes).not.toContain("cost-limit-unknown");
    expect(body.candidates[0]!.cost?.capOutcome).toBe("unknown-allowed");
  });
});
