/**
 * Schema contract for the derived request-history index (RI-02).
 *
 * `usage.jsonl` remains the canonical append-only evidence ledger;
 * `routing-history.sqlite` is a disposable, rebuildable query projection
 * (ADR-1/ADR-8 in devlog/_fin/260804_router_intelligence/000_master_plan.md).
 */

export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_DB_FILENAME = "routing-history.sqlite";

export const HISTORY_META_KEYS = {
  schemaVersion: "schema_version",
  sourcePath: "source_path",
  sourceDev: "source_dev",
  sourceIno: "source_ino",
  sourceBirthtimeMs: "source_birthtime_ms",
  sourceSize: "source_size",
  sourceMtimeMs: "source_mtime_ms",
  indexedOffset: "indexed_offset",
  indexedRows: "indexed_rows",
  builtAtMs: "built_at_ms",
  lastError: "last_error",
} as const;

export const HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  request_id       TEXT PRIMARY KEY,
  timestamp        INTEGER NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  requested_model  TEXT,
  status           INTEGER NOT NULL,
  surface          TEXT,
  inbound_protocol TEXT,
  api_key_id       TEXT,
  conversation_id  TEXT,
  route_kind       TEXT,
  profile_id       TEXT,
  profile_revision TEXT,
  fallback         INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL,
  first_output_ms  INTEGER,
  usage_status     TEXT,
  usage_json       TEXT,
  total_tokens     INTEGER,
  error_code       TEXT,
  terminal_status  TEXT,
  close_reason     TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 1,
  decision_json    TEXT,
  row_json         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_requested_model ON requests(requested_model);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_conversation ON requests(conversation_id);
CREATE INDEX IF NOT EXISTS idx_requests_api_key ON requests(api_key_id);
CREATE INDEX IF NOT EXISTS idx_requests_profile ON requests(profile_id);
`;

export function historyIndexPath(configDir: string): string {
  return `${configDir.replace(/[\\/]+$/, "")}/${HISTORY_DB_FILENAME}`;
}
