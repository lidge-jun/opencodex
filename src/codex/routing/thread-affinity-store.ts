import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import { getConfigDir } from "../../config/paths";
import { initializeConfigOwnership, recordOwnedConfigPath } from "../../lib/config-ownership";
import { sameFileIdentity, type FileIdentity } from "../../lib/file-identity";
import { isPassiveRead } from "../../lib/passive-read";
import { assertPrivateSqliteEntryOrMissing, assertPrivateSqliteSidecars, preparePrivateSqliteDatabase } from "../../lib/private-sqlite-path";
import {
  assertStorageOwned,
  currentSpendLedgerOwnerGeneration,
  mintSpendLedgerStorage,
  onSpendLedgerOwnerAcquired,
  onSpendLedgerOwnerReleased,
  onSpendLedgerOwnerReleasing,
  spendLedgerStoragePath,
  type SpendLedgerStorage,
} from "../../lib/spend-ledger-owner";
import { assertNotRealHomeUnderTest } from "../../lib/test-home-guard";
import { hardenSecretPath } from "../../lib/windows-secret-acl";
import { readCodexAccountRecord } from "../account-store";
import { isRequestOwnedAffinityKey } from "../request-owned-affinity-key";
import { setCodexConversationAnchorObserver } from "../lineage";
import type { CodexQuotaScope } from "./health-store";

export type StoredThreadRow = {
  scope: string;
  accountId: string;
  fence: string;
  createdAt: number;
  lastUsedAt: number;
};
export const CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER =
  "__unknown_codex_conversation_state_issuer__";
type LiveReader = {
  thread(
    key: string,
    scope: string,
  ):
    | {
        accountId: string;
        identityFence?: string;
        createdAt: number;
        lastUsedAt: number;
      }
    | undefined;
  issuer(
    key: string,
  ): { accountId: string; fence?: string; lastUsedAt: number } | undefined;
  clearLive(): void;
};
type Op = {
  sql: string;
  args: (string | number | null)[];
  key?: string;
  scope?: string;
  kind: string;
};
type Scope = {
  home: string;
  generation: number;
  token: SpendLedgerStorage;
  db?: Database;
  /** The database file the handle was opened on; every write transaction re-checks the path against it. */
  file?: FileIdentity;
  secret?: Uint8Array;
  disabled: boolean;
  poisoned: boolean;
  failures: number;
  log: Op[];
  threads: Map<string, { key: string; scope: string; rowKey: string }>;
  issuers: Map<string, { key: string; rowKey: string }>;
  anchors: Map<string, { family: string; thread: string; at: number }>;
  threadKeys: Map<string, { rowKey: string; scopes: Map<string, string> }>;
  issuerKeys: Map<string, string>;
  consulted: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  pruneTimer?: ReturnType<typeof setInterval>;
  scheduled: boolean;
};
const TTL = 24 * 60 * 60_000;
const BASE_SCOPES = [
  "shared",
  "reserve",
] as const satisfies readonly CodexQuotaScope[];
const BASE_SCOPES_EXHAUSTIVE: Exclude<
  CodexQuotaScope,
  (typeof BASE_SCOPES)[number]
> extends never
  ? true
  : never = true;
void BASE_SCOPES_EXHAUSTIVE;
let current: Scope | undefined;
let observedHome: string | undefined;
/** The home whose database the most recent scope in this process actually opened. */
let persistedHome: string | undefined;
/**
 * A persistable change to pins or issuers happened while that home's database was not writable
 * (between leases, or while a scope could not open it). The database may still hold the row the
 * change replaced or deleted, so the next scope that opens it clears it first. Live memory keeps
 * routing as before; a later restart then restores nothing rather than something stale. Only a
 * process that releases and reacquires its lease reaches this: a serving proxy holds one lease for
 * its whole life.
 */
let needsClear = false;
/** Anchors of the last retired scope, handed to the next scope of the same home. */
let carried: { home: string; anchors: Scope["anchors"]; threadKeys: Scope["threadKeys"]; issuerKeys: Scope["issuerKeys"] } | undefined;
let reader: LiveReader | undefined;

