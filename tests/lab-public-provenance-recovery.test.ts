import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labExportDir, labPublicOriginDir } from "../src/lab/paths";
import {
  createPublicEvidenceRevocation,
  importCommunityEvidenceBundle,
  importCommunityEvidenceValue,
  listCommunityEvidence,
  listLocalPublicOrigins,
  purgeLocalPublicEvidenceCopies,
  publicEvidenceId,
  recordLocalPublicOrigin,
  signPublicEvidenceBundle,
  writePublicEvidenceBundle,
  type PublicEvidenceRecordV1,
} from "../src/lab/public";
import { setPrivateFileCommitFaultForTests } from "../src/lab/public/private-file";

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

function fixedRecord(day = "2026-08-12"): PublicEvidenceRecordV1 {
  const subject = {
    subjectKind: "protocol" as const,
    compatibilityVersion: "2.13.0",
    adapterFamily: "openai-chat" as const,
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
  };
  const subjectId = publicEvidenceId("subject", subject);
  const body = {
    subjectId,
    evidenceLayer: "protocol_conformance" as const,
    suiteId: "responses-core",
    suiteVersion: "1.0.0",
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1.0.0",
    verdict: "VERIFIED" as const,
    observedDayUtc: day,
    subject,
    assertions: [
      { id: "method", required: true, passed: true },
      { id: "message", required: true, passed: true },
      { id: "temperature", required: true, passed: true },
    ],
  };
  return { recordId: publicEvidenceId("record", body), ...body };
}

function signedBundle(config: string, day = "2026-08-12") {
  return signPublicEvidenceBundle({
    records: [fixedRecord(day)],
    artifacts: [],
    createdDayUtc: day,
    configDir: config,
  });
}

test("one corrupt origin marker does not discard later valid purge provenance", () => {
  const home = configDir("ocx-cl10-origin-salvage-");
  const publisherA = configDir("ocx-cl10-origin-publisher-a-");
  const publisherB = configDir("ocx-cl10-origin-publisher-b-");
  const bundles = [signedBundle(publisherA), signedBundle(publisherB, "2026-08-13")];

  for (const bundle of bundles) {
    importCommunityEvidenceBundle(bundle, home);
    recordLocalPublicOrigin({ publisherKeyId: bundle.publisher.keyId, bundleId: bundle.bundleId }, home);
  }

  const dir = labPublicOriginDir(home);
  const names = readdirSync(dir).sort();
  expect(names).toHaveLength(2);
  writeFileSync(join(dir, names[0]!), "{", { mode: 0o600 });
  const validName = names[1]!;
  const validBundle = bundles.find((bundle) => validName.includes(bundle.bundleId));
  if (!validBundle) throw new Error(`no bundle matches origin marker ${validName}`);

  expect(() => purgeLocalPublicEvidenceCopies(home)).toThrow(/origin.*classification.*incomplete/i);
  expect(listCommunityEvidence(home).map((row) => row.bundleId)).not.toContain(validBundle.bundleId);
});

test("origin pressure preserves provenance while the matching local export exists", () => {
  const home = configDir("ocx-cl10-origin-export-retain-");
  const bundle = signedBundle(home);
  writePublicEvidenceBundle(bundle, home);
  recordLocalPublicOrigin({ publisherKeyId: bundle.publisher.keyId, bundleId: bundle.bundleId }, home);

  const dir = labPublicOriginDir(home);
  for (let index = 0; index < 1023; index += 1) {
    const publisherKeyId = publicEvidenceId("publisher_key", { seed: `old-publisher-${index}` });
    const bundleId = publicEvidenceId("bundle", { seed: `old-bundle-${index}` });
    writeFileSync(join(dir, `origin-${publisherKeyId}-${bundleId}.json`), "{}", { mode: 0o600 });
  }

  const next = {
    publisherKeyId: publicEvidenceId("publisher_key", { seed: "next-publisher" }),
    bundleId: publicEvidenceId("bundle", { seed: "next-bundle" }),
  };
  recordLocalPublicOrigin(next, home);

  expect(existsSync(join(dir, `origin-${bundle.publisher.keyId}-${bundle.bundleId}.json`))).toBe(true);
});

