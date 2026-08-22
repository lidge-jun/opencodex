import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicyProfile } from "../src/routing/evaluator";
import { assemblePolicyCandidateEvidence } from "../src/routing/compatibility/assemble";
import { setCompatibilityEvidenceProvider } from "../src/routing/compatibility/provider-slot";
import { labCompatibilityEvidenceProvider } from "../src/routing/compatibility/lab-evidence-provider";
import { evaluateCompatibilityForCandidate } from "../src/routing/compatibility/policy";
import { findVerdictForSuite, loadCompatibilityEvidenceSnapshot } from "../src/routing/compatibility/reader";
import {
  resolvePolicyCompatibilitySubjects,
  resolvePolicyRouteSubject,
} from "../src/routing/compatibility/subject";
import { subjectIdForSubject } from "../src/lab/digest";
import { buildProtocolSubjectV1 } from "../src/lab/subject/protocol-subject";
import { readInstallationSalt } from "../src/lab/subject/installation-salt";
import { labRoot } from "../src/lab/paths";
import { getRoutingProfile, normalizeRoutingProfile, routingProfileIssues } from "../src/routing/profile";
import {
  resetCompatibilityVersionCacheForTests,
  setCompatibilityVersionOverrideForTests,
} from "../src/routing/compatibility/version";
import { normalizeRouteDecisionTrace } from "../src/routing/trace";
import type { OcxConfig } from "../src/types";
import type { CandidateCompatibilityEvidence } from "../src/routing/compatibility/types";

const COMPAT_VERSION = "f".repeat(64);
const SUBJECT_ID = "s".repeat(64);
const SUITE_DIGEST = "a".repeat(64);
let home = "";

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-responses", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    routingProfiles: {
      legacy: {
        candidates: [{ provider: "a", model: "m1" }],
        require: { tools: true },
      },
      compat: {
        candidates: [{ provider: "a", model: "m1" }],
        compatibility: {
          requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
          minStatus: "PROBED",
          unknownEvidence: "exclude",
          degradedEvidence: "penalize",
        },
      },
    },
    ...overrides,
  };
}

function routed(provider: OcxConfig["providers"][string]) {
  return { ...provider };
}

function evidence(
  verdict: CandidateCompatibilityEvidence["suites"][number]["verdict"],
  asOf = Date.now(),
  maxAgeMs: number | null = null,
): CandidateCompatibilityEvidence {
  return {
    subjectIds: { live_route_compatibility: SUBJECT_ID },
    projectionAvailable: true,
    suites: [{
      subjectId: SUBJECT_ID,
      suiteId: "responses-core",
      evidenceLayer: "live_route_compatibility",
      suiteVersion: "1",
      suiteManifestDigest: SUITE_DIGEST,
      verdict,
      asOf,
      maxAgeMs,
      notes: [],
    }],
  };
}

const policy = getRoutingProfile(baseConfig(), "compat")!.compatibility!;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-cl06-"));
  readInstallationSalt(home);
  setCompatibilityVersionOverrideForTests(COMPAT_VERSION);
});

