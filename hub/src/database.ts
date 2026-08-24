import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomReference, randomToken } from "./security";

const SCHEMA_VERSION = 3;

function prepareDatabasePath(path: string): string {
  if (path === ":memory:") return path;
  const resolved = resolve(path);
  try {
    const parent = lstatSync(dirname(resolved));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("unsafe parent");
    if (process.platform !== "win32" && (parent.mode & 0o022) !== 0) throw new Error("writable parent");

    const existing = existsSync(resolved) ? lstatSync(resolved) : null;
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("unsafe target");
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const flags = existing
      ? constants.O_RDWR | noFollow
      : constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow;
    const descriptor = openSync(resolved, flags, 0o600);
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error("unsafe target");
      if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    return resolved;
  } catch {
    throw new Error("unsafe hub database path");
  }
}

function secureDatabaseArtifacts(path: string): void {
  if (path === ":memory:" || process.platform === "win32") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(candidate)) continue;
    const metadata = lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe hub database artifact");
    const descriptor = openSync(candidate, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error("unsafe hub database artifact");
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  }
}

export class HubDatabase {
  readonly db: Database;
  private lockOwner: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(path: string) {
    const databasePath = prepareDatabasePath(path);
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    secureDatabaseArtifacts(databasePath);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_runtime_lock (
        lock_name TEXT PRIMARY KEY CHECK (lock_name = 'single-node'),
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_users (
        id TEXT PRIMARY KEY,
        support_reference TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        token_digest TEXT NOT NULL UNIQUE,
        csrf_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS hub_sessions_user_active
        ON hub_sessions(user_id, revoked_at, expires_at);
      CREATE TABLE IF NOT EXISTS hub_accounts (
        user_id TEXT PRIMARY KEY REFERENCES hub_users(id) ON DELETE CASCADE,
        balance_units INTEGER NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
        reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
        updated_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS hub_user_account_after_insert
      AFTER INSERT ON hub_users
      BEGIN
        INSERT INTO hub_accounts(user_id, balance_units, reserved_units, updated_at)
        VALUES (NEW.id, 0, 0, NEW.created_at);
      END;
      CREATE TABLE IF NOT EXISTS hub_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key_digest TEXT NOT NULL UNIQUE,
        display_prefix TEXT NOT NULL,
        display_suffix TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS hub_api_keys_user_status ON hub_api_keys(user_id, status, created_at);
      CREATE TABLE IF NOT EXISTS hub_recharge_batches (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        unit_amount INTEGER NOT NULL CHECK (unit_amount > 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        expires_at INTEGER,
        created_by TEXT NOT NULL REFERENCES hub_users(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_recharge_codes (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES hub_recharge_batches(id),
        code_digest TEXT NOT NULL UNIQUE,
        display_suffix TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'redeemed', 'revoked')),
        redeemed_by TEXT REFERENCES hub_users(id),
        redeemed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS hub_recharge_codes_batch_status ON hub_recharge_codes(batch_id, status);
      CREATE TABLE IF NOT EXISTS hub_ledger_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('recharge', 'reservation', 'settlement', 'release', 'refund', 'adjustment')),
        amount_units INTEGER NOT NULL CHECK (amount_units != 0),
        idempotency_key TEXT NOT NULL,
        reference_type TEXT NOT NULL,
        reference_id TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS hub_ledger_user_created ON hub_ledger_entries(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS hub_request_reservations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        api_key_id TEXT NOT NULL REFERENCES hub_api_keys(id),
        client_idempotency_key TEXT,
        request_fingerprint TEXT NOT NULL,
        pricing_version TEXT NOT NULL,
        route_path TEXT,
        model_alias TEXT,
        reserved_units INTEGER NOT NULL CHECK (reserved_units > 0),
        settled_units INTEGER,
        status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'released')),
        upstream_status INTEGER,
        upstream_started_at INTEGER,
        first_output_at INTEGER,
        terminal_reason TEXT,
        terminal_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(api_key_id, client_idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS hub_request_reservations_user_created
        ON hub_request_reservations(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS hub_auth_failures (
        subject_digest TEXT PRIMARY KEY,
        failure_count INTEGER NOT NULL,
        window_started_at INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS hub_rate_limits (
        scope TEXT NOT NULL,
        subject_digest TEXT NOT NULL,
        request_count INTEGER NOT NULL,
        window_started_at INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(scope, subject_digest)
      );
      CREATE TABLE IF NOT EXISTS hub_audit_events (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT REFERENCES hub_users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
        created_at INTEGER NOT NULL
      );
    `);
    const current = this.db.query("SELECT value FROM hub_meta WHERE key = 'schema_version'").get() as { value: string } | null;
    const currentVersion = current ? Number(current.value) : 0;
    if (!Number.isInteger(currentVersion) || currentVersion < 0 || currentVersion > SCHEMA_VERSION) {
      throw new Error(`unsupported hub schema version ${current?.value ?? "unknown"}`);
    }

    const userColumns = new Set((this.db.query("PRAGMA table_info(hub_users)").all() as Array<{ name: string }>).map(row => row.name));
    if (!userColumns.has("support_reference")) {
      this.db.exec("ALTER TABLE hub_users ADD COLUMN support_reference TEXT");
    }
    const usersWithoutReference = this.db.query("SELECT id FROM hub_users WHERE support_reference IS NULL OR support_reference = ''").all() as Array<{ id: string }>;
    const setReference = this.db.query("UPDATE hub_users SET support_reference = ? WHERE id = ?");
    for (const user of usersWithoutReference) setReference.run(randomReference("usr_"), user.id);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS hub_users_support_reference_unique ON hub_users(support_reference)");

    const reservationColumns = new Set((this.db.query("PRAGMA table_info(hub_request_reservations)").all() as Array<{ name: string }>).map(row => row.name));
    const reservationMigrations = [
      ["route_path", "TEXT"],
      ["model_alias", "TEXT"],
      ["upstream_status", "INTEGER"],
      ["upstream_started_at", "INTEGER"],
      ["first_output_at", "INTEGER"],
      ["terminal_reason", "TEXT"],
      ["terminal_at", "INTEGER"],
    ] as const;
    for (const [column, type] of reservationMigrations) {
      if (!reservationColumns.has(column)) this.db.exec(`ALTER TABLE hub_request_reservations ADD COLUMN ${column} ${type}`);
    }

    if (!current) {
      this.db.query("INSERT INTO hub_meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (currentVersion < SCHEMA_VERSION) {
      this.db.query("UPDATE hub_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    }
  }

  acquireSingleNodeLock(now = Date.now(), leaseMs = 30_000): void {
    if (this.lockOwner) return;
    const owner = `${process.pid}:${randomToken("lock_")}`;
    const acquire = this.db.transaction(() => {
      this.db.query("DELETE FROM hub_runtime_lock WHERE lock_name = 'single-node' AND expires_at < ?").run(now);
      this.db.query("INSERT INTO hub_runtime_lock(lock_name, owner, expires_at) VALUES ('single-node', ?, ?)").run(owner, now + leaseMs);
    });
    try {
      acquire();
    } catch {
      throw new Error("hub database is already owned by another running instance");
    }
    this.lockOwner = owner;
    this.heartbeat = setInterval(() => {
      if (!this.lockOwner) return;
      const result = this.db.query("UPDATE hub_runtime_lock SET expires_at = ? WHERE lock_name = 'single-node' AND owner = ?")
        .run(Date.now() + leaseMs, this.lockOwner);
      if (result.changes !== 1) throw new Error("hub single-node lease was lost");
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    this.heartbeat.unref?.();
  }

  assertNoActiveRuntimeLock(now = Date.now()): void {
    const row = this.db.query("SELECT expires_at FROM hub_runtime_lock WHERE lock_name = 'single-node'").get() as { expires_at: number } | null;
    if (row && row.expires_at >= now) throw new Error("hub must be stopped before running an offline bootstrap operation");
  }

  releaseSingleNodeLock(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (!this.lockOwner) return;
    this.db.query("DELETE FROM hub_runtime_lock WHERE lock_name = 'single-node' AND owner = ?").run(this.lockOwner);
    this.lockOwner = null;
  }

  close(): void {
    this.releaseSingleNodeLock();
    this.db.close();
  }
}
