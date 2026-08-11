import type { CaseRecord, VerificationRole } from "../conformance/types";
import { fixtureDigest, scenarioManifestDigest, suiteManifestDigest } from "../digest";
import {
  FABRIC_EVIDENCE_LAYER,
  FABRIC_LIMITS,
  FABRIC_SCENARIO_ID,
  FABRIC_SCENARIO_VERSION,
  FABRIC_SUITE_ID,
  FABRIC_SUITE_VERSION,
  FABRIC_TASK_CLASS_ID,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_VALUE_PATH,
} from "./constants";
import { verifierManifestDigest } from "./subject";

/** In-memory authority for the frozen CL-07 fabric scenario catalogue. */
export interface FabricCaseAuthority {
  schemaVersion: number;
  sourceCommit: string;
  assertionDslVersion: string;
  evidenceSchemaVersion: string;
  manifestDefaults: {
    version: string;
    suiteVersion: string;
    evidenceLayer: typeof FABRIC_EVIDENCE_LAYER;
    verificationRole: VerificationRole;
    freshness: { maxAgeMs: number | null };
    executionLimits: Record<string, number | null>;
    artifactPolicy: Record<string, unknown>;
  };
  cases: CaseRecord[];
}

const FABRIC_SOURCE_COMMIT = "b66e33ce7207d91014644d99317e456c992a3418";
const FIXTURE_BYTES_UTF8 = JSON.stringify({
  path: SYNTHETIC_VALUE_PATH,
  before: SYNTHETIC_BEFORE_UTF8,
  after: SYNTHETIC_AFTER_UTF8,
});

/** Frozen CL-07 fabric scenario authority loaded from compiled constants. */
export function loadFabricCaseAuthority(): FabricCaseAuthority {
  const fixtureBytes = new TextEncoder().encode(FIXTURE_BYTES_UTF8);
  const digest = fixtureDigest(fixtureBytes);
  return {
    schemaVersion: 1,
    sourceCommit: FABRIC_SOURCE_COMMIT,
    assertionDslVersion: "1.0.0",
    evidenceSchemaVersion: "1.0.0",
    manifestDefaults: {
      version: FABRIC_SCENARIO_VERSION,
      suiteVersion: FABRIC_SUITE_VERSION,
      evidenceLayer: FABRIC_EVIDENCE_LAYER,
      verificationRole: "required",
      freshness: { maxAgeMs: 2_592_000_000 },
      executionLimits: {
        totalTimeoutMs: FABRIC_LIMITS.totalTimeoutMs,
        inactivityTimeoutMs: FABRIC_LIMITS.inactivityTimeoutMs,
        maxInputBytes: FABRIC_LIMITS.maxAggregateIoBytes,
        maxOutputBytes: FABRIC_LIMITS.maxAggregateIoBytes,
        maxArtifactBytes: FABRIC_LIMITS.aggregateArtifactBytes,
        maxRequests: 0,
        maxToolCalls: 0,
        maxOutputTokens: null,
        connectTimeoutMs: null,
        firstByteTimeoutMs: null,
      },
      artifactPolicy: {
        retain: ["verifier_summary", "normalized_tree_diff", "execution_metadata"],
        forbid: ["file_bodies", "prompts", "raw_logs"],
      },
    },
    cases: [{
      id: FABRIC_SCENARIO_ID,
      suite: FABRIC_SUITE_ID,
      capability: FABRIC_TASK_CLASS_ID,
      verificationRole: "required",
      requirements: {
        inboundProtocols: [],
        upstreamProtocols: [],
        surfaces: [],
        requiredClaims: [],
        requiredHarnessFeatures: ["fabric-scratch-v1"],
        platforms: ["*"],
        routePreconditions: ["exact-route-subject"],
      },
      fixture: {
        id: "fabric-core.task.synthetic-patch.fixture",
        role: "adapter_vector",
        mediaType: "application/json",
        bytesUtf8: FIXTURE_BYTES_UTF8,
        digest,
      },
      assertions: [{
        id: "exact-tree-diff-pass",
        operator: "equals",
        selector: "/verifier/passed",
        expected: true,
        required: true,
      }],
    }],
  };
}

