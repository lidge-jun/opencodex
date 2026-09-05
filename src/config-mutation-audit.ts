/**
 * Config mutation audit leaf: durable SQLite trail plus write-ahead recovery for
 * persisted config mutations.
 *
 * This module intentionally does NOT import src/config.ts (or routing/server code):
 * config.ts owns the save orchestration and passes the resolved config dir/path, the
 * atomic-write function, and the open mutation transaction handle into this leaf, so
 * the two boundaries stay acyclic and the pure diff/redaction logic is directly
 * testable without loading the whole config stack.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { REDACTED_SECRET, redactSecretString, redactSecrets } from "./lib/redact";

export const CONFIG_MUTATION_DB_FILENAME = "config-mutation.sqlite";
/** Per-mutation write-ahead marker prefix; each marker is `config-mutation-pending-<id>.json`. */
export const CONFIG_MUTATION_PENDING_AUDIT_FILENAME = "config-mutation-pending-";
const CONFIG_MUTATION_PENDING_AUDIT_SUFFIX = ".json";

/**
 * Who performed a persisted config mutation. `surface` separates the two human-facing
 * entry points (management API vs CLI) from internal/automatic writers so an operator
 * can tell a GUI edit from a background migration at a glance.
 */
export interface ConfigMutationSource {
  readonly surface: "cli" | "api" | "internal";
  /** Human-readable route or command, e.g. "PUT /api/providers/blsc" or "ocx provider set". */
  readonly detail: string;
}

export interface ConfigMutationAuditRow {
  id: number;
  mutationId: string;
  createdAt: number;
  surface: "cli" | "api" | "internal";
  detail: string;
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/** Bounded audit retention: newest N rows survive each insert; older rows are pruned. */
export const CONFIG_AUDIT_MAX_ROWS = 5_000;
let configAuditMaxRows = CONFIG_AUDIT_MAX_ROWS;

/** Test-only seam: shrink the audit retention bound without building a 5k-row fixture. */
export function setConfigAuditMaxRowsForTests(value: number | null): void {
  configAuditMaxRows = value ?? CONFIG_AUDIT_MAX_ROWS;
}
/**
 * Test-only seam: run code after the read-path recovery snapshots the marker
 * paths but before it deletes reconciled markers, so a concurrent-writer window
 * can be exercised deterministically.
 */
let reconcilePendingConfigMutationAuditOnReadBeforeCleanupForTests: (() => void) | null = null;
export function setReconcilePendingConfigMutationAuditOnReadBeforeCleanupForTests(hook: (() => void) | null): void {
  reconcilePendingConfigMutationAuditOnReadBeforeCleanupForTests = hook;
}
/** A single changed-field path list is capped so a wholesale rewrite cannot bloat the row. */
const CONFIG_AUDIT_MAX_FIELDS = 64;
/** Redacted before/after values are capped per entry; longer values are truncated. */
const CONFIG_AUDIT_MAX_VALUE_CHARS = 4_096;
/** Route/command detail is capped so a long CLI line cannot bloat the row or marker. */
const CONFIG_AUDIT_MAX_DETAIL_CHARS = 512;
/** A single redacted field-label segment is capped; longer keys are truncated. */
const CONFIG_AUDIT_MAX_LABEL_CHARS = 256;
/**
 * Durable write-ahead marker for one config write. Written (atomically) BEFORE the
 * config.json rename and removed AFTER the audit row commits, so a process crash
 * between the rename and the commit can be replayed instead of leaving a changed
 * config with no audit record. `mutationId` also names the marker file, so recovery
 * can only ever delete the exact marker it reconciled.
 */
export type PendingConfigMutationAudit = {
  mutationId: string;
  createdAt: number;
  surface: ConfigMutationSource["surface"];
  detail: string;
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** SHA-256 of the exact config.json bytes the pending write produced. */
  afterSha256: string;
};

/** Marker path under the config dir for one mutation (read/write side). */
export function configMutationPendingAuditPath(configDir: string, mutationId: string): string {
  return join(configDir, `${CONFIG_MUTATION_PENDING_AUDIT_FILENAME}${mutationId}${CONFIG_MUTATION_PENDING_AUDIT_SUFFIX}`);
}

/** Every pending marker currently on disk (deterministic filename order). */
export function listPendingConfigMutationAuditPaths(configDir: string): string[] {
  try {
    return readdirSync(configDir)
      .filter(name => name.startsWith(CONFIG_MUTATION_PENDING_AUDIT_FILENAME) && name.endsWith(CONFIG_MUTATION_PENDING_AUDIT_SUFFIX))
      .sort()
      .map(name => join(configDir, name));
  } catch {
    return [];
  }
}

/** Read-only DB path with no directory creation or ACL side effects. */
export function configMutationDatabasePathForRead(configDir: string): string {
  return join(configDir, CONFIG_MUTATION_DB_FILENAME);
}

const CONFIG_MUTATION_AUDIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS config_mutation_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    surface TEXT NOT NULL,
    detail TEXT NOT NULL,
    fields TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL
  )
