import { expect, test } from "bun:test";
import {
  assignEventId,
  projectVerdicts,
  subjectIdForSubject,
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
} from "../src/lab";
import type { SuiteManifestV1 } from "../src/lab/conformance/suite-manifest";
import type { ObservationEvent, ProtocolSubjectV1 } from "../src/lab/events/types";
import { evaluateAllApplicableRequiredPassV1 } from "../src/lab/projection/verification";

function hash(value: string): string {
  return Bun.CryptoHasher.hash("sha256", value, "hex");
}

function protocolSubject(seed = "projection"): ProtocolSubjectV1 {
  return {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: "protocol-v1",
    effectiveAdapter: "openai-chat",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
    behaviorFingerprint: hash(seed),
  };
}

function observation(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  const {
    subject: subjectOverride,
    subjectId: _ignoredSubjectId,
    ...eventOverrides
  } = overrides;
  void _ignoredSubjectId;
  const subject = subjectOverride?.subjectKind === "protocol"
    ? subjectOverride
    : protocolSubject(overrides.scenarioId ?? "projection");
  const subjectId = subjectIdForSubject(subject);
  const scenarioManifestDigest = eventOverrides.scenarioManifestDigest ?? hash(`scenario:${eventOverrides.scenarioId ?? "required"}`);
  const suiteManifestDigest = eventOverrides.suiteManifestDigest ?? hash("suite:projection");
  const fixtureDigest = hash("fixture:projection");

  return assignEventId({
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "observation" as const,
    recordedAt: 10_000,
    producer: LAB_PRODUCER,
    producerVersion: "2.10.2",
    evidenceLayer: "protocol_conformance" as const,
    scenarioId: "responses-core.protocol.required",
    scenarioVersion: "1",
    scenarioManifestDigest,
    suiteId: "responses-core",
    suiteVersion: "1",
    suiteManifestDigest,
    fixtureDigests: [fixtureDigest],
    startedAt: 9_900,
    completedAt: 10_000,
    executionMode: "fixture" as const,
    attempt: 1,
    limits: { totalTimeoutMs: 1_000 },
    outcome: "pass" as const,
    assertions: [
      {
        id: "required",
        operator: "equals",
        required: true,
        passed: true,
        expectedSummary: "ok",
        observedSummary: "ok",
      },
    ],
    environment: { runtime: { platform: "test", arch: "x64", bunVersion: "1.0.0" } },
    artifactRefs: [
      {
        digest: scenarioManifestDigest,
        mediaType: "application/json",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${scenarioManifestDigest}.bin`,
        artifactClass: "scenario_manifest" as const,
      },
      {
        digest: suiteManifestDigest,
        mediaType: "application/json",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${suiteManifestDigest}.bin`,
        artifactClass: "suite_manifest" as const,
      },
      {
        digest: fixtureDigest,
        mediaType: "application/octet-stream",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${fixtureDigest}.bin`,
        artifactClass: "fixture" as const,
      },
    ],
    ...eventOverrides,
    subject,
    subjectId,
  }) as ObservationEvent;
}

test("verification uses the stricter suite/scenario freshness bound", () => {
  const obs = observation();
  const manifest: SuiteManifestV1 = {
    schemaVersion: 1,
    id: obs.suiteId,
    version: obs.suiteVersion,
    evidenceLayer: "protocol_conformance",
    capability: "responses-core",
    assertionDslVersion: "1",
    evidenceSchemaVersion: "1",
    freshness: { maxAgeMs: 1_000 },
    contradictionRule: "newest-required-observation-v1",
    scenarios: [
      {
        id: obs.scenarioId,
        version: obs.scenarioVersion,
        role: "required",
        manifestDigest: obs.scenarioManifestDigest,
      },
    ],
    verificationRule: "all-applicable-required-pass-v1",
  };
  const loadScenarioRequirements = () => ({
    inboundProtocols: ["openai-responses"],
    upstreamProtocols: ["openai-chat"],
    surfaces: ["responses-http"],
    freshness: { maxAgeMs: 500 },
  });

  const atBoundary = evaluateAllApplicableRequiredPassV1(manifest, [obs], "fixture", {
    subject: obs.subject as ProtocolSubjectV1,
    loadScenarioRequirements,
    asOf: obs.completedAt + 500,
  });
  expect(atBoundary.canVerify).toBe(true);
  expect(atBoundary.notes).not.toContain(`stale_observation:${obs.scenarioId}`);

  const stale = evaluateAllApplicableRequiredPassV1(manifest, [obs], "fixture", {
    subject: obs.subject as ProtocolSubjectV1,
    loadScenarioRequirements,
    asOf: obs.completedAt + 501,
  });
  expect(stale.canVerify).toBe(false);
  expect(stale.missingRequiredScenarioIds).toEqual([obs.scenarioId]);
  expect(stale.notes).toContain(`stale_observation:${obs.scenarioId}`);
});

test("matched capability-absence control projects UNSUPPORTED without changing V1 authority", () => {
  const obs = observation({
    expectedFailure: {
      controlKind: "capability_absence_control",
      expectedClass: "capability_failure",
      expectedCode: "capability_unavailable",
      assertionIds: ["required"],
      onMatch: "unsupported",
      onMismatch: "fail",
    },
  });

  const projected = projectVerdicts([obs]);
  expect(projected.corruptions).toEqual([]);
  expect(projected.verdicts).toHaveLength(1);
  expect(projected.verdicts[0]!.verdict).toBe("UNSUPPORTED");
  expect(projected.verdicts[0]!.notes).toContain("capability_absence_control");
  expect(projected.verdicts[0]!.contributingEventIds).toContain(obs.eventId);
});
