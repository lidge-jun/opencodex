import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import type { JevDecisionBackend } from "../../combos/jev";
import { recordOwnedConfigPath } from "../../lib/config-ownership";
import { isPassiveRead } from "../../lib/passive-read";
import {
  assertPrivateSqliteEntryOrMissing,
  assertPrivateSqliteSidecars,
  preparePrivateSqliteDatabase,
  SQLITE_SIDECAR_SUFFIXES,
} from "../../lib/private-sqlite-path";
import {
  assertStorageOwned,
  currentSpendLedgerOwnerGeneration,
  mintSpendLedgerStorage,
  onSpendLedgerOwnerReleasing,
  spendLedgerOwnerSnapshot,
  spendLedgerStoragePath,
  type SpendLedgerStorage,
} from "../../lib/spend-ledger-owner";
import { hardenSecretPath } from "../../lib/windows-secret-acl";
import type { OcxComboDefaultEffort } from "../../types";

export interface StoredJevSessionPin {
  targetKey: string;
  effort: OcxComboDefaultEffort | null;
  backend: JevDecisionBackend;
  at: number;
  comboFingerprint: string;
}

const FILENAME = "jev-session-pins.sqlite";
// Bound disk state without dropping an existing conversation's pin to make room.
const MAX_SAVED_PINS = 16_384;
type FileIdentity = { dev: number; ino: number };
interface PinStore {
  db: Database;
  storage: SpendLedgerStorage;
  file: FileIdentity;
  secret: string;
  warnedFull: boolean;
}

let store: PinStore | undefined;
let refusedGeneration: number | undefined;

function privateFile(path: string): FileIdentity {
  if (!assertPrivateSqliteEntryOrMissing(path)) throw new Error("Missing JEV pin database");
  const { dev, ino } = lstatSync(path);
  return { dev, ino };
}

function assertCurrent(state: Pick<PinStore, "storage" | "file">): void {
  assertStorageOwned(state.storage);
  const path = spendLedgerStoragePath(state.storage);
  assertPrivateSqliteSidecars(path);
  const file = privateFile(path);
  if (file.dev !== state.file.dev || file.ino !== state.file.ino) throw new Error("JEV pin database replaced");
}

function open(): PinStore {
  const storage = mintSpendLedgerStorage(FILENAME);
  const path = spendLedgerStoragePath(storage);
  const home = dirname(path);
  recordOwnedConfigPath(home, path);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) recordOwnedConfigPath(home, path + suffix);
  preparePrivateSqliteDatabase(path);
  const file = privateFile(path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  hardenSecretPath(path, { required: true });
  assertCurrent({ storage, file });
  const db = new Database(path, { create: false });
  try {
    db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pins (
        row_key TEXT PRIMARY KEY, target_key TEXT NOT NULL, effort TEXT, backend TEXT NOT NULL,
        at INTEGER NOT NULL, combo_fingerprint TEXT NOT NULL
      );`);
    db.query("INSERT OR IGNORE INTO meta VALUES ('secret', ?), ('clean', '1')").run(randomBytes(32).toString("hex"));
    const secret = db.query<{ value: string }, []>("SELECT value FROM meta WHERE name='secret'").get()?.value;
    if (!secret || !/^[0-9a-f]{64}$/.test(secret)) throw new Error("Invalid JEV pin database");
    // A failed deletion must not revive an old pin on the next process. Restore only after
    // the previous writer shut down cleanly with its storage still usable.
    db.exec(`DELETE FROM pins WHERE (SELECT value FROM meta WHERE name='clean') <> '1';
      UPDATE meta SET value='0' WHERE name='clean'; COMMIT;`);
    assertCurrent({ storage, file });
    return { db, storage, file, secret, warnedFull: false };
  } catch (error) {
    try { db.close(); } catch { /* preserve the open failure */ }
    throw error;
  }
}

function close(clean: boolean): void {
  const state = store;
  store = undefined;
  if (!state) return;
  try {
    if (clean) {
      assertCurrent(state);
      state.db.exec("UPDATE meta SET value='1' WHERE name='clean'");
    }
  } catch {
    console.warn("[opencodex] Could not finalize JEV conversation pins.");
  } finally {
    try { state.db.close(); } catch { /* ownership still releases */ }
  }
}

onSpendLedgerOwnerReleasing(() => close(true));

function withPin<T>(key: string, operation: (state: PinStore, rowKey: string) => T): T | undefined {
  if (isPassiveRead() || spendLedgerOwnerSnapshot().ownership !== "held") return undefined;
  const generation = currentSpendLedgerOwnerGeneration();
  if (refusedGeneration === generation) return undefined;
  try {
    store ??= open();
    assertCurrent(store);
    const rowKey = createHmac("sha256", store.secret).update("ocx/jev-session-pin/v1\0").update(key).digest("hex");
    return operation(store, rowKey);
  } catch {
    refusedGeneration = generation;
    close(false);
    console.warn("[opencodex] JEV conversation pins are using memory only; local storage is unavailable.");
    return undefined;
  }
}

export function readStoredJevSessionPin(key: string): StoredJevSessionPin | undefined {
  return withPin(key, ({ db }, rowKey) => db.query<StoredJevSessionPin, [string]>(
    "SELECT target_key AS targetKey, effort, backend, at, combo_fingerprint AS comboFingerprint FROM pins WHERE row_key=?",
  ).get(rowKey) ?? undefined);
}

export function saveJevSessionPin(key: string, pin: StoredJevSessionPin): void {
  withPin(key, (state, rowKey) => {
    const result = state.db.query(`
      INSERT INTO pins (row_key, target_key, effort, backend, at, combo_fingerprint)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pins WHERE row_key=?)
        OR NOT EXISTS (SELECT 1 FROM pins LIMIT 1 OFFSET ${MAX_SAVED_PINS - 1})
      ON CONFLICT(row_key) DO UPDATE SET target_key=excluded.target_key, effort=excluded.effort,
        backend=excluded.backend, at=excluded.at, combo_fingerprint=excluded.combo_fingerprint
    `).run(rowKey, pin.targetKey, pin.effort, pin.backend, pin.at, pin.comboFingerprint, rowKey);
    if (result.changes === 0 && !state.warnedFull) {
      state.warnedFull = true;
      console.warn("[opencodex] JEV conversation pin storage is full; new pins are using memory only.");
    }
  });
}

export function deleteStoredJevSessionPin(key: string): void {
  withPin(key, ({ db }, rowKey) => db.query("DELETE FROM pins WHERE row_key=?").run(rowKey));
}