export function registerCodexAffinityLiveState(value: LiveReader): void {
  reader = value;
  setCodexConversationAnchorObserver(observeAnchor);
}
function warning(): void {
  console.warn("Codex affinity persistence unavailable; continuing in memory.");
}
/** Retire the lease-scoped handle without discarding in-memory affinity. */
function retire(): void {
  const s = current;
  if (!s) return;
  current = undefined;
  // Anchors are process-local facts about this home's conversations; the next scope of the same
  // home needs them to re-derive row keys for pins that are still live in memory.
  // Row keys too: after an anchor is evicted they are the only way a delete can still reach its row.
  if (s.db && !s.poisoned) carried = { home: s.home, anchors: s.anchors, threadKeys: s.threadKeys, issuerKeys: s.issuerKeys };
  if (s.timer) clearTimeout(s.timer);
  if (s.pruneTimer) clearInterval(s.pruneTimer);
  try {
    s.db?.close();
  } catch {
    warning();
  }
}
// BigInt stats: NTFS file IDs exceed Number.MAX_SAFE_INTEGER, and a rounded identity can match a
// different file.
function checkFile(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (process.platform !== "win32" && stat.uid !== BigInt(process.getuid!()))
  )
    throw new Error("unsafe file");
  return stat;
}
function open(s: Scope): void {
  const path = spendLedgerStoragePath(s.token);
  let db: Database | undefined;
  try {
    assertNotRealHomeUnderTest(s.home);
    // An owned home must list these files before they exist, so uninstall removes them. A home with
    // no ownership manifest (one that predates ownership tracking) cannot record anything, and
    // uninstall refuses to remove anything from it; like the spend-ledger owner database, the store
    // still works there rather than silently losing persistence.
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      if (!recordOwnedConfigPath(s.home, path + suffix) && initializeConfigOwnership(s.home))
        throw new Error("ownership");
    // Refuses a link or reparse point at the database or a sidecar before anything is created:
    // Windows creates a new file through a link at its name.
    preparePrivateSqliteDatabase(path);
    const before = checkFile(path);
    if (before.size > 8n * 1024n * 1024n) throw new Error("oversized");
    if (process.platform !== "win32") chmodSync(path, 0o600);
    if (!hardenSecretPath(path, { required: true }).ok) throw new Error("acl");
    checkFile(path);
    assertStorageOwned(s.token);
    // SQLite creates sidecars in the private, hardened config directory, as with
    // spend-ledger-owner.sqlite and config-mutation.sqlite.
    assertPrivateSqliteSidecars(path);
    db = new Database(path);
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const version = (
      db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    const objects = db
      .query("SELECT type, name FROM sqlite_master ORDER BY name")
      .all() as { type: string; name: string }[];
    const tables = objects.filter((o) => o.type === "table");
    if (version === 0 && objects.length === 0) {
      db.exec(
        "CREATE TABLE meta(name TEXT PRIMARY KEY, value BLOB); CREATE TABLE threads(row_key TEXT, scope TEXT, account_id TEXT, fence TEXT, created_at INTEGER, last_used_at INTEGER, PRIMARY KEY(row_key, scope)); CREATE TABLE issuers(row_key TEXT PRIMARY KEY, account_id TEXT, fence TEXT, last_used_at INTEGER); PRAGMA user_version = 1",
      );
      db.query("INSERT INTO meta VALUES ('secret', ?), ('clean', 0)").run(
        randomBytes(32),
      );
    } else {
      if (
        version !== 1 ||
        tables.map((t) => t.name).join(",") !== "issuers,meta,threads"
      )
        throw new Error("version");
      const expected: Record<string, string> = {
        meta: "name:TEXT:1,value:BLOB:0",
        threads:
          "row_key:TEXT:1,scope:TEXT:2,account_id:TEXT:0,fence:TEXT:0,created_at:INTEGER:0,last_used_at:INTEGER:0",
        issuers:
          "row_key:TEXT:1,account_id:TEXT:0,fence:TEXT:0,last_used_at:INTEGER:0",
      };
      for (const [table, columns] of Object.entries(expected)) {
        const actual = db.query(`PRAGMA table_info(${table})`).all() as {
          name: string;
          type: string;
          pk: number;
          notnull: number;
          dflt_value: unknown;
        }[];
        if (
          actual.map((c) => `${c.name}:${c.type}:${c.pk}`).join(",") !==
            columns ||
          actual.some((c) => c.notnull !== 0 || c.dflt_value !== null)
        )
          throw new Error("shape");
      }
      const indexes = objects
        .filter((o) => o.type === "index")
        .map((o) => o.name)
        .join(",");
      if (
        objects.length !== 6 ||
        indexes !==
          "sqlite_autoindex_issuers_1,sqlite_autoindex_meta_1,sqlite_autoindex_threads_1"
      )
        throw new Error("shape");
      const rows = db.query("SELECT name, value FROM meta").all() as {
        name: string;
        value: unknown;
      }[];
      const secret = rows.find((r) => r.name === "secret")?.value;
      const clean = rows.find((r) => r.name === "clean")?.value;
      if (
        !(secret instanceof Uint8Array) ||
        secret.length !== 32 ||
        rows.length !== 2 ||
        !rows.some((r) => r.name === "clean")
      )
        throw new Error("meta");
      db.exec("PRAGMA secure_delete = ON");
      // Only a completed final flush permits the next owner to restore rows.
      if (clean !== 1) db.exec("DELETE FROM threads; DELETE FROM issuers");
      db.exec("UPDATE meta SET value=0 WHERE name='clean'");
    }
    db.exec("PRAGMA secure_delete = ON");
    const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
    db.exec(`PRAGMA max_page_count = ${Math.floor(8 * 1024 * 1024 / pageSize)}`);
    prune(db, Date.now());
    const secret = (
      db.query("SELECT value FROM meta WHERE name='secret'").get() as {
        value: Uint8Array;
      }
    ).value;
    db.exec("COMMIT");
    const after = checkFile(path);
    if (!sameFileIdentity(before, after)) throw new Error("replaced");
    s.db = db;
    s.file = after;
    s.secret = secret;
    s.pruneTimer = setInterval(() => {
      if (current === s) {
        if (s.poisoned || isPassiveRead()) pruneOnly(s);
        else flush(s, false);
      }
    }, 60 * 60_000);
    s.pruneTimer.unref();
  } catch {
    try {
      db?.exec("ROLLBACK");
    } catch {
      /* no transaction */
    }
    try {
      db?.close();
    } catch {
      /* preserve open failure */
    }
    s.disabled = true;
    warning();
  }
}
/**
 * Refuse a write unless the database is still the single-link private file this handle opened and
 * no sidecar name holds a link: the rollback journal is created per transaction, and a link added
 * to the database since open would expose every later write.
 */
function assertWritable(s: Scope): void {
  const path = spendLedgerStoragePath(s.token);
  assertPrivateSqliteSidecars(path);
  if (!assertPrivateSqliteEntryOrMissing(path)) throw new Error("missing");
  const now = checkFile(path);
  if (!s.file || !sameFileIdentity(now, s.file)) throw new Error("replaced");
}
function resolvedHome(acquiredHome?: string): string {
  let home = resolve(acquiredHome ?? getConfigDir());
  try {
    home = realpathSync.native(home);
  } catch {
    /* ownership check below refuses it */
  }
  return process.platform === "win32" ? home.toLowerCase() : home;
}
function scope(acquiredHome?: string): Scope | undefined {
  if (!acquiredHome && isPassiveRead()) return undefined;
  const home = resolvedHome(acquiredHome);
  // A lease ends a store scope; only a change of home invalidates live maps.
  if (observedHome !== undefined && observedHome !== home) {
    retire();
    carried = undefined;
    persistedHome = undefined;
    needsClear = false;
    reader?.clearLive();
  }
  observedHome = home;
  const generation = currentSpendLedgerOwnerGeneration();
  if (current && (current.home !== home || current.generation !== generation))
    retire();
  if (current) {
    try {
      assertStorageOwned(current.token);
      return current;
    } catch {
      retire();
      return undefined;
    }
  }
  let token: SpendLedgerStorage;
  try {
    token = mintSpendLedgerStorage("codex-affinity.sqlite");
    assertStorageOwned(token);
  } catch {
    return undefined;
  }
  const s: Scope = {
    home,
    generation,
    token,
    disabled: false,
    poisoned: false,
    failures: 0,
    log: [],
    threads: new Map(),
    issuers: new Map(),
    anchors: carried?.home === home ? carried.anchors : new Map(),
    threadKeys: carried?.home === home ? carried.threadKeys : new Map(),
    issuerKeys: carried?.home === home ? carried.issuerKeys : new Map(),
    consulted: new Set(),
    scheduled: false,
  };
  const prior = carried;
  carried = undefined;
  current = s;
  open(s);
  // A scope that could not open never touched the carried maps; keep them for the next one.
  if (!s.db && prior?.home === home) carried = prior;
  if (s.db) {
    if (needsClear && persistedHome === home) recordAllCleared();
    needsClear = false;
    persistedHome = home;
  }
  return s;
}
/**
 * The scope for a change to which pins or issuers exist. When the change could have been persisted
 * but this home's database is not writable right now, remember that the database is stale.
 */
function writableScope(persistable: boolean): Scope | undefined {
  const s = usable();
  if (!s && persistable && persistedHome !== undefined && !isPassiveRead() && persistedHome === resolvedHome())
    needsClear = true;
  return s;
}
function usable(): Scope | undefined {
  const s = scope();
  return s && !s.disabled && !s.poisoned && s.db ? s : undefined;
}
function observeAnchor(key: string, family: string, thread: string): void {
  // Caller-owned keys are process-local by contract (structure/providers/codex-request-owned-affinity.md).
  if (isRequestOwnedAffinityKey(key)) return;
  const s = usable();
  if (!s) return;
  const now = Date.now();
  for (const [k, a] of s.anchors) {
    if (now - a.at <= TTL) break;
    s.anchors.delete(k);
  }
  s.anchors.delete(key);
  s.anchors.set(key, { family, thread, at: now });
  while (s.anchors.size > 4096)
    s.anchors.delete(s.anchors.keys().next().value!);
}
setCodexConversationAnchorObserver(observeAnchor);
function rowKey(
  s: Scope,
  key: string,
  kind: "conversation" | "issuer",
): string | undefined {
  // The single choke point for every bind, touch, delete, adoption and issuer path: a request-owned
  // key never has a durable row key, so nothing for it is ever written or restored.
  if (isRequestOwnedAffinityKey(key)) return undefined;
  const a = s.anchors.get(key);
  if (!a || Date.now() - a.at > TTL) {
    s.anchors.delete(key);
    return kind === "conversation" ? s.threadKeys.get(key)?.rowKey : s.issuerKeys.get(key);
  }
  return createHmac("sha256", s.secret!)
    .update(`opencodex/codex-affinity/${kind}/v1\0`)
    .update(a.family)
    .update("\0")
    .update(a.thread)
    .digest("hex");
}
export function codexAffinityIdentityFence(
  accountId: string,
): string | undefined {
  if (accountId === "__main__") return undefined;
  const record = readCodexAccountRecord(accountId);
  if (
    !record?.credential ||
    record.deletedAt != null ||
    !record.quotaHistoryIdentity
  )
    return undefined;
  return identityFence(record.quotaHistoryIdentity);
}
export function identityFence(identity: string | undefined): string | undefined {
  if (!identity) return undefined;
  return createHash("sha256")
    .update("opencodex/codex-affinity/identity/v1\0")
    .update(identity)
    .digest("hex");
}
function rememberThreadKey(s: Scope, key: string, rk: string, scopeName: string, accountId: string): void {
  let entry = s.threadKeys.get(key);
  if (!entry) s.threadKeys.set(key, entry = { rowKey: rk, scopes: new Map() });
  entry.scopes.set(scopeName, accountId);
  if (s.threadKeys.size + s.issuerKeys.size > 8192) poison(s);
}
function rememberIssuerKey(s: Scope, key: string, rk: string): void {
  s.issuerKeys.set(key, rk);
  if (s.threadKeys.size + s.issuerKeys.size > 8192) poison(s);
}
/** A poisoned scope cannot safely declare itself clean on release. */
function poison(s: Scope): void {
  s.poisoned = true;
  s.log = [];
  s.threads.clear();
  s.issuers.clear();
  s.threadKeys.clear();
  s.issuerKeys.clear();
  if (s.timer) clearTimeout(s.timer);
  warning();
}
function enqueue(s: Scope, op: Op): void {
  // Preserve structural ordering; only clearAll supersedes the whole log.
  if (op.kind === "clearAll") s.log = [];
  s.log.push(op);
  if (s.log.length > 16384) {
    poison(s);
    return;
  }
  if (!s.scheduled) {
    s.scheduled = true;
    queueMicrotask(() => {
      s.scheduled = false;
      if (current === s && !isPassiveRead()) flush(s, false);
    });
  }
}
function scheduleTouch(s: Scope): void {
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = undefined;
    if (current === s && !isPassiveRead()) flush(s, false);
  }, 1000);
  s.timer.unref();
}
function prune(db: Database, now: number): void {
  for (const table of ["threads", "issuers"])
    db.query(`DELETE FROM ${table} WHERE last_used_at < ? OR last_used_at > ?`).run(now - TTL, now);
  db.query("DELETE FROM threads WHERE created_at > ?").run(now);
  db.exec("DELETE FROM threads WHERE rowid IN (SELECT rowid FROM threads ORDER BY (scope LIKE 'model-detour:%') ASC, last_used_at DESC, row_key, scope LIMIT -1 OFFSET 2048); DELETE FROM issuers WHERE rowid IN (SELECT rowid FROM issuers ORDER BY last_used_at DESC, row_key LIMIT -1 OFFSET 2048)");
}
function pruneOnly(s: Scope): boolean {
  if (!s.db || s.disabled) return false;
  try {
    assertStorageOwned(s.token);
    assertWritable(s);
    s.db.exec("BEGIN IMMEDIATE");
    // Pending touches first, so a pin used since its last persisted timestamp is not evicted as idle.
    if (!s.poisoned) applyTouches(s, s.db);
    prune(s.db, Date.now());
    s.db.exec("COMMIT");
    return true;
  } catch {
    try { s.db.exec("ROLLBACK"); } catch { /* no transaction */ }
    warning();
    return false;
  }
}
/** Write the live last-used time of every touched row; UPDATE-only, so it never creates or revives a row. */
function applyTouches(s: Scope, db: Database): void {
  for (const t of s.threads.values()) {
    const row = reader?.thread(t.key, t.scope);
    if (row?.identityFence)
      db.query(
        "UPDATE threads SET last_used_at=max(last_used_at, ?) WHERE row_key=? AND scope=? AND account_id=? AND fence=?",
      ).run(
        row.lastUsedAt,
        t.rowKey,
        t.scope,
        row.accountId,
        row.identityFence,
      );
  }
  for (const t of s.issuers.values()) {
    const row = reader?.issuer(t.key);
    if (row)
      db.query(
        "UPDATE issuers SET last_used_at=max(last_used_at, ?) WHERE row_key=? AND account_id=? AND fence IS ?",
      ).run(row.lastUsedAt, t.rowKey, row.accountId, row.fence ?? null);
  }
}
/**
 * Commit the ordered log and touches. The final release flush (clean=true) commits work that was
 * logged outside any passive read, so it runs even if the release happens inside one.
 */
