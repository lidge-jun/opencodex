import { describe, expect, test } from "bun:test";
import {
  FABRIC_SCENARIO_ID,
  FABRIC_SCENARIO_VERSION,
  FABRIC_SUITE_ID,
  FABRIC_SUITE_VERSION,
  FABRIC_VERIFIER_ID,
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  assignEventId,
  buildTaskSubjectV1,
  subjectIdForSubject,
  taskSubjectId,
  type ObservationEvent,
  type ProtocolSubjectV1,
  type RouteSubjectV1,
  type TaskSubjectV1,
} from "../src/lab";
import {
  PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  PUBLIC_ROUTE_REGISTRY_V1,
  PublicEvidenceValidationError,
  authorizePublicRouteSubject,
  authorizePublicTaskSubject,
  isPublicIncidentRef,
  projectPublicEvidence,
  projectPublicEvidenceRecord,
  publicEvidenceId,
  validatePublicEvidenceBundleUnsigned,
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
    environment: {
      localPath: "C:\\Users\\private\\repo",
      authorization: "Bearer sk-private-CANARY",
      email: "private@example.com",
      endpoint: "https://private.example.test/v1?tenant=acme",
      ip: "10.23.45.67",
    },
    artifactRefs: [],
    sourceRefs: ["request_1234567890", "decision_1234567890"],
  }) as ObservationEvent;
}

function routeObservation(): ObservationEvent {
  const subject: RouteSubjectV1 = {
    subjectSchemaVersion: 1,
    subjectKind: "route",
    providerId: "openai-apikey",
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

function taskObservation(): ObservationEvent {
  const route = routeObservation();
  const subject = buildTaskSubjectV1({ routeSubject: route.subject as RouteSubjectV1 });
  const subjectId = taskSubjectId(subject);
  return assignEventId({
    ...route,
    eventId: undefined,
    evidenceLayer: "task_effectiveness" as const,
    suiteId: FABRIC_SUITE_ID,
    suiteVersion: FABRIC_SUITE_VERSION,
    scenarioId: FABRIC_SCENARIO_ID,
    scenarioVersion: FABRIC_SCENARIO_VERSION,
    executionMode: "sandbox" as const,
    subject,
    subjectId,
    sourceRefs: ["fabric_run_PRIVATE"],
  }) as ObservationEvent;
}

function routeAuthority(event = routeObservation()) {
  const authority = authorizePublicRouteSubject({
    subject: event.subject as RouteSubjectV1,
    localSubjectId: event.subjectId,
    effectiveBaseUrl: "https://api.openai.com/v1",
    privateBehaviorDimensions: [],
  });
  if (!authority) throw new Error("expected public route authority");
  return authority;
}

describe("CL-10 public authority", () => {
  test("ships a closed, self-consistent public route registry manifest", () => {
    const manifest = validatePublicRouteRegistryManifest(PUBLIC_ROUTE_REGISTRY_V1);
    expect(manifest.schemaVersion).toBe("public_route_registry_v1");
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.entries.every((entry) => entry.providerId && entry.modelId)).toBe(true);
    expect(manifest.entries.every((entry) => entry.canonicalBaseUrl.startsWith("https://"))).toBe(true);
  });

  test("public incident references are closed corpus ids only", () => {
    expect(isPublicIncidentRef("IC-001")).toBe(true);
    expect(isPublicIncidentRef("IC-020")).toBe(true);
    expect(isPublicIncidentRef("https://github.com/private/issue/1")).toBe(false);
    expect(isPublicIncidentRef("devlog/_plan/private.md")).toBe(false);
    expect(isPublicIncidentRef("IC-1")).toBe(false);
  });

  test("authorises only an exact canonical route with no private behavior dimensions", () => {
    const event = routeObservation();
    const authority = routeAuthority(event);
    expect(authority.descriptor.providerId).toBe("openai-apikey");
    expect(authority.descriptor.modelId).toBe("gpt-5.6-sol");

    expect(authorizePublicRouteSubject({
      subject: event.subject as RouteSubjectV1,
      localSubjectId: event.subjectId,
      effectiveBaseUrl: "https://proxy.private.example/v1",
      privateBehaviorDimensions: [],
    })).toBeNull();
    expect(authorizePublicRouteSubject({
      subject: event.subject as RouteSubjectV1,
      localSubjectId: event.subjectId,
      effectiveBaseUrl: "https://api.openai.com/v1",
      privateBehaviorDimensions: ["headers"],
    })).toBeNull();
    expect(authorizePublicRouteSubject({
      subject: event.subject as RouteSubjectV1,
      localSubjectId: hex("wrong-local-subject"),
      effectiveBaseUrl: "https://api.openai.com/v1",
      privateBehaviorDimensions: [],
    })).toBeNull();
  });
});

describe("CL-10 public projection", () => {
  test("projects protocol evidence without leaking local ids, diagnostics, secrets, or assertion text", () => {
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
      "sk-private-CANARY",
      "private@example.com",
      "private.example.test",
      "10.23.45.67",
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

  test("projects an exact reviewed public route only with a trusted authority", () => {
    const event = routeObservation();
    const authority = routeAuthority(event);
    const result = projectPublicEvidenceRecord({ observation: event, verdict: "PROBED", routeAuthority: authority });
    expect(result.status).toBe("exportable");
    if (result.status !== "exportable") throw new Error("expected exportable route record");
    expect(result.record.subject).toMatchObject({
      subjectKind: "route",
      providerId: "openai-apikey",
      modelId: "gpt-5.6-sol",
    });
    const serialized = JSON.stringify(result.record);
    expect(serialized).not.toContain((event.subject as RouteSubjectV1).providerInstanceFingerprint);
    expect(serialized).not.toContain((event.subject as RouteSubjectV1).endpointFingerprint);
    expect(serialized).not.toContain((event.subject as RouteSubjectV1).behaviorFingerprint);

    const forged = { ...authority };
    expect(projectPublicEvidenceRecord({ observation: event, verdict: "PROBED", routeAuthority: forged })).toEqual({
      status: "not_exportable",
      reason: "private_route_identity",
    });
  });

  test("projects only the frozen public Fabric task authority", () => {
    const event = taskObservation();
    const routeSubject = (event.subject as TaskSubjectV1).routeSubject;
    const routeEvent = routeObservation();
    const routeAuth = authorizePublicRouteSubject({
      subject: routeSubject,
      localSubjectId: subjectIdForSubject(routeSubject),
      effectiveBaseUrl: "https://api.openai.com/v1",
      privateBehaviorDimensions: [],
    });
    if (!routeAuth) throw new Error("expected route authority");
    const taskAuthority = authorizePublicTaskSubject({
      subject: event.subject as TaskSubjectV1,
      localSubjectId: event.subjectId,
      routeAuthority: routeAuth,
    });
    expect(taskAuthority).not.toBeNull();
    const result = projectPublicEvidenceRecord({
      observation: event,
      verdict: "VERIFIED",
      taskAuthority: taskAuthority ?? undefined,
    });
    expect(result.status).toBe("exportable");
    if (result.status !== "exportable") throw new Error("expected exportable task record");
    expect(result.record.subject).toMatchObject({
      subjectKind: "task",
      taskClassId: FABRIC_SCENARIO_ID,
      taskClassVersion: FABRIC_SCENARIO_VERSION,
      verifierAuthorityId: FABRIC_VERIFIER_ID,
    });
    const serialized = JSON.stringify(result.record);
    expect(serialized).not.toContain(event.subjectId);
    expect(serialized).not.toContain((event.subject as TaskSubjectV1).taskFixtureDigest);
    expect(serialized).not.toContain((event.subject as TaskSubjectV1).verifierManifestDigest);
    expect(routeEvent.subjectId).not.toBe(event.subjectId);
  });

  test("uses domain-separated deterministic public ids", () => {
    const payload = { providerId: "openai-apikey", modelId: "gpt-5.6-sol" };
    const a = publicEvidenceId("subject", payload);
    const b = publicEvidenceId("subject", payload);
    const c = publicEvidenceId("record", payload);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(c);
  });

  test("runtime validation rejects unknown top-level and nested public fields", () => {
    const result = projectPublicEvidenceRecord({ observation: protocolObservation(), verdict: "VERIFIED" });
    if (result.status !== "exportable") throw new Error("expected exportable protocol record");
    const withUnknown = { ...result.record, localSubjectId: "PRIVATE" };
    expect(() => validatePublicEvidenceRecord(withUnknown)).toThrow(PublicEvidenceValidationError);
    const nestedUnknown = {
      ...result.record,
      subject: { ...result.record.subject, behaviorFingerprint: hex("PRIVATE") },
    };
    expect(() => validatePublicEvidenceRecord(nestedUnknown)).toThrow(PublicEvidenceValidationError);
  });

  test("builds a closed deterministic unsigned bundle and reports exclusions", () => {
    const privateRoute = routeObservation();
    const projected = projectPublicEvidence({
      createdDayUtc: "2026-08-12",
      records: [
        { observation: protocolObservation(), verdict: "VERIFIED" },
        { observation: privateRoute, verdict: "PROBED" },
      ],
    });
    expect(projected.bundle.schemaVersion).toBe(PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION);
    expect(projected.bundle.records).toHaveLength(1);
    expect(projected.bundle.artifacts).toEqual([]);
    expect(projected.excluded).toEqual([{ index: 1, reason: "private_route_identity" }]);
    expect(projected.bundle.bundleId).toMatch(/^[0-9a-f]{64}$/);
    expect(validatePublicEvidenceBundleUnsigned(projected.bundle)).toEqual(projected.bundle);
    expect(JSON.stringify(projected.bundle)).not.toContain(privateRoute.subjectId);
  });
});
