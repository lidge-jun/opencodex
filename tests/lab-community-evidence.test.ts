import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  assignEventId,
  labLedgerPath,
  labSqlitePath,
  purgeSensitiveEvidence,
  subjectIdForSubject,
  type ObservationEvent,
  type ProtocolSubjectV1,
} from "../src/lab";
import { labCommunityDir } from "../src/lab/paths";
import {
  buildPublicEvidenceBundle,
  createPublicEvidenceRevocation,
  getOrCreatePublicPublisher,
  importCommunityEvidenceBundle,
  importCommunityEvidenceRevocation,
  listCommunityEvidence,
  projectPublicEvidence,
  publicEvidenceId,
  signPublicEvidenceBundle,
  signPublicPublisherDigest,
  verifyPublicEvidenceRevocation,
  writePublicEvidenceBundle,
} from "../src/lab/public";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function configDir(prefix = "ocx-cl10-community-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function hex(seed: string): string {
  return Bun.CryptoHasher.hash("sha256", seed, "hex");
}

function assertionsForScenario(scenarioId: string) {
  const ids = scenarioId === "responses-core.protocol.sse-framing"
    ? ["events", "text", "terminal"]
    : ["method", "message", "temperature"];
  return ids.map((id) => ({ id, operator: "equals", required: true, passed: true }));
}

function protocolObservation(scenarioId = "responses-core.protocol.request-shape"): ObservationEvent {
  const subject: ProtocolSubjectV1 = {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: "2.13.0",
    effectiveAdapter: "openai-chat",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
    behaviorFingerprint: hex("PRIVATE-community-behavior"),
  };
  return assignEventId({
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "observation" as const,
    recordedAt: Date.UTC(2026, 7, 12, 14, 37, 48),
    producer: LAB_PRODUCER,
    producerVersion: "2.13.0",
    evidenceLayer: "protocol_conformance" as const,
    scenarioId,
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
    assertions: assertionsForScenario(scenarioId),
    environment: {},
    artifactRefs: [],
  }) as ObservationEvent;
}

function signedBundle(config: string, scenarioId?: string) {
  const projected = projectPublicEvidence({
    createdDayUtc: "2026-08-12",
    records: [{ observation: protocolObservation(scenarioId), verdict: "VERIFIED" }],
  });
  return signPublicEvidenceBundle({
    records: projected.bundle.records,
    artifacts: projected.bundle.artifacts,
    createdDayUtc: projected.bundle.createdDayUtc,
    configDir: config,
  });
}

function signedUnreviewedScenarioBundle(config: string) {
  const projected = projectPublicEvidence({
    records: [{ observation: protocolObservation(), verdict: "VERIFIED" }],
  });
  const baseRecord = projected.bundle.records[0];
  if (!baseRecord) throw new Error("expected reviewed source record");
  const { recordId: _recordId, ...baseFields } = baseRecord;
  const withoutRecordId = { ...baseFields, scenarioId: "private.unknown.scenario" };
  const record = { recordId: publicEvidenceId("record", withoutRecordId), ...withoutRecordId };
  const handle = getOrCreatePublicPublisher(config);
  const unsigned = buildPublicEvidenceBundle({
    records: [record],
    artifacts: [],
    createdDayUtc: projected.bundle.createdDayUtc,
    publisher: handle.publisher,
  });
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519" as const,
      signedDigest: unsigned.bundleDigest,
      signature: signPublicPublisherDigest(handle, unsigned.bundleDigest),
    },
  };
}

