import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readIntegrationRecord,
  updateIntegrationRecord,
} from "../src/codex/integration-record";
import type {
  CodexArtifactId,
  CodexIntegrationRecord,
  CodexProvenanceEntry,
} from "../src/codex/convergence-types";

let opencodexHome = "";
let previousOpencodexHome: string | undefined;

function integrationRecordPath(): string {
  return join(opencodexHome, "integrations", "codex.json");
}

function writeRecord(value: unknown): void {
  mkdirSync(join(opencodexHome, "integrations"), { recursive: true });
  writeFileSync(integrationRecordPath(), JSON.stringify(value, null, 2));
}

function persistedRecord(): Record<string, unknown> {
  return JSON.parse(readFileSync(integrationRecordPath(), "utf8")) as Record<string, unknown>;
}

function knownArtifactFields(artifact: CodexArtifactId): CodexArtifactId {
  switch (artifact.kind) {
    case "config":
    case "generated-profile":
    case "models-cache":
    case "injection-journal":
      return { kind: artifact.kind };
    case "active-catalog":
      return { kind: artifact.kind, canonicalPath: artifact.canonicalPath };
    case "catalog-backup":
      return { kind: artifact.kind, form: artifact.form, canonicalPath: artifact.canonicalPath };
    case "history-row":
    case "history-manifest-entry":
      return { kind: artifact.kind, stateDbId: artifact.stateDbId, threadId: artifact.threadId };
    case "history-manifest":
    case "history-rollout":
      return { kind: artifact.kind, stateDbId: artifact.stateDbId, canonicalPath: artifact.canonicalPath };
  }
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-integration-record-"));
  process.env.OPENCODEX_HOME = opencodexHome;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
});

describe("Codex integration record", () => {
  test("accepts a v1 record written before provenance existed", () => {
    writeRecord({ version: 1 });

    expect(readIntegrationRecord()).toEqual({
      kind: "ready",
      record: { version: 1 },
    });
  });

  test("preserves future keys at record, ledger, entry, artifact, and both baseline levels", () => {
    const artifacts: CodexArtifactId[] = [
      { kind: "config", futureArtifact: { owner: "future-config" } },
      { kind: "generated-profile", futureArtifact: { owner: "future-profile" } },
      { kind: "active-catalog", canonicalPath: "/catalog", futureArtifact: { owner: "future-catalog" } },
      { kind: "catalog-backup", form: "hashed", canonicalPath: "/backup", futureArtifact: { owner: "future-backup" } },
      { kind: "models-cache", futureArtifact: { owner: "future-cache" } },
      { kind: "injection-journal", futureArtifact: { owner: "future-journal" } },
      { kind: "history-row", stateDbId: "db-row", threadId: "thread-row", futureArtifact: { owner: "future-row" } },
      { kind: "history-manifest", stateDbId: "db-manifest", canonicalPath: "/manifest", futureArtifact: { owner: "future-manifest" } },
      { kind: "history-manifest-entry", stateDbId: "db-entry", threadId: "thread-entry", futureArtifact: { owner: "future-entry" } },
      { kind: "history-rollout", stateDbId: "db-rollout", canonicalPath: "/rollout", futureArtifact: { owner: "future-rollout" } },
    ];
    writeRecord({
      version: 1,
      futureRecord: { mode: "newer" },
      provenance: {
        futureLedger: ["keep"],
        entries: artifacts.map((artifact, index): CodexProvenanceEntry => ({
          artifact,
          baseline: index % 2 === 0
            ? { kind: "absent", futureAbsentBaseline: index }
            : {
                kind: "present",
                sha256: `baseline-sha-${index}`,
                bytesBase64: "YmFzZWxpbmU=",
                futurePresentBaseline: { codec: index },
              },
          postImage: `old-post-image-${index}`,
          txId: `tx-${index}`,
          at: `2026-08-04T00:00:${String(index).padStart(2, "0")}.000Z`,
          futureEntry: { evidence: index },
        })),
      },
    });

    const result = updateIntegrationRecord(record => ({
      version: 1,
      provenance: {
        entries: record.provenance!.entries.map((entry, index) => ({
          artifact: knownArtifactFields(entry.artifact),
          baseline: entry.baseline.kind === "absent"
            ? { kind: "absent" }
            : {
                kind: "present",
                sha256: entry.baseline.sha256,
                bytesBase64: entry.baseline.bytesBase64,
              },
          postImage: `new-post-image-${index}`,
          txId: entry.txId,
          at: entry.at,
        })),
      },
    }));

    expect(result.kind).toBe("updated");
    const saved = persistedRecord();
    expect(saved.futureRecord).toEqual({ mode: "newer" });
    const ledger = saved.provenance as Record<string, unknown>;
    expect(ledger.futureLedger).toEqual(["keep"]);
    const entries = ledger.entries as Array<Record<string, unknown>>;
    expect(entries.map(entry => entry.futureEntry)).toEqual(
      artifacts.map((_, index) => ({ evidence: index })),
    );
    expect(entries.map(entry => (entry.artifact as Record<string, unknown>).futureArtifact)).toEqual(
      artifacts.map(artifact => artifact.futureArtifact),
    );
    expect((entries[0]!.baseline as Record<string, unknown>).futureAbsentBaseline).toBe(0);
    expect((entries[1]!.baseline as Record<string, unknown>).futurePresentBaseline)
      .toEqual({ codec: 1 });
    expect(entries.map(entry => entry.postImage)).toEqual(
      artifacts.map((_, index) => `new-post-image-${index}`),
    );
  });

  test("fails closed on unparseable bytes without invoking the mutator or resetting the file", () => {
    mkdirSync(join(opencodexHome, "integrations"), { recursive: true });
    writeFileSync(integrationRecordPath(), "{ definitely-not-json", "utf8");
    let invoked = false;

    const result = updateIntegrationRecord((record): CodexIntegrationRecord => {
      invoked = true;
      return record;
    });

    expect(result).toEqual({
      kind: "invalid",
      message: "Codex integration record contains invalid JSON",
    });
    expect(invoked).toBe(false);
    expect(readFileSync(integrationRecordPath(), "utf8")).toBe("{ definitely-not-json");
  });

  test("creates the minimal v1 record on the first provenance write", () => {
    const firstEntry: CodexProvenanceEntry = {
      artifact: { kind: "config" },
      baseline: { kind: "absent" },
      postImage: "first-post-image",
      txId: "tx-first",
      at: "2026-08-04T00:00:00.000Z",
    };
    const result = updateIntegrationRecord(record => ({
      ...record,
      provenance: { entries: [firstEntry] },
    }));

    expect(result).toEqual({
      kind: "updated",
      record: { version: 1, provenance: { entries: [firstEntry] } },
    });
    expect(persistedRecord()).toEqual({
      version: 1,
      provenance: { entries: [firstEntry] },
    });
  });
});
