import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignEventId,
  jcsStringify,
  LabValidationError,
  purgeSensitiveEvidence,
  replayLabLedger,
  subjectIdForSubject,
  validateLabEvent,
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
} from "../src/lab";
import { createArtifactStore } from "../src/lab/artifacts/store";
import {
  ArtifactFsError,
  closeTrustedArtifactDir,
  openTrustedArtifactDir,
  putNamedDigestBytes,
} from "../src/lab/artifacts/secure-fs";
import { suiteManifestDigest } from "../src/lab/digest";
import { enforceEventStructureLimits } from "../src/lab/events/limits";
import type { ObservationEvent, ProtocolSubjectV1 } from "../src/lab/events/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-hardening-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try {
      removeTreeWithRetry(dir);
    } catch {
      /* ignore */
    }
  }
  delete process.env.OPENCODEX_HOME;
});

function createHashHex(value: string): string {
  return Bun.CryptoHasher.hash("sha256", value, "hex");
}

function protocolSubject(seed = "hardening"): ProtocolSubjectV1 {
  return {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: "protocol-v1",
    effectiveAdapter: "openai-chat",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
    behaviorFingerprint: createHashHex(seed),
  };
}

function baseObservation(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  const subject = protocolSubject(overrides.scenarioId ?? "hardening");
  const subjectId = subjectIdForSubject(subject);
  const fixtureDigest = createHashHex("fixture");
  const scenarioDigest = createHashHex("scenario");
  const suiteDigest = createHashHex("suite");
  return assignEventId({
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "observation" as const,
    recordedAt: 1_700_000_000_000,
    producer: LAB_PRODUCER,
    producerVersion: "2.10.2",
    evidenceLayer: "protocol_conformance" as const,
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1",
    scenarioManifestDigest: scenarioDigest,
    suiteId: "responses-core",
    suiteVersion: "1",
    suiteManifestDigest: suiteDigest,
    fixtureDigests: [fixtureDigest],
    subject,
    subjectId,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_100,
    executionMode: "fixture" as const,
    attempt: 1,
    limits: { totalTimeoutMs: 1000 },
    outcome: "pass" as const,
    assertions: [
      {
        id: "a1",
        operator: "equals",
        required: true,
        passed: true,
        expectedSummary: "ok",
        observedSummary: "ok",
      },
    ],
    environment: { runtime: { platform: "test", arch: "x64", bunVersion: "1.0.0" } },
    artifactRefs: [
      {
        digest: scenarioDigest,
        mediaType: "application/json",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${scenarioDigest}.bin`,
        artifactClass: "scenario_manifest" as const,
      },
      {
        digest: suiteDigest,
        mediaType: "application/json",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${suiteDigest}.bin`,
        artifactClass: "suite_manifest" as const,
      },
      {
        digest: fixtureDigest,
        mediaType: "application/json",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${fixtureDigest}.bin`,
        artifactClass: "fixture" as const,
      },
    ],
    ...overrides,
  }) as ObservationEvent;
}

test("replay preserves a UTF-8 code point split at the 64 KiB read boundary", () => {
  const home = tempHome();
  const ledger = join(home, "compatibility.jsonl");
  const first = baseObservation({ scenarioId: "responses-core.protocol.pad" });
  const second = baseObservation({
    scenarioId: "responses-core.protocol.utf8",
    assertions: [
      {
        id: "utf8",
        operator: "equals",
        required: true,
        passed: true,
        expectedSummary: "café",
        observedSummary: "café",
      },
    ],
  });

  const firstJson = jcsStringify(first);
  const secondLine = `${jcsStringify(second)}\n`;
  const secondBytes = Buffer.from(secondLine, "utf8");
  const accentIndex = secondBytes.indexOf(Buffer.from("é", "utf8"));
  expect(accentIndex).toBeGreaterThan(0);
  const targetFirstLineBytes = 64 * 1024 - accentIndex - 1;
  const padBytes = targetFirstLineBytes - Buffer.byteLength(firstJson, "utf8") - 1;
  expect(padBytes).toBeGreaterThanOrEqual(0);
  const firstLine = `${" ".repeat(padBytes)}${firstJson}\n`;
  expect(Buffer.byteLength(firstLine, "utf8") + accentIndex).toBe(64 * 1024 - 1);

  writeFileSync(ledger, `${firstLine}${secondLine}`, "utf8");
  const replay = replayLabLedger(ledger);
  expect(replay.corruptions).toEqual([]);
  expect(replay.events).toHaveLength(2);
  const utf8 = replay.events.find((event) => event.eventId === second.eventId) as ObservationEvent | undefined;
  expect(utf8?.assertions[0]?.observedSummary).toBe("café");
});

test("replay discards an oversized unterminated line after reporting it once", () => {
  const home = tempHome();
  const ledger = join(home, "compatibility.jsonl");
  writeFileSync(ledger, Buffer.alloc(128 * 1024, 0x61));

  const replay = replayLabLedger(ledger);
  expect(replay.events).toEqual([]);
  expect(replay.totalLineCount).toBe(1);
  expect(replay.corruptions).toHaveLength(1);
  expect(replay.corruptions[0]?.kind).toBe("malformed_line");
});

test("event privacy admission rejects raw POSIX path bypass forms", () => {
  for (const detail of [
    "config=/home/alice/work/repo",
    "cwd=/usr/local/bin",
    "cwd=/tmp",
    "cwd=/tmp/",
    "cwd=/",
    "/",
    "cwd=/tmp//secret",
    "cwd=/home/@alice",
    "cwd=/home/josé/work",
    "x-/home/alice",
  ]) {
    try {
      enforceEventStructureLimits({ detail });
      throw new Error(`expected raw_path rejection for ${detail}`);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("raw_path");
    }
  }
});

test("invalid JSON contract artifacts classify as artifact_mismatch", () => {
  const home = tempHome();
  const artifactsDir = join(home, "artifacts");
  const digest = createHashHex("malformed-suite-manifest");
  const dir = openTrustedArtifactDir(artifactsDir);
  try {
    putNamedDigestBytes(dir, digest, new TextEncoder().encode("{"), () => digest);
  } finally {
    closeTrustedArtifactDir(dir);
  }

  const store = createArtifactStore(artifactsDir);
  try {
    expect(() => store.get(digest, { artifactClass: "suite_manifest" })).toThrow(ArtifactFsError);
    try {
      store.get(digest, { artifactClass: "suite_manifest" });
      throw new Error("expected artifact mismatch");
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactFsError);
      expect((err as ArtifactFsError).code).toBe("artifact_mismatch");
    }
  } finally {
    store.close();
  }
});

test("store.put converts malformed contract JSON to artifact_mismatch", () => {
  const home = tempHome();
  const store = createArtifactStore(join(home, "artifacts"));
  try {
    try {
      store.put({
        artifactClass: "suite_manifest",
        payload: new TextEncoder().encode("{"),
      });
      throw new Error("expected store.put to reject malformed contract JSON");
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactFsError);
      expect((err as ArtifactFsError).code).toBe("artifact_mismatch");
    }
  } finally {
    store.close();
  }
});

test("contract artifacts reject malformed UTF-8 instead of replacement-decoding it", () => {
  const home = tempHome();
  const artifactsDir = join(home, "artifacts");
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"x":"', "utf8"),
    Buffer.from([0x80]),
    Buffer.from('"}', "utf8"),
  ]);
  const digest = suiteManifestDigest({ x: "\uFFFD" });
  const dir = openTrustedArtifactDir(artifactsDir);
  try {
    putNamedDigestBytes(dir, digest, invalidUtf8, () => digest);
  } finally {
    closeTrustedArtifactDir(dir);
  }

  const store = createArtifactStore(artifactsDir);
  try {
    try {
      store.get(digest, { artifactClass: "suite_manifest" });
      throw new Error("expected malformed UTF-8 artifact mismatch");
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactFsError);
      expect((err as ArtifactFsError).code).toBe("artifact_mismatch");
    }
  } finally {
    store.close();
  }
});

test("default sensitive purge removes export evidence", () => {
  const home = tempHome();
  const exportDir = join(home, "lab", "export");
  mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  const secret = join(exportDir, "bundle.json");
  writeFileSync(secret, "sensitive export", "utf8");

  purgeSensitiveEvidence({ configDir: home, recordedAt: 1_700_000_000_500 });
  expect(existsSync(secret)).toBe(false);
});

test("purge tombstone without targets still requires a directory-scoped action", () => {
  try {
    validateLabEvent(assignEventId({
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "purge_tombstone",
      recordedAt: 1_700_000_000_500,
      producer: LAB_PRODUCER,
      producerVersion: "test",
      targetEventIds: [],
      targetArtifactDigests: [],
      reason: "sensitive_evidence",
      purgeActions: ["artifact", "ledger", "sqlite"],
    }));
    throw new Error("expected empty_purge_targets validation failure");
  } catch (err) {
    expect(err).toBeInstanceOf(LabValidationError);
    expect((err as LabValidationError).code).toBe("empty_purge_targets");
  }
});
