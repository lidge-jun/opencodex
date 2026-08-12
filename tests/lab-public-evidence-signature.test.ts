import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  assignEventId,
  subjectIdForSubject,
  type ObservationEvent,
  type ProtocolSubjectV1,
} from "../src/lab";
import {
  getOrCreatePublicPublisher,
  projectPublicEvidence,
  readPublicEvidenceBundle,
  signPublicEvidenceBundle,
  verifyPublicEvidenceBundle,
  writePublicEvidenceBundle,
} from "../src/lab/public";
import { labPublicPublisherKeyPath, labPublicExportsDir } from "../src/lab/paths";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-cl10-sign-"));
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
    behaviorFingerprint: hex("PRIVATE-behavior"),
  };
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
    subjectId: subjectIdForSubject(subject),
    startedAt: Date.UTC(2026, 7, 12, 14, 37, 40),
    completedAt: Date.UTC(2026, 7, 12, 14, 37, 41),
    executionMode: "fixture" as const,
    attempt: 1,
    limits: { totalTimeoutMs: 1000 },
    outcome: "pass" as const,
    assertions: [{ id: "request-shape", operator: "equals", required: true, passed: true, expectedSummary: "PRIVATE", observedSummary: "PRIVATE" }],
    environment: {},
    artifactRefs: [],
  }) as ObservationEvent;
}

function unsignedBundle() {
  return projectPublicEvidence({
    createdDayUtc: "2026-08-12",
    records: [{ observation: observation(), verdict: "VERIFIED" }],
  }).bundle;
}

describe("CL-10 public publisher", () => {
  test("creates a stable opaque Ed25519 publisher with a restricted private key file", () => {
    const dir = configDir();
    const a = getOrCreatePublicPublisher(dir);
    const b = getOrCreatePublicPublisher(dir);
    expect(a.publisher).toEqual(b.publisher);
    expect(a.publisher).toMatchObject({ algorithm: "ed25519" });
    expect(a.publisher.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.publisher.publicKey.length).toBeGreaterThan(32);
    expect(JSON.stringify(a)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(a)).not.toContain("privateKey");
    if (process.platform !== "win32") {
      expect(statSync(labPublicPublisherKeyPath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  test("signs deterministic canonical bundle bytes and rejects tampering", () => {
    const dir = configDir();
    const signer = getOrCreatePublicPublisher(dir);
    const unsigned = unsignedBundle();
    const first = signPublicEvidenceBundle(unsigned, signer);
    const second = signPublicEvidenceBundle(unsigned, signer);
    expect(first.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.signature.signedDigest).toBe(first.bundleDigest);
    expect(first.signature.signature).toBe(second.signature.signature);
    expect(first.bundleDigest).toBe(second.bundleDigest);
    expect(verifyPublicEvidenceBundle(first).status).toBe("cryptographically_valid");

    const badSignature = {
      ...first,
      signature: { ...first.signature, signature: Buffer.alloc(64, 1).toString("base64") },
    };
    expect(verifyPublicEvidenceBundle(badSignature).status).toBe("signature_invalid");

    const tampered = {
      ...first,
      records: first.records.map((record, index) => index === 0 ? { ...record, scenarioId: "tampered.scenario" } : record),
    };
    expect(verifyPublicEvidenceBundle(tampered).status).toBe("digest_invalid");
  });
});

describe("CL-10 public export storage", () => {
  test("writes and reads a verified bundle only inside the restricted exports directory", () => {
    const dir = configDir();
    const bundle = signPublicEvidenceBundle(unsignedBundle(), getOrCreatePublicPublisher(dir));
    const stored = writePublicEvidenceBundle(bundle, dir);
    const exportsDir = resolve(labPublicExportsDir(dir));
    expect(resolve(stored.path).startsWith(exportsDir + sep)).toBe(true);
    expect(stored.created).toBe(true);
    expect(writePublicEvidenceBundle(bundle, dir).created).toBe(false);
    const read = readPublicEvidenceBundle(bundle.bundleId, dir);
    expect(read.bundleDigest).toBe(bundle.bundleDigest);
    expect(verifyPublicEvidenceBundle(read).status).toBe("cryptographically_valid");
  });

  test("rejects traversal-like bundle ids before filesystem access", () => {
    const dir = configDir();
    expect(() => readPublicEvidenceBundle("../PRIVATE", dir)).toThrow();
    expect(() => readPublicEvidenceBundle("a".repeat(64) + "/PRIVATE", dir)).toThrow();
  });
});
