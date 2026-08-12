/**
 * The sole reader/writer for integrations/codex.json.
 *
 * Provenance once disappeared when a corrupt record was treated as an empty one
 * (005_disable_leaves_a_broken_file.md). Reads therefore validate the complete
 * known shape, and updates refuse malformed bytes instead of manufacturing a new
 * baseline over evidence we can no longer trust.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir, withConfigMutationLockSync } from "../config";
import type {
  CodexArtifactId,
  CodexIntegrationRecord,
  CodexProvenanceEntry,
  CodexProvenanceLedger,
} from "./convergence-types";

const RECORD_FILENAME = "codex.json";
const LEGACY_TRANSITION_KEYS = new Set([
  "nativeGeneration",
  "currentTxId",
  "generation",
  "history",
  "historySchedule",
]);

function recordPath(): string {
  return join(getConfigDir(), "integrations", RECORD_FILENAME);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function invalid(message: string) {
  return { kind: "invalid" as const, message };
}

function validateArtifact(value: unknown): value is CodexArtifactId {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "config":
    case "generated-profile":
    case "models-cache":
    case "injection-journal":
      return true;
    case "active-catalog":
    case "history-manifest":
    case "history-rollout":
      return typeof value.canonicalPath === "string"
        && (value.kind === "active-catalog" || typeof value.stateDbId === "string");
    case "catalog-backup":
      return (value.form === "hashed" || value.form === "legacy")
        && typeof value.canonicalPath === "string";
    case "history-row":
    case "history-manifest-entry":
      return typeof value.stateDbId === "string" && typeof value.threadId === "string";
    default:
      return false;
  }
}

function validateBaseline(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "absent") return true;
  return value.kind === "present"
    && typeof value.sha256 === "string"
    && typeof value.bytesBase64 === "string";
}

function validateEntry(value: unknown): value is CodexProvenanceEntry {
  return isPlainRecord(value)
    && validateArtifact(value.artifact)
    && validateBaseline(value.baseline)
    && (typeof value.postImage === "string" || value.postImage === null)
    && typeof value.txId === "string"
    && typeof value.at === "string";
}

function validateLedger(value: unknown): value is CodexProvenanceLedger {
  return isPlainRecord(value)
    && Array.isArray(value.entries)
    && value.entries.every(validateEntry);
}

function validateRecord(value: unknown): value is CodexIntegrationRecord {
  return isPlainRecord(value)
    && value.version === 1
    && !Object.keys(value).some(key => LEGACY_TRANSITION_KEYS.has(key))
    && (value.provenance === undefined || validateLedger(value.provenance));
}

function readIntegrationRecordUnlocked() {
  let raw: string;
  try {
    raw = readFileSync(recordPath(), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { kind: "missing" as const, record: null };
    return invalid(`Codex integration record is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return invalid("Codex integration record contains invalid JSON");
  }
  if (!validateRecord(parsed)) {
    return invalid("Codex integration record has an unsupported or malformed v1 shape");
  }
  return { kind: "ready" as const, record: parsed };
}

export const readIntegrationRecord = readIntegrationRecordUnlocked;

function copyUnknown(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (!knownKeys.has(key)) merged[key] = value;
  }
  return { ...merged, ...next };
}

function artifactKnownKeys(artifact: CodexArtifactId): ReadonlySet<string> {
  switch (artifact.kind) {
    case "config":
    case "generated-profile":
    case "models-cache":
    case "injection-journal":
      return new Set(["kind"]);
    case "active-catalog":
      return new Set(["kind", "canonicalPath"]);
    case "catalog-backup":
      return new Set(["kind", "form", "canonicalPath"]);
    case "history-row":
    case "history-manifest-entry":
      return new Set(["kind", "stateDbId", "threadId"]);
    case "history-manifest":
    case "history-rollout":
      return new Set(["kind", "stateDbId", "canonicalPath"]);
  }
}

function mergeArtifact(previous: CodexArtifactId, next: CodexArtifactId): CodexArtifactId {
  return copyUnknown(
    previous as CodexArtifactId & Record<string, unknown>,
    next as CodexArtifactId & Record<string, unknown>,
    artifactKnownKeys(previous),
  ) as CodexArtifactId;
}

function mergeBaseline(
  previous: CodexProvenanceEntry["baseline"],
  next: CodexProvenanceEntry["baseline"],
): CodexProvenanceEntry["baseline"] {
  const known = previous.kind === "present"
    ? new Set(["kind", "sha256", "bytesBase64"])
    : new Set(["kind"]);
  return copyUnknown(previous, next, known) as CodexProvenanceEntry["baseline"];
}

function knownArtifactIdentity(artifact: CodexArtifactId): string {
  switch (artifact.kind) {
    case "config":
    case "generated-profile":
    case "models-cache":
    case "injection-journal":
      return artifact.kind;
    case "active-catalog":
      return `${artifact.kind}\0${artifact.canonicalPath}`;
    case "catalog-backup":
      return `${artifact.kind}\0${artifact.form}\0${artifact.canonicalPath}`;
    case "history-row":
    case "history-manifest-entry":
      return `${artifact.kind}\0${artifact.stateDbId}\0${artifact.threadId}`;
    case "history-manifest":
    case "history-rollout":
      return `${artifact.kind}\0${artifact.stateDbId}\0${artifact.canonicalPath}`;
  }
}

function mergeEntry(previous: CodexProvenanceEntry, next: CodexProvenanceEntry): CodexProvenanceEntry {
  const merged = copyUnknown(
    previous,
    next,
    new Set(["artifact", "baseline", "postImage", "txId", "at"]),
  );
  return {
    ...merged,
    artifact: mergeArtifact(previous.artifact, next.artifact),
    baseline: mergeBaseline(previous.baseline, next.baseline),
  } as CodexProvenanceEntry;
}

function mergeLedger(previous: CodexProvenanceLedger, next: CodexProvenanceLedger): CodexProvenanceLedger {
  const unused = new Set(previous.entries.map((_, index) => index));
  const entries = next.entries.map((entry, nextIndex) => {
    let previousIndex = previous.entries.findIndex((candidate, index) =>
      unused.has(index)
      && candidate.txId === entry.txId
      && candidate.at === entry.at
      && knownArtifactIdentity(candidate.artifact) === knownArtifactIdentity(entry.artifact));
    if (previousIndex < 0 && unused.has(nextIndex)) previousIndex = nextIndex;
    if (previousIndex < 0) return entry;
    unused.delete(previousIndex);
    return mergeEntry(previous.entries[previousIndex]!, entry);
  });
  return {
    ...copyUnknown(previous, next, new Set(["entries"])),
    entries,
  } as CodexProvenanceLedger;
}

function preserveExtensions(
  previous: CodexIntegrationRecord,
  next: CodexIntegrationRecord,
): CodexIntegrationRecord {
  const merged = copyUnknown(previous, next, new Set(["version", "provenance"]));
  if (previous.provenance && next.provenance) {
    merged.provenance = mergeLedger(previous.provenance, next.provenance);
  }
  return merged as CodexIntegrationRecord;
}

/**
 * Keep read, extension merge, and atomic replacement inside the config mutation
 * coordinator. WP12 must call this function instead of recreating the incident's
 * stale read/merge/write sequence at its own call site.
 */
export const updateIntegrationRecord = (
  mutate: (record: CodexIntegrationRecord) => CodexIntegrationRecord,
) => {
  try {
    return withConfigMutationLockSync(() => {
      const read = readIntegrationRecordUnlocked();
      if (read.kind === "invalid") return read;
      const previous: CodexIntegrationRecord = read.kind === "ready" ? read.record : { version: 1 };
      const proposed = mutate(previous);
      if (!validateRecord(proposed)) {
        return { kind: "invalid", message: "Codex integration record update produced a malformed v1 shape" };
      }
      const record = preserveExtensions(previous, proposed);
      if (!validateRecord(record)) {
        return { kind: "invalid", message: "Codex integration record extension merge produced a malformed v1 shape" };
      }
      const path = recordPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`);
      return { kind: "updated", record };
    });
  } catch (error) {
    return {
      kind: "invalid",
      message: `Codex integration record update failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
