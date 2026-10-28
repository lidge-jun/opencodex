import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hardenSecretDir, windowsSecretAclApplies } from "../lib/windows-secret-acl";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";

/**
 * A per-observer SQLite file held in an exclusive transaction for the observer's lifetime. It is
 * an OS lock that process death releases, so status can tell a live observer from surviving
 * metadata without trusting a PID. Status opens it read-only and only an exact SQLITE_BUSY on the
 * same file identity counts as alive.
 */
const UUID = /^[0-9a-f-]{36}$/;
function pathFor(home: string, owner: string): string {
  if (!UUID.test(owner)) throw new Error("Invalid credential observer owner");
  return join(home, "local-credential-observers", `${owner}.sqlite`);
}
function safeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe credential observer directory");
}
export function acquireCredentialObservationLease(home: string, owner: string): { close(): void } {
  assertNotRealHomeUnderTest(home);
  safeDirectory(home);
  const dir = join(home, "local-credential-observers");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  safeDirectory(dir);
  if (windowsSecretAclApplies()) hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  const path = pathFor(home, owner);
  try { lstatSync(path); throw new Error("Credential observer lease already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
  const db = new Database(path, { create: true });
  let held = false;
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE liveness (id INTEGER PRIMARY KEY)");
    // No writes after BEGIN: process death releases the lock without a hot rollback journal.
    db.exec("BEGIN EXCLUSIVE");
    held = true;
    return { close() {
      if (!held) return;
      held = false;
      try { db.exec("ROLLBACK"); }
      finally {
        db.close();
        try { unlinkSync(path); } catch { /* An unlocked residue never proves observer liveness. */ }
      }
    } };
  } catch (error) { db.close(); throw error; }
}
export function credentialObservationLeaseAlive(home: string, owner: string): boolean {
  let db: Database | undefined;
  try {
    safeDirectory(home);
    safeDirectory(join(home, "local-credential-observers"));
    const path = pathFor(home, owner);
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024n * 1024n) return false;
    try {
      db = new Database(path, { readonly: true });
      db.exec("PRAGMA busy_timeout=0");
      db.query("SELECT id FROM liveness LIMIT 1").get();
      return false;
    } catch (error) {
      const after = lstatSync(path, { bigint: true });
      return (error as { code?: string })?.code === "SQLITE_BUSY"
        && before.dev === after.dev && before.ino === after.ino && after.isFile() && !after.isSymbolicLink();
    }
  } catch { return false; }
  finally { db?.close(); }
}

/** Removes the leases of observers that died without closing them; callers hold the config lock. */
export function sweepDeadCredentialObservationLeases(home: string, keep: string): void {
  let names: string[];
  try { names = readdirSync(join(home, "local-credential-observers")); } catch { return; }
  for (const name of names) {
    const owner = name.endsWith(".sqlite") ? name.slice(0, -".sqlite".length) : "";
    if (!UUID.test(owner) || owner === keep || credentialObservationLeaseAlive(home, owner)) continue;
    try { unlinkSync(pathFor(home, owner)); } catch { /* a lease that cannot be removed proves nothing either */ }
  }
}
