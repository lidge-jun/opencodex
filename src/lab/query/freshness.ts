import type { EvidenceLayer } from "../constants";
import { closeLabReadConnection, openLabReadConnection } from "./connection";

export interface ExactObservationIdentity {
  subjectId: string;
  layer: EvidenceLayer;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
}

/** Return the newest non-excluded observation for one exact evidence identity. */
export function queryLatestExactObservationCompletedAt(
  identity: ExactObservationIdentity,
  configDir?: string,
): number | undefined {
  const conn = openLabReadConnection(configDir);
  try {
    const row = conn.db
      .query(
        `SELECT o.completed_at
         FROM observations o
         JOIN events e ON e.event_id = o.event_id
         WHERE o.subject_id = ?
           AND o.evidence_layer = ?
           AND o.suite_id = ?
           AND o.suite_version = ?
           AND o.suite_manifest_digest = ?
           AND o.scenario_id = ?
           AND o.scenario_version = ?
           AND o.scenario_manifest_digest = ?
           AND e.excluded = 0
         ORDER BY o.completed_at DESC, o.event_id DESC
         LIMIT 1`,
      )
      .get(
        identity.subjectId,
        identity.layer,
        identity.suiteId,
        identity.suiteVersion,
        identity.suiteManifestDigest,
        identity.scenarioId,
        identity.scenarioVersion,
        identity.scenarioManifestDigest,
      ) as { completed_at: number } | null;
    return row ? Number(row.completed_at) : undefined;
  } finally {
    closeLabReadConnection(conn);
  }
}
