/**
 * Observe and explicitly quarantine non-authoritative native-write coordinators.
 *
 * Default doctor runs use immutable SQLite reads so diagnostics cannot create
 * WAL/SHM sidecars. Recovery is deliberately opt-in and moves, never deletes,
 * only a file that is still the same private regular file observed beforehand.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Database, constants as sqliteConstants } from "bun:sqlite";

import { resolveCodexHomeDir } from "./home";
import {
  CodexUserIdentityRefusal,
  probeCodexCoordinatorNamespace,
  resolveEffectiveUserIdentity,
  samePathIdentity,
} from "./user-identity";
import {
  CODEX_COORDINATOR_SCHEMA_VERSION,
  readCodexCoordinatorState,
} from "./transition-state";

const IMMUTABLE_READONLY_FLAGS =
  sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI;

export type FileIdentity = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">;

export interface CodexCoordinatorDiagnosticEvidence {
  sizeBytes: number;
  schemaVersion: number;
  tables: readonly string[];
  transitionRows: number | null;
  singletonRows: number | null;
}

export type CodexCoordinatorDiagnostic =
  | { kind: "absent"; path: string | null }
  | { kind: "zero-byte"; path: string; identity: FileIdentity; evidence: CodexCoordinatorDiagnosticEvidence }
  | { kind: "unversioned-empty"; path: string; identity: FileIdentity; evidence: CodexCoordinatorDiagnosticEvidence }
  | { kind: "unversioned-nonempty"; path: string; identity: FileIdentity; evidence: CodexCoordinatorDiagnosticEvidence }
  | { kind: "rowless"; path: string; identity: FileIdentity; evidence: CodexCoordinatorDiagnosticEvidence }
  | { kind: "ready"; path: string; identity: FileIdentity; evidence: CodexCoordinatorDiagnosticEvidence }
  | { kind: "unsupported"; path: string; identity: FileIdentity; version: number; evidence: CodexCoordinatorDiagnosticEvidence }
  | { kind: "changed"; path: string }
  | { kind: "unsafe"; path: string | null; reason: string }
  | { kind: "unreadable"; path: string; reason: string; evidence?: CodexCoordinatorDiagnosticEvidence };

export type CodexCoordinatorRecoveryResult =
  | { ok: true; backupPath: string }
  | { ok: false; reason: string };

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameNodeAndSize(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function coordinatorPathWithoutCreation(): { kind: "absent"; path: string | null } | { kind: "path"; path: string } {
  const identity = resolveEffectiveUserIdentity();
  const canonicalCodexHome = realpathSync.native(resolveCodexHomeDir());
  const namespace = probeCodexCoordinatorNamespace(identity);
  if (namespace.status === "missing") return { kind: "absent", path: null };

  const locks = join(namespace.root, "native-write-locks");
  let locksEntry: Stats;
  try {
    locksEntry = lstatSync(locks);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") {
      const digest = createHash("sha256").update(canonicalCodexHome).digest("hex");
      return { kind: "absent", path: join(locks, `${digest}.sqlite`) };
    }
    throw new CodexUserIdentityRefusal("The coordinator lock directory cannot be inspected.", { cause });
  }
  if (locksEntry.isSymbolicLink() || !locksEntry.isDirectory()) {
    throw new CodexUserIdentityRefusal("The coordinator lock namespace is not a real directory.");
  }
  if (identity.platform === "posix") {
    if (locksEntry.uid !== identity.uid || (locksEntry.mode & 0o777) !== 0o700) {
      throw new CodexUserIdentityRefusal("The coordinator lock namespace has unsafe ownership or permissions.");
    }
  } else if (!samePathIdentity(realpathSync.native(locks), locks, "win32")) {
    throw new CodexUserIdentityRefusal("The coordinator lock namespace is redirected by a junction or reparse point.");
  }

  const digest = createHash("sha256").update(canonicalCodexHome).digest("hex");
  return { kind: "path", path: join(locks, `${digest}.sqlite`) };
}

function inspectTarget(
  path: string,
  options: { allowSqliteSidecars?: boolean } = {},
): { kind: "absent" } | { kind: "file"; identity: FileIdentity } | { kind: "unsafe"; reason: string } {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return { kind: "absent" };
    return { kind: "unsafe", reason: "the coordinator file cannot be inspected" };
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    return { kind: "unsafe", reason: "the coordinator path is not a real file" };
  }
  try {
    if (!samePathIdentity(realpathSync.native(path), path)) {
      return { kind: "unsafe", reason: "the coordinator path is redirected" };
    }
  } catch {
    return { kind: "unsafe", reason: "the coordinator path cannot be resolved" };
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || entry.uid !== uid || (entry.mode & 0o777) !== 0o600) {
      return { kind: "unsafe", reason: "the coordinator file has unsafe ownership or permissions" };
    }
  }
  if (!options.allowSqliteSidecars) {
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) {
        return { kind: "unsafe", reason: `the coordinator has an active SQLite ${suffix.slice(1)} sidecar` };
      }
    }
  }
  return { kind: "file", identity: entry };
}

function classifyOpenedDatabase(
  database: Database,
  path: string,
  identity: FileIdentity,
): CodexCoordinatorDiagnostic {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const tables = database.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map(row => row.name);
  const baseEvidence = {
    sizeBytes: identity.size,
    schemaVersion: version,
    tables,
    transitionRows: null,
    singletonRows: null,
  } satisfies CodexCoordinatorDiagnosticEvidence;
  if (version === 0) {
    const evidence = tables.length === 0
      ? { ...baseEvidence, transitionRows: 0, singletonRows: 0 }
      : baseEvidence;
    return tables.length === 0
      ? { kind: "unversioned-empty", path, identity, evidence }
      : { kind: "unversioned-nonempty", path, identity, evidence };
  }
  if (version !== CODEX_COORDINATOR_SCHEMA_VERSION) {
    return { kind: "unsupported", path, identity, version, evidence: baseEvidence };
  }
  if (tables.length !== 1 || tables[0] !== "codex_transition_state") {
    return tables.length === 0
      ? { kind: "rowless", path, identity, evidence: baseEvidence }
      : { kind: "unreadable", path, reason: "the coordinator contains unexpected tables", evidence: baseEvidence };
  }
  let rowCounts: { total: number; singleton: number } | null;
  try {
    rowCounts = database.query<{ total: number; singleton: number }, []>(
      "SELECT count(*) AS total, sum(CASE WHEN singleton = 1 THEN 1 ELSE 0 END) AS singleton FROM codex_transition_state",
    ).get() ?? null;
  } catch {
    return {
      kind: "unreadable",
      path,
      reason: "the transition table schema is not recognized",
      evidence: baseEvidence,
    };
  }
  const evidence = {
    ...baseEvidence,
    transitionRows: rowCounts?.total ?? null,
    singletonRows: rowCounts?.singleton ?? null,
  };
  if (!rowCounts || rowCounts.total === 0) return { kind: "rowless", path, identity, evidence };
  if (rowCounts.total !== 1 || rowCounts.singleton !== 1) {
    return {
      kind: "unreadable",
      path,
      reason: "the coordinator does not contain exactly one singleton row",
      evidence,
    };
  }
  try {
    readCodexCoordinatorState(database);
  } catch {
    return {
      kind: "unreadable",
      path,
      reason: "the authoritative transition row is malformed",
      evidence,
    };
  }
  return { kind: "ready", path, identity, evidence };
}

export function inspectCodexCoordinator(): CodexCoordinatorDiagnostic {
  let resolved: ReturnType<typeof coordinatorPathWithoutCreation>;
  try {
    resolved = coordinatorPathWithoutCreation();
  } catch (cause) {
    return {
      kind: "unsafe",
      path: null,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (resolved.kind === "absent") return resolved;
  return inspectCodexCoordinatorPath(resolved.path);
}

/** Inspect one already-resolved coordinator path without creating SQLite state. */
export function inspectCodexCoordinatorPath(path: string): CodexCoordinatorDiagnostic {
  const target = inspectTarget(path);
  if (target.kind === "absent") return { kind: "absent", path };
  if (target.kind === "unsafe") return { kind: "unsafe", path, reason: target.reason };

  let database: Database | undefined;
  try {
    const uri = `${pathToFileURL(path).href}?immutable=1`;
    database = new Database(uri, IMMUTABLE_READONLY_FLAGS);
    const result = classifyOpenedDatabase(database, path, target.identity);
    const after = inspectTarget(path);
    if (after.kind !== "file" || !sameIdentity(target.identity, after.identity)) {
      return { kind: "changed", path };
    }
    // Size alone is not evidence that this is a non-authoritative remnant.
    // Query the immutable snapshot too, so the recovery label means all three
    // facts were observed together: zero bytes, schema version zero, no tables.
    if (target.identity.size === 0 && result.kind === "unversioned-empty") {
      return { kind: "zero-byte", path, identity: target.identity, evidence: result.evidence };
    }
    return result;
  } catch (cause) {
    return { kind: "unreadable", path, reason: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    try { database?.close(); } catch { /* diagnostics already completed */ }
  }
}

function recoverable(diagnostic: CodexCoordinatorDiagnostic): diagnostic is Extract<
  CodexCoordinatorDiagnostic,
  { kind: "zero-byte" }
> {
  return diagnostic.kind === "zero-byte";
}

function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

export function recoverZeroByteCodexCoordinator(now = new Date()): CodexCoordinatorRecoveryResult {
  const observed = inspectCodexCoordinator();
  if (!recoverable(observed)) {
    if (observed.kind === "unsafe" || observed.kind === "unreadable") {
      return { ok: false, reason: `coordinator state is ${observed.kind}: ${observed.reason}` };
    }
    return { ok: false, reason: `coordinator state is ${observed.kind}, not a recoverable zero-byte remnant` };
  }

  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(observed.path, { readwrite: true, create: false });
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    const lockedEntry = inspectTarget(observed.path, { allowSqliteSidecars: true });
    // SQLite may update file timestamps merely by opening a zero-byte database
    // for BEGIN IMMEDIATE. Device/inode/size are the stable identity here; the
    // transaction excludes content writers while we reclassify the database.
    if (lockedEntry.kind !== "file" || !sameNodeAndSize(observed.identity, lockedEntry.identity)) {
      return { ok: false, reason: "the coordinator changed before recovery acquired its SQLite lock" };
    }
    if (lockedEntry.identity.size !== 0) {
      return { ok: false, reason: "the coordinator stopped being zero-byte before recovery" };
    }
    database.exec("ROLLBACK");
    transactionOpen = false;
    database.close();
    database = undefined;

    const finalEntry = inspectTarget(observed.path);
    if (finalEntry.kind !== "file" || !sameIdentity(lockedEntry.identity, finalEntry.identity)) {
      return { ok: false, reason: "the coordinator changed before the backup move" };
    }
    const backupPath = `${observed.path}.zero-byte-backup-${backupTimestamp(now)}`;
    if (existsSync(backupPath)) return { ok: false, reason: "the same-directory backup path already exists" };
    renameSync(observed.path, backupPath);
    const backupEntry = inspectTarget(backupPath);
    // The rename itself can advance ctime, so post-move verification uses the
    // stable filesystem object and byte size. The full timestamp identity was
    // already revalidated immediately before rename while the source existed.
    if (backupEntry.kind !== "file" || !sameNodeAndSize(finalEntry.identity, backupEntry.identity) || existsSync(observed.path)) {
      return { ok: false, reason: "the coordinator backup move could not be verified" };
    }
    return { ok: true, backupPath };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const busy = errorCode(cause) === "SQLITE_BUSY" || errorCode(cause) === "SQLITE_LOCKED"
      || /database (?:is|table is) locked/i.test(message);
    return { ok: false, reason: busy ? "the coordinator is busy; stop active sync/service writers and retry" : message };
  } finally {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close releases the lock */ }
    }
    try { database?.close(); } catch { /* recovery already completed */ }
  }
}
