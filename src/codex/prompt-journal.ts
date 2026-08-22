/**
 * prompt-journal.ts — the write transaction behind the prompt-layer surface.
 *
 * Two files must move together: `opencodex-prompt.json` (the source of truth for
 * custom layers) and `config.toml` (which carries the generated projection).
 * Atomic rename makes each write individually torn-free; it does nothing about
 * a crash between them, or about another writer touching a file after we read
 * it. That is what this module is for.
 *
 * THE JOURNAL IS PREPARED INTENT, NOT A COMMIT. Commit is deleting the journal
 * after both targets verify against the post-image. So a journal found on disk
 * always means the transaction never committed, and recovery rolls BACK. An
 * earlier design rolled forward from the post-image while also claiming a failed
 * request changes nothing; an audit showed the two rules cannot both hold.
 *
 * RECOVERY NEVER WRITES A FILE IT DOES NOT RECOGNISE. Each target is classified
 * independently against the pre- and post-image hashes, and a single
 * unrecognised target aborts the whole recovery. The failure this prevents is
 * concrete: crash after writing config.toml, user or Codex then edits it,
 * recovery sees a mismatch and overwrites their work with a stale image.
 */
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { forgetEphemeralSecretPath, hardenSecretPath, windowsSecretAclApplies } from "../lib/windows-secret-acl";
import { renameAtomicFile } from "../lib/windows-atomic-replace";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function hashBytes(bytes: string | null): string {
  return bytes === null
    ? "\0absent"
    : createHash("sha256").update(bytes).digest("hex");
}

function readOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * fsync the containing directory so a rename survives a crash. Fsyncing the file
 * alone does not make its directory entry durable.
 *
 * Windows has no directory fsync; `hardenSecretPath` covers the ACL side and the
 * durability gap is documented as a WP1 acceptance item — the journal is still
 * written first, so the worst case is a recovery that reports
 * `recovery_required` rather than one that loses data silently.
 */
