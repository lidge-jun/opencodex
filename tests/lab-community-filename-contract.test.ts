import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { labPublicOriginDir } from "../src/lab/paths";
import {
  communityBundleFileName,
  communityRevocationFileName,
} from "../src/lab/public/community-files";
import {
  createPublicEvidenceRevocation,
  importCommunityEvidenceBundle,
  importCommunityEvidenceRevocation,
  purgeLocalPublicEvidenceCopies,
  publicEvidenceId,
  recordLocalPublicOrigin,
  signPublicEvidenceBundle,
  type PublicEvidenceRecordV1,
} from "../src/lab/public";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-cl10-community-filenames-"));
  roots.push(root);
  return root;
}

function hex(seed: string): string {
  return Bun.CryptoHasher.hash("sha256", seed, "hex");
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

test("writer, origin retention, and purge share the community filename contract", () => {
  const home = configDir();
  const bundle = signPublicEvidenceBundle({
    records: [fixedRecord()],
    artifacts: [],
    createdDayUtc: "2026-08-12",
    configDir: home,
  });
  const importedBundle = importCommunityEvidenceBundle(bundle, home);
  expect(basename(importedBundle.path)).toBe(
    communityBundleFileName(bundle.publisher.keyId, bundle.bundleId),
  );

  const revocation = createPublicEvidenceRevocation({
    configDir: home,
    targetBundle: bundle,
    issuedDayUtc: "2026-08-13",
    targets: [{ kind: "bundle", id: bundle.bundleId }],
    reason: "publisher_retracted",
  });
  const importedRevocation = importCommunityEvidenceRevocation(revocation, home);
  expect(basename(importedRevocation.path)).toBe(
    communityRevocationFileName(revocation.revocationId),
  );

  recordLocalPublicOrigin({
    publisherKeyId: bundle.publisher.keyId,
    bundleId: bundle.bundleId,
  }, home);

  const originDir = labPublicOriginDir(home);
  for (let index = 0; index < 1023; index += 1) {
    writeFileSync(
      join(originDir, `origin-${hex(`stale-publisher-${index}`)}-${hex(`stale-bundle-${index}`)}.json`),
      "{}",
      { mode: 0o600 },
    );
  }
  recordLocalPublicOrigin({
    publisherKeyId: hex("new-publisher"),
    bundleId: hex("new-bundle"),
  }, home);

  expect(readdirSync(originDir)).toContain(
    `origin-${bundle.publisher.keyId}-${bundle.bundleId}.json`,
  );

  const purged = purgeLocalPublicEvidenceCopies(home);
  expect(purged.deletedCommunityBundles).toBe(1);
  expect(purged.deletedCommunityRevocations).toBe(1);
  expect(existsSync(importedBundle.path)).toBe(false);
  expect(existsSync(importedRevocation.path)).toBe(false);
});
