import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";

/**
 * The credential-publication fence: the OS lock of one small SQLite file, separate from the config
 * mutation lock. Instrumented credential writers hold it EXCLUSIVE across their ticket, the
 * credential write and the ticket's close; `ocx status` holds it SHARED across its generation
 * reads and source scan, so a snapshot can never interleave with a publication. Nothing is written
 * inside the transaction, so process death releases the lock without a hot journal. Holding is
 * reentrant per process and per home, which also covers an async publication that awaits inside it.
 */
export const CREDENTIAL_FENCE_FILENAME = "local-credential-publication.sqlite";
/** How long a writer waits for readers and other writers; a reader never waits inside SQLite. */
export const CREDENTIAL_FENCE_WRITER_WAIT_MS = 10_000;

const held = new Map<string, { db: Database; holders: number }>();

function acquire(home: string, waitMs: number): () => void {
  const current = held.get(home);
  if (current) current.holders += 1;
  else {
    assertNotRealHomeUnderTest(home);
    const path = join(home, CREDENTIAL_FENCE_FILENAME);
    recordOwnedConfigPath(home, path);
    const db = new Database(path, { create: true });
    try {
      if (process.platform !== "win32") chmodSync(path, 0o600);
      db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(waitMs))}; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS fence (id INTEGER PRIMARY KEY)`);
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) { db.close(); throw error; }
    held.set(home, { db, holders: 1 });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = held.get(home);
    if (!entry || --entry.holders > 0) return;
    held.delete(home);
    try { entry.db.exec("ROLLBACK"); } catch { /* close below releases the lock */ }
    entry.db.close();
  };
}

export function withCredentialPublicationFence<T>(home: string, fn: () => T, waitMs = CREDENTIAL_FENCE_WRITER_WAIT_MS): T {
  const release = acquire(home, waitMs);
  try { return fn(); } finally { release(); }
}

export async function withCredentialPublicationFenceAsync<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const release = acquire(home, CREDENTIAL_FENCE_WRITER_WAIT_MS);
  try { return await fn(); } finally { release(); }
}

export type FencedRead<T> = { kind: "read"; value: T } | { kind: "busy" } | { kind: "unavailable" };

/** One consistent read with no publication in flight; never creates the fence or waits. */
export function readUnderCredentialPublicationFence<T>(home: string, fn: () => T): FencedRead<T> {
  if (held.has(home)) return { kind: "busy" };
  let db: Database;
  try { db = new Database(join(home, CREDENTIAL_FENCE_FILENAME), { readonly: true }); }
  catch { return { kind: "unavailable" }; }
  let open = false;
  try {
    db.exec("PRAGMA busy_timeout=0");
    db.exec("BEGIN");
    open = true;
    try { db.query("SELECT count(*) FROM sqlite_master").get(); }
    catch (error) {
      return String((error as { code?: unknown })?.code ?? "").startsWith("SQLITE_BUSY") ? { kind: "busy" } : { kind: "unavailable" };
    }
    return { kind: "read", value: fn() };
  } catch { return { kind: "unavailable" }; }
  finally {
    if (open) { try { db.exec("COMMIT"); } catch { /* close below releases the shared lock */ } }
    db.close();
  }
}