`;

export function ensureConfigMutationAuditTable(database: Database): void {
  database.exec(CONFIG_MUTATION_AUDIT_TABLE_SQL);
  // CREATE TABLE IF NOT EXISTS cannot add the constraint to an existing database,
  // so enforce uniqueness idempotently for pre-existing audit stores as well.
  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS config_mutation_audit_mutation_id ON config_mutation_audit(mutation_id)",
  );
}

function boundAuditDetail(detail: string): string {
  return detail.length <= CONFIG_AUDIT_MAX_DETAIL_CHARS
    ? detail
    : `${detail.slice(0, Math.max(0, CONFIG_AUDIT_MAX_DETAIL_CHARS - "…[truncated]".length))}…[truncated]`;
}

const CONFIG_AUDIT_TRUNCATION_SUFFIX = "…[truncated]";

function boundAuditLabelToLength(label: string, maxLength: number): string {
  return label.length <= maxLength
    ? label
    : `${label.slice(0, Math.max(0, maxLength - CONFIG_AUDIT_TRUNCATION_SUFFIX.length))}${CONFIG_AUDIT_TRUNCATION_SUFFIX}`;
}

function boundAuditLabel(label: string): string {
  return boundAuditLabelToLength(label, CONFIG_AUDIT_MAX_LABEL_CHARS);
}

/** Bound a duplicate label while reserving room for its occurrence suffix. */
function boundAuditLabelWithOccurrence(label: string, seen: number): string {
  const suffix = `#${seen}`;
  return `${boundAuditLabelToLength(label, CONFIG_AUDIT_MAX_LABEL_CHARS - suffix.length)}${suffix}`;
}

/**
 * Insert one audit row deduped by the per-write mutation id, then prune retention.
 * Used by the live write path and by crash recovery, so a replayed marker can never
 * duplicate the row it already committed, while two distinct same-millisecond writes
 * are never coalesced.
 */
