import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  assignEventId,
  subjectIdForSubject,
  type ObservationEvent,
  type ProtocolSubjectV1,
  type RouteSubjectV1,
} from "../src/lab";
import { labPublicPublisherKeyPath } from "../src/lab/paths";
import {
  PUBLIC_ROUTE_REGISTRY_V1,
  PublicEvidenceValidationError,
  buildPublicEvidenceBundle,
  getOrCreatePublicPublisher,
  isPublicIncidentRef,
  projectPublicEvidence,
  projectPublicEvidenceRecord,
  publicEvidenceId,
  readPublicEvidenceBundle,
  signPublicEvidenceBundle,
  validatePublicEvidenceRecord,
  validatePublicRouteRegistryManifest,
  verifyPublicEvidenceBundle,
  writePublicEvidenceBundle,
} from "../src/lab/public";

const HOMES: string[] = [];
const DEFAULT_COMPLETED_AT = Date.UTC(2026, 7, 12, 14, 37, 41);

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-public-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function hex(seed: string): string {
  return Bun.CryptoHasher.hash("sha256", seed, "hex");
}

function protocolObservation(completedAt = DEFAULT_COMPLETED_AT): ObservationEvent {
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
    recordedAt: completedAt + 7_000,
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
    subjectId,
    startedAt: completedAt - 1_000,
    completedAt,
    executionMode: "fixture" as const,
    attempt: 1,
    limits: { totalTimeoutMs: 1000 },
    outcome: "pass" as const,
    assertions: [
      {
        id: "method",
        operator: "equals",
        required: true,
        passed: true,
        expectedSummary: "CANARY-PRIVATE-EXPECTED",
        observedSummary: "CANARY-PRIVATE-OBSERVED",
      },
      { id: "message", operator: "equals", required: true, passed: true },
      { id: "temperature", operator: "equals", required: true, passed: true },
    ],
    environment: { localPath: "C:\\Users\\private\\repo" },
    artifactRefs: [],
    sourceRefs: ["request_1234567890", "decision_1234567890"],
  }) as ObservationEvent;
}

function routeObservation(completedAt = DEFAULT_COMPLETED_AT): ObservationEvent {
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
    ...protocolObservation(completedAt),
    eventId: undefined,
    evidenceLayer: "live_route_compatibility" as const,
    scenarioId: "responses-core.live.request-shape",
    executionMode: "live" as const,
    subject,
    subjectId,
    sourceRefs: ["request_PRIVATE", "decision_PRIVATE"],
  }) as ObservationEvent;
}

function exportedProtocolRecord() {
  const result = projectPublicEvidenceRecord({ observation: protocolObservation(), verdict: "VERIFIED" });
  if (result.status !== "exportable") throw new Error("expected exportable protocol record");
  return result.record;
}

