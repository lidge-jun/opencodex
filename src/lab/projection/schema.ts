/**
 * Disposable SQLite projection schema for Compatibility Lab (CL-02).
 * Not canonical storage — rebuildable from JSONL + content-addressed artifacts.
 */
export const LAB_SQLITE_SCHEMA_VERSION = 3;

export const LAB_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('observation', 'claim_snapshot', 'invalidation', 'purge_tombstone')),
  recorded_at INTEGER NOT NULL,
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  exclusion_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_kind ON events(event_kind, recorded_at);
CREATE INDEX IF NOT EXISTS idx_events_excluded ON events(excluded);

CREATE TABLE IF NOT EXISTS subjects (
  subject_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  event_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  evidence_layer TEXT NOT NULL CHECK (evidence_layer IN ('protocol_conformance', 'live_route_compatibility', 'task_effectiveness')),
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  suite_manifest_digest TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_version TEXT NOT NULL,
  scenario_manifest_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'blocked', 'inconclusive')),
  completed_at INTEGER NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('fixture', 'live', 'fabric')),
  FOREIGN KEY(event_id) REFERENCES events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_observations_proj ON observations(
  subject_id, evidence_layer, suite_id, suite_version, suite_manifest_digest, completed_at
);

CREATE INDEX IF NOT EXISTS idx_observations_exact_identity ON observations(
  evidence_layer,
  subject_id,
  suite_id,
  suite_version,
  suite_manifest_digest,
  scenario_id,
  scenario_version,
  scenario_manifest_digest,
  completed_at DESC,
  event_id DESC
);

CREATE TABLE IF NOT EXISTS claims (
  event_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('supported', 'not_supported', 'withdrawn')),
  source_manifest_digest TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  supersedes_json TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 0 CHECK (current IN (0, 1)),
  usable INTEGER NOT NULL DEFAULT 1 CHECK (usable IN (0, 1)),
  FOREIGN KEY(event_id) REFERENCES events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_claims_key ON claims(subject_id, capability, effective_at, event_id);

CREATE TABLE IF NOT EXISTS invalidations (
  event_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  FOREIGN KEY(event_id) REFERENCES events(event_id)
);

CREATE TABLE IF NOT EXISTS purges (
  event_id TEXT PRIMARY KEY,
  target_event_ids_json TEXT NOT NULL,
  target_artifact_digests_json TEXT NOT NULL,
  purge_actions_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY(event_id) REFERENCES events(event_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  digest TEXT PRIMARY KEY,
  artifact_class TEXT,
  media_type TEXT,
  byte_count INTEGER,
  status TEXT NOT NULL CHECK (status IN ('present', 'corrupt', 'purged_unavailable')),
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS verdicts (
  projection_key TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  evidence_layer TEXT NOT NULL,
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  suite_manifest_digest TEXT NOT NULL,
  projection_spec_version TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('UNKNOWN', 'CLAIMED', 'PROBED', 'VERIFIED', 'DEGRADED', 'BLOCKED', 'UNSUPPORTED')),
  as_of INTEGER NOT NULL,
  scenario_manifest_digests_json TEXT NOT NULL,
  claim_source_digest TEXT,
  contributing_event_ids_json TEXT NOT NULL,
  contradicting_event_ids_json TEXT NOT NULL,
  notes_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verdicts_subject ON verdicts(subject_id, evidence_layer, suite_id);

CREATE TABLE IF NOT EXISTS corruption (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  line_number INTEGER,
  event_id TEXT,
  detail TEXT NOT NULL
);
`;
