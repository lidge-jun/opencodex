import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  labCommunityDir,
  labExportDir,
  labPublicPublisherKeyPath,
} from "../src/lab/paths";
import {
  publishPrivateFileExclusive,
  setPrivateFileCommitFaultForTests,
} from "../src/lab/public/private-file";
import {
  createPublicEvidenceRevocation,
  importCommunityEvidenceBundle,
  importCommunityEvidenceRevocation,
  listCommunityEvidence,
  listLocalPublicOrigins,
  purgeLocalPublicEvidenceCopies,
  publicEvidenceId,
  recordLocalPublicOrigin,
  signPublicEvidenceBundle,
  writePublicEvidenceBundle,
  type PublicEvidenceRecordV1,
} from "../src/lab/public";

const roots: string[] = [];
afterEach(() => {
  setPrivateFileCommitFaultForTests(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fixedRecord(): PublicEvidenceRecordV1 {
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
  };
  return { recordId: publicEvidenceId("record", withoutRecordId), ...withoutRecordId };
}

function signedBundle(config: string, day = "2026-08-12") {
  return signPublicEvidenceBundle({
    records: [fixedRecord()],
    artifacts: [],
    createdDayUtc: day,
    configDir: config,
  });
}

function addLivePrivateStages(dir: string, count: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let index = 0; index < count; index += 1) {
    const finalName = `bundle-${String(index).padStart(3, "0")}.json`;
    writeFileSync(
      join(dir, `.${finalName}.${process.pid}.${randomUUID()}.tmp`),
      "stage",
      { mode: 0o600 },
    );
  }
}

describe("CL-10 public lifecycle hardening", () => {
  test("exclusive private publication never exposes a partial final file", () => {
    const root = configDir("ocx-cl10-atomic-");
    const finalPath = join(root, "object.json");
    const bytes = Buffer.from('{"ok":true}', "utf8");

    setPrivateFileCommitFaultForTests("before_publish");
    expect(() => publishPrivateFileExclusive(finalPath, bytes)).toThrow(/synthetic.*commit failure/i);
    expect(existsSync(finalPath)).toBe(false);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    setPrivateFileCommitFaultForTests(null);
    expect(publishPrivateFileExclusive(finalPath, bytes)).toEqual({ created: true });
    expect(existsSync(finalPath)).toBe(true);
  });

  test("private staging files do not consume the bounded community object quota", () => {
    const publisher = configDir("ocx-cl10-stage-publisher-");
    const consumer = configDir("ocx-cl10-stage-consumer-");
    addLivePrivateStages(labCommunityDir(consumer), 512);

    const bundle = signedBundle(publisher);
    expect(importCommunityEvidenceBundle(bundle, consumer)).toMatchObject({
      created: true,
      status: "cryptographically_valid",
      bundleId: bundle.bundleId,
    });
    expect(listCommunityEvidence(consumer)).toEqual([
      expect.objectContaining({ bundleId: bundle.bundleId, activeRecordCount: 1 }),
    ]);
  });

  test("durable origin provenance purges local community copies even after export and key corruption", () => {
    const local = configDir("ocx-cl10-origin-local-");
    const thirdParty = configDir("ocx-cl10-origin-third-party-");
    const localBundle = signedBundle(local);
    const thirdPartyBundle = signedBundle(thirdParty, "2026-08-13");

    const localExportPath = writePublicEvidenceBundle(localBundle, local);
    recordLocalPublicOrigin({
      publisherKeyId: localBundle.publisher.keyId,
      bundleId: localBundle.bundleId,
    }, local);
    importCommunityEvidenceBundle(localBundle, local);
    importCommunityEvidenceBundle(thirdPartyBundle, local);

    const localRevocation = createPublicEvidenceRevocation({
      configDir: local,
      targetBundle: localBundle,
      issuedDayUtc: "2026-08-13",
      reason: "privacy_retraction",
      targets: [{ kind: "bundle", id: localBundle.bundleId }],
    });
    importCommunityEvidenceRevocation(localRevocation, local);

    expect(listLocalPublicOrigins(local)).toEqual([{
      publisherKeyId: localBundle.publisher.keyId,
      bundleId: localBundle.bundleId,
    }]);

    writeFileSync(localExportPath, "{", { encoding: "utf8" });
    unlinkSync(labPublicPublisherKeyPath(local));

    expect(purgeLocalPublicEvidenceCopies(local)).toMatchObject({
      deletedCommunityBundles: 1,
      deletedCommunityRevocations: 1,
    });
    expect(readdirSync(labExportDir(local))).toEqual([]);
    expect(listLocalPublicOrigins(local)).toEqual([]);
    expect(listCommunityEvidence(local).map((row) => row.bundleId)).toEqual([thirdPartyBundle.bundleId]);
  });

  test("locally-originated hardlinked community path is removed without deleting its peer", () => {
    const local = configDir("ocx-cl10-unsafe-community-purge-");
    const localBundle = signedBundle(local);
    writePublicEvidenceBundle(localBundle, local);
    recordLocalPublicOrigin({
      publisherKeyId: localBundle.publisher.keyId,
      bundleId: localBundle.bundleId,
    }, local);
    const imported = importCommunityEvidenceBundle(localBundle, local);
    const peerPath = join(local, "community-hardlink-witness.json");

    linkSync(imported.path, peerPath);

    expect(purgeLocalPublicEvidenceCopies(local)).toMatchObject({
      deletedExports: 1,
      deletedCommunityBundles: 1,
    });
    expect(readdirSync(labExportDir(local))).toEqual([]);
    expect(existsSync(imported.path)).toBe(false);
    expect(existsSync(peerPath)).toBe(true);
  });

  test("duplicate-key revocation JSON is rejected before persistence", () => {
    const publisher = configDir("ocx-cl10-dup-rev-publisher-");
    const consumer = configDir("ocx-cl10-dup-rev-consumer-");
    const bundle = signedBundle(publisher);
    importCommunityEvidenceBundle(bundle, consumer);
    const revocation = createPublicEvidenceRevocation({
      configDir: publisher,
      targetBundle: bundle,
      issuedDayUtc: "2026-08-13",
      reason: "evidence_invalidated",
      targets: [{ kind: "record", id: bundle.records[0]!.recordId }],
    });
    const raw = JSON.stringify(revocation).replace(
      '"schemaVersion":"public_evidence_revocation_v1"',
      '"schemaVersion":"public_evidence_revocation_v1","schemaVersion":"public_evidence_revocation_v1"',
    );

    expect(() => importCommunityEvidenceRevocation(raw, consumer)).toThrow(/duplicate json object key/i);
    expect(readdirSync(labCommunityDir(consumer)).filter((name) => name.startsWith("revocation-"))).toEqual([]);
  });
});