function withRecomputedRecordId(record: ReturnType<typeof exportedProtocolRecord>) {
  const { recordId: _oldRecordId, ...withoutRecordId } = record;
  return { recordId: publicEvidenceId("record", withoutRecordId), ...withoutRecordId };
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
    expect(result.record.assertions).toEqual([
      { id: "method", required: true, passed: true },
      { id: "message", required: true, passed: true },
      { id: "temperature", required: true, passed: true },
    ]);

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

  test("derives bundle day only from records that survive exportability gates", () => {
    const olderPublic = protocolObservation(Date.UTC(2026, 7, 12, 23, 59, 59));
    const newerPrivateRoute = routeObservation(Date.UTC(2026, 7, 13, 12, 0, 0));
    const projected = projectPublicEvidence({
      createdDayUtc: "2099-12-31",
      records: [
        { observation: olderPublic, verdict: "VERIFIED" },
        { observation: newerPrivateRoute, verdict: "PROBED" },
      ],
    });
    expect(projected.bundle.createdDayUtc).toBe("2026-08-12");
    expect(projected.bundle.records).toHaveLength(1);
    expect(projected.excluded).toEqual([{ index: 1, reason: "private_route_identity" }]);
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

describe("CL-10 public bundle and publisher", () => {
  test("builds deterministic bundle ids and digests from public-safe bytes", () => {
    const home = tempHome();
    const publisher = getOrCreatePublicPublisher(home).publisher;
    const input = {
      records: [exportedProtocolRecord()],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      publisher,
    };
    const a = buildPublicEvidenceBundle(input);
    const b = buildPublicEvidenceBundle(input);
    expect(a.bundleId).toBe(b.bundleId);
    expect(a.bundleDigest).toBe(b.bundleDigest);
    expect(a.bundleId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.bundleId).not.toBe(a.bundleDigest);
  });

  test("creates one installation-local Ed25519 publisher key with restrictive permissions", () => {
    const home = tempHome();
    const first = getOrCreatePublicPublisher(home);
    const second = getOrCreatePublicPublisher(home);
    expect(first.publisher).toEqual(second.publisher);
    expect(first.publisher.algorithm).toBe("ed25519");
    expect(first.publisher.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.publisher.publicKey.length).toBeGreaterThan(20);
    const privateKey = readFileSync(first.privateKeyPath, "utf8");
    expect(privateKey).toContain("PRIVATE KEY");
    if (process.platform !== "win32") {
      expect(statSync(first.privateKeyPath).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects unreviewed assertion authority before publisher key creation", () => {
    const home = tempHome();
    const record = exportedProtocolRecord();
    const unauthorized = withRecomputedRecordId({
      ...record,
      assertions: [{ id: "private-assertion-name", required: true, passed: true }],
    });
    expect(() => signPublicEvidenceBundle({
      records: [unauthorized],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      configDir: home,
    })).toThrow(/assertion.*authority/i);
    expect(existsSync(labPublicPublisherKeyPath(home))).toBe(false);
  });

  test("rejects privacy-canary public fields before publisher key creation", () => {
    const home = tempHome();
    const record = exportedProtocolRecord();
    if (record.subject.subjectKind !== "protocol") throw new Error("expected protocol public subject");
    const subject = { ...record.subject, surface: "https://private.example.test/path?token=secret" };
    const subjectId = publicEvidenceId("subject", subject);
    const unsafe = withRecomputedRecordId({ ...record, subject, subjectId });
    expect(() => signPublicEvidenceBundle({
      records: [unsafe],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      configDir: home,
    })).toThrow(/closed public identifier|forbidden URL material/i);
    expect(existsSync(labPublicPublisherKeyPath(home))).toBe(false);
  });

  test("signs and verifies exact canonical bundle bytes without serializing private key material", () => {
    const home = tempHome();
    const handle = getOrCreatePublicPublisher(home);
    const bundle = signPublicEvidenceBundle({
      records: [exportedProtocolRecord()],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      configDir: home,
    });
    expect(verifyPublicEvidenceBundle(bundle)).toEqual({ status: "cryptographically_valid" });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(handle.privateKeyPath);
    const pemBodyLines = readFileSync(handle.privateKeyPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("-----"));
    expect(pemBodyLines.length).toBeGreaterThan(0);
    for (const line of pemBodyLines) expect(serialized).not.toContain(line);

    const badDigest = { ...bundle, bundleDigest: hex("tampered-bundle") };
    expect(verifyPublicEvidenceBundle(badDigest)).toEqual({ status: "digest_invalid" });
    const badSignature = {
      ...bundle,
      signature: { ...bundle.signature, signature: Buffer.from("tampered").toString("base64") },
    };
    expect(verifyPublicEvidenceBundle(badSignature)).toEqual({ status: "signature_invalid" });
  });

  test("writes and reads a bounded local export by public bundle id", () => {
    const home = tempHome();
    const bundle = signPublicEvidenceBundle({
      records: [exportedProtocolRecord()],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      configDir: home,
    });
    const path = writePublicEvidenceBundle(bundle, home);
    expect(path).toBe(join(home, "lab", "export", `${bundle.bundleId}.json`));
    expect(readPublicEvidenceBundle(bundle.bundleId, home)).toEqual(bundle);
  });

  test("rejects non-object local export JSON with a validation error", () => {
    const home = tempHome();
    const bundleId = "f".repeat(64);
    const exportDir = join(home, "lab", "export");
    mkdirSync(exportDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(exportDir, `${bundleId}.json`), "null\n", { encoding: "utf8", mode: 0o600 });
    expect(() => readPublicEvidenceBundle(bundleId, home)).toThrow(PublicEvidenceValidationError);
  });
});