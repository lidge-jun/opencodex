import { describe, expect, test } from "bun:test";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  assignEventId,
  subjectIdForSubject,
  type ObservationEvent,
  type ProtocolSubjectV1,
  type RouteSubjectV1,
} from "../src/lab";
import {
  PUBLIC_ROUTE_REGISTRY_V1,
  PublicEvidenceValidationError,
  isPublicIncidentRef,
  projectPublicEvidenceRecord,
  publicEvidenceId,
  validatePublicEvidenceRecord,
  validatePublicRouteRegistryManifest,
} from "../src/lab/public";

function hex(seed: string): string {
  return Bun.CryptoHasher.hash("sha256", seed, "hex");
}

function protocolObservation(): ObservationEvent {
  const subject: ProtocolSubjectV1 = {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: "2.13.0",
    effectiveAdapter: "openai-chat",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
    behaviorFingerprint: hex("private-protocol-behavior"),
  };
  const subjectId = subjectIdForSubject(subject);
  return assignEventId({
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "observation" as const,
    recordedAt: Date.UTC(2026, 7, 12, 14, 37, 48),
    producer: LAB_PRODUCER,
    producerVersion: "2.13.0",
    evidenceLayer: "protocol_conformance" as const,
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1",
    scenarioManifestDigest: hex("scenario"),
    suiteId: "responses-core",
    suiteVersion: "1",
    suiteManifestDigest: hex("suite"),
    fixtureDigests: [hex("fixture")],
    subject,
    subjectId,
    startedAt: Date.UTC(2026, 7, 12, 14, 37, 40),
    completedAt: Date.UTC(2026, 7, 12, 14, 37, 41),
    executionMode: "fixture" as const,
    attempt: 1,
    limits: { totalTimeoutMs: 1000 },
    outcome: "pass" as const,
    assertions: [{
      id: "request-shape",
      operator: "equals",
      required: true,
      passed: true,
      expectedSummary: "CANARY-PRIVATE-EXPECTED",
      observedSummary: "CANARY-PRIVATE-OBSERVED",
    }],
    environment: { localPath: "C:\\Users\\private\\repo" },
    artifactRefs: [],
    sourceRefs: ["request_1234567890", "decision_1234567890"],
  }) as ObservationEvent;
}

function routeObservation(): ObservationEvent {
  const subject: RouteSubjectV1 = {
    subjectSchemaVersion: 1,
    subjectKind: "route",
    providerId: "openai",
    providerInstanceFingerprint: hex("PRIVATE-provider-instance"),
    clientModelId: "gpt-5.6-sol",
    upstreamModelId: "gpt-5.6-sol",
    effectiveAdapter: "openai-responses",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-responses",
    surface: "responses-http",
    opencodexCompatibilityVersion: "2.13.0",
    behaviorFingerprint: hex("PRIVATE-route-behavior"),
    endpointFingerprint: hex("PRIVATE-endpoint"),
    dependencies: [],
  };
  const subjectId = subjectIdForSubject(subject);
  return assignEventId({
    ...protocolObservation(),
    eventId: undefined,
    evidenceLayer: "live_route_compatibility" as const,
    scenarioId: "responses-core.live.request-shape",
    executionMode: "live" as const,
    subject,
    subjectId,
    sourceRefs: ["request_PRIVATE", "decision_PRIVATE"],
  }) as ObservationEvent;
}

describe("CL-10 public authority", () => {
  test("ships a closed, self-consistent public route registry manifest", () => {
    const manifest = validatePublicRouteRegistryManifest(PUBLIC_ROUTE_REGISTRY_V1);
    expect(manifest.schemaVersion).toBe("public_route_registry_v1");
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.entries.every((entry) => entry.providerId && entry.modelId)).toBe(true);
  });

  test("public incident references are closed corpus ids only", () => {
    expect(isPublicIncidentRef("IC-001")).toBe(true);
    expect(isPublicIncidentRef("IC-020")).toBe(true);
    expect(isPublicIncidentRef("https://github.com/private/issue/1")).toBe(false);
    expect(isPublicIncidentRef("devlog/_plan/private.md")).toBe(false);
    expect(isPublicIncidentRef("IC-1")).toBe(false);
  });
});

describe("CL-10 public projection", () => {
  test("projects protocol evidence without leaking local ids, diagnostics, or assertion text", () => {
    const event = protocolObservation();
    const result = projectPublicEvidenceRecord({ observation: event, verdict: "VERIFIED" });
    expect(result.status).toBe("exportable");
    if (result.status !== "exportable") throw new Error("expected exportable protocol record");

    expect(result.record.evidenceLayer).toBe("protocol_conformance");
    expect(result.record.subject.subjectKind).toBe("protocol");
    expect(result.record.observedDayUtc).toBe("2026-08-12");
    expect(result.record.subjectId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.subjectId).not.toBe(event.subjectId);
    expect(result.record.recordId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.assertions).toEqual([{ id: "request-shape", required: true, passed: true }]);

    const serialized = JSON.stringify(result.record);
    for (const canary of [
      event.subjectId,
      event.eventId,
      "CANARY-PRIVATE-EXPECTED",
      "CANARY-PRIVATE-OBSERVED",
      "C:\\Users\\private\\repo",
      "request_1234567890",
      "decision_1234567890",
      (event.subject as ProtocolSubjectV1).behaviorFingerprint,
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  test("does not generalise a private exact route into a public claim", () => {
    const event = routeObservation();
    const result = projectPublicEvidenceRecord({ observation: event, verdict: "PROBED" });
    expect(result).toEqual({ status: "not_exportable", reason: "private_route_identity" });
  });

  test("uses domain-separated deterministic public ids", () => {
    const payload = { providerId: "openai", modelId: "gpt-5.6-sol" };
    const a = publicEvidenceId("subject", payload);
    const b = publicEvidenceId("subject", payload);
    const c = publicEvidenceId("record", payload);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(c);
  });

  test("runtime validation rejects unknown public fields", () => {
    const result = projectPublicEvidenceRecord({ observation: protocolObservation(), verdict: "VERIFIED" });
    if (result.status !== "exportable") throw new Error("expected exportable protocol record");
    const withUnknown = { ...result.record, localSubjectId: "PRIVATE" };
    expect(() => validatePublicEvidenceRecord(withUnknown)).toThrow(PublicEvidenceValidationError);
  });
});
