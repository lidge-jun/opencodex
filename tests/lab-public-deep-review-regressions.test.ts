import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcsStringify } from "../src/lab/conformance/jcs";
import { labCommunityDir, labPublicPublisherKeyPath } from "../src/lab/paths";
import {
  buildPublicEvidenceBundle,
  createPublicEvidenceRevocation,
  getOrCreatePublicPublisher,
  importCommunityEvidenceBundle,
  importCommunityEvidenceRevocation,
  listCommunityEvidence,
  parseStrictPublicJson,
  publicEvidenceId,
  signPublicEvidenceBundle,
  signPublicPublisherDigest,
  validatePublicEvidenceRecordPrivacy,
  verifyPublicEvidenceBundle,
  type PublicArtifactV1,
  type PublicEvidenceBundleV1,
  type PublicEvidenceRecordV1,
} from "../src/lab/public";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fixedRecord(overrides: Partial<Omit<PublicEvidenceRecordV1, "recordId" | "subjectId" | "subject">> = {}): PublicEvidenceRecordV1 {
  const subject = {
    subjectKind: "protocol" as const,
    compatibilityVersion: "2.13.0",
    adapterFamily: "openai-chat" as const,
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
  };
  const subjectId = publicEvidenceId("subject", subject);
  const withoutRecordId = {
    subjectId,
    evidenceLayer: "protocol_conformance" as const,
    suiteId: "responses-core",
    suiteVersion: "1.0.0",
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1.0.0",
    verdict: "VERIFIED" as const,
    observedDayUtc: "2026-08-12",
    subject,
    assertions: [
      { id: "method", required: true, passed: true },
      { id: "message", required: true, passed: true },
      { id: "temperature", required: true, passed: true },
    ],
    ...overrides,
  };
  return { recordId: publicEvidenceId("record", withoutRecordId), ...withoutRecordId };
}

function rebuildRecord(record: PublicEvidenceRecordV1, patch: Partial<Omit<PublicEvidenceRecordV1, "recordId">>): PublicEvidenceRecordV1 {
  const { recordId: _recordId, ...base } = record;
  const withoutRecordId = { ...base, ...patch };
  return { recordId: publicEvidenceId("record", withoutRecordId), ...withoutRecordId } as PublicEvidenceRecordV1;
}

function signArbitraryBundle(input: {
  configDir: string;
  records: PublicEvidenceRecordV1[];
  artifacts?: PublicArtifactV1[];
  createdDayUtc?: string;
}): PublicEvidenceBundleV1 {
  const handle = getOrCreatePublicPublisher(input.configDir);
  const unsigned = buildPublicEvidenceBundle({
    records: input.records,
    artifacts: input.artifacts ?? [],
    createdDayUtc: input.createdDayUtc ?? "2026-08-12",
    publisher: handle.publisher,
  });
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signedDigest: unsigned.bundleDigest,
      signature: signPublicPublisherDigest(handle, unsigned.bundleDigest),
    },
  };
}

function publicArtifact(content: string): PublicArtifactV1 {
  const contentBase64 = Buffer.from(content, "utf8").toString("base64");
  const body = {
    artifactClass: "verifier_summary",
    mediaType: "text/plain",
    byteCount: Buffer.from(contentBase64, "base64").byteLength,
    contentBase64,
  };
  return { artifactId: publicEvidenceId("artifact", body), ...body };
}