function flush(s: Scope, clean: boolean): boolean {
  if (!s.db || s.disabled || s.poisoned || (!clean && isPassiveRead())) return false;
  const db = s.db;
  for (let attempt = 0; attempt < 2; attempt++) try {
    assertStorageOwned(s.token);
    assertWritable(s);
    db.exec("BEGIN IMMEDIATE");
    // Touches go before the log as well as after it, so the pruning between chunks sees the live
    // last-used times and cannot evict a pin that is in use but persisted with an old timestamp.
    applyTouches(s, db);
    for (let i = 0; i < s.log.length; i++) {
      const op = s.log[i]!;
      if (op.args.length) db.query(op.sql).run(...op.args);
      else db.exec(op.sql);
      // Touches before every chunk prune, so rows this chunk inserted carry their live last-used time.
      if ((i + 1) % 256 === 0) {
        applyTouches(s, db);
        prune(db, Date.now());
      }
    }
    // Again after the log: rows the log just inserted take their live last-used time.
    applyTouches(s, db);
    prune(db, Date.now());
    if (clean) db.exec("UPDATE meta SET value=1 WHERE name='clean'");
    db.exec("COMMIT");
    s.log = [];
    s.threads.clear();
    s.issuers.clear();
    s.failures = 0;
    return true;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve failure */
    }
    if (attempt === 0 && error instanceof Error && "code" in error && error.code === "SQLITE_FULL" && pruneOnly(s)) continue;
    if (++s.failures >= 3) poison(s);
    else warning();
    // Deleting expired rows does not depend on the failed batch; keep the retention bound.
    pruneOnly(s);
    return false;
  }
  return false;
}
// Open eagerly so the startup prune runs without traffic; a passive read never opens the store.
onSpendLedgerOwnerAcquired((home) => { if (!isPassiveRead()) scope(home); });
// Commit clean before closing; a later close failure cannot undo that commit.
onSpendLedgerOwnerReleasing(() => {
  const s = current;
  if (s) {
    flush(s, true);
    retire();
  }
});
onSpendLedgerOwnerReleased(() => retire());
function pending(s: Scope, row: string, issuer: boolean): boolean {
  return s.log.some(
    (op) =>
      op.kind === "clearAll" ||
      (issuer
        ? op.kind === "clearIssuers" ||
          (op.kind === "issuerDelete" && op.key === row)
        : op.kind === "clearThreads" || (op.kind === "deleteKey" && op.key === row)),
  );
}
function consulted(s: Scope, key: string): boolean {
  if (s.consulted.has(key)) return true;
  s.consulted.add(key);
  if (s.consulted.size > 8192)
    s.consulted.delete(s.consulted.values().next().value!);
  return false;
}
function validScope(value: string): boolean {
  const bases: readonly string[] = ["legacy", ...BASE_SCOPES];
  if (bases.includes(value)) return true;
  const m = /^model-detour:([^:]+):(.+)$/s.exec(value);
  return (
    !!m && bases.includes(m[1]!) && Buffer.byteLength(m[2]!, "utf8") <= 512
  );
}
export function adoptStoredThreadRows(
  key: string,
  now: number,
  scopeName?: string,
): StoredThreadRow[] {
  const s = usable();
  if (!s) return [];
  const rk = rowKey(s, key, "conversation");
  // A completed unscoped read (marker "*") already adopted every stored scope for this key.
  if (
    !rk
    || pending(s, rk, false)
    || s.consulted.has(`t:${rk}:*`)
    || (scopeName !== undefined && s.consulted.has(`t:${rk}:${scopeName}`))
  ) return [];
  try {
    // Enumerating every scope matters: routing decides account-wide release from this view. The
    // table itself is trimmed to 2048 rows at open and on every flush, which bounds the read.
    const rows = s
      .db!.query(
        scopeName === undefined
          ? "SELECT scope, account_id, fence, created_at, last_used_at FROM threads WHERE row_key=? ORDER BY last_used_at DESC, scope LIMIT 2048"
          : "SELECT scope, account_id, fence, created_at, last_used_at FROM threads WHERE row_key=? AND scope=? LIMIT 1",
      )
      .all(...(scopeName === undefined ? [rk] : [rk, scopeName])) as {
      scope: string;
      account_id: string;
      fence: string;
      created_at: number;
      last_used_at: number;
    }[];
    const result: StoredThreadRow[] = [];
    for (const r of rows) {
      if (
        s.log.some(
          (op) =>
            op.kind === "deleteScope" && op.key === rk && op.scope === r.scope,
        ) ||
        s.log.some(
          (op) => (op.kind === "deleteAccount" && op.args[0] === r.account_id) ||
            (op.kind === "deleteKeyAccount" && op.key === rk && op.args[1] === r.account_id),
        )
      )
        continue;
      if (
        !validScope(r.scope) ||
        !Number.isFinite(r.created_at) ||
        !Number.isFinite(r.last_used_at) ||
        r.created_at > now ||
        r.last_used_at > now ||
        now - r.last_used_at > TTL ||
        !r.fence ||
        codexAffinityIdentityFence(r.account_id) !== r.fence
      ) {
        enqueue(s, {
          kind: "deleteScope",
          key: rk,
          scope: r.scope,
          sql: "DELETE FROM threads WHERE row_key=? AND scope=?",
          args: [rk, r.scope],
        });
        continue;
      }
      rememberThreadKey(s, key, rk, r.scope, r.account_id);
      if (s.poisoned) return [];
      result.push({
        scope: r.scope,
        accountId: r.account_id,
        fence: r.fence,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      });
    }
    for (const row of rows) consulted(s, `t:${rk}:${row.scope}`);
    if (scopeName !== undefined) consulted(s, `t:${rk}:${scopeName}`);
    else consulted(s, `t:${rk}:*`);
    return result;
  } catch {
    warning();
    return [];
  }
}
export function adoptStoredIssuer(
  key: string,
  now: number,
): { issuer: string; storedAccountId: string; storedFence: string | null } | undefined {
  const s = usable();
  if (!s) return;
  const rk = rowKey(s, key, "issuer");
  if (!rk || pending(s, rk, true) || s.consulted.has(`i:${rk}`)) return;
  try {
    const r = s
      .db!.query(
        "SELECT account_id, fence, last_used_at FROM issuers WHERE row_key=?",
      )
      .get(rk) as {
      account_id: string;
      fence: string | null;
      last_used_at: number;
    } | null;
    if (!r) {
      consulted(s, `i:${rk}`);
      return;
    }
    if (
      !Number.isFinite(r.last_used_at) ||
      r.last_used_at > now ||
      now - r.last_used_at > TTL
    ) {
      enqueue(s, {
        kind: "issuerDelete",
        key: rk,
        sql: "DELETE FROM issuers WHERE row_key=?",
        args: [rk],
      });
      return;
    }
    const result =
      r.fence && codexAffinityIdentityFence(r.account_id) === r.fence
        ? r.account_id
        : CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER;
    rememberIssuerKey(s, key, rk);
    if (s.poisoned) return;
    consulted(s, `i:${rk}`);
    return { issuer: result, storedAccountId: r.account_id, storedFence: r.fence };
  } catch {
    warning();
    return;
  }
}
export function recordThreadBind(
  key: string,
  scopeName: string,
  row: StoredThreadRow,
): void {
  if (isRequestOwnedAffinityKey(key)) return;
  const s = writableScope(row.accountId !== "__main__" && !!row.fence);
  if (!s || row.accountId === "__main__" || !row.fence) return;
  const rk = rowKey(s, key, "conversation");
  if (!rk) return;
  rememberThreadKey(s, key, rk, scopeName, row.accountId);
  if (s.poisoned) return;
  enqueue(s, {
    kind: "bind",
    key: rk,
    scope: scopeName,
    sql: "INSERT INTO threads VALUES (?,?,?,?,?,?) ON CONFLICT(row_key,scope) DO UPDATE SET account_id=excluded.account_id,fence=excluded.fence,created_at=excluded.created_at,last_used_at=excluded.last_used_at",
    args: [
      rk,
      scopeName,
      row.accountId,
      row.fence,
      row.createdAt,
      row.lastUsedAt,
    ],
  });
}
export function recordThreadTouch(key: string, scopeName: string): void {
  const s = usable();
  if (!s) return;
  const rk = rowKey(s, key, "conversation");
  if (!rk) return;
  s.threads.set(`${rk}\0${scopeName}`, { key, scope: scopeName, rowKey: rk });
  scheduleTouch(s);
}
export function recordThreadDelete(key: string, scopeName?: string): void {
  if (isRequestOwnedAffinityKey(key)) return;
  const s = writableScope(true);
  if (!s) return;
  const rk = rowKey(s, key, "conversation");
  if (!rk) return;
  const known = s.threadKeys.get(key);
  if (scopeName === undefined) s.threadKeys.delete(key);
  else if (known) { known.scopes.delete(scopeName); if (!known.scopes.size) s.threadKeys.delete(key); }
  enqueue(
    s,
    scopeName === undefined
      ? {
          kind: "deleteKey",
          key: rk,
          sql: "DELETE FROM threads WHERE row_key=?",
          args: [rk],
        }
      : {
          kind: "deleteScope",
          key: rk,
          scope: scopeName,
          sql: "DELETE FROM threads WHERE row_key=? AND scope=?",
          args: [rk, scopeName],
        },
  );
}
export function recordThreadAccountDeleted(key: string, id: string): void {
  if (isRequestOwnedAffinityKey(key)) return;
  const s = writableScope(true);
  if (!s) return;
  const rk = rowKey(s, key, "conversation");
  if (!rk) return;
  const known = s.threadKeys.get(key);
  if (known) {
    for (const [scopeName, account] of known.scopes) if (account === id) known.scopes.delete(scopeName);
    if (!known.scopes.size) s.threadKeys.delete(key);
  }
  enqueue(s, { kind: "deleteKeyAccount", key: rk, sql: "DELETE FROM threads WHERE row_key=? AND account_id=?", args: [rk, id] });
}
export function recordAccountPinsCleared(id: string): void {
  const s = writableScope(true);
  if (s) {
    for (const [key, entry] of s.threadKeys) {
      for (const [scopeName, account] of entry.scopes) if (account === id) entry.scopes.delete(scopeName);
      if (!entry.scopes.size) s.threadKeys.delete(key);
    }
    enqueue(s, {
      kind: "deleteAccount",
      sql: "DELETE FROM threads WHERE account_id=?",
      args: [id],
    });
  }
}
export function recordAllCleared(): void {
  const s = writableScope(true);
  if (s) {
    s.threadKeys.clear(); s.issuerKeys.clear();
    enqueue(s, {
      kind: "clearAll",
      sql: "DELETE FROM threads; DELETE FROM issuers",
      args: [],
    });
  }
}
/** A manual account switch clears pins but keeps the issuers of carried state. */
export function recordThreadsCleared(): void {
  const s = writableScope(true);
  if (s) {
    s.threadKeys.clear();
    enqueue(s, { kind: "clearThreads", sql: "DELETE FROM threads", args: [] });
  }
}
/** Test seam: feed the anchor observer directly, as a future derivation path might. */
export function noteCodexAffinityAnchorForTests(key: string, family: string, thread: string): void {
  observeAnchor(key, family, thread);
}
export function recordIssuerSet(
  key: string,
  id: string,
  fence: string | null,
  lastUsedAt: number,
): void {
  if (isRequestOwnedAffinityKey(key)) return;
  const s = writableScope(id !== "__main__");
  if (!s || id === "__main__") return;
  const rk = rowKey(s, key, "issuer");
  if (!rk) return;
  rememberIssuerKey(s, key, rk);
  if (s.poisoned) return;
  enqueue(s, {
    kind: "issuerSet",
    key: rk,
    sql: "INSERT INTO issuers VALUES (?,?,?,?) ON CONFLICT(row_key) DO UPDATE SET account_id=excluded.account_id,fence=excluded.fence,last_used_at=excluded.last_used_at",
    args: [rk, id, fence, lastUsedAt],
  });
}
export function recordIssuerTouch(key: string): void {
  const s = usable();
  if (!s) return;
  const rk = rowKey(s, key, "issuer");
  if (!rk) return;
  s.issuers.set(rk, { key, rowKey: rk });
  scheduleTouch(s);
}
export function recordIssuerDelete(key: string): void {
  if (isRequestOwnedAffinityKey(key)) return;
  const s = writableScope(true);
  if (!s) return;
  const rk = rowKey(s, key, "issuer");
  if (rk) {
    s.issuerKeys.delete(key);
    enqueue(s, {
      kind: "issuerDelete",
      key: rk,
      sql: "DELETE FROM issuers WHERE row_key=?",
      args: [rk],
    });
  }
}
export function recordIssuersCleared(): void {
  const s = writableScope(true);
  if (s) {
    s.issuerKeys.clear();
    enqueue(s, { kind: "clearIssuers", sql: "DELETE FROM issuers", args: [] });
  }
}
export function flushCodexAffinityStoreForTests(): void {
  if (current && !isPassiveRead()) flush(current, false);
}
export function resetCodexAffinityStoreForTests(): void {
  if (current) {
    flush(current, false);
    retire();
  }
  // Model a fresh process: nothing carried from an earlier scope, nothing known to be stale.
  carried = undefined;
  persistedHome = undefined;
  needsClear = false;
}