describe("CL-10 community quarantine", () => {
  test("imports valid signed evidence without touching canonical Lab authority", () => {
    const publisherDir = configDir("ocx-cl10-publisher-");
    const consumerDir = configDir("ocx-cl10-consumer-");
    const bundle = signedBundle(publisherDir);
    const imported = importCommunityEvidenceBundle(bundle, consumerDir);
    expect(imported).toMatchObject({ created: true, status: "cryptographically_valid", bundleId: bundle.bundleId });
    expect(existsSync(labLedgerPath(consumerDir))).toBe(false);
    expect(existsSync(labSqlitePath(consumerDir))).toBe(false);
    expect(listCommunityEvidence(consumerDir)).toEqual([expect.objectContaining({
      bundleId: bundle.bundleId,
      status: "cryptographically_valid",
      activeRecordCount: 1,
      revokedRecordCount: 0,
    })]);
    expect(importCommunityEvidenceBundle(bundle, consumerDir).created).toBe(false);
  });

  test("rejects cryptographically valid but unknown scenario authority", () => {
    const publisherDir = configDir("ocx-cl10-publisher-");
    const consumerDir = configDir("ocx-cl10-consumer-");
    const bundle = signedUnreviewedScenarioBundle(publisherDir);
    expect(() => importCommunityEvidenceBundle(bundle, consumerDir)).toThrow(/authority/i);
    expect(listCommunityEvidence(consumerDir)).toEqual([]);
  });

  test("same-key revocation is verified, idempotent, and removes records from default community context", () => {
    const publisherDir = configDir("ocx-cl10-publisher-");
    const consumerDir = configDir("ocx-cl10-consumer-");
    const bundle = signedBundle(publisherDir);
    importCommunityEvidenceBundle(bundle, consumerDir);

    const revocation = createPublicEvidenceRevocation({
      configDir: publisherDir,
      targetBundle: bundle,
      issuedDayUtc: "2026-08-12",
      reason: "evidence_invalidated",
      targets: [{ kind: "record", id: bundle.records[0]!.recordId }],
    });
    expect(verifyPublicEvidenceRevocation(revocation, bundle).status).toBe("cryptographically_valid");
    expect(importCommunityEvidenceRevocation(revocation, consumerDir).created).toBe(true);
    expect(importCommunityEvidenceRevocation(revocation, consumerDir).created).toBe(false);
    expect(listCommunityEvidence(consumerDir)[0]).toMatchObject({ activeRecordCount: 0, revokedRecordCount: 1 });
  });

  test("rejects cross-key revocation and conflicting same-id stored bytes", () => {
    const publisherDir = configDir("ocx-cl10-publisher-");
    const otherDir = configDir("ocx-cl10-other-");
    const consumerDir = configDir("ocx-cl10-consumer-");
    const bundle = signedBundle(publisherDir);
    importCommunityEvidenceBundle(bundle, consumerDir);
    expect(() => createPublicEvidenceRevocation({
      configDir: otherDir,
      targetBundle: bundle,
      issuedDayUtc: "2026-08-12",
      reason: "publisher_retracted",
      targets: [{ kind: "bundle", id: bundle.bundleId }],
    })).toThrow(/publisher/i);

    const revocation = createPublicEvidenceRevocation({
      configDir: publisherDir,
      targetBundle: bundle,
      issuedDayUtc: "2026-08-12",
      reason: "publisher_retracted",
      targets: [{ kind: "bundle", id: bundle.bundleId }],
    });
    const conflictPath = join(labCommunityDir(consumerDir), `revocation-${revocation.revocationId}.json`);
    writeFileSync(conflictPath, JSON.stringify({ conflicting: true }), { mode: 0o600 });
    expect(() => importCommunityEvidenceRevocation(revocation, consumerDir)).toThrow(/identity.*different bytes|conflict/i);
  });

  test("sensitive export purge removes local exports and local community copies but preserves third-party bundles", () => {
    const consumerDir = configDir("ocx-cl10-consumer-");
    const thirdPartyDir = configDir("ocx-cl10-third-party-");
    const localBundle = signedBundle(consumerDir);
    const localStored = writePublicEvidenceBundle(localBundle, consumerDir);
    importCommunityEvidenceBundle(localBundle, consumerDir);

    const thirdPartyBundle = signedBundle(thirdPartyDir, "responses-core.protocol.sse-framing");
    importCommunityEvidenceBundle(thirdPartyBundle, consumerDir);
    expect(listCommunityEvidence(consumerDir)).toHaveLength(2);

    purgeSensitiveEvidence({
      configDir: consumerDir,
      targetArtifactDigests: [hex("sensitive-purge-target")],
      purgeActions: ["export"],
      recordedAt: Date.UTC(2026, 7, 12, 18, 0, 0),
    });

    expect(existsSync(localStored)).toBe(false);
    expect(listCommunityEvidence(consumerDir).map((row) => row.bundleId)).toEqual([thirdPartyBundle.bundleId]);
  });
});