test("operator import of an own verified bundle restores missing local-origin provenance", () => {
  const home = configDir("ocx-cl10-origin-rehydrate-");
  const bundle = signedBundle(home);
  expect(listLocalPublicOrigins(home)).toEqual([]);

  importCommunityEvidenceValue(bundle, home);
  expect(listLocalPublicOrigins(home)).toEqual([{
    publisherKeyId: bundle.publisher.keyId,
    bundleId: bundle.bundleId,
  }]);
});

test("operator import of a third-party verified bundle does not create local-origin provenance", () => {
  const home = configDir("ocx-cl10-origin-third-party-home-");
  const publisher = configDir("ocx-cl10-origin-third-party-publisher-");
  signedBundle(home);
  const bundle = signedBundle(publisher);

  importCommunityEvidenceValue(bundle, home);
  expect(listLocalPublicOrigins(home)).toEqual([]);
});

test("failed own-origin commit rolls back a newly imported community copy", () => {
  const home = configDir("ocx-cl10-origin-rollback-");
  const bundle = signedBundle(home);
  const dir = labPublicOriginDir(home);
  const exportDir = labExportDir(home);
  for (let index = 0; index < 1024; index += 1) {
    const publisherKeyId = publicEvidenceId("publisher_key", { seed: `occupied-publisher-${index}` });
    const bundleId = publicEvidenceId("bundle", { seed: `occupied-bundle-${index}` });
    writeFileSync(
      join(dir, `origin-${publisherKeyId}-${bundleId}.json`),
      JSON.stringify({ schemaVersion: "public_origin_v1", publisherKeyId, bundleId }),
      { mode: 0o600 },
    );
    writeFileSync(join(exportDir, `${bundleId}.json`), "retained", { mode: 0o600 });
  }

  expect(() => importCommunityEvidenceValue(bundle, home)).toThrow(/origin marker bound/i);
  expect(listCommunityEvidence(home)).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "origin and community persistence recover after same-process parent-directory sync failures",
  () => {
    const home = configDir("ocx-cl10-origin-recovery-");
    const publisher = configDir("ocx-cl10-community-recovery-publisher-");
    const identity = {
      publisherKeyId: publicEvidenceId("publisher_key", { seed: "recovery-publisher" }),
      bundleId: publicEvidenceId("bundle", { seed: "recovery-bundle" }),
    };

    setPrivateFileCommitFaultForTests("parent_directory_sync");
    expect(() => recordLocalPublicOrigin(identity, home)).toThrow();
    setPrivateFileCommitFaultForTests(null);
    expect(() => recordLocalPublicOrigin(identity, home)).not.toThrow();

    const bundle = signedBundle(publisher);
    setPrivateFileCommitFaultForTests("parent_directory_sync");
    expect(() => importCommunityEvidenceBundle(bundle, home)).toThrow();
    setPrivateFileCommitFaultForTests(null);
    expect(importCommunityEvidenceBundle(bundle, home)).toMatchObject({ created: false, bundleId: bundle.bundleId });
  },
);

test("V1 revocations are bounded to one already-verified anchor bundle", () => {
  const publisher = configDir("ocx-cl10-revocation-anchor-");
  const first = signedBundle(publisher, "2026-08-12");
  const second = signedBundle(publisher, "2026-08-13");

  expect(() => createPublicEvidenceRevocation({
    configDir: publisher,
    targetBundle: first,
    issuedDayUtc: "2026-08-13",
    reason: "superseded",
    targets: [
      { kind: "bundle", id: first.bundleId },
      { kind: "bundle", id: second.bundleId },
    ],
  })).toThrow(/target|unknown/i);
});
