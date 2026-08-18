import {
  closeTrustedArtifactDir,
  deleteArtifactBytes,
  openTrustedArtifactDir,
  type TrustedArtifactDir,
} from "../artifacts/secure-fs";
import { ArtifactFsError } from "../artifacts/secure-fs";
import { renameAtomicFile } from "../../lib/windows-atomic-replace";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  LAB_PRODUCER_VERSION,
  PURGE_ACTIONS,
} from "../constants";
import type { LabEvent, PurgeTombstoneEvent } from "../events/types";
import { assignEventId, validateLabEvent } from "../events/validate";
import {
  artifactDeletionPlan,
  expandSensitiveArtifactEventTargets,
} from "./artifact-refs";
import { buildInvalidationIndex } from "./invalidation";
import { withLedgerMutation } from "./store";
import { ensureLabDirs } from "../paths";
import { rebuildLabProjection } from "../projection/rebuild";
import { jcsStringify } from "../digest";
import { purgeLocalPublicEvidenceCopies } from "../public/purge";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
 
export class PurgeError extends Error {
  readonly code: string;
  readonly completedActions: string[];
  constructor(code: string, message: string, completedActions: string[] = []) {
    super(message);
    this.name = "PurgeError";
    this.code = code;
    this.completedActions = [...completedActions];
  }
}
 
export interface SensitivePurgeRequest {
  configDir?: string;
  targetEventIds?: string[];
  targetArtifactDigests?: string[];
  purgeActions?: Array<(typeof PURGE_ACTIONS)[number]>;
  recordedAt?: number;
  producerVersion?: string;
}
 
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const n = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (n <= 0) throw new PurgeError("short_write", "ledger rewrite short write");
    offset += n;
  }
}
 