describe("CL-10 deep-review trust regressions", () => {
  test("verification rejects a signed bundle whose canonical record order was changed", () => {
    const publisher = configDir("ocx-cl10-order-");
    const first = fixedRecord();
    const second = fixedRecord({ observedDayUtc: "2026-08-13" });
    const bundle = signArbitraryBundle({ configDir: publisher, records: [first, second] });
    expect(bundle.records).toHaveLength(2);

    const reordered = { ...bundle, records: [...bundle.records].reverse() };
    expect(reordered.records.map(row => row.recordId)).not.toEqual(bundle.records.map(row => row.recordId));
    expect(verifyPublicEvidenceBundle(reordered)).toEqual({ status: "schema_rejected" });
  });

  test("community import rejects artifact bytes until reviewed public_export authority exists", () => {
    const publisher = configDir("ocx-cl10-artifact-publisher-");
    const consumer = configDir("ocx-cl10-artifact-consumer-");
    const bundle = signArbitraryBundle({
      configDir: publisher,
      records: [fixedRecord()],
      artifacts: [publicArtifact("synthetic-safe-content")],
    });
    expect(verifyPublicEvidenceBundle(bundle)).toEqual({ status: "cryptographically_valid" });
    expect(() => importCommunityEvidenceBundle(bundle, consumer)).toThrow(/public_export|artifact.*authority/i);
  });

  test("record revocation remains effective when the same publisher later imports another bundle containing that record", () => {
    const publisher = configDir("ocx-cl10-revoke-publisher-");
    const consumer = configDir("ocx-cl10-revoke-consumer-");
    const record = fixedRecord();
    const first = signPublicEvidenceBundle({ records: [record], artifacts: [], createdDayUtc: "2026-08-12", configDir: publisher });
    const second = signPublicEvidenceBundle({ records: [record], artifacts: [], createdDayUtc: "2026-08-13", configDir: publisher });
    expect(first.bundleId).not.toBe(second.bundleId);

    importCommunityEvidenceBundle(first, consumer);
    const revocation = createPublicEvidenceRevocation({
      configDir: publisher,
      targetBundle: first,
      issuedDayUtc: "2026-08-13",
      reason: "evidence_invalidated",
      targets: [{ kind: "record", id: record.recordId }],
    });
    importCommunityEvidenceRevocation(revocation, consumer);
    importCommunityEvidenceBundle(second, consumer);

    const summaries = listCommunityEvidence(consumer);
    expect(summaries.map((row) => row.bundleId)).toEqual([first.bundleId, second.bundleId].sort());
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ bundleId: first.bundleId, activeRecordCount: 0, revokedRecordCount: 1 }),
      expect.objectContaining({ bundleId: second.bundleId, activeRecordCount: 0, revokedRecordCount: 1 }),
    ]));
  });

  test("invalid signing input fails before publisher identity is created", () => {
    const home = configDir("ocx-cl10-invalid-sign-");
    expect(() => signPublicEvidenceBundle({
      records: [fixedRecord()],
      artifacts: [],
      createdDayUtc: "not-a-day",
      configDir: home,
    })).toThrow(/day/i);
    expect(existsSync(labPublicPublisherKeyPath(home))).toBe(false);
  });

  test("foreign revocation attempt does not create a new publisher identity", () => {
    const publisher = configDir("ocx-cl10-foreign-target-");
    const attacker = configDir("ocx-cl10-foreign-revoker-");
    const target = signPublicEvidenceBundle({
      records: [fixedRecord()], artifacts: [], createdDayUtc: "2026-08-12", configDir: publisher,
    });
    expect(() => createPublicEvidenceRevocation({
      configDir: attacker,
      targetBundle: target,
      issuedDayUtc: "2026-08-13",
      reason: "publisher_retracted",
      targets: [{ kind: "bundle", id: target.bundleId }],
    })).toThrow(/publisher|key/i);
    expect(existsSync(labPublicPublisherKeyPath(attacker))).toBe(false);
  });

  test("JCS rejects lone UTF-16 surrogate code units", () => {
    expect(() => jcsStringify("\uDEAD")).toThrow(/unicode|surrogate/i);
    expect(() => jcsStringify({ ["\uDEAD"]: true })).toThrow(/unicode|surrogate/i);
  });

  test("reviewed assertion authority requires exact unique assertion coverage", () => {
    const missingHome = configDir("ocx-cl10-assert-missing-");
    const duplicateHome = configDir("ocx-cl10-assert-duplicate-");
    const base = fixedRecord();
    const missing = rebuildRecord(base, { assertions: [] });
    const duplicate = rebuildRecord(base, { assertions: [
      { id: "method", required: true, passed: true },
      { id: "message", required: true, passed: true },
      { id: "temperature", required: true, passed: true },
      { id: "method", required: true, passed: false },
    ] });

    expect(() => signPublicEvidenceBundle({
      records: [missing], artifacts: [], createdDayUtc: "2026-08-12", configDir: missingHome,
    })).toThrow(/assertion.*authority|missing.*assertion/i);
    expect(existsSync(labPublicPublisherKeyPath(missingHome))).toBe(false);

    expect(() => signPublicEvidenceBundle({
      records: [duplicate], artifacts: [], createdDayUtc: "2026-08-12", configDir: duplicateHome,
    })).toThrow(/assertion.*authority|duplicate.*assertion/i);
    expect(existsSync(labPublicPublisherKeyPath(duplicateHome))).toBe(false);
  });

  test("community import enforces the cache file quota before creating another object", () => {
    const publisher = configDir("ocx-cl10-cache-publisher-");
    const consumer = configDir("ocx-cl10-cache-consumer-");
    const community = labCommunityDir(consumer);
    mkdirSync(community, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 512; index += 1) {
      writeFileSync(join(community, `occupied-${String(index).padStart(3, "0")}`), "x", { mode: 0o600 });
    }
    const bundle = signPublicEvidenceBundle({
      records: [fixedRecord()], artifacts: [], createdDayUtc: "2026-08-12", configDir: publisher,
    });
    expect(() => importCommunityEvidenceBundle(bundle, consumer)).toThrow(/cache.*bound|cache.*limit|capacity/i);
  });

  test("duplicate-key diagnostics are bounded and do not reflect attacker-controlled key contents", () => {
    const key = `SECRET-${"x".repeat(64 * 1024)}`;
    const raw = Buffer.from(`{${JSON.stringify(key)}:1,${JSON.stringify(key)}:2}`, "utf8");
    let failure: unknown;
    try {
      parseStrictPublicJson(raw);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/duplicate json object key/i);
    expect(message.length).toBeLessThan(256);
    expect(message).not.toContain("SECRET-");
  });

  test("privacy scanner rejects unbracketed IPv6 literals", () => {
    const base = fixedRecord();
    const subject = { ...base.subject, surface: "2001:db8::1" };
    const subjectId = publicEvidenceId("subject", subject);
    const record = rebuildRecord(base, { subject, subjectId });
    expect(() => validatePublicEvidenceRecordPrivacy(record)).toThrow(/IP address|privacy/i);
  });
});
