import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  assignEventId,
  subjectIdForSubject,
  type ObservationEvent,
  type ProtocolSubjectV1,
} from "../src/lab";
import {
  createPublicEvidenceRevocation,
  importCommunityEvidenceBundle,
  importCommunityEvidenceRevocation,
  listCommunityEvidence,
  projectPublicEvidence,
  signPublicEvidenceBundle,
} from "../src/lab/public";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function hex(seed: string): string {
  return Bun.CryptoHasher.hash("sha256", seed, "hex");
}

function observation(): ObservationEvent {
  const subject: ProtocolSubjectV1 = {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: "2.13.0",
    effectiveAdapter: "openai-chat",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
    behaviorFingerprint: hex("PRIVATE-publisher-continuity"),
  };
  return assignEventId({
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "observation" as const,
    recordedAt: Date.UTC(2026, 7, 12, 14, 37, 48),
    producer: LAB_PRODUCER,
    producerVersion: "2.13.0",
    evidenceLayer: "protocol_conformance" as const,
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1.0.0",
    scenarioManifestDigest: hex("scenario"),
    suiteId: "responses-core",
    suiteVersion: "1.0.0",
    suiteManifestDigest: hex("suite"),
    fixtureDigests: [hex("fixture")],
    subject,
    subjectId: subjectIdForSubject(subject),
    startedAt: Date.UTC(2026, 7, 12, 14, 37, 40),
    completedAt: Date.UTC(2026, 7, 12, 14, 37, 41),
    executionMode: "fixture" as const,
    attempt: 1,
    limits: { totalTimeoutMs: 1000 },
    outcome: "pass" as const,
    assertions: [
      { id: "method", operator: "equals", required: true, passed: true },
      { id: "message", operator: "equals", required: true, passed: true },
      { id: "temperature", operator: "equals", required: true, passed: true },
    ],
    environment: {},
    artifactRefs: [],
  }) as ObservationEvent;
}

function projectedBundle() {
  return projectPublicEvidence({
    createdDayUtc: "2026-08-12",
    records: [{ observation: observation(), verdict: "VERIFIED" }],
  }).bundle;
}

describe("CL-10 publisher continuity", () => {
  test("same content from two publishers coexists and revokes independently", () => {
    const publisherA = configDir("ocx-cl10-publisher-a-");
    const publisherB = configDir("ocx-cl10-publisher-b-");
    const consumer = configDir("ocx-cl10-consumer-");
    const unsigned = projectedBundle();
    const bundleA = signPublicEvidenceBundle({ ...unsigned, configDir: publisherA });
    const bundleB = signPublicEvidenceBundle({ ...unsigned, configDir: publisherB });

    expect(bundleA.bundleId).not.toBe(bundleB.bundleId);
    expect(bundleA.publisher.keyId).not.toBe(bundleB.publisher.keyId);
    expect(importCommunityEvidenceBundle(bundleA, consumer).created).toBe(true);
    expect(importCommunityEvidenceBundle(bundleB, consumer).created).toBe(true);

    let summaries = listCommunityEvidence(consumer);
    expect(summaries).toHaveLength(2);
    expect(new Set(summaries.map((row) => row.publisherKeyId)).size).toBe(2);

    const revocationA = createPublicEvidenceRevocation({
      configDir: publisherA,
      targetBundle: bundleA,
      issuedDayUtc: "2026-08-12",
      reason: "publisher_retracted",
      targets: [{ kind: "bundle", id: bundleA.bundleId }],
    });
    expect(importCommunityEvidenceRevocation(revocationA, consumer).created).toBe(true);

    summaries = listCommunityEvidence(consumer);
    const rowA = summaries.find((row) => row.publisherKeyId === bundleA.publisher.keyId)!;
    const rowB = summaries.find((row) => row.publisherKeyId === bundleB.publisher.keyId)!;
    expect(rowA).toMatchObject({ activeRecordCount: 0, revokedRecordCount: 1 });
    expect(rowB).toMatchObject({ activeRecordCount: 1, revokedRecordCount: 0 });
  });
});