function atomicRewriteLedger(ledgerPath: string, events: LabEvent[]): void {
  const body = events.map((e) => jcsStringify(e)).join("\n") + (events.length ? "\n" : "");
  const bytes = new TextEncoder().encode(body);
  const parent = dirname(ledgerPath);
  const tmpPath = join(parent, `.purge-${process.pid}-${Date.now()}.jsonl.tmp`);
  let renamed = false;
  try {
    const fd = openSync(tmpPath, "wx", 0o600);
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameAtomicFile(tmpPath, ledgerPath, undefined, "lab-ledger");
    renamed = true;
  } catch (err) {
    if (!renamed) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Preserve the original failure.
      }
    }
    throw err;
  }
 
  if (process.platform !== "win32") {
    try {
      const dirFd = openSync(parent, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (err) {
      throw new PurgeError(
        "ledger_durability_failed",
        `ledger rewrite committed but directory fsync failed: ${err instanceof Error ? err.message : String(err)}`,
        ["ledger"],
      );
    }
  }
}
 
function deleteArtifactsFailClosed(dir: TrustedArtifactDir, digests: string[]): void {
  const errors: string[] = [];
  for (const digest of digests) {
    try {
      deleteArtifactBytes(dir, digest);
    } catch (err) {
      if (err instanceof ArtifactFsError && err.code === "artifact_missing") continue;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) {
    throw new PurgeError("artifact_delete_failed", errors.join("; "));
  }
}
 
function purgeBoundedDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    try {
      rmSync(full, { recursive: entry.isDirectory(), force: true });
    } catch (err) {
      throw new PurgeError(
        "scratch_export_delete_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
 
function normalizePurgeError(err: unknown, completed: readonly string[]): PurgeError {
  if (err instanceof PurgeError) {
    return new PurgeError(
      err.code,
      err.message,
      [...new Set([...completed, ...err.completedActions])],
    );
  }
  return new PurgeError(
    "purge_failed",
    err instanceof Error ? err.message : String(err),
    [...completed],
  );
}
 
function buildPurgeTombstone(
  req: SensitivePurgeRequest,
  removeIds: ReadonlySet<string>,
  targetArtifactDigests: string[],
  purgeActions: Array<(typeof PURGE_ACTIONS)[number]>,
): PurgeTombstoneEvent {
  return validateLabEvent(assignEventId({
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "purge_tombstone" as const,
    recordedAt: req.recordedAt ?? Date.now(),
    producer: LAB_PRODUCER,
    producerVersion: req.producerVersion ?? LAB_PRODUCER_VERSION,
    targetEventIds: [...removeIds].sort(),
    targetArtifactDigests,
    reason: "sensitive_evidence" as const,
    purgeActions,
  })) as PurgeTombstoneEvent;
}
 
/**
 * Exceptional sensitive-evidence purge:
 * physically remove targeted JSONL lines and artifacts, append purge_tombstone,
 * rebuild SQLite. Fails closed when required sensitive bytes cannot be removed.
 */
export function purgeSensitiveEvidence(req: SensitivePurgeRequest): PurgeTombstoneEvent {
  const paths = ensureLabDirs(req.configDir);
  const targetEventIds = [...(req.targetEventIds ?? [])].sort();
  const targetArtifactDigests = [...(req.targetArtifactDigests ?? [])].sort();
  const purgeActions = [...(req.purgeActions ?? PURGE_ACTIONS)].sort();
  const explicitSensitive = new Set(targetArtifactDigests);
  const completed: string[] = [];
  // Cell object: the mutation callback assigns through the property, which keeps
  // the post-mutation read at the declared type (a closure-captured let would
  // narrow to null and break the combined-error report below).
  const deferredExport: { error: PurgeError | null } = { error: null };
  let operationError: PurgeError | null = null;
  let tombstone: PurgeTombstoneEvent | null = null;
 
  try {
    tombstone = withLedgerMutation(paths.ledgerPath, (ledger) => {
      // Replay and plan under the same lock as every append. Otherwise an event
      // appended after this snapshot can be lost by the atomic rename or can
      // start referencing an artifact after the deletion plan was calculated.
      const replay = ledger.replay();
      const index = buildInvalidationIndex(replay.events);
      const removeIds = expandSensitiveArtifactEventTargets(
        replay.events,
        index,
        new Set(targetEventIds),
        explicitSensitive,
      );
 
      const deletionPlan = purgeActions.includes("artifact")
        ? artifactDeletionPlan(replay.events, index, removeIds, targetArtifactDigests)
        : { deletable: [], retainedExplicit: [] };
 
      if (deletionPlan.retainedExplicit.length > 0) {
        throw new PurgeError(
          "sensitive_bytes_retained",
          `explicit sensitive artifacts remain required: ${deletionPlan.retainedExplicit.join(",")}`,
        );
      }
 
      if (purgeActions.includes("scratch")) {
        purgeBoundedDirectory(paths.scratchDir);
        completed.push("scratch");
      }
      if (purgeActions.includes("export")) {
        try {
          purgeLocalPublicEvidenceCopies(req.configDir);
          completed.push("export");
        } catch (err) {
          // Export deletion is independent from artifact/ledger/sqlite deletion. Keep
          // deleting every other requested sensitive copy, then report this failure.
          deferredExport.error = normalizePurgeError(err, completed);
        }
      }
 
      let dir: TrustedArtifactDir | null = null;
      try {
        if (purgeActions.includes("artifact")) {
          if (deletionPlan.deletable.length > 0) {
            dir = openTrustedArtifactDir(paths.artifactsDir);
            deleteArtifactsFailClosed(dir, deletionPlan.deletable);
          }
          completed.push("artifact");
        }
 
        // Never persist a tombstone claiming that export completed when the export
        // purge failed. Other independent actions remain recordable and continue.
        const tombstoneActions = deferredExport.error
          ? purgeActions.filter((action) => action !== "export")
          : purgeActions;
        const hasTombstoneTarget = removeIds.size > 0
          || targetArtifactDigests.length > 0
          || tombstoneActions.includes("scratch")
          || tombstoneActions.includes("export");
 
        if (tombstoneActions.length > 0 && (hasTombstoneTarget || !deferredExport.error)) {
          const mutationTombstone = buildPurgeTombstone(req, removeIds, targetArtifactDigests, tombstoneActions);
          if (purgeActions.includes("ledger")) {
            const kept: LabEvent[] = [];
            for (const event of replay.events) {
              if (removeIds.has(event.eventId)) continue;
              kept.push(event);
            }
            kept.push(mutationTombstone);
            atomicRewriteLedger(paths.ledgerPath, kept);
            completed.push("ledger");
          } else {
            ledger.append(mutationTombstone);
          }
          return mutationTombstone;
        }
        return null;
      } finally {
        if (dir) closeTrustedArtifactDir(dir);
      }
    });
 
    // SQLite is disposable and rebuildLabProjection replays the canonical
    // ledger again, so it does not need to extend the mutation lock duration.
    if (purgeActions.includes("sqlite")) {
      rebuildLabProjection(req.configDir);
      completed.push("sqlite");
    }
  } catch (err) {
    operationError = normalizePurgeError(err, completed);
  }
 
  const deferredExportError = deferredExport.error;
  if (operationError && deferredExportError) {
    throw new PurgeError(
      "purge_failed",
      `export purge failed: ${deferredExportError.message}; subsequent purge failure (${operationError.code}): ${operationError.message}`,
      [...new Set([...completed, ...deferredExportError.completedActions, ...operationError.completedActions])],
    );
  }
  if (operationError) throw operationError;
  if (deferredExportError) {
    throw new PurgeError(
      deferredExportError.code,
      deferredExportError.message,
      [...new Set([...completed, ...deferredExportError.completedActions])],
    );
  }
  if (!tombstone) {
    throw new PurgeError("purge_failed", "purge completed without a durable tombstone", completed);
  }
  return tombstone;
}
 
