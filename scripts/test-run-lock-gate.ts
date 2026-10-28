import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { constants, Database } from "bun:sqlite";
import { samePathIdentity } from "../src/codex/user-identity";
import { hardenSecretDir, hardenSecretPath } from "../src/lib/windows-secret-acl";

export const TEST_RUN_LOCK_RELEASE_WAIT_MS = 10_000;

// sqlite3_busy_timeout bounds cumulative *scheduled* sleep, not elapsed time:
// each native wait may overshoot. An overshooting BEGIN IMMEDIATE wait was
// observed exceeding this budget in hosted CI. Retrying in slices under a
// monotonic deadline bounds the elapsed wait regardless of per-sleep
// overshoot; the bound is a deadline, not a realtime guarantee.
const BUSY_WAIT_SLICE_MS = 250;

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function refuse(): never {
  throw new Error("Cannot open the Bun test lock generation gate: unsafe path, permissions or file identity.");
}

function inspectFile(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) refuse();
    if (process.platform !== "win32" && entry.uid !== process.getuid?.()) refuse();
    if (!samePathIdentity(path, realpathSync.native(path), process.platform)) refuse();
    return entry;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

function openGate(lockPath: string): { db: Database; identity: { dev: number | bigint; ino: number | bigint } } {
  if (!isAbsolute(lockPath)) refuse();
  const requestedParent = dirname(lockPath);
  // Windows' OS temp path can use an 8.3 spelling. Canonicalize that alias,
  // without silently accepting a junction/symlink anywhere in its ancestry.
  for (let ancestor = requestedParent;; ancestor = dirname(ancestor)) {
    const entry = lstatSync(ancestor);
    if (entry.isSymbolicLink()) {
      // macOS exposes its OS-owned temp hierarchy through these system aliases.
      const systemAlias = process.platform === "darwin" && (ancestor === "/var" || ancestor === "/tmp")
        && entry.uid === 0 && realpathSync.native(ancestor) === `/private${ancestor}`
        && lstatSync(`/private${ancestor}`).uid === 0;
      if (!systemAlias) refuse();
    }
    if (dirname(ancestor) === ancestor) break;
  }
  const parent = realpathSync.native(requestedParent);
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || !samePathIdentity(parent, realpathSync.native(parent), process.platform)) refuse();
  if (process.platform === "win32") hardenSecretDir(parent, { required: true });
  else if (directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) refuse();
  const path = join(parent, `${basename(lockPath)}.gate.sqlite`);
  const before = inspectFile(path);
  // Never fs.open/close this inode: POSIX close can cancel another SQLite
  // connection's locks in this process. The private parent protects creation.
  const db = Database.open(path,
    constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW);
  try {
    const opened = inspectFile(path);
    if (!opened || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) refuse();
    if (process.platform === "win32") hardenSecretPath(path, { required: true });
    else chmodSync(path, 0o600);
    const secured = inspectFile(path);
    const parentAfter = lstatSync(parent);
    if (!secured || secured.dev !== opened.dev || secured.ino !== opened.ino
      || directory.dev !== parentAfter.dev || directory.ino !== parentAfter.ino) refuse();
    return { db, identity: secured };
  } catch (error) {
    db.close(true);
    throw error;
  }
}

/** Permanent sibling: never unlink/replace it or PID/mtime-reclaim it.
 * Old executables do not participate: metadata compatibility does not stop an
 * old in-flight actor's already-decided pathname operations.
 */
export function openTestRunLockGate(lockPath: string) {
  const { db, identity } = openGate(lockPath);
  return {
    run<T>(action: () => T, busyMs = 0): { value: T } | undefined {
      const current = inspectFile(db.filename);
      if (!current || current.dev !== identity.dev || current.ino !== identity.ino) refuse();
      let entered = false;
      try {
        // The deadline bounds only the wait for gate entry. Once BEGIN
        // IMMEDIATE is granted the action runs to completion, exactly once,
        // outside the budget — same semantics as a single long wait.
        // A non-finite budget is not a meaningful wait and would never satisfy
        // the deadline comparison: normalize to the documented busyMs=0
        // single immediate attempt rather than looping.
        const budget = Number.isFinite(busyMs) ? Math.max(0, Math.floor(busyMs)) : 0;
        const deadline = performance.now() + budget;
        for (;;) {
          const remaining = Math.max(0, Math.floor(deadline - performance.now()));
          db.exec(`PRAGMA busy_timeout = ${Math.min(remaining, BUSY_WAIT_SLICE_MS)}`);
          try {
            db.exec("BEGIN IMMEDIATE");
            entered = true;
            break;
          } catch (error) {
            if (code(error) !== "SQLITE_BUSY") throw error;
            if (budget <= 0 || performance.now() >= deadline) return undefined;
          }
        }
        // A bounded busy wait can outlive external pathname interference.
        const locked = inspectFile(db.filename);
        if (!locked || locked.dev !== identity.dev || locked.ino !== identity.ino) refuse();
        return { value: action() };
      } finally { if (entered) db.exec("ROLLBACK"); }
    },
    close() { db.close(true); },
  };
}

export function withTestRunLockGate<T>(lockPath: string, action: () => T, busyMs = 0): { value: T } | undefined {
  const gate = openTestRunLockGate(lockPath);
  try { return gate.run(action, busyMs); }
  finally { gate.close(); }
}