/** List fabric scenarios, optionally filtered by suite id. */
export function discoverFabricScenarios(
  authority: FabricCaseAuthority = loadFabricCaseAuthority(),
  suites?: readonly string[],
): CaseRecord[] {
  return authority.cases.filter((row) => !suites || suites.includes(row.suite));
}

/** Expand a fabric case into the canonical scenario manifest object. */
export function expandFabricScenario(
  caseRecord: CaseRecord,
  authority: FabricCaseAuthority = loadFabricCaseAuthority(),
): Record<string, unknown> {
  const defaults = authority.manifestDefaults;
  return {
    schemaVersion: authority.schemaVersion,
    id: caseRecord.id,
    version: defaults.version,
    suite: {
      id: caseRecord.suite,
      version: defaults.suiteVersion,
      evidenceLayer: defaults.evidenceLayer,
    },
    evidenceLayer: defaults.evidenceLayer,
    capability: caseRecord.capability,
    verificationRole: caseRecord.verificationRole ?? defaults.verificationRole,
    requirements: caseRecord.requirements,
    fixtures: [{
      id: caseRecord.fixture.id,
      role: caseRecord.fixture.role,
      mediaType: caseRecord.fixture.mediaType,
      digest: caseRecord.fixture.digest,
      byteLength: Buffer.byteLength(caseRecord.fixture.bytesUtf8, "utf8"),
      syntheticMarker: "ocx-lab-synthetic-v1",
      provenance: {
        kind: "lab_authored",
        authority: "007_cl07_task_effectiveness.md",
        sourceCommit: authority.sourceCommit,
      },
    }],
    executionLimits: defaults.executionLimits,
    assertions: caseRecord.assertions,
    failureRules: [
      {
        id: "verifier-fail",
        match: ["behavioral_failure"],
        classification: "behavioral_failure",
        verdictEffect: "degraded",
        retry: "never",
        expected: false,
      },
      {
        id: "sandbox-block",
        match: ["sandbox_violation"],
        classification: "sandbox_violation",
        verdictEffect: "none",
        retry: "bounded",
        expected: false,
      },
      {
        id: "timeout-block",
        match: ["timeout", "inactivity_timeout", "budget_exhausted"],
        classification: "timeout",
        verdictEffect: "none",
        retry: "bounded",
        expected: false,
      },
    ],
    artifactPolicy: defaults.artifactPolicy,
    freshness: defaults.freshness,
    verifierManifestDigest: verifierManifestDigest(),
  };
}

/** Expand a fabric suite id into the canonical suite manifest object. */
export function expandFabricSuiteManifest(
  suiteId: string = FABRIC_SUITE_ID,
  authority: FabricCaseAuthority = loadFabricCaseAuthority(),
): Record<string, unknown> {
  const cases = authority.cases.filter((row) => row.suite === suiteId);
  if (cases.length === 0) throw new Error(`unknown fabric suite ${suiteId}`);
  const defaults = authority.manifestDefaults;
  return {
    schemaVersion: 1,
    id: suiteId,
    version: defaults.suiteVersion,
    evidenceLayer: defaults.evidenceLayer,
    capability: cases[0]!.capability,
    assertionDslVersion: authority.assertionDslVersion,
    evidenceSchemaVersion: authority.evidenceSchemaVersion,
    freshness: defaults.freshness,
    contradictionRule: "newest-required-observation-v1",
    scenarios: cases.map((caseRecord) => ({
      id: caseRecord.id,
      version: defaults.version,
      role: caseRecord.verificationRole ?? defaults.verificationRole,
      manifestDigest: scenarioManifestDigest(expandFabricScenario(caseRecord, authority)),
    })),
    verificationRule: "all-applicable-required-pass-v1",
  };
}

/** Digest of the expanded fabric scenario manifest for a case. */
export function fabricScenarioManifestDigest(
  caseRecord: CaseRecord = loadFabricCaseAuthority().cases[0]!,
  authority: FabricCaseAuthority = loadFabricCaseAuthority(),
): string {
  return scenarioManifestDigest(expandFabricScenario(caseRecord, authority));
}

/** Digest of the expanded fabric suite manifest. */
export function fabricSuiteManifestDigest(
  suiteId: string = FABRIC_SUITE_ID,
  authority: FabricCaseAuthority = loadFabricCaseAuthority(),
): string {
  return suiteManifestDigest(expandFabricSuiteManifest(suiteId, authority));
}
