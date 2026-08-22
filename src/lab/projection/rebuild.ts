import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { createArtifactStore, loadClaimSourceManifest } from "../artifacts/store";
import { ArtifactFsError } from "../artifacts/secure-fs";
import { sanitizeDiagnostic } from "../artifacts/sanitize";
import { LAB_PROJECTION_SPEC_VERSION } from "../constants";
import { expandScenario, loadCaseAuthority } from "../conformance/manifest";
import { scenarioManifestDigest, jcsStringify } from "../digest";
import {
  parseSuiteManifestFromArtifact,
  type ScenarioRequirements,
} from "./verification";
import type { ClaimSnapshotEvent, LabEvent, LedgerCorruption } from "../events/types";
import { buildInvalidationIndex, isEventExcluded } from "../ledger/invalidation";
import { replayLabLedger } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import { LAB_SQLITE_DDL, LAB_SQLITE_SCHEMA_VERSION } from "./schema";
import {
  claimKeyString,
  excludeEventIds,
  projectVerdicts,
  projectionKeyString,
  resolveClaimStates,
} from "./verdicts";

export interface RebuildResult {
  events: number;
  verdicts: number;
  corruptions: LedgerCorruption[];
  sqlitePath: string;
}

function wipeSqlite(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    let removed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        if (existsSync(candidate)) unlinkSync(candidate);
        removed = true;
        break;
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
        if (code !== "EBUSY" && code !== "EPERM") throw err;
        if (attempt < 7) Bun.sleepSync(20 * (attempt + 1));
      }
    }
    if (!removed) {
      throw new Error(`failed to remove stale projection file after retries: ${candidate}`);
    }
  }
}

function resetProjectionSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS verdicts;
    DROP TABLE IF EXISTS corruption;
    DROP TABLE IF EXISTS artifacts;
    DROP TABLE IF EXISTS purges;
    DROP TABLE IF EXISTS invalidations;
    DROP TABLE IF EXISTS claims;
    DROP TABLE IF EXISTS observations;
    DROP TABLE IF EXISTS subjects;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS schema_meta;
  `);
  db.exec(LAB_SQLITE_DDL);
}

interface ArtifactValidationResult {
  unusableObservationIds: Set<string>;
  unusableClaimEventIds: Set<string>;
}

/**
 * Deterministic rebuild:
 * delete compatibility.sqlite → replay JSONL → validate artifacts → project.
 */
export function rebuildLabProjection(configDir?: string): RebuildResult {
  const paths = ensureLabDirs(configDir);
  wipeSqlite(paths.sqlitePath);

  const replay = replayLabLedger(paths.ledgerPath);
  const corruptions: LedgerCorruption[] = [...replay.corruptions];
  const index = buildInvalidationIndex(replay.events);
  corruptions.push(...index.corruptions);

  const artifactStore = createArtifactStore(paths.artifactsDir);
  const validation = validateRequiredArtifacts(replay.events, index, artifactStore, corruptions);

  const authority = loadCaseAuthority();
  const scenarioRequirementsByDigest = new Map<string, ScenarioRequirements>();
  for (const caseRecord of authority.cases) {
    const expanded = expandScenario(caseRecord, authority);
    scenarioRequirementsByDigest.set(scenarioManifestDigest(expanded), {
      inboundProtocols: [...caseRecord.requirements.inboundProtocols],
      upstreamProtocols: [...caseRecord.requirements.upstreamProtocols],
      surfaces: [...caseRecord.requirements.surfaces],
      freshness: { ...authority.manifestDefaults.freshness },
    });
  }

  const loadSuiteManifest = (digest: string) => {
    try {
      const bytes = artifactStore.get(digest, { artifactClass: "suite_manifest" });
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parseSuiteManifestFromArtifact(parsed);
    } catch {
      return null;
    }
  };
  const loadScenarioManifest = (digest: string) => {
    try {
      const bytes = artifactStore.get(digest, { artifactClass: "scenario_manifest" });
      return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const loadScenarioRequirements = (digest: string) => scenarioRequirementsByDigest.get(digest) ?? null;

  const db = new Database(paths.sqlitePath);
  let transactionOpen = false;
  // Every statement prepared below, so they can be finalized before the close.
  //
  // Bun keeps a prepared statement alive until it is finalized or garbage collected,
  // and on Windows an unfinalized statement holds the database file open: `close()`
  // leaves the handle, and `close(true)` throws "database is locked". A second
  // rebuild then failed to unlink the previous projection with EBUSY, and the retry
  // loop in `wipeSqlite` could only turn that into a slower failure. POSIX allows
  // unlinking an open file, which is why this never surfaced there.
  const prepared: Array<{ finalize(): void }> = [];
  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    prepared.push(statement);
    return statement;
  };
  try {
    db.exec("PRAGMA journal_mode=DELETE;");
    db.exec("PRAGMA foreign_keys=OFF;");
    db.exec("BEGIN IMMEDIATE;");
    transactionOpen = true;
    resetProjectionSchema(db);

    const insertMeta = prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)");
    insertMeta.run("schema_version", String(LAB_SQLITE_SCHEMA_VERSION));
    insertMeta.run("projection_spec_version", LAB_PROJECTION_SPEC_VERSION);
    insertMeta.run("built_at_ms", String(Date.now()));

    const insertCorruption = prepare(
      "INSERT INTO corruption(kind, line_number, event_id, detail) VALUES (?, ?, ?, ?)",
    );
    for (const c of corruptions) {
      insertCorruption.run(c.kind, c.lineNumber ?? null, c.eventId ?? null, c.detail);
    }

    const insertEvent = prepare(
      `INSERT INTO events(event_id, event_kind, recorded_at, producer, producer_version, payload_json, excluded, exclusion_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSubject = prepare(
      `INSERT OR IGNORE INTO subjects(subject_id, subject_kind, subject_json) VALUES (?, ?, ?)`,
    );
    const insertObs = prepare(
      `INSERT INTO observations(
         event_id, subject_id, evidence_layer, suite_id, suite_version, suite_manifest_digest,
         scenario_id, scenario_version, scenario_manifest_digest, outcome, completed_at, execution_mode
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertClaim = prepare(
      `INSERT INTO claims(
         event_id, subject_id, capability, polarity, source_manifest_digest,
         effective_at, recorded_at, supersedes_json, current, usable
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertInv = prepare(
      `INSERT INTO invalidations(event_id, reason, targets_json, recorded_at, applied) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertPurge = prepare(
      `INSERT INTO purges(event_id, target_event_ids_json, target_artifact_digests_json, purge_actions_json, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertArtifact = prepare(
      `INSERT INTO artifacts(digest, artifact_class, media_type, byte_count, status, last_error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(digest) DO UPDATE SET
         artifact_class = COALESCE(excluded.artifact_class, artifacts.artifact_class),
         media_type = COALESCE(excluded.media_type, artifacts.media_type),
         byte_count = COALESCE(excluded.byte_count, artifacts.byte_count),
         status = CASE
           WHEN artifacts.status = 'purged_unavailable' OR excluded.status = 'purged_unavailable'
             THEN 'purged_unavailable'
           WHEN artifacts.status = 'corrupt' OR excluded.status = 'corrupt'
             THEN 'corrupt'
           ELSE 'present'
         END,
         last_error = COALESCE(excluded.last_error, artifacts.last_error)`,
    );

    const excluded = excludeEventIds(index);
    const usableClaimEvents = replay.events.filter(
      (e): e is ClaimSnapshotEvent =>
        e.eventKind === "claim_snapshot" && !isEventExcluded(e.eventId, index),
    );
    const claimStates = resolveClaimStates(usableClaimEvents, {
      unusableClaimEventIds: validation.unusableClaimEventIds,
      purgedEventIds: index.purgedEventIds,
    });

    for (const event of replay.events) {
      const isExcluded = excluded.has(event.eventId);
      let exclusionReason: string | null = null;
      if (index.purgedEventIds.has(event.eventId)) exclusionReason = "purged";
      else if (index.invalidatedBy.has(event.eventId)) exclusionReason = "invalidated";

      insertEvent.run(
        event.eventId,
        event.eventKind,
        event.recordedAt,
        event.producer,
        event.producerVersion,
        jcsStringify(event),
        isExcluded ? 1 : 0,
        exclusionReason,
      );

      if (event.eventKind === "observation") {
        insertSubject.run(event.subjectId, event.subject.subjectKind, jcsStringify(event.subject));
        const usable = !isExcluded && !validation.unusableObservationIds.has(event.eventId);
        if (usable) {
          insertObs.run(
            event.eventId,
            event.subjectId,
            event.evidenceLayer,
            event.suiteId,
            event.suiteVersion,
            event.suiteManifestDigest,
            event.scenarioId,
            event.scenarioVersion,
            event.scenarioManifestDigest,
            event.outcome,
            event.completedAt,
            event.executionMode,
          );
        }
        for (const ref of event.artifactRefs) {
          const purged = index.purgedArtifactDigests.has(ref.digest);
          const corrupt = validation.unusableObservationIds.has(event.eventId);
          insertArtifact.run(
            ref.digest,
            ref.artifactClass,
            ref.mediaType,
            ref.byteCount,
            purged ? "purged_unavailable" : corrupt ? "corrupt" : "present",
            corrupt ? "required artifact unusable" : null,
          );
        }
      } else if (event.eventKind === "claim_snapshot") {
        insertSubject.run(event.subjectId, event.subject.subjectKind, jcsStringify(event.subject));
        const key = claimKeyString(event.subjectId, event.capability);
        const state = claimStates.states.get(key);
        const current = state?.current?.eventId === event.eventId ? 1 : 0;
        const claimCorruption = corruptions.find(
          (c) => c.kind === "claim_corruption" && c.eventId === event.eventId,
        );
        const usable = !isExcluded && !state?.corruption &&
          !validation.unusableClaimEventIds.has(event.eventId) ? 1 : 0;

        if (!isExcluded) {
          insertArtifact.run(
            event.sourceManifestDigest,
            "claim_source_manifest",
            "application/json",
            null,
            claimCorruption ? "corrupt" : "present",
            claimCorruption?.detail ?? null,
          );
        }

        insertClaim.run(
          event.eventId,
          event.subjectId,
          event.capability,
          event.polarity,
          event.sourceManifestDigest,
          event.effectiveAt,
          event.recordedAt,
          jcsStringify(event.supersedes),
          current,
          usable,
        );
      } else if (event.eventKind === "invalidation") {
        const applied = !corruptions.some((c) => c.eventId === event.eventId && c.kind === "invalid_reference");
        insertInv.run(
          event.eventId,
          event.reason,
          jcsStringify(event.targetEventIds),
          event.recordedAt,
          applied ? 1 : 0,
        );
      } else if (event.eventKind === "purge_tombstone") {
        insertPurge.run(
          event.eventId,
          jcsStringify(event.targetEventIds),
          jcsStringify(event.targetArtifactDigests),
          jcsStringify(event.purgeActions),
          event.recordedAt,
        );
        for (const digest of event.targetArtifactDigests) {
          insertArtifact.run(digest, null, null, null, "purged_unavailable", null);
        }
      }
    }

    const { verdicts, corruptions: verdictCorruptions } = projectVerdicts(replay.events, {
      index,
      unusableObservationIds: validation.unusableObservationIds,
      unusableClaimEventIds: validation.unusableClaimEventIds,
      loadSuiteManifest,
      loadScenarioManifest,
      loadScenarioRequirements,
    });
    for (const c of verdictCorruptions) {
      if (!corruptions.some((x) => x.detail === c.detail && x.eventId === c.eventId)) {
        corruptions.push(c);
        insertCorruption.run(c.kind, c.lineNumber ?? null, c.eventId ?? null, c.detail);
      }
    }

    const insertVerdict = prepare(
      `INSERT INTO verdicts(
         projection_key, subject_id, evidence_layer, suite_id, suite_version, suite_manifest_digest,
         projection_spec_version, verdict, as_of, scenario_manifest_digests_json, claim_source_digest,
         contributing_event_ids_json, contradicting_event_ids_json, notes_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const v of verdicts) {
      insertVerdict.run(
        projectionKeyString(v.key),
        v.key.subjectId,
        v.key.evidenceLayer,
        v.key.suiteId,
        v.key.suiteVersion,
        v.key.suiteManifestDigest,
        v.key.projectionSpecVersion,
        v.verdict,
        v.asOf,
        jcsStringify(v.scenarioManifestDigests),
        v.claimSourceDigest ?? null,
        jcsStringify(v.contributingEventIds),
        jcsStringify(v.contradictingEventIds),
        jcsStringify(v.notes),
      );
    }

    db.exec("COMMIT;");
    transactionOpen = false;
    return {
      events: replay.events.length,
      verdicts: verdicts.length,
      corruptions,
      sqlitePath: paths.sqlitePath,
    };
  } catch (err) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the original rebuild failure.
      }
    }
    throw err;
  } finally {
    try {
      db.exec("PRAGMA foreign_keys=ON;");
    } catch {
      // Closing the disposable DB is still safe if pragma restoration fails.
    }
    // Finalize before closing: an outstanding statement keeps the file open on
    // Windows, and the next rebuild cannot unlink the projection it is replacing.
    for (const statement of prepared) {
      try {
        statement.finalize();
      } catch {
        // A statement already finalized by an error path is not a rebuild failure.
      }
    }
    db.close();
    artifactStore.close();
  }
}

function validateRequiredArtifacts(
  events: LabEvent[],
  index: ReturnType<typeof buildInvalidationIndex>,
  artifactStore: ReturnType<typeof createArtifactStore>,
  corruptions: LedgerCorruption[],
): ArtifactValidationResult {
  const unusableObservationIds = new Set<string>();
  const unusableClaimEventIds = new Set<string>();

  for (const event of events) {
    if (isEventExcluded(event.eventId, index)) continue;
    if (event.eventKind === "observation") {
      const required: Array<{ digest: string; artifactClass: "scenario_manifest" | "suite_manifest" | "fixture" }> = [
        { digest: event.scenarioManifestDigest, artifactClass: "scenario_manifest" },
        { digest: event.suiteManifestDigest, artifactClass: "suite_manifest" },
        ...event.fixtureDigests.map((digest) => ({ digest, artifactClass: "fixture" as const })),
      ];
      let unusable = false;
      for (const { digest, artifactClass } of required) {
        if (index.purgedArtifactDigests.has(digest)) {
          corruptions.push({
            kind: "missing_artifact",
            eventId: event.eventId,
            detail: `required artifact purged: ${digest}`,
          });
          unusable = true;
          continue;
        }
        try {
          artifactStore.get(digest, { artifactClass });
        } catch (err) {
          const detail = sanitizeDiagnostic(err);
          corruptions.push({
            kind: err instanceof ArtifactFsError &&
              (err.code === "artifact_mismatch" || err.message.includes("mismatch"))
              ? "artifact_mismatch"
              : "missing_artifact",
            eventId: event.eventId,
            detail,
          });
          unusable = true;
        }
      }
      if (unusable) unusableObservationIds.add(event.eventId);
      continue;
    }

    if (event.eventKind === "claim_snapshot") {
      if (index.purgedArtifactDigests.has(event.sourceManifestDigest)) {
        unusableClaimEventIds.add(event.eventId);
        corruptions.push({
          kind: "claim_corruption",
          eventId: event.eventId,
          detail: `claim source artifact purged: ${event.sourceManifestDigest}`,
        });
        continue;
      }
      const loaded = loadClaimSourceManifest(artifactStore, event.sourceManifestDigest, {
        subjectId: event.subjectId,
        capability: event.capability,
      });
      if (!loaded.ok) {
        unusableClaimEventIds.add(event.eventId);
        corruptions.push({
          kind: "claim_corruption",
          eventId: event.eventId,
          detail: loaded.corruption,
        });
      }
    }
  }

  return { unusableObservationIds, unusableClaimEventIds };
}

/** Snapshot derived verdict rows for rebuild-determinism tests (excludes asOf wall clock). */
export function readVerdictSnapshot(sqlitePath: string): unknown[] {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    return db
      .query(
        `SELECT projection_key, subject_id, evidence_layer, suite_id, suite_version,
                suite_manifest_digest, projection_spec_version, verdict,
                scenario_manifest_digests_json, claim_source_digest,
                contributing_event_ids_json, contradicting_event_ids_json, notes_json
         FROM verdicts ORDER BY projection_key`,
      )
      .all();
  } finally {
    db.close();
  }
}

export function readCorruptionRows(sqlitePath: string): unknown[] {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    return db.query(`SELECT kind, line_number, event_id, detail FROM corruption ORDER BY id`).all();
  } finally {
    db.close();
  }
}
