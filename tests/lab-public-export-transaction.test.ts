import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  labExportDir,
  labPublicOriginDir,
  persistConformanceResult,
  rebuildLabProjection,
} from "../src/lab";
import { createArtifactStore } from "../src/lab/artifacts/store";
import { resolveProtocolExecutionContext } from "../src/lab/conformance/executor";
import { discoverScenarios, loadCaseAuthority } from "../src/lab/conformance/manifest";
import type { CaseRecord } from "../src/lab/conformance/types";
import {
  buildPublicEvidenceBundle,
  exportLocalPublicEvidence,
  getOrCreatePublicPublisher,
  previewLocalPublicEvidence,
} from "../src/lab/public";
import { queryLabObservations } from "../src/lab/query";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = join(tmpdir(), `ocx-cl10-export-transaction-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  homes.push(home);
  return home;
}

function syntheticPassResult(caseRecord: CaseRecord) {
  return {
    scenarioId: caseRecord.id,
    suite: caseRecord.suite,
    passed: true,
    classification: "inconclusive" as const,
    assertionResults: caseRecord.assertions.map((assertion) => ({
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: true,
    })),
    diagnostics: [],
    executionContext: resolveProtocolExecutionContext(caseRecord),
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
  };
}

function seedProtocolProjection(home: string): string {
  const authority = loadCaseAuthority();
  const scenario = discoverScenarios(authority, ["responses-core"])
    .find((candidate) => candidate.id === "responses-core.protocol.request-shape")
    ?? discoverScenarios(authority, ["responses-core"])[0];
  if (!scenario) throw new Error("no responses-core protocol scenario available");
  const store = createArtifactStore(join(home, "lab", "artifacts"));
  try {
    persistConformanceResult(syntheticPassResult(scenario), scenario, authority, {
      configDir: home,
      recordedAt: 1_700_000_001_100,
      artifactStore: store,
    });
  } finally {
    store.close();
  }
  rebuildLabProjection(home);
  const eventId = queryLabObservations(
    { layer: "protocol_conformance", scenarioId: scenario.id },
    undefined,
    10,
    home,
  ).items[0]?.eventId;
  if (!eventId) throw new Error("seeded observation missing");
  return eventId;
}

test("a provenance failure prevents local public export publication", () => {
  const home = tempHome();
  const eventId = seedProtocolProjection(home);
  const preview = previewLocalPublicEvidence({ eventIds: [eventId] }, home);
  const publisher = getOrCreatePublicPublisher(home).publisher;
  const unsigned = buildPublicEvidenceBundle({
    records: preview.bundle.records,
    artifacts: preview.bundle.artifacts,
    createdDayUtc: preview.bundle.createdDayUtc,
    publisher,
  });
  const exportPath = join(labExportDir(home), `${unsigned.bundleId}.json`);
  const originPath = join(
    labPublicOriginDir(home),
    `origin-${publisher.keyId}-${unsigned.bundleId}.json`,
  );

  // A directory at the marker pathname makes the provenance commit fail closed.
  mkdirSync(originPath, { mode: 0o700 });
  expect(() => exportLocalPublicEvidence({ eventIds: [eventId] }, home)).toThrow(/public origin marker/i);
  expect(existsSync(exportPath)).toBe(false);
});