export function insertConfigMutationAuditRow(
  database: Database,
  mutationId: string,
  createdAt: number,
  source: Pick<ConfigMutationSource, "surface" | "detail">,
  fields: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  ensureConfigMutationAuditTable(database);
  // Labels are already bounded and de-duplicated by buildConfigMutationSnapshot
  // (and markers store that final form); inserting must not re-transform them or
  // the persisted fields and the before/after keys can diverge.
  const fieldsJson = JSON.stringify(fields);
  const detail = boundAuditDetail(redactSecretString(source.detail));
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  const existing = database.prepare(`
    SELECT 1 FROM config_mutation_audit WHERE mutation_id = ? LIMIT 1
  `).get(mutationId);
  if (existing) return;
  database.prepare(`
    INSERT OR IGNORE INTO config_mutation_audit (mutation_id, created_at, surface, detail, fields, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(mutationId, createdAt, source.surface, detail, fieldsJson, beforeJson, afterJson);
  // Keep the newest CONFIG_AUDIT_MAX_ROWS rows: delete every row at or below the id of
  // the (N+1)-th newest entry. COALESCE keeps a small table a no-op.
  database.prepare(`
    DELETE FROM config_mutation_audit
    WHERE id <= COALESCE((
      SELECT id FROM config_mutation_audit ORDER BY id DESC LIMIT 1 OFFSET ?
    ), 0)
    `).run(configAuditMaxRows);
}

/**
 * Atomically persist the write-ahead marker for one mutation id, then fsync the
 * directory as a best-effort ordering aid. This narrows the process-crash window; it
 * is not a power-loss durability guarantee because the config temp file itself is not
 * fsynced before its rename.
 */
export function writePendingConfigMutationAudit(
  payload: PendingConfigMutationAudit,
  configDir: string,
  atomicWriteFile: (path: string, content: string) => void,
): void {
  const path = configMutationPendingAuditPath(configDir, payload.mutationId);
  atomicWriteFile(path, JSON.stringify({ ...payload, detail: boundAuditDetail(redactSecretString(payload.detail)) }));
  try {
    const dir = openSync(configDir, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* best-effort */ }
}

export function deletePendingConfigMutationAudit(configDir: string, mutationId: string): void {
  deletePendingConfigMutationAuditAtPath(configMutationPendingAuditPath(configDir, mutationId));
}

/** Unlink one exact marker path; recovery uses this so a newer writer's marker is never removed. */
export function deletePendingConfigMutationAuditAtPath(markerPath: string): void {
  try { unlinkSync(markerPath); } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

function readPendingConfigMutationAuditAtPath(path: string): PendingConfigMutationAudit | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(path, "utf8"),
    );
  } catch (error) {
    if (!isMissingPathError(error)) {
      // A malformed marker must not block future writes; drop it and continue.
      try { unlinkSync(path); } catch { /* best-effort */ }
    }
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // A JSON null/array root can never be a valid marker; drop it so recovery
    // does not throw or reprocess it on every read.
    try { unlinkSync(path); } catch { /* best-effort */ }
    return null;
  }
  const marker = parsed as Partial<PendingConfigMutationAudit>;
  const valid =
    typeof marker.mutationId === "string" && marker.mutationId.length > 0 &&
    typeof marker.createdAt === "number" && Number.isSafeInteger(marker.createdAt) &&
    (marker.surface === "cli" || marker.surface === "api" || marker.surface === "internal") &&
    typeof marker.detail === "string" &&
    Array.isArray(marker.fields) && marker.fields.every(field => typeof field === "string") &&
    typeof marker.afterSha256 === "string" && marker.afterSha256.length > 0 &&
    !!marker.before && typeof marker.before === "object" && !Array.isArray(marker.before) &&
    !!marker.after && typeof marker.after === "object" && !Array.isArray(marker.after);
  if (!valid) {
    // A parseable-but-invalid marker can never be reconciled; drop it so
    // recovery does not reprocess it on every read or write. Valid markers
    // whose hashes mismatch stay intact: they may belong to an in-flight write.
    try { unlinkSync(path); } catch { /* best-effort */ }
    return null;
  }
  return marker as PendingConfigMutationAudit;
}

export function readPendingConfigMutationAudit(configDir: string, mutationId: string): PendingConfigMutationAudit | null {
  return readPendingConfigMutationAuditAtPath(configMutationPendingAuditPath(configDir, mutationId));
}

/**
 * Reconcile one interrupted write inside an OPEN writable transaction: if the config
 * bytes on disk match the pending marker, the rename landed before the crash, so the
 * audit row is replayed (deduped by mutation id). Otherwise the rename never landed
 * (or the marker belongs to a writer whose rename has not landed yet).
 *
 * Returns true only when the marker is fully resolved and safe to delete after the
 * caller's transaction commits. A hash-mismatching marker may belong to an in-flight
 * writer between the marker write and the config rename, so read-side recovery must
 * retain it; write-side recovery (exclusively under `withConfigMutationLockSync`)
 * decides stale markers and removes them after its commit.
 */
export function reconcilePendingConfigMutationAudit(
  database: Database,
  markerPath: string,
  configPath: string,
): boolean {
  const pending = readPendingConfigMutationAuditAtPath(markerPath);
  if (!pending) return false;
  let currentHash: string | null = null;
  try {
    currentHash = createHash("sha256").update(readFileSync(configPath)).digest("hex");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  if (currentHash === pending.afterSha256) {
    insertConfigMutationAuditRow(
      database,
      pending.mutationId,
      pending.createdAt,
      pending,
      pending.fields,
      pending.before,
      pending.after,
    );
    return true;
  }
  return false;
}

/**
 * Record the row described by one marker inside the CURRENT open transaction. Returns
 * true when the caller should delete that exact marker after its transaction commits.
 */
export function recordPendingConfigMutationAuditNow(
  database: Database,
  configDir: string,
  mutationId: string,
): boolean {
  const pending = readPendingConfigMutationAudit(configDir, mutationId);
  if (!pending) return false;
  insertConfigMutationAuditRow(
    database,
    pending.mutationId,
    pending.createdAt,
    pending,
    pending.fields,
    pending.before,
    pending.after,
  );
  return true;
}

/** Best-effort read-path recovery: replay orphaned markers when the DB already exists. */
export function reconcilePendingConfigMutationAuditOnRead(
  databasePath: string,
  configDir: string,
  configPath: string,
): void {
  const markerPaths = listPendingConfigMutationAuditPaths(configDir);
  if (markerPaths.length === 0) return;
  const cleanupPaths: string[] = [];
  try {
    const writable = new Database(databasePath);
    try {
      for (const markerPath of markerPaths) {
        if (reconcilePendingConfigMutationAudit(writable, markerPath, configPath)) {
          cleanupPaths.push(markerPath);
        }
      }
    } finally {
      writable.close();
    }
    // The implicit autocommit committed before close; only now is each marker's
    // deletion safe. Every unlink targets the exact per-mutation path that was
    // reconciled, so a marker created by a concurrent writer after this snapshot
    // can never be removed by a stale recovery.
    const beforeCleanup = reconcilePendingConfigMutationAuditOnReadBeforeCleanupForTests;
    reconcilePendingConfigMutationAuditOnReadBeforeCleanupForTests = null;
    beforeCleanup?.();
    for (const markerPath of cleanupPaths) {
      deletePendingConfigMutationAuditAtPath(markerPath);
    }
  } catch {
    // A concurrent writer may hold the SQLite lock; the next mutation reconciles.
  }
}

/**
 * Read the bounded audit trail, newest first. Defaults to 100 rows; the cap is 1000.
 * Missing database or table yields an empty trail, never an error.
 */
export function readConfigMutationAudit(
  configDir: string,
  configPath: string,
  limit = 100,
): { rows: ConfigMutationAuditRow[]; maxRows: number } {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
  let database: Database | undefined;
  try {
    // A management read must never create or harden the coordinator directory, so
    // resolve the path without the write-side effects of configMutationDatabasePath().
    const path = configMutationDatabasePathForRead(configDir);
    if (!existsSync(path)) return { rows: [], maxRows: configAuditMaxRows };
    reconcilePendingConfigMutationAuditOnRead(path, configDir, configPath);
    database = new Database(path, { readonly: true });
    const rows = database.prepare(`
      SELECT id, mutation_id AS mutationId, created_at AS createdAt, surface, detail, fields,
             before_json AS beforeJson, after_json AS afterJson
      FROM config_mutation_audit
      ORDER BY id DESC
      LIMIT ?
    `).all(safeLimit).map((row: unknown) => {
      const record = row as Record<string, unknown>;
      return {
        id: Number(record.id),
        mutationId: String(record.mutationId),
        createdAt: Number(record.createdAt),
        surface: String(record.surface) as ConfigMutationAuditRow["surface"],
        detail: String(record.detail),
        fields: JSON.parse(String(record.fields)) as string[],
        before: JSON.parse(String(record.beforeJson)) as Record<string, unknown>,
        after: JSON.parse(String(record.afterJson)) as Record<string, unknown>,
      };
    });
    return { rows, maxRows: configAuditMaxRows };
  } catch {
    return { rows: [], maxRows: configAuditMaxRows };
  } finally {
    try { database?.close(); } catch { /* read path is best-effort */ }
  }
}

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect changed paths as segment arrays, descending at most three object levels (e.g. providers.<id>.<field>). */
function collectConfigDiffPaths(
  before: unknown,
  after: unknown,
  prefix: string[],
  depth: number,
  out: string[][],
): void {
  if (out.length >= CONFIG_AUDIT_MAX_FIELDS) return;
  const beforeObject = isPlainConfigObject(before);
  const afterObject = isPlainConfigObject(after);
  if (beforeObject && afterObject && depth < 3) {
    const keys = new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ]);
    for (const key of keys) {
      collectConfigDiffPaths(before[key], after[key], [...prefix, key], depth + 1, out);
    }
    return;
  }
  if (!deepEqual(before, after)) out.push(prefix);
}

function extractConfigValueAtPath(root: unknown, segments: readonly string[]): unknown {
  let current = root;
  for (const part of segments) {
    if (!isPlainConfigObject(current)) return undefined;
    current = current[part];
    if (current === undefined) return undefined;
  }
  return current;
}

/** Redact the admission-secret `key` field of every apiKeys entry, including degraded rows. */
function redactApiKeyEntries(value: unknown, inApiKeysSubtree = false): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactApiKeyEntries(item, inApiKeysSubtree));
  }
  if (!isPlainConfigObject(value)) return value;
  const out: Record<string, unknown> = Object.create(null);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    out[entryKey] = redactApiKeyEntries(entryValue, inApiKeysSubtree || entryKey === "apiKeys");
  }
  // OcxApiKeyEntry.key is the data-plane admission secret. Leaf-name redaction
  // cannot see it (the field is `key`, not `apiKey`), so the whole subtree is
  // masked before the row is persisted or echoed by GET /api/config/mutations.
  // The schema deliberately salvages degraded entries (missing id/name/createdAt
  // metadata), so match by context plus a string key rather than the full
  // happy-path shape; outside the apiKeys subtree require a plausible entry.
  if (
    typeof out.key === "string"
    && (inApiKeysSubtree || [out.id, out.name, out.createdAt].some(v => typeof v === "string"))
  ) {
    out.key = REDACTED_SECRET;
  }
  return out;
}

type ProviderHeaderContext = "outside" | "provider" | "headers";

function providerHeaderContextForPath(segments: readonly string[]): ProviderHeaderContext {
  if (segments[0] === "providers") {
    if (segments.length >= 3 && segments[2] === "headers") return "headers";
    return "provider";
  }
  return "outside";
}

function redactProviderHeaderValues(value: unknown, context: ProviderHeaderContext = "outside"): unknown {
  if (Array.isArray(value)) return value.map(item => redactProviderHeaderValues(item, context));
  if (!isPlainConfigObject(value)) {
    return context === "headers" && typeof value === "string" ? REDACTED_SECRET : value;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    let next: ProviderHeaderContext = context;
    if (context === "outside" && entryKey === "providers") next = "provider";
    else if (context === "provider" && entryKey === "headers") next = "headers";
    out[entryKey] = redactProviderHeaderValues(entryValue, next);
  }
  return out;
}

/** Mask userinfo in any URL-shaped string (http://user:pass@host) while preserving the rest. */
function redactUrlUserinfoString(value: string): string {
  // Mask every scheme://authority@ occurrence wherever it appears in the string,
  // preserving surrounding text. The authority ends at the first / or whitespace;
  // userinfo itself may contain @ characters, so the delimiter is the FINAL @
  // inside that authority segment (the greedy class backtracks to the last @
  // before the first / or whitespace).
  return value.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:[/][/])([^/\s]+)@/g,
    (_whole, scheme) => `${scheme}${REDACTED_SECRET}@`,
  );
}

/** Recursively mask URL userinfo in every string inside an audit snapshot. */
function redactUrlUserinfo(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUrlUserinfo);
  if (!isPlainConfigObject(value)) {
    return typeof value === "string" ? redactUrlUserinfoString(value) : value;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    out[entryKey] = redactUrlUserinfo(entryValue);
  }
  return out;
}

/** Redact secrets and bound the serialized size of one audit value. */
function boundAuditValue(value: unknown, key: string, segments: readonly string[]): unknown {
  // Wrap in an object so redactSecrets can see the field name: a bare string leaf
  // like `sk-old` has no context of its own and would otherwise survive unmasked.
  const wrapped = redactSecrets({ [key]: value });
  // Apply the apiKeys-entry mask to the WHOLE extracted subtree: a first-ever
  // save snapshots the entire config under the root label, so the admission
  // key must be redacted even when the outer path is not apiKeys.*. When the
  // extracted subtree IS the apiKeys array, say so: a degraded entry with only
  // a key (no id/name/createdAt) would otherwise fall through the heuristic
  // unmasked because leaf-name redaction cannot see the admission key field.
  const redacted = redactApiKeyEntries(
    (wrapped as Record<string, unknown>)[key],
    key === "apiKeys",
  );
  const redactedHeaders = redactProviderHeaderValues(
    redacted,
    providerHeaderContextForPath(segments),
  );
  const redactedUserinfo = redactUrlUserinfo(redactedHeaders);
  const text = JSON.stringify(redactedUserinfo);
  if (text === undefined) return null;
  return text.length <= CONFIG_AUDIT_MAX_VALUE_CHARS
    ? redactedUserinfo
    : `${text.slice(0, CONFIG_AUDIT_MAX_VALUE_CHARS)}…[truncated]`;
}

/**
 * Build the bounded, redacted before/after snapshot for one config write. Both inputs
 * must be parsed config objects (raw JSON text must be JSON.parsed by the caller).
 */
export function buildConfigMutationSnapshot(
  beforeRaw: unknown,
  afterRaw: unknown,
): { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> } {
  const segmentPaths: string[][] = [];
  collectConfigDiffPaths(beforeRaw, afterRaw, [], 0, segmentPaths);
  // Config keys are caller-controlled and can be token-shaped (see the provider-name
  // redaction at the schema boundary). Redact every segment before it is persisted
  // and echoed by GET /api/config/mutations; extraction keeps the raw segments.
  // Segments and joined labels are bounded so passthrough root keys cannot bloat rows.
  const fields = segmentPaths.map(segments => {
    const joined = segments.map(part => redactSecretString(part)).join(".");
    return joined === "" ? "<root>" : boundAuditLabel(joined);
  });
  // Redaction can collapse distinct paths (two token-shaped provider names both
  // become providers.[REDACTED].<field>), and a dotted key can collide with a
  // dotted passthrough name. Give duplicates a deterministic, non-secret
  // occurrence suffix so no before/after record overwrites another.
  const labelCounts = new Map<string, number>();
  for (const label of fields) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  const labelSeen = new Map<string, number>();
  const uniqueFields = fields.map(label => {
    const count = labelCounts.get(label) ?? 1;
    if (count <= 1) return label;
    const seen = (labelSeen.get(label) ?? 0) + 1;
    labelSeen.set(label, seen);
    // Bound the suffixed form too so the stored label never exceeds the cap,
    // reserving room for the occurrence suffix before shortening.
    return seen === 1 ? label : boundAuditLabelWithOccurrence(label, seen);
  });
  const before: Record<string, unknown> = Object.create(null);
  const after: Record<string, unknown> = Object.create(null);
  segmentPaths.forEach((segments, index) => {
    const label = uniqueFields[index]!;
    const key = segments.at(-1) ?? label;
    before[label] = boundAuditValue(extractConfigValueAtPath(beforeRaw, segments), key, segments);
    after[label] = boundAuditValue(extractConfigValueAtPath(afterRaw, segments), key, segments);
  });
  return { fields: uniqueFields, before, after };
}

function isMissingPathError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    return (error as { code?: unknown }).code === "ENOENT";
  }
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // `undefined` values and absent keys are the same thing after a JSON round-trip.
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}
