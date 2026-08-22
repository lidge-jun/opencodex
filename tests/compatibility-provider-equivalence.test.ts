/**
 * Relocation equivalence for the Lab/core compatibility split.
 *
 * Phase 3 moved subject resolution, the catalog snapshot, the projection read, and
 * attachCompatibilityEvidence out of assemble.ts into a provider behind a slot. The
 * evaluator treats a defined-but-empty compatibility object differently from an absent
 * one, so the shape has to match the pre-split behavior exactly:
 *
 *   requirements present + provider registered -> every candidate gets an object, even
 *                                                 candidates whose subject cannot resolve
 *   no provider registered                     -> compatibility is absent everywhere, and
 *                                                 scoring falls back to capability/health/
 *                                                 quota/cost as it did before CL-06
 *
 * devlog/_fin/260814_lab_core_decoupling/030_router_and_startup_activation.md
 */
import { describe, expect, test } from "bun:test";
import { assemblePolicyCandidateEvidence } from "../src/routing/compatibility/assemble";
import { setCompatibilityEvidenceProvider, resetCompatibilityEvidenceProviderForTests } from "../src/routing/compatibility/provider-slot";
import { labCompatibilityEvidenceProvider } from "../src/routing/compatibility/lab-evidence-provider";
import { getRoutingProfile } from "../src/routing/profile";
import type { OcxConfig } from "../src/types";

const config = {
  providers: { a: { baseUrl: "https://a.test", adapter: "openai-responses", apiKey: "k" } },
  routingProfiles: {
    compat: {
      candidates: [{ provider: "a", model: "m1" }, { provider: "missing", model: "m2" }],
      optimize: { latency: 1, health: 0, cost: 0, quota: 0 },
      compatibility: { requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }] },
    },
  },
} as unknown as OcxConfig;

describe("relocation equivalence", () => {
  test("every candidate gets a compatibility object when requirements exist, even unresolvable ones", () => {
    resetCompatibilityEvidenceProviderForTests();
    setCompatibilityEvidenceProvider(labCompatibilityEvidenceProvider);
    const rows = assemblePolicyCandidateEvidence(config, getRoutingProfile(config, "compat")!, Date.now(), {
      routedProviderConfig: (_n, p) => p,
      resolveSubjects: () => { throw new Error("unresolvable"); },
      loadCatalogSnapshot: () => new Map(),
      loadEvidenceSnapshot: () => ({ projectionAvailable: true, projectionIncompatible: false, bySubject: new Map() }),
    } as never);
    console.log(JSON.stringify(rows.map(r => ({ m: r.model, hasCompat: r.compatibility !== undefined }))));
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.compatibility).toBeDefined();
  });

  test("with NO provider registered, compatibility is undefined for all candidates", () => {
    resetCompatibilityEvidenceProviderForTests();
    const rows = assemblePolicyCandidateEvidence(config, getRoutingProfile(config, "compat")!, Date.now(), {
      routedProviderConfig: (_n, p) => p,
    });
    for (const r of rows) expect(r.compatibility).toBeUndefined();
  });
});
