import type { CompatibilityVerdict, EvidenceLayer } from "../../lab/constants";
import { closeLabReadConnection, openLabReadConnection } from "../../lab/query/connection";

export interface VerdictRow {
  subjectId: string;
  evidenceLayer: EvidenceLayer;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  verdict: CompatibilityVerdict;
  asOf: number;
  notes: string[];
}

export interface CompatibilityEvidenceSnapshot {
  projectionAvailable: boolean;
  projectionIncompatible: boolean;
  bySubject: Map<string, VerdictRow[]>;
}

function parseNotes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Bounded read-only compatibility verdict snapshot for routing evaluation.
 * One connection + one query for all subject IDs.
 */
export function loadCompatibilityEvidenceSnapshot(
  subjectIds: readonly string[],
  configDir?: string,
): CompatibilityEvidenceSnapshot {
  const empty: CompatibilityEvidenceSnapshot = {
    projectionAvailable: false,
    projectionIncompatible: false,
    bySubject: new Map(),
  };
  if (subjectIds.length === 0) return { ...empty, projectionAvailable: true };

  try {
    const conn = openLabReadConnection(configDir);
    try {
      const uniqueSubjectIds = [...new Set(subjectIds)];
      const placeholders = uniqueSubjectIds.map(() => "?").join(", ");
      const rows = conn.db.prepare(
        `SELECT subject_id, evidence_layer, suite_id, suite_version, suite_manifest_digest, verdict, as_of, notes_json
         FROM verdicts
         WHERE subject_id IN (${placeholders})`,
      ).all(...uniqueSubjectIds) as Array<{
        subject_id: string;
        evidence_layer: string;
        suite_id: string;
        suite_version: string;
        suite_manifest_digest: string;
        verdict: string;
        as_of: number;
        notes_json: string;
      }>;

      const bySubject = new Map<string, VerdictRow[]>();
      for (const row of rows) {
        const list = bySubject.get(row.subject_id) ?? [];
        list.push({
          subjectId: row.subject_id,
          evidenceLayer: row.evidence_layer as EvidenceLayer,
          suiteId: row.suite_id,
          suiteVersion: row.suite_version,
          suiteManifestDigest: row.suite_manifest_digest,
          verdict: row.verdict as CompatibilityVerdict,
          asOf: row.as_of,
          notes: parseNotes(row.notes_json),
        });
        bySubject.set(row.subject_id, list);
      }
      return { projectionAvailable: true, projectionIncompatible: false, bySubject };
    } finally {
      closeLabReadConnection(conn);
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = String((err as { code: unknown }).code);
      if (code === "lab_projection_incompatible") {
        return { projectionAvailable: false, projectionIncompatible: true, bySubject: new Map() };
      }
    }
    return empty;
  }
}

/** Match the current canonical projection identity, never a stale suite revision. */
export function findVerdictForSuite(
  snapshot: CompatibilityEvidenceSnapshot,
  subjectId: string,
  evidenceLayer: EvidenceLayer,
  suiteId: string,
  suiteVersion: string,
  suiteManifestDigest: string,
): VerdictRow | undefined {
  const rows = snapshot.bySubject.get(subjectId) ?? [];
  return rows.find(row =>
    row.evidenceLayer === evidenceLayer
    && row.suiteId === suiteId
    && row.suiteVersion === suiteVersion
    && row.suiteManifestDigest === suiteManifestDigest);
}
