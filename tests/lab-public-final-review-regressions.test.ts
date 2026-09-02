import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLabDirs, labPublicOriginDir } from "../src/lab/paths";
import {
  importCommunityEvidenceBundle,
  listLocalPublicOrigins,
  purgeLocalPublicEvidenceCopies,
  publicEvidenceId,
  signPublicEvidenceBundle,
  writePublicEvidenceBundle,
  type PublicEvidenceRecordV1,
} from "../src/lab/public";
import { listValidPublicOriginsForPurge } from "../src/lab/public/origin-purge";
import { setPublicEvidencePurgeFaultForTests } from "../src/lab/public/purge-test-fault";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  setPublicEvidencePurgeFaultForTests(null);
  for (const root of roots.splice(0)) {
    if (existsSync(root)) removeTreeWithRetry(root);
  }
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function record(day = "2026-08-12"): PublicEvidenceRecordV1 {
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

function bundle(config: string, day = "2026-08-12") {
  return signPublicEvidenceBundle({
    records: [record(day)],
    artifacts: [],
    createdDayUtc: day,
    configDir: config,
  });
}

test("raw community import restores provenance for an exact own-publisher bundle", () => {
  const home = configDir("ocx-cl10-raw-own-import-");
  const own = bundle(home);
  expect(listLocalPublicOrigins(home)).toEqual([]);

  importCommunityEvidenceBundle(own, home);
  expect(listLocalPublicOrigins(home)).toEqual([{
    publisherKeyId: own.publisher.keyId,
    bundleId: own.bundleId,
  }]);
});

test("purge provenance salvage does not truncate valid markers at the operational quota", () => {
  const home = configDir("ocx-cl10-purge-origin-overflow-");
  ensureLabDirs(home);
  const dir = labPublicOriginDir(home);

  for (let index = 0; index < 1025; index += 1) {
    const publisherKeyId = publicEvidenceId("publisher_key", { index });
    const bundleId = publicEvidenceId("bundle", { index });
    writeFileSync(
      join(dir, `origin-${publisherKeyId}-${bundleId}.json`),
      JSON.stringify({ schemaVersion: "public_origin_v1", publisherKeyId, bundleId }),
      { mode: 0o600 },
    );
  }

  expect(listValidPublicOriginsForPurge(home)).toHaveLength(1025);
});

test.skipIf(process.platform === "win32")(
  "export purge keeps failing closed on retry until POSIX deletion durability is established",
  () => {
    const home = configDir("ocx-cl10-export-delete-durability-");
    const own = bundle(home);
    writePublicEvidenceBundle(own, home);

    const restoreFault = setPublicEvidencePurgeFaultForTests("export_directory_sync");
    try {
      expect(() => purgeLocalPublicEvidenceCopies(home)).toThrow(/directory|sync|durab/i);
      // The first attempt already removed the export pathname. A retry must still
      // fsync the now-empty directory rather than reporting success without durability.
      expect(() => purgeLocalPublicEvidenceCopies(home)).toThrow(/directory|sync|durab/i);
    } finally {
      restoreFault();
    }
    expect(() => purgeLocalPublicEvidenceCopies(home)).not.toThrow();
  },
);
