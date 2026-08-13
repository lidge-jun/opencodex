import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLabDirs, labPublicOriginDir } from "../src/lab/paths";
import { purgeSensitiveEvidence } from "../src/lab/ledger/purge";
import { replayLabLedger } from "../src/lab/ledger/store";
import * as publicApi from "../src/lab/public";
import { setPublicEvidencePurgeFaultForTests } from "../src/lab/public/purge-test-fault";
import {
  importCommunityEvidenceBundle,
  purgeLocalPublicEvidenceCopies,
  publicEvidenceId,
  recordLocalPublicOrigin,
  signPublicEvidenceBundle,
  writePublicEvidenceBundle,
  PublicEvidenceValidationError,
  type PublicEvidenceRecordV1,
} from "../src/lab/public";

const roots: string[] = [];
afterEach(() => {
  setPublicEvidencePurgeFaultForTests(null);
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

function signedBundle(config: string) {
  return signPublicEvidenceBundle({
    records: [fixedRecord()],
    artifacts: [],
    createdDayUtc: "2026-08-12",
    configDir: config,
  });
}

test("decoded community objects are depth-bounded before JCS canonicalization", () => {
  const consumer = configDir("ocx-cl10-object-bound-");
  let raw: unknown = { leaf: true };
  for (let index = 0; index < 20_000; index += 1) raw = { nested: raw };

  try {
    importCommunityEvidenceBundle(raw, consumer);
    throw new Error("expected bounded object rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PublicEvidenceValidationError);
    expect((error as PublicEvidenceValidationError).code).toBe("community_depth");
  }
});

test("public barrel does not expose private test fault setters", () => {
  expect("setPrivateFileCommitFaultForTests" in publicApi).toBe(false);
  expect("setPublicEvidencePurgeFaultForTests" in publicApi).toBe(false);
});

test("public origin quota stays bounded when unreclaimable unexpected entries fill it", () => {
  const home = configDir("ocx-cl10-origin-bound-");
  ensureLabDirs(home);
  const dir = labPublicOriginDir(home);
  for (let index = 0; index < 1024; index += 1) {
    writeFileSync(join(dir, `occupied-${String(index).padStart(4, "0")}`), "x", { mode: 0o600 });
  }

  expect(() => recordLocalPublicOrigin({
    publisherKeyId: hex("publisher-bound"),
    bundleId: hex("bundle-bound"),
  }, home)).toThrow(/origin marker bound/i);
  expect(readdirSync(dir)).toHaveLength(1024);
});

test("public origin pressure reclaims markers with no community copy", () => {
  const home = configDir("ocx-cl10-origin-reclaim-");
  ensureLabDirs(home);
  const dir = labPublicOriginDir(home);
  for (let index = 0; index < 1024; index += 1) {
    const publisherKeyId = hex(`publisher-old-${index}`);
    const bundleId = hex(`bundle-old-${index}`);
    writeFileSync(
      join(dir, `origin-${publisherKeyId}-${bundleId}.json`),
      "{}",
      { mode: 0o600 },
    );
  }

  const current = { publisherKeyId: hex("publisher-current"), bundleId: hex("bundle-current") };
  recordLocalPublicOrigin(current, home);
  const names = readdirSync(dir);
  expect(names).toHaveLength(1);
  expect(names[0]).toBe(`origin-${current.publisherKeyId}-${current.bundleId}.json`);
});

test("corrupt origin provenance cannot retain mandatory local export bytes", () => {
  const home = configDir("ocx-cl10-origin-corrupt-");
  const bundle = signedBundle(home);
  writePublicEvidenceBundle(bundle, home);
  recordLocalPublicOrigin({ publisherKeyId: bundle.publisher.keyId, bundleId: bundle.bundleId }, home);
  const originEntry = readdirSync(labPublicOriginDir(home))[0]!;
  writeFileSync(join(labPublicOriginDir(home), originEntry), "{", { mode: 0o600 });

  expect(purgeLocalPublicEvidenceCopies(home).deletedExports).toBe(1);
  expect(readdirSync(ensureLabDirs(home).exportDir)).toEqual([]);
});

test("unsafe locally-originated community copies fail the export purge closed", () => {
  const home = configDir("ocx-cl10-community-unsafe-");
  const bundle = signedBundle(home);
  writePublicEvidenceBundle(bundle, home);
  recordLocalPublicOrigin({ publisherKeyId: bundle.publisher.keyId, bundleId: bundle.bundleId }, home);
  const imported = importCommunityEvidenceBundle(bundle, home);
  writeFileSync(imported.path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x78), { mode: 0o600 });

  expect(() => purgeLocalPublicEvidenceCopies(home)).toThrow(/community|unsafe|purge/i);
  expect(readdirSync(ensureLabDirs(home).exportDir)).toEqual([]);
  expect(existsSync(imported.path)).toBe(true);
});

test("failed export purge is omitted from the durable tombstone action set", () => {
  const home = configDir("ocx-cl10-tombstone-export-");
  const paths = ensureLabDirs(home);
  writeFileSync(join(paths.scratchDir, "scratch.txt"), "scratch", { mode: 0o600 });
  writeFileSync(join(paths.exportDir, "sensitive.txt"), "sensitive", { mode: 0o600 });
  setPublicEvidencePurgeFaultForTests("before_export_delete");

  let failure: unknown;
  try {
    purgeSensitiveEvidence({
      configDir: home,
      purgeActions: ["export", "scratch"],
      recordedAt: Date.UTC(2026, 7, 13, 6, 0, 0),
    });
  } catch (error) {
    failure = error;
  } finally {
    setPublicEvidencePurgeFaultForTests(null);
  }
  expect(failure).toBeInstanceOf(Error);

  const tombstones = replayLabLedger(paths.ledgerPath).events.filter((event) => event.eventKind === "purge_tombstone");
  expect(tombstones).toHaveLength(1);
  expect(tombstones[0]!.purgeActions).toEqual(["scratch"]);
});