function fsyncDir(path: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } catch {
    /* best effort: a filesystem may refuse to fsync a directory */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Write at mode 0600 from creation — a later chmod leaves a readable window. */
export function durableWrite(path: string, content: string): void {
  const tmp = `${path}.ocx.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: FILE_MODE });
    // The journal carries full config.toml bytes (provider credentials):
    // hardening must fail closed, matching the token/tray writers.
    if (windowsSecretAclApplies()) hardenSecretPath(tmp, { required: true, timeoutMemoKey: path });
    fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Windows can refuse the replace with EBUSY/EPERM/EACCES while a scanner
    // still holds the target; the shared helper retries that briefly. Losing
    // this publish breaks journal restore, so it should not fail on a blink.
    renameAtomicFile(tmp, path, undefined, "prompt-journal");
    // The temp is renamed away: proven absent — release its ACL memos.
    forgetEphemeralSecretPath(tmp);
    fsyncDir(path);
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ }
    if (!existsSync(tmp)) {
      // Explicit non-existence is proven absence — release even when the
      // failure happened before/while the temp disappeared.
      forgetEphemeralSecretPath(tmp);
    } else {
      try {
        unlinkSync(tmp);
        forgetEphemeralSecretPath(tmp);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          forgetEphemeralSecretPath(tmp);
        }
        /* residual temp: memos stay (fail-closed) */
      }
    }
    throw error;
  }
}

export function durableDelete(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
    fsyncDir(path);
  } catch (error) {
    // Only absence is the state we wanted; every other deletion failure must
    // surface — recovery and commit evidence depend on the file being gone.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

/**
 * Exclusive create for backups: a timestamp alone can collide, and a salvage
 * whose safety net silently overwrote an earlier one is not a safety net.
 * Throws if the path already exists.
 */
export function durableWriteExclusive(path: string, content: string): void {
  let fd: number | undefined;
  try {
    writeFileSync(path, content, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    if (process.platform === "win32") hardenSecretPath(path, { required: false });
    fd = openSync(path, "r+");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDir(path);
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ }
    throw error;
  }
}

export function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

// ---------------------------------------------------------------------------
// Envelope
//
// Line 1 is `ocx-journal-v1 <sha256 of line 2>`; line 2 is the record. The
// checksum is verified BEFORE anything is read from it. An earlier design said
// "restore from the pre-image if it is intact" for a journal that had failed its
// own checksum — restoring from a document you have just declared untrustworthy.
// Any checksum failure or truncation is now recovery_required: nothing read,
// nothing written.
// ---------------------------------------------------------------------------

export interface JournalRecord {
  configPath: string;
  storePath: string;
  preConfig: string;
  postConfig: string;
  preStore: string;
  postStore: string;
  /** null means the file should not exist in that image */
  postConfigBytes: string | null;
  postStoreBytes: string | null;
  preConfigBytes: string | null;
  preStoreBytes: string | null;
}

const ENVELOPE_TAG = "ocx-journal-v1";

export function encodeJournal(record: JournalRecord): string {
  const body = JSON.stringify(record);
  const sum = createHash("sha256").update(body).digest("hex");
  return `${ENVELOPE_TAG} ${sum}\n${body}\n`;
}

/** null for absent, malformed, truncated, or checksum-mismatched journals. */
export function decodeJournal(raw: string | null): JournalRecord | null {
  if (raw === null) return null;
  const newline = raw.indexOf("\n");
  if (newline === -1) return null;
  const header = raw.slice(0, newline);
  const body = raw.slice(newline + 1).replace(/\n$/, "");
  const [tag, sum] = header.split(" ");
  if (tag !== ENVELOPE_TAG || !sum) return null;
  if (createHash("sha256").update(body).digest("hex") !== sum) return null;
  try {
    const parsed = JSON.parse(body) as JournalRecord;
    if (typeof parsed?.configPath !== "string" || typeof parsed?.storePath !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classification — the guard that keeps recovery from destroying other work.
// ---------------------------------------------------------------------------

export type TargetState = "pre" | "post" | "unknown";

export function classify(actual: string | null, pre: string, post: string): TargetState {
  const hash = hashBytes(actual);
  if (hash === post) return "post";
  if (hash === pre) return "pre";
  return "unknown";
}

export type RecoveryOutcome =
  | { ok: true; action: "none" | "committed" | "rolled-back" }
  | { ok: false; error: "recovery_required"; detail: string };

export interface RecoveryTargets {
  configPath: string;
  storePath: string;
}

/** Lexical path identity only: never resolve an untrusted journal path through the filesystem. */
export function sameRecoveryPath(
  recordedPath: string,
  expectedPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const recorded = resolve(recordedPath);
  const expected = resolve(expectedPath);
  return platform === "win32"
    ? recorded.toLowerCase() === expected.toLowerCase()
    : recorded === expected;
}

/**
 * Run at service start and at every lock acquisition. Never from a read.
 *
 * A journal on disk means commit never happened, so the default is rollback.
 * The single exception is not a roll-forward: when BOTH targets already hold the
 * post-image the writes had finished and only the journal deletion was missing.
 *
 * The expected targets come from the active prompt-layer configuration, not
 * from the journal. The envelope checksum detects accidental corruption, not a
 * same-user forgery, so recovery binds the decoded record to those trusted
 * paths before reading either target.
 */
export function recoverIfNeeded(
  journalPath: string,
  expectedTargets: RecoveryTargets,
): RecoveryOutcome {
  const raw = readOrNull(journalPath);
  if (raw === null) return { ok: true, action: "none" };

  const record = decodeJournal(raw);
  if (record === null) {
    return {
      ok: false,
      error: "recovery_required",
      detail: `journal at ${journalPath} failed its checksum or is truncated; nothing was read from it`,
    };
  }

  if (
    !sameRecoveryPath(record.configPath, expectedTargets.configPath)
    || !sameRecoveryPath(record.storePath, expectedTargets.storePath)
  ) {
    return {
      ok: false,
      error: "recovery_required",
      detail: `journal at ${journalPath} does not match the active prompt-layer paths; nothing was read from its targets`,
    };
  }

  const config = classify(readOrNull(expectedTargets.configPath), record.preConfig, record.postConfig);
  const store = classify(readOrNull(expectedTargets.storePath), record.preStore, record.postStore);

  if (config === "unknown" || store === "unknown") {
    const which = config === "unknown" ? expectedTargets.configPath : expectedTargets.storePath;
    return {
      ok: false,
      error: "recovery_required",
      detail: `${which} matches neither the pre- nor post-image; it was modified outside opencodex`,
    };
  }

  if (config === "post" && store === "post") {
    try {
      durableDelete(journalPath);
    } catch (error) {
      return {
        ok: false,
        error: "recovery_required",
        detail: `commit confirmed but the journal could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true, action: "committed" };
  }

  // Revalidate each target immediately before its own restore: a target that
  // changed since the initial classification must not be overwritten.
  if (config === "post") {
    if (classify(readOrNull(expectedTargets.configPath), record.preConfig, record.postConfig) !== "post") {
      return {
        ok: false,
        error: "recovery_required",
        detail: `${expectedTargets.configPath} changed after its first classification; refusing to overwrite it`,
      };
    }
    try {
      restore(expectedTargets.configPath, record.preConfigBytes);
    } catch (error) {
      return {
        ok: false,
        error: "recovery_required",
        detail: `rollback of ${expectedTargets.configPath} failed mid-write: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (store === "post") {
    if (classify(readOrNull(expectedTargets.storePath), record.preStore, record.postStore) !== "post") {
      return {
        ok: false,
        error: "recovery_required",
        detail: `${expectedTargets.storePath} changed after its first classification; refusing to overwrite it`,
      };
    }
    try {
      restore(expectedTargets.storePath, record.preStoreBytes);
    } catch (error) {
      return {
        ok: false,
        error: "recovery_required",
        detail: `rollback of ${expectedTargets.storePath} failed mid-write: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    durableDelete(journalPath);
  } catch (error) {
    return {
      ok: false,
      error: "recovery_required",
      detail: `rollback restored but the journal could not be removed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, action: "rolled-back" };
}

function restore(path: string, bytes: string | null): void {
  if (bytes === null) durableDelete(path);
  else durableWrite(path, bytes);
}