afterEach(() => {
  resetCompatibilityVersionCacheForTests();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("CL-06 routing compatibility", () => {
  test("legacy profile without compatibility retains pre-CL-06 behavior", () => {
    const config = baseConfig();
    const legacy = getRoutingProfile(config, "legacy")!;
    expect(legacy.compatibility).toBeUndefined();
    const result = evaluatePolicyProfile(config, "legacy", {}, [{
      provider: "a",
      model: "m1",
      capability: { tools: true, contextWindow: 200000 },
    }]);
    expect(result.selectedIndex).toBe(0);
    expect(result.candidates[0]?.exclusions).toEqual([]);
  });

  test("legacy profile revision stability when compatibility omitted", () => {
    const config = baseConfig();
    const revision = getRoutingProfile(config, "legacy")!.revision;
    const again = normalizeRoutingProfile("legacy", config.routingProfiles!.legacy!);
    expect(again.revision).toBe(revision);
    expect(again.compatibility).toBeUndefined();
  });

  test("exact route identity changes when only adapter changes", () => {
    const config = baseConfig();
    const provider = config.providers.a!;
    const responses = resolvePolicyRouteSubject(config, "a", "m1", { ...provider, adapter: "openai-responses" }, home);
    const chat = resolvePolicyRouteSubject(config, "a", "m1", { ...provider, adapter: "openai-chat" }, home);
    expect(responses?.subjectId).toBeDefined();
    expect(chat?.subjectId).toBeDefined();
    expect(responses!.subjectId).not.toBe(chat!.subjectId);
  });

  test("protocol and live-route requirements use different canonical subjects", () => {
    const config = baseConfig();
    const resolved = resolvePolicyCompatibilitySubjects(config, "a", "m1", routed(config.providers.a!), home);
    const expectedProtocol = subjectIdForSubject(buildProtocolSubjectV1({
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-responses",
      surface: "responses-http",
    }, "openai-responses"));
    expect(resolved.subjectIds.protocol_conformance).toBe(expectedProtocol);
    expect(resolved.subjectIds.live_route_compatibility).toBeDefined();
    expect(resolved.subjectIds.live_route_compatibility).not.toBe(expectedProtocol);
  });

  test("provider-specific adapter cannot borrow generic protocol evidence", () => {
    const config = baseConfig({
      providers: {
        a: { adapter: "command-code", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      },
      defaultProvider: "a",
    });
    const resolved = resolvePolicyCompatibilitySubjects(config, "a", "m1", routed(config.providers.a!), home);
    const genericChat = subjectIdForSubject(buildProtocolSubjectV1({
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-chat",
      surface: "responses-sse",
    }));
    expect(resolved.subjectIds.protocol_conformance).toBeDefined();
    expect(resolved.subjectIds.protocol_conformance).not.toBe(genericChat);
  });

  test("route subject changes for behavior-affecting config but not credential rotation", () => {
    const config = baseConfig();
    const provider = config.providers.a!;
    const base = resolvePolicyRouteSubject(config, "a", "m1", routed(provider), home)!;
    const stateless = resolvePolicyRouteSubject(config, "a", "m1", { ...provider, statelessResponses: true }, home)!;
    const header = resolvePolicyRouteSubject(config, "a", "m1", { ...provider, headers: { "x-route-mode": "strict" } }, home)!;
    const rotated = resolvePolicyRouteSubject(config, "a", "m1", { ...provider, apiKey: "rotated-secret" }, home)!;
    const credentialHeader = resolvePolicyRouteSubject(config, "a", "m1", { ...provider, headers: { Authorization: "Bearer secret" } }, home)!;
    expect(stateless.subjectId).not.toBe(base.subjectId);
    expect(header.subjectId).not.toBe(base.subjectId);
    expect(rotated.subjectId).toBe(base.subjectId);
    expect(credentialHeader.subjectId).toBe(base.subjectId);
  });

  test("routing subject resolution never creates a missing Lab salt", () => {
    const freshHome = mkdtempSync(join(tmpdir(), "ocx-cl06-nosalt-"));
    try {
      const root = labRoot(freshHome);
      expect(existsSync(root)).toBe(false);
      const config = baseConfig();
      const resolved = resolvePolicyCompatibilitySubjects(config, "a", "m1", routed(config.providers.a!), freshHome);
      expect(resolved.route).toBeUndefined();
      expect(resolved.subjectIds.protocol_conformance).toBeDefined();
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(freshHome, { recursive: true, force: true });
    }
  });

  test("VERIFIED satisfies minimum PROBED", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, minStatus: "PROBED" }, evidence("VERIFIED"));
    expect(out.exclusions).toEqual([]);
  });

  test("VERIFIED satisfies minimum VERIFIED", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, minStatus: "VERIFIED" }, evidence("VERIFIED"));
    expect(out.exclusions).toEqual([]);
  });

  test("PROBED satisfies minimum PROBED", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, minStatus: "PROBED" }, evidence("PROBED"));
    expect(out.exclusions).toEqual([]);
  });

  test("PROBED fails minimum VERIFIED", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, minStatus: "VERIFIED" }, evidence("PROBED"));
    expect(out.exclusions.some(row => row.code === "compatibility-insufficient")).toBe(true);
  });

  test("UNSUPPORTED excludes required suite", () => {
    const out = evaluateCompatibilityForCandidate(policy, evidence("UNSUPPORTED"));
    expect(out.exclusions.some(row => row.code === "compatibility-unsupported")).toBe(true);
  });

  test("DEGRADED allow behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, degradedEvidence: "allow" }, evidence("DEGRADED"));
    expect(out.exclusions).toEqual([]);
    expect(out.penaltyScore).toBeNull();
  });

  test("DEGRADED penalize behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, degradedEvidence: "penalize" }, evidence("DEGRADED"));
    expect(out.exclusions).toEqual([]);
    expect(out.penaltyScore).toBe(0.3);
  });

  test("DEGRADED exclude behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, degradedEvidence: "exclude" }, evidence("DEGRADED"));
    expect(out.exclusions.some(row => row.code === "compatibility-degraded")).toBe(true);
  });

  test("UNKNOWN allow behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "allow" }, evidence("UNKNOWN"));
    expect(out.exclusions).toEqual([]);
  });

  test("UNKNOWN penalize behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "penalize" }, evidence("UNKNOWN"));
    expect(out.penaltyScore).toBe(0.3);
  });

  test("UNKNOWN exclude behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "exclude" }, evidence("UNKNOWN"));
    expect(out.exclusions.some(row => row.code === "compatibility-unknown")).toBe(true);
  });

  test("CLAIMED follows unknown-evidence behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "exclude" }, evidence("CLAIMED"));
    expect(out.exclusions.some(row => row.code === "compatibility-unknown")).toBe(true);
  });

  test("BLOCKED follows unknown-evidence behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "penalize" }, evidence("BLOCKED"));
    expect(out.penaltyScore).toBe(0.3);
  });

  test("stale positive evidence does not satisfy policy", () => {
    const stale = evidence("VERIFIED", Date.now() - 30 * 24 * 60 * 60 * 1000, 60_000);
    const out = evaluateCompatibilityForCandidate(
      { ...policy, minStatus: "VERIFIED", maxEvidenceAgeMs: 120_000 },
      stale,
    );
    expect(out.exclusions.length).toBeGreaterThan(0);
  });

  test("future-dated evidence is not treated as fresh", () => {
    const future = evidence("VERIFIED", Date.now() + 60_000, null);
    const out = evaluateCompatibilityForCandidate(
      { ...policy, minStatus: "VERIFIED", unknownEvidence: "exclude" },
      future,
    );
    expect(out.exclusions.some(row => row.code === "compatibility-stale")).toBe(true);
  });

  test("missing Lab projection does not crash evaluation", () => {
    const out = evaluateCompatibilityForCandidate(policy, {
      subjectIds: { live_route_compatibility: SUBJECT_ID },
      projectionAvailable: false,
      suites: [],
    });
    expect(out.exclusions.some(row => row.code === "compatibility-unknown")).toBe(true);
  });

  test("incompatible projection is treated as unavailable without rebuild", () => {
    const missingHome = mkdtempSync(join(tmpdir(), "ocx-cl06-missing-"));
    try {
      const snap = loadCompatibilityEvidenceSnapshot(["missing-subject"], missingHome);
      expect(snap.projectionAvailable).toBe(false);
    } finally {
      rmSync(missingHome, { recursive: true, force: true });
    }
  });

  test("reader matches exact suite version and manifest digest", () => {
    const snapshot = {
      projectionAvailable: true,
      projectionIncompatible: false,
      bySubject: new Map([[SUBJECT_ID, [
        { subjectId: SUBJECT_ID, evidenceLayer: "live_route_compatibility" as const, suiteId: "responses-core", suiteVersion: "1", suiteManifestDigest: "1".repeat(64), verdict: "VERIFIED" as const, asOf: 1, notes: [] },
        { subjectId: SUBJECT_ID, evidenceLayer: "live_route_compatibility" as const, suiteId: "responses-core", suiteVersion: "2", suiteManifestDigest: "2".repeat(64), verdict: "DEGRADED" as const, asOf: 2, notes: [] },
      ]]]),
    };
    expect(findVerdictForSuite(snapshot, SUBJECT_ID, "live_route_compatibility", "responses-core", "2", "2".repeat(64))?.verdict).toBe("DEGRADED");
    expect(findVerdictForSuite(snapshot, SUBJECT_ID, "live_route_compatibility", "responses-core", "3", "3".repeat(64))).toBeUndefined();
  });

  test("policy evaluation does not import live probe executors", async () => {
    const mod = await import("../src/routing/compatibility/policy");
    expect(Object.keys(mod)).not.toContain("runLiveScenario");
  });

  test("legacy assembly skips all compatibility catalog/subject/projection work", () => {
    const config = baseConfig();
    const legacy = getRoutingProfile(config, "legacy")!;
    let calls = 0;
    const rows = assemblePolicyCandidateEvidence(config, legacy, 123, {
      routedProviderConfig: (_name, provider) => provider,
      resolveSubjects: () => { calls++; throw new Error("should not resolve"); },
      loadCatalogSnapshot: () => { calls++; throw new Error("should not catalog"); },
      loadEvidenceSnapshot: () => { calls++; throw new Error("should not read"); },
    });
    expect(rows).toHaveLength(1);
    expect(calls).toBe(0);
  });

  test("compatibility assembly resolves each candidate exactly once", () => {
    const config = baseConfig();
    const compat = getRoutingProfile(config, "compat")!;
    let resolves = 0;
    // Compatibility evidence is provider-supplied since the Lab/core boundary landed
    // (devlog/_fin/260814_lab_core_decoupling): the core assembler no longer reaches Lab
    // itself, so the test installs the provider the activation path would install.
    const detach = setCompatibilityEvidenceProvider(labCompatibilityEvidenceProvider);
    const rows = assemblePolicyCandidateEvidence(config, compat, 123, {
      routedProviderConfig: (_name, provider) => provider,
      resolveSubjects: () => {
        resolves++;
        return { subjectIds: { live_route_compatibility: SUBJECT_ID } };
      },
      loadCatalogSnapshot: () => new Map([["live_route_compatibility:responses-core", {
        suiteId: "responses-core",
        evidenceLayer: "live_route_compatibility",
        suiteVersion: "1",
        suiteManifestDigest: SUITE_DIGEST,
        maxAgeMs: null,
      }]]),
      loadEvidenceSnapshot: () => ({ projectionAvailable: true, projectionIncompatible: false, bySubject: new Map() }),
    });
    detach();
    expect(rows).toHaveLength(1);
    expect(resolves).toBe(1);
  });

  test("compatibility penalty lowers score instead of rewarding unknown evidence", () => {
    const config = baseConfig({
      routingProfiles: {
        compat: {
          candidates: [{ provider: "a", model: "m1" }],
          optimize: { latency: 1, health: 0, cost: 0, quota: 0 },
          compatibility: {
            requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
            unknownEvidence: "penalize",
            degradedEvidence: "penalize",
          },
        },
      },
    });
    const common = { provider: "a", model: "m1", capability: { tools: true, contextWindow: 200000 } };
    const satisfied = evaluatePolicyProfile(config, "compat", {}, [{ ...common, compatibility: evidence("VERIFIED", 1000) }], 1000);
    const penalized = evaluatePolicyProfile(config, "compat", {}, [{ ...common, compatibility: evidence("UNKNOWN", 1000) }], 1000);
    expect(penalized.candidates[0]!.score!.total).toBeLessThan(satisfied.candidates[0]!.score!.total);
    expect(penalized.candidates[0]!.score!.components.compatibility).toBe(0.3);
    expect(satisfied.candidates[0]!.score!.components.compatibility).toBeUndefined();
  });

  test("requirements beyond trace cap are still enforced", () => {
    const subjectId = "9".repeat(64);
    const requirements = Array.from({ length: 9 }, (_, i) => ({
      suiteId: `suite-${i}`,
      evidenceLayer: "live_route_compatibility" as const,
    }));
    const suites = requirements.map((row, i) => ({
      subjectId,
      ...row,
      suiteVersion: "1",
      suiteManifestDigest: `${i}`.repeat(64).slice(0, 64),
      verdict: (i === 8 ? "UNSUPPORTED" : "VERIFIED") as "UNSUPPORTED" | "VERIFIED",
      asOf: 1000,
      maxAgeMs: null,
      notes: [],
    }));
    const out = evaluateCompatibilityForCandidate({
      ...policy,
      requiredSuites: requirements,
      minStatus: "VERIFIED",
    }, {
      subjectIds: { live_route_compatibility: subjectId },
      projectionAvailable: true,
      suites,
    }, 1000);
    expect(out.exclusions.some(row => row.code === "compatibility-unsupported" && row.detail === "suite-8")).toBe(true);
    expect(out.suiteTraces).toHaveLength(8);
    expect(out.traceTruncated).toBe(true);
    expect(out.trace?.truncated).toBe(true);
  });

  test("profile validation bounds compatibility requirements", () => {
    const config = baseConfig();
    const issues = routingProfileIssues("too-many", {
      candidates: [{ provider: "a", model: "m1" }],
      compatibility: {
        requiredSuites: Array.from({ length: 9 }, (_, i) => ({
          suiteId: `suite-${i}`,
          evidenceLayer: "live_route_compatibility",
        })),
      },
    }, config);
    expect(issues.some(issue => issue.path.join(".") === "compatibility.requiredSuites" && issue.message.includes("at most 8"))).toBe(true);

    expect(routingProfileIssues("zero-age", {
      candidates: [{ provider: "a", model: "m1" }],
      compatibility: {
        requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
        maxEvidenceAgeMs: 0,
      },
    }, config)).toEqual([]);
    expect(routingProfileIssues("negative-age", {
      candidates: [{ provider: "a", model: "m1" }],
      compatibility: {
        requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
        maxEvidenceAgeMs: -1,
      },
    }, config).some(issue => issue.path.join(".") === "compatibility.maxEvidenceAgeMs")).toBe(true);
  });

  test("compatibility profile revision changes when only compatibility changes", () => {
    const config = baseConfig();
    const raw = config.routingProfiles!.compat!;
    const base = normalizeRoutingProfile("compat", raw);
    const same = normalizeRoutingProfile("compat", structuredClone(raw));
    const changedRaw = structuredClone(raw);
    changedRaw.compatibility = { ...changedRaw.compatibility, minStatus: "VERIFIED" };
    const changed = normalizeRoutingProfile("compat", changedRaw);
    expect(same.revision).toBe(base.revision);
    expect(changed.revision).not.toBe(base.revision);
  });

  test("compatibility truncation survives persisted trace normalization", () => {
    const normalized = normalizeRouteDecisionTrace({
      version: 1,
      decisionId: "a".repeat(12),
      createdAt: 1,
      requestedModel: "policy/compat",
      routeKind: "policy",
      requirements: [],
      candidates: [{
        provider: "a",
        model: "m1",
        eligible: true,
        exclusions: [],
        compatibility: {
          truncated: true,
          suites: [{
            suiteId: "responses-core",
            evidenceLayer: "live_route_compatibility",
            subjectIdPrefix: "1".repeat(16),
            outcome: "satisfied",
          }],
        },
      }],
      selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "policy-selected" },
    });
    expect(normalized?.truncated?.compatibility).toBe(true);
    expect(normalized?.candidates[0]?.compatibility?.suites[0]?.subjectIdPrefix).toBe("1".repeat(16));
  });

  test("subject id is stable for frozen route subject", () => {
    const subject = {
      subjectSchemaVersion: 1 as const,
      subjectKind: "route" as const,
      providerId: "a",
      providerInstanceFingerprint: "a".repeat(64),
      clientModelId: "m1",
      upstreamModelId: "m1",
      effectiveAdapter: "openai-responses",
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-responses",
      surface: "responses-http",
      opencodexCompatibilityVersion: COMPAT_VERSION,
      behaviorFingerprint: "b".repeat(64),
      endpointFingerprint: "c".repeat(64),
      dependencies: [],
    };
    expect(subjectIdForSubject(subject)).toBe(subjectIdForSubject({ ...subject }));
  });
});
