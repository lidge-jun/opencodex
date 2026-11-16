import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GenerationContext } from "./state-store-sweeper";
import { renameAtomicFile } from "./windows-atomic-replace";
import {
  canonicalRootUnchanged,
  elevatedRemovalRefusal,
  ownedEntryPresent,
  removeOwnedEntry,
  rootIdentity,
  uninstallRunsElevated,
  type RootIdentity,
} from "./config-ownership-removal";

export const CONFIG_OWNER_FILE = ".opencodex-owner.json";
export const CONFIG_UNINSTALL_MANIFEST = ".opencodex-uninstall.json";
/**
 * Cross-process lock for every manifest read-modify-write (#8093). It is the OS-held SQLite write
 * lock that `src/config/mutation-lock.ts` uses: `BEGIN IMMEDIATE` on this file, released when the
 * handle closes, including at process exit or crash, so there is no stale owner to recover.
 */
export const CONFIG_OWNERSHIP_LOCK = ".opencodex-uninstall.lock";
const OWNERSHIP_LOCK_SIDECARS = ["-journal", "-wal", "-shm"] as const;
/** The section under the lock is a few file operations; a longer wait means a stuck holder. */
const OWNERSHIP_LOCK_WAIT_MS = 50;

/** A registration found the uninstall tombstone and wrote nothing. */
export class ConfigUninstallInProgressError extends Error {
  readonly code = "CONFIG_UNINSTALL_IN_PROGRESS";
  constructor() {
    // No path: this message can reach logs, and the config root can name the user.
    super("opencodex uninstall is in progress for this config directory; run `ocx uninstall` again to finish it before writing new state there.");
    this.name = "ConfigUninstallInProgressError";
  }
}

export class ConfigOwnershipLockError extends Error {
  readonly code = "CONFIG_OWNERSHIP_LOCK_UNAVAILABLE";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigOwnershipLockError";
  }
}

export type ConfigRemovalResult = {
  status: "absent" | "removed" | "partial" | "refused";
  reason?: string;
  residualPaths: string[];
};

type ConfigOwner = {
  version: 1;
  ownerId: string;
  root: string;
};

type ConfigUninstallManifest = ConfigOwner & {
  paths: string[];
  /** Tombstone: set under the lock before uninstall snapshots `paths`; registrations then refuse. */
  uninstallStartedAt?: number;
};

const METADATA_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_PATHS = 1024;
const INITIAL_OWNED_PATHS = [
  ".star-prompted",
  "artifacts",
  "auth.json",
  "auth.store.lock",
  "admin-api-token",
  "catalog-backup.json",
  "claude-env.sh",
  "codex-accounts.json",
  "codex-runtime-clamp.json",
  "codex-runtime.json",
  "codex-shim.autorestore.lock",
  "codex-shim.json",
  "config.json",
  "config-mutation.sqlite",
  "config-mutation.sqlite-journal",
  "config-mutation.sqlite-shm",
  "config-mutation.sqlite-wal",
  "codex-affinity.sqlite",
  "codex-affinity.sqlite-journal",
  "codex-affinity.sqlite-shm",
  "codex-affinity.sqlite-wal",
  "local-credentials.json",
  "local-credential-observers",
  "local-credential-publication.sqlite",
  "local-credential-publication.sqlite-journal",
  "crash.log",
  "kimi-device-id",
  "mimo-client-id",
  "ocx.pid",
  "opencodex-service-launcher.vbs",
  "opencodex-service-task.xml",
  "opencodex-service.cmd",
  "opencodex-tray-offline.ico",
  "opencodex-tray-offline-update.ico",
  "opencodex-tray-online.ico",
  "opencodex-tray-online-update.ico",
  "opencodex-tray-warning.ico",
  "opencodex-tray-warning-update.ico",
  "opencodex-tray.ps1",
  "responses-state.json",
  "runtime-port.json",
  "service-api-token",
  "service-state.json",
  "service.log",
  "system-env-port",
  "thought-signature-replay.json",
  "tray-heartbeat.json",
  "tray-state.json",
  "update-job.json",
  "usage-debug.jsonl",
  "usage.jsonl",
  "version.json",
  "winsw",
] as const;
/**
 * Room an uninstall rerun may use past the usual caps, under its tombstone, to record the opencodex
 * files its own cleanup recreates (the config mutation database, for one). Only initially owned
 * names qualify, each at most once, so a full manifest from an older version cannot strand them and
 * the manifest stays bounded.
 */
const RECOVERY_RESERVE_PATHS = INITIAL_OWNED_PATHS.length;
const RECOVERY_RESERVE_BYTES = INITIAL_OWNED_PATHS.reduce((total, name) => total + Buffer.byteLength(name) + 8, 0);
const ownershipCache = new Map<string, {
  owner: ConfigOwner;
  manifest: ConfigUninstallManifest;
} | null>();
let lastReconciledGeneration = 0;
/**
 * Manifest identity (dev:ino:size:mtime) this process last observed under the ownership lock.
 * A cached path returns without locking only while the manifest is still that file, so a
 * tombstone written by another process sends even an already-recorded path to the locked check.
 */
const lockedManifestIdentity = new Map<string, string>();
const warnedFullManifest = new Set<string>();
/**
 * The metadata state in which a creation wait already ran out for a home, keyed as
 * {@link ownershipCache}. An unowned home whose manifest and owner marker keep the same identity
 * has no publication left to wait for (a stopped creation, or a corrupt marker), so a registration
 * must not pay the bounded wait again; either file changing re-arms a single wait.
 */
const expiredCreationWait = new Map<string, string>();
/**
 * Open while this process runs `ocx uninstall` itself. Its own registrations then skip the
 * tombstone check: the same process runs removeOwnedConfigState afterwards, whose locked snapshot
 * includes whatever they add, so nothing it records is orphaned. Without this, a rerun after an
 * interrupted uninstall would refuse its own teardown steps (the config mutation lock records
 * its database) before it reached the remover that finishes the job. Other processes still refuse.
 */
let teardownDepth = 0;

type UninstallStep = "snapshot-removed" | "owner-deleted" | "lock-retired";
let uninstallStepHookForTests: ((step: UninstallStep) => void) | undefined;
/**
 * Test seam, called inside uninstall's single lock hold: after it removed its snapshot, and after it
 * deleted the owner marker. A hook that throws stops the run there, as a crash would.
 */
export function setUninstallStepHookForTests(hook: ((step: UninstallStep) => void) | undefined): void {
  uninstallStepHookForTests = hook;
}

/** Mark this process as the uninstaller until the returned release runs. */
export function beginConfigOwnershipTeardown(): () => void {
  teardownDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    teardownDepth -= 1;
    // Nothing this scope observed may let a later call skip the tombstone check.
    lockedManifestIdentity.clear();
  };
}

function manifestIdentity(configDir: string): string | undefined {
  try {
    const entry = lstatSync(join(configDir, CONFIG_UNINSTALL_MANIFEST), { bigint: true });
    return entry.isFile() ? `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which file each ownership metadata name refers to while a manifest exists, in the same
 * dev:ino:size:mtime terms {@link manifestIdentity} uses, or null when no manifest exists: without
 * one the publication wait ends in a single pass, so there is no spent wait to remember. The
 * manifest is replaced atomically and the owner marker written once, so either file changing
 * produces a new identity and re-arms a single wait.
 */
function creationWaitIdentity(configDir: string): string | null {
  const describe = (name: string): string | null => {
    try {
      const entry = lstatSync(join(configDir, name), { bigint: true });
      return `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? null : `unreadable:${code ?? "unknown"}`;
    }
  };
  const manifest = describe(CONFIG_UNINSTALL_MANIFEST);
  return manifest === null ? null : `${manifest}|${describe(CONFIG_OWNER_FILE)}`;
}

export function listLiveConfigOwnershipRoots(currentConfigDir: string): ReadonlySet<string> {
  const currentRoot = ownershipCacheKey(currentConfigDir);
  const roots = new Set<string>([currentRoot]);
  for (const [root, ownership] of ownershipCache) {
    if (root === currentRoot) continue;
    if (ownership?.manifest.paths.some(rel => existsSync(join(root, ...rel.split("/"))))) {
      roots.add(root);
    }
  }
  return roots;
}

export function reconcileConfigOwnershipRoots(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const [root, ownership] of ownershipCache) {
    if (context.configRoots.has(root)) continue;
    const hasLiveOwnedPath = ownership?.manifest.paths.some(rel =>
      existsSync(join(root, ...rel.split("/"))));
    if (hasLiveOwnedPath) continue;
    ownershipCache.delete(root);
    expiredCreationWait.delete(root);
    removed += 1;
  }
  lastReconciledGeneration = context.generation;
  return removed;
}

function ownershipCacheKey(configDir: string): string {
  const key = resolve(configDir);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function readBoundedJson(path: string, maxBytes = METADATA_MAX_BYTES): unknown {
  return readBoundedJsonSized(path, maxBytes).value;
}

function readBoundedJsonSized(path: string, maxBytes: number): { value: unknown; size: number } {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("ownership metadata is not a regular file");
  }
  // Size first, so an oversized file is refused before it is read; the read is rechecked for a
  // file that grew in between.
  if (metadata.size > maxBytes) throw new Error("ownership metadata is too large");
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw new Error("ownership metadata is too large");
  return { value: JSON.parse(bytes.toString("utf8")) as unknown, size: bytes.length };
}

function isOwner(value: unknown): value is ConfigOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.version === 1
    && typeof owner.ownerId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.ownerId)
    && typeof owner.root === "string";
}

function isManifest(value: unknown): value is ConfigUninstallManifest {
  if (!isOwner(value)) return false;
  const { paths, uninstallStartedAt } = value as Record<string, unknown>;
  return Array.isArray(paths)
    && paths.length <= MANIFEST_MAX_PATHS + (uninstallStartedAt === undefined ? 0 : RECOVERY_RESERVE_PATHS)
    && paths.every(path => typeof path === "string")
    && (uninstallStartedAt === undefined || Number.isSafeInteger(uninstallStartedAt));
}

function canonicalRoot(configDir: string): string {
  return realpathSync.native(resolve(configDir));
}

function manifestRelativePath(configDir: string, candidatePath: string): string | null {
  const root = resolve(configDir);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  if (
    !rel
    || rel === ".."
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) return null;
  const normalized = rel.split(sep).join("/");
  if (normalized.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
    return null;
  }
  if (normalized === CONFIG_OWNER_FILE || normalized === CONFIG_UNINSTALL_MANIFEST) return null;
  if (normalized === CONFIG_OWNERSHIP_LOCK || OWNERSHIP_LOCK_SIDECARS.some(suffix => normalized === `${CONFIG_OWNERSHIP_LOCK}${suffix}`)) {
    return null;
  }
  return normalized;
}

function loadOwnership(configDir: string): { owner: ConfigOwner; manifest: ConfigUninstallManifest } | null {
  const ownerPath = join(configDir, CONFIG_OWNER_FILE);
  const manifestPath = join(configDir, CONFIG_UNINSTALL_MANIFEST);
  if (!existsSync(ownerPath) || !existsSync(manifestPath)) return null;
  try {
    const owner = readBoundedJson(ownerPath);
    // A tombstoned manifest may use the reserve: a home written by an older version can hold a
    // manifest up to the limit, and uninstall must still resume after adding its tombstone.
    const read = readBoundedJsonSized(manifestPath, TOMBSTONED_MANIFEST_MAX_BYTES);
    const manifest = read.value;
    if (isManifest(manifest) && manifest.uninstallStartedAt === undefined && read.size > METADATA_MAX_BYTES) return null;
    const root = canonicalRoot(configDir);
    if (
      !isOwner(owner)
      || !isManifest(manifest)
      || owner.ownerId !== manifest.ownerId
      || !samePath(owner.root, root)
      || !samePath(manifest.root, root)
    ) return null;
    return { owner, manifest };
  } catch {
    return null;
  }
}

function createOwnership(configDir: string): { owner: ConfigOwner; manifest: ConfigUninstallManifest } | null {
  const rootStat = lstatSync(configDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || readdirSync(configDir).length !== 0) return null;
  const owner: ConfigOwner = {
    version: 1,
    ownerId: randomUUID(),
    root: canonicalRoot(configDir),
  };
  const manifest: ConfigUninstallManifest = { ...owner, paths: [...INITIAL_OWNED_PATHS] };
  // Manifest first, owner marker second; uninstall deletes them in the reverse order (owner marker,
  // then manifest). Both leave a manifest without an owner marker in between, told apart by the
  // tombstone: creation's manifest never carries one, so a home still being created is never
  // mistaken for a stopped uninstall.
  writeFileSync(join(configDir, CONFIG_UNINSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    writeFileSync(join(configDir, CONFIG_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    try { unlinkSync(join(configDir, CONFIG_UNINSTALL_MANIFEST)); } catch { /* incomplete metadata fails closed */ }
    throw error;
  }
  return { owner, manifest };
}

/** Temporary names `writeManifest` uses; one left behind means a write stopped before its rename. */
const MANIFEST_TEMP_PATTERN = new RegExp(`^${CONFIG_UNINSTALL_MANIFEST.replace(/\./g, "\\.")}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`);

/**
 * Under the lock no manifest write is in progress, so such a temporary file is abandoned. It is
 * removed only when its content shows `writeManifest` wrote it for this home: a manifest carrying
 * this home's random owner id and root. Any other file with a matching name, a truncated write
 * included, is kept, and uninstall reports it as a residual path.
 */
function removeAbandonedMetadataTemps(configDir: string, owner: ConfigOwner): void {
  for (const name of readdirSync(configDir)) {
    if (!MANIFEST_TEMP_PATTERN.test(name)) continue;
    const path = join(configDir, name);
    let content: unknown;
    try { content = readBoundedJson(path, TOMBSTONED_MANIFEST_MAX_BYTES); } catch { continue; }
    if (!isManifest(content) || content.ownerId !== owner.ownerId || !samePath(content.root, owner.root)) continue;
    unlinkSync(path);
  }
}

/** Room the `uninstallStartedAt` tombstone needs on top of a registration's manifest. */
const TOMBSTONE_RESERVE_BYTES = 64;
/** Largest manifest uninstall accepts once tombstoned: the tombstone and the recovery reserve on top. */
const TOMBSTONED_MANIFEST_MAX_BYTES = METADATA_MAX_BYTES + TOMBSTONE_RESERVE_BYTES + RECOVERY_RESERVE_BYTES;

function serializeManifest(manifest: ConfigUninstallManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function writeManifest(configDir: string, manifest: ConfigUninstallManifest): void {
  const path = join(configDir, CONFIG_UNINSTALL_MANIFEST);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, serializeManifest(manifest), { encoding: "utf8", mode: 0o600 });
  try {
    // Same Windows sharing-violation tolerance the config writer has: a
    // scanner holding the manifest must not turn uninstall bookkeeping into a
    // hard failure.
    renameAtomicFile(temp, path, undefined, "config-ownership");
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function fileIdentity(path: string): string {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) {
    throw new ConfigOwnershipLockError("config ownership lock is not a single-link regular file");
  }
  return `${entry.dev}:${entry.ino}`;
}

/**
 * Run `run` while holding the ownership lock. Callers create ownership metadata first: the lock
 * file is never created in a root that has none, so a refused uninstall of a legacy home leaves it
 * untouched. Returns `undefined` without running `run` when the root disappeared, which only
 * happens once an uninstall has finished.
 */
function withOwnershipLock<T>(configDir: string, run: () => T): { value: T } | undefined {
  const path = join(configDir, CONFIG_OWNERSHIP_LOCK);
  const ownerPath = join(configDir, CONFIG_OWNER_FILE);
  const manifestPath = join(configDir, CONFIG_UNINSTALL_MANIFEST);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Never lock (and so never create the lock file in) a root without ownership metadata. A
    // tombstoned manifest alone is an uninstall that stopped after deleting the owner marker.
    if (!existsSync(ownerPath) && !existsSync(manifestPath)) return undefined;
    try {
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (code !== "EEXIST") throw error;
    }
    let before: string;
    try { before = fileIdentity(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let database: Database | undefined;
    try {
      database = new Database(path, { create: false, readwrite: true });
      acquireImmediate(database);
    } catch (cause) {
      try { database?.close(); } catch { /* acquisition already failed */ }
      // A waiter whose lock file was unlinked by a finishing uninstall fails on the stale handle
      // (macOS reports SQLITE_IOERR_VNODE); it retries against whatever the path names now.
      if (lockFileChanged(path, before)) continue;
      const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code?: unknown }).code) : "";
      throw new ConfigOwnershipLockError(
        code === "SQLITE_BUSY" ? "config ownership metadata is busy in another opencodex process" : "could not lock config ownership metadata",
        { cause },
      );
    }
    try {
      // Uninstall unlinks the lock file last; a waiter that locked the unlinked file retries.
      if (lockFileChanged(path, before)) continue;
      return { value: run() };
    } finally {
      // A holder that finds the metadata gone (a finished uninstall) retires the lock it held, and
      // only that file: a new installation may already have created its own lock at the same path.
      // It unlinks the file while still holding it, so a process that takes the old file afterwards
      // sees the path change and retries instead of working beside a new installation's lock.
      // Windows refuses to delete a file any handle has open, this one included, so there the
      // unlink is retried after release and succeeds only when no other process has the file open.
      const finished = !existsSync(ownerPath) && !existsSync(manifestPath);
      const retired = !finished || unlinkLockFile(path, before);
      if (finished && retired) uninstallStepHookForTests?.("lock-retired");
      try { database.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
      try { database.close(); } catch { /* the OS lock is released with the handle */ }
      if (!retired) unlinkLockFile(path, before);
      if (finished) removeEmptyLockSidecars(configDir);
    }
  }
  throw new ConfigOwnershipLockError("config ownership lock kept changing while it was acquired");
}

function lockFileChanged(path: string, before: string): boolean {
  try { return fileIdentity(path) !== before; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/**
 * `BEGIN IMMEDIATE` with SQLite's own busy wait off, retried only briefly. A registration's section
 * under the lock is a few file operations, so a cooperating holder usually releases within
 * milliseconds. The retry is synchronous: while another process holds the lock (a paused holder, or
 * an uninstall removing files) it blocks the calling thread for at most
 * {@link OWNERSHIP_LOCK_WAIT_MS}, then throws, and the caller reports the registration or uninstall
 * as busy.
 */
function acquireImmediate(database: Database): void {
  database.exec("PRAGMA busy_timeout = 0");
  const deadline = Date.now() + OWNERSHIP_LOCK_WAIT_MS;
  for (;;) {
    try {
      database.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
      Bun.sleepSync(2);
    }
  }
}

/**
 * Unlink the lock file `before` identifies; a file another installation put at the path is left
 * alone. True once the path no longer names that file.
 */
function unlinkLockFile(path: string, before: string): boolean {
  try {
    if (lockFileChanged(path, before)) return true;
    unlinkSync(path);
    return true;
  } catch {
    return false; // uninstall reports what remains
  }
}

/**
 * Remove the lock's SQLite sidecars once released. SQLite deletes the journal its own transaction
 * created when that transaction ends, and the lock never writes data, so a sidecar this module left
 * is empty. A sidecar name holding data, or a link, is not provably ours: it stays and uninstall
 * reports it.
 */
function removeEmptyLockSidecars(configDir: string): void {
  for (const suffix of OWNERSHIP_LOCK_SIDECARS) {
    const path = join(configDir, `${CONFIG_OWNERSHIP_LOCK}${suffix}`);
    try {
      const entry = lstatSync(path);
      if (entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size === 0) unlinkSync(path);
    } catch { /* absent, or uninstall reports it */ }
  }
}

/** Initialize only an empty or already-owned root; do not claim a candidate path. */
export function initializeConfigOwnership(configDir: string): boolean {
  const cacheKey = ownershipCacheKey(configDir);
  if (!existsSync(configDir)) {
    ownershipCache.delete(cacheKey);
    expiredCreationWait.delete(cacheKey);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  let ownership = ownershipCache.get(cacheKey);
  if (ownership === undefined || ownership === null) {
    // A previously unowned home can enter creation later; use the same bounded publication wait,
    // but spend it at most once per unchanged metadata pair. A manifest left without a valid
    // owner marker — a stopped creation, or a corrupt marker — is not a creation still in
    // progress, and registrations run on the request path: charging each of them the full wait
    // stalls every request to that home. Either file changing re-arms a single wait.
    const observed = creationWaitIdentity(configDir);
    if (observed !== null && expiredCreationWait.get(cacheKey) === observed) {
      // A spent wait suppresses only the wait itself, never the reload: the identity it keeps
      // may already name a completed pair. One plain load stays cheap for an unchanged invalid
      // pair and lets a valid one register instead of sticking unowned.
      ownership = loadOwnership(configDir);
      if (ownership !== null) expiredCreationWait.delete(cacheKey);
    } else {
      ownership = loadOrCreateOwnership(configDir);
      const current = creationWaitIdentity(configDir);
      // Record only the identity the wait actually ran out on: unchanged across it, so its last
      // failed read describes the same state. A pair that changed during the wait, including one
      // that completed just after that read, spends its own wait on the next registration.
      if (ownership === null && current !== null && current === observed) expiredCreationWait.set(cacheKey, current);
      else expiredCreationWait.delete(cacheKey);
    }
    ownershipCache.set(cacheKey, ownership);
  }
  return ownership !== null;
}

/**
 * The metadata of an uninstall that stopped after deleting the owner marker: a valid, tombstoned
 * manifest for this root and no owner marker. Uninstall deletes the owner marker first and the
 * manifest last, so this state carries the owner id, the root and the exact snapshot. Creation
 * writes an untombstoned manifest first, so it never looks like this.
 */
function tombstonedManifestWithoutOwner(configDir: string): { owner: ConfigOwner; manifest: ConfigUninstallManifest } | null {
  if (existsSync(join(configDir, CONFIG_OWNER_FILE))) return null;
  const path = join(configDir, CONFIG_UNINSTALL_MANIFEST);
  if (!existsSync(path)) return null;
  try {
    const manifest = readBoundedJsonSized(path, TOMBSTONED_MANIFEST_MAX_BYTES).value;
    if (!isManifest(manifest) || manifest.uninstallStartedAt === undefined || !samePath(manifest.root, canonicalRoot(configDir))) return null;
    return { owner: { version: 1, ownerId: manifest.ownerId, root: manifest.root }, manifest };
  } catch {
    return null;
  }
}

/** Ownership for uninstall: the usual pair, or the tombstoned manifest a stopped uninstall left. */
function loadOwnershipForUninstall(configDir: string): { owner: ConfigOwner; manifest: ConfigUninstallManifest } | null {
  return loadOwnership(configDir) ?? tombstonedManifestWithoutOwner(configDir);
}

/** How long an uncached or unowned registration waits for another process creating the same home. */
const CONCURRENT_CREATION_WAIT_MS = 100;

/**
 * Load the ownership metadata, or create it in an empty root. Two processes can start on the same
 * absent home: the loser of the exclusive manifest write, or one that sees the manifest before the
 * complete owner marker (creation writes them in that order), waits briefly and loads the winner's metadata
 * instead of caching the home as unowned for the rest of its life.
 */
function loadOrCreateOwnership(configDir: string): { owner: ConfigOwner; manifest: ConfigUninstallManifest } | null {
  const deadline = Date.now() + CONCURRENT_CREATION_WAIT_MS;
  for (;;) {
    const loaded = loadOwnership(configDir);
    if (loaded) return loaded;
    try {
      const created = createOwnership(configDir);
      if (created) return created;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Exclusive create publishes the owner file name before its JSON bytes are complete.
    // Only a valid matching pair proves ownership; file presence alone must not end this wait.
    const creating = existsSync(join(configDir, CONFIG_UNINSTALL_MANIFEST))
      && !tombstonedManifestWithoutOwner(configDir);
    if (!creating || Date.now() >= deadline) return loadOwnership(configDir);
    Bun.sleepSync(5);
  }
}

type RecordOutcome = {
  ownership: { owner: ConfigOwner; manifest: ConfigUninstallManifest };
  recorded: boolean;
  identity: string | undefined;
};

/** What a registration did: recorded the path, found no ownership to record it in, or found the manifest full. */
export type OwnedPathRegistration = "recorded" | "unowned" | "full";

export function recordOwnedConfigPath(configDir: string, candidatePath: string): boolean {
  return registerOwnedConfigPath(configDir, candidatePath) === "recorded";
}

/**
 * Read-only: whether the manifest lists `candidatePath` or one of its ancestors ("listed"), lists
 * neither ("unlisted"), or the home has no ownership metadata ("unowned"). Writes nothing; throws
 * {@link ConfigUninstallInProgressError} under an uninstall tombstone, as a registration would.
 */
export function configPathOwnership(configDir: string, candidatePath: string): "listed" | "unlisted" | "unowned" {
  const current = loadOwnership(configDir) ?? tombstonedManifestWithoutOwner(configDir);
  if (!current) return "unowned";
  if (current.manifest.uninstallStartedAt !== undefined && teardownDepth === 0) throw new ConfigUninstallInProgressError();
  const parts = manifestRelativePath(configDir, candidatePath)?.split("/") ?? [];
  return parts.some((_, index) => current.manifest.paths.includes(parts.slice(0, index + 1).join("/"))) ? "listed" : "unlisted";
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * {@link recordOwnedConfigPath} with the reason a path was not recorded, for callers that must tell
 * an unowned home (keep working as before) from an owned home whose manifest is full (whatever they
 * create there survives uninstall).
 */
export function registerOwnedConfigPath(configDir: string, candidatePath: string): OwnedPathRegistration {
  const rel = manifestRelativePath(configDir, candidatePath);
  if (!rel) return "unowned";
  const cacheKey = ownershipCacheKey(configDir);
  if (initializeConfigOwnership(configDir)) {
    const ownership = ownershipCache.get(cacheKey);
    if (!ownership) return "unowned";
    if (ownership.manifest.paths.includes(rel)) {
      const seen = lockedManifestIdentity.get(cacheKey);
      if (seen !== undefined && seen === manifestIdentity(configDir)) return "recorded";
    }
  } else if (!tombstonedManifestWithoutOwner(configDir)) {
    return "unowned";
  } else if (teardownDepth === 0) {
    // Between uninstall's two final unlinks only the tombstoned manifest remains. That is an
    // uninstall finishing (or stopped there), not an unowned home.
    throw new ConfigUninstallInProgressError();
  }
  // Read-modify-write against the manifest on disk, never the cache: another process may have
  // recorded paths or started an uninstall since this one cached it (#8093).
  let locked: { value: RecordOutcome | null } | undefined;
  try {
    locked = withOwnershipLock(configDir, (): RecordOutcome | null => {
      let current = loadOwnership(configDir);
      if (!current) {
        // A process that cached the ownership before uninstall deleted the owner marker lands here.
        const stopped = tombstonedManifestWithoutOwner(configDir);
        if (!stopped) return null;
        if (teardownDepth === 0) throw new ConfigUninstallInProgressError();
        current = stopped;
      }
      const tombstoned = current.manifest.uninstallStartedAt !== undefined;
      if (tombstoned && teardownDepth === 0) throw new ConfigUninstallInProgressError();
      if (current.manifest.paths.includes(rel)) return { ownership: current, recorded: true, identity: manifestIdentity(configDir) };
      // Under a tombstone only this process's own uninstall rerun registers: it records a path it is
      // about to create, so its remover takes that path too, and never adopts an existing entry the
      // snapshot does not list (with or without the owner marker).
      if (tombstoned && entryExists(join(configDir, ...rel.split("/")))) return null;
      const manifest = { ...current.manifest, paths: [...current.manifest.paths, rel].sort() };
      // A manifest over either cap would fail validation and strand every recorded path. The byte
      // check leaves room for the tombstone uninstall adds later. Under the tombstone, an initially
      // owned name may use the recovery reserve instead.
      const bytes = Buffer.byteLength(serializeManifest(manifest));
      const withinCaps = manifest.paths.length <= MANIFEST_MAX_PATHS && bytes + TOMBSTONE_RESERVE_BYTES <= METADATA_MAX_BYTES;
      const withinRecovery = tombstoned && (INITIAL_OWNED_PATHS as readonly string[]).includes(rel)
        && manifest.paths.length <= MANIFEST_MAX_PATHS + RECOVERY_RESERVE_PATHS && bytes <= TOMBSTONED_MANIFEST_MAX_BYTES;
      if (!withinCaps && !withinRecovery) {
        return { ownership: current, recorded: false, identity: manifestIdentity(configDir) };
      }
      writeManifest(configDir, manifest);
      return { ownership: { owner: current.owner, manifest }, recorded: true, identity: manifestIdentity(configDir) };
    });
  } catch (error) {
    if (!(error instanceof ConfigOwnershipLockError)) throw error;
    // A busy lock blocks nothing for a path the manifest already lists. The manifest is replaced
    // atomically, so an unlocked read is a consistent version: accept the path unless that version
    // carries an uninstall tombstone. Only a new path needs the lock, and it still fails here.
    const current = loadOwnership(configDir) ?? tombstonedManifestWithoutOwner(configDir);
    if (current?.manifest.uninstallStartedAt !== undefined && teardownDepth === 0) throw new ConfigUninstallInProgressError();
    if (current?.manifest.paths.includes(rel)) return "recorded";
    throw error;
  }
  if (!locked?.value) {
    ownershipCache.delete(cacheKey);
    lockedManifestIdentity.delete(cacheKey);
    return "unowned";
  }
  // A tombstoned manifest is never cached or remembered for the fast path: only the teardown scope
  // may register under it, and once that scope ends every call must see the tombstone again.
  if (locked.value.ownership.manifest.uninstallStartedAt !== undefined) {
    ownershipCache.delete(cacheKey);
    lockedManifestIdentity.delete(cacheKey);
  } else {
    ownershipCache.set(cacheKey, locked.value.ownership);
    if (locked.value.identity === undefined) lockedManifestIdentity.delete(cacheKey);
    else lockedManifestIdentity.set(cacheKey, locked.value.identity);
  }
  if (!locked.value.recorded && !warnedFullManifest.has(cacheKey)) {
    warnedFullManifest.add(cacheKey);
    // Uninstall still reports such a file as a residual path; it just cannot remove it.
    console.warn("[opencodex] The config ownership manifest is full; new files will not be removed by uninstall.");
  }
  return locked.value.recorded ? "recorded" : "full";
}

/**
 * What a finished uninstall can leave when a lock file could not be unlinked (Windows keeps a file
 * another process holds open): nothing but this module's lock files. Without ownership metadata
 * nothing proves where such a name came from, so only files that hold no data qualify: the lock is
 * a SQLite transaction that never writes, so its file and any sidecar stay empty. The main lock file
 * must be among them, and each one is a single-link regular file. Anything else is refused untouched.
 */
function onlyOwnershipLockFilesRemain(configDir: string): boolean {
  const names = readdirSync(configDir);
  const lockNames = new Set([CONFIG_OWNERSHIP_LOCK, ...OWNERSHIP_LOCK_SIDECARS.map(suffix => `${CONFIG_OWNERSHIP_LOCK}${suffix}`)]);
  return names.includes(CONFIG_OWNERSHIP_LOCK) && names.every(name => {
    if (!lockNames.has(name)) return false;
    const entry = lstatSync(join(configDir, name));
    return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size === 0;
  });
}

/** Remove leftover lock files only if no other process holds the lock (an uninstall still finishing). */
function removeIdleLockFiles(configDir: string): "removed" | "busy" {
  const path = join(configDir, CONFIG_OWNERSHIP_LOCK);
  const before = fileIdentity(path);
  const database = new Database(path, { create: false, readwrite: true });
  try {
    acquireImmediate(database);
  } catch (error) {
    try { database.close(); } catch { /* acquisition already failed */ }
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "SQLITE_BUSY") return "busy";
    throw error;
  }
  let same: boolean;
  try {
    same = !lockFileChanged(path, before);
  } finally {
    try { database.exec("ROLLBACK"); } catch { /* close releases it */ }
    database.close();
  }
  // Taking the lock proved no process holds it. The files are checked again only after release,
  // because while held SQLite keeps this transaction's own rollback journal beside the lock file and
  // deletes it when the transaction ends. Nothing else takes the lock in between: without ownership
  // metadata no registration locks this root, creation never claims a nonempty one, and a second run
  // of this cleanup removes the same files.
  if (!same || !onlyOwnershipLockFilesRemain(configDir)) return "busy";
  if (!unlinkLockFile(path, before)) throw new Error("the ownership lock file could not be removed");
  removeEmptyLockSidecars(configDir);
  return "removed";
}

/** The elevated-run check; null when the run is not elevated. */
function privilegeCheck(configDir: string): { refusal: string | null } | null {
  if (!uninstallRunsElevated()) return null;
  return { refusal: elevatedRemovalRefusal(configDir) };
}

/**
 * Read-only check `ocx uninstall` runs before its first teardown step: the reason an elevated run
 * must not touch this home, or null. The remover repeats it before taking the lock.
 */
export function uninstallPrivilegeRefusal(configDir: string): string | null {
  return privilegeCheck(configDir)?.refusal ?? null;
}

export function removeOwnedConfigState(configDir: string): ConfigRemovalResult {
  ownershipCache.delete(ownershipCacheKey(configDir));
  lockedManifestIdentity.delete(ownershipCacheKey(configDir));
  if (!existsSync(configDir)) return { status: "absent", residualPaths: [] };
  const root = lstatSync(configDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return {
      status: "refused",
      reason: "config ownership root is not a real directory",
      residualPaths: [configDir],
    };
  }
  // Everything below works on the canonical root, resolved once here, so no later step goes back
  // through the spelling the caller passed. Residual paths are reported in that spelling.
  let canonical: string;
  let identity: RootIdentity;
  try {
    canonical = canonicalRoot(configDir);
    identity = rootIdentity(canonical);
  } catch {
    return { status: "refused", reason: "config ownership root is not a real directory", residualPaths: [configDir] };
  }
  const result = removeCanonicalOwnedConfigState(canonical, identity);
  return { ...result, residualPaths: result.residualPaths.map(path => callerSpelling(path, canonical, configDir)) };
}

function callerSpelling(path: string, canonical: string, configDir: string): string {
  if (path === canonical) return configDir;
  const rel = relative(canonical, path);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? join(configDir, rel) : path;
}

function removeCanonicalOwnedConfigState(configDir: string, identity: RootIdentity): ConfigRemovalResult {
  // `configDir` is the canonical root resolved once by the caller, and `identity` the directory it
  // named then. It is never resolved again: each step below that acts on it first confirms it is still
  // that directory, a real one resolving to itself. A change before anything is written is refused;
  // one found later ends the run partial, and the tombstone lets a rerun finish.
  const rootChanged: ConfigRemovalResult = {
    status: "refused",
    reason: "the config directory changed while uninstall ran; run 'ocx uninstall' again",
    residualPaths: [configDir],
  };
  const rootMoved: ConfigRemovalResult = {
    status: "partial",
    reason: "the config directory changed while uninstall ran; run 'ocx uninstall' again",
    residualPaths: [configDir],
  };
  ownershipCache.delete(ownershipCacheKey(configDir));
  lockedManifestIdentity.delete(ownershipCacheKey(configDir));
  // Before the lock exists or anything is written, so a refused elevated run changes nothing.
  const privilege = privilegeCheck(configDir);
  if (privilege?.refusal) return { status: "refused", reason: privilege.refusal, residualPaths: [configDir] };
  if (!canonicalRootUnchanged(configDir, identity)) return rootChanged;
  if (!loadOwnershipForUninstall(configDir)) {
    // A finished uninstall whose lock file could not be unlinked (Windows keeps a file another
    // process holds open) leaves only lock files. They are removed once no process holds the lock.
    if (onlyOwnershipLockFilesRemain(configDir)) {
      try {
        if (removeIdleLockFiles(configDir) === "busy") {
          return { status: "refused", reason: "another opencodex process holds the ownership lock; retry shortly", residualPaths: [configDir] };
        }
        rmdirSync(configDir);
        return { status: "removed", residualPaths: [] };
      } catch (error) {
        return {
          status: "partial",
          reason: `could not remove the ownership lock: ${error instanceof Error ? error.message : String(error)}`,
          residualPaths: readdirSync(configDir).map(name => join(configDir, name)),
        };
      }
    }
    return {
      status: "refused",
      reason: "config ownership metadata is missing or invalid",
      residualPaths: [configDir],
    };
  }

  // One lock hold covers the whole run: validate, tombstone, snapshot, remove the snapshot, delete
  // the owner marker and then the manifest. While it is held no other process can record a path (a
  // listed path read without the lock sees the tombstone and refuses, a new path needs the lock),
  // and a second uninstall is refused as busy, so nothing can be recorded or recreated behind this
  // run. A run interrupted at any point leaves the tombstoned manifest, which carries the owner id,
  // the root and the exact snapshot, so a rerun finishes from it.
  let outcome: ConfigRemovalResult;
  try {
    const locked = withOwnershipLock(configDir, (): ConfigRemovalResult => {
      const ownership = loadOwnershipForUninstall(configDir);
      if (!ownership) {
        return { status: "refused", reason: "config ownership metadata is missing or invalid", residualPaths: [configDir] };
      }
      for (const rel of ownership.manifest.paths) {
        if (manifestRelativePath(configDir, join(configDir, ...rel.split("/"))) !== rel) {
          return { status: "refused", reason: "config ownership manifest contains an unsafe path", residualPaths: [configDir] };
        }
      }
      // Checked again under the lock and before the tombstone: the manifest, ownership, modes and the
      // tree may all have changed since the unlocked check.
      const lockedRefusal = privilege ? elevatedRemovalRefusal(configDir) : null;
      if (lockedRefusal) return { status: "refused", reason: lockedRefusal, residualPaths: [configDir] };
      if (!canonicalRootUnchanged(configDir, identity)) return rootChanged;
      if (ownership.manifest.uninstallStartedAt === undefined) {
        writeManifest(configDir, { ...ownership.manifest, uninstallStartedAt: Date.now() });
      }
      if (!canonicalRootUnchanged(configDir, identity)) return rootMoved;
      removeAbandonedMetadataTemps(configDir, ownership.owner);
      const rootPath = configDir;
      const elevatedUid = process.platform !== "win32" && uninstallRunsElevated() ? process.geteuid?.() : undefined;
      for (const rel of ownership.manifest.paths) {
        const parts = rel.split("/");
        const path = join(configDir, ...parts);
        try {
          // lstat-based: a listed symlink whose target is gone is still ours to unlink, and a link on
          // the way to an entry is reported rather than read as absence.
          if (ownedEntryPresent(rootPath, parts)) removeOwnedEntry(rootPath, parts, { elevatedUid, rootIdentity: identity });
        } catch (error) {
          return {
            status: "partial",
            reason: `could not remove owned path ${rel}: ${error instanceof Error ? error.message : String(error)}`,
            residualPaths: [path],
          };
        }
      }
      uninstallStepHookForTests?.("snapshot-removed");
      if (!canonicalRootUnchanged(configDir, identity)) return rootMoved;
      try {
        // Owner marker first, manifest last: until the end the tombstoned manifest stays as the record
        // a rerun resumes from, and creation (manifest first) never leaves that state.
        try { unlinkSync(join(configDir, CONFIG_OWNER_FILE)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        uninstallStepHookForTests?.("owner-deleted");
        unlinkSync(join(configDir, CONFIG_UNINSTALL_MANIFEST));
      } catch (error) {
        return {
          status: "partial",
          reason: `could not remove ownership metadata: ${error instanceof Error ? error.message : String(error)}`,
          residualPaths: readdirSync(configDir).map(name => join(configDir, name)),
        };
      }
      return { status: "removed", residualPaths: [] };
    });
    outcome = locked?.value
      ?? { status: "refused", reason: "config ownership metadata is missing or invalid", residualPaths: [configDir] };
  } catch (error) {
    outcome = {
      status: "refused",
      reason: `could not lock the ownership manifest: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: [configDir],
    };
  }
  if (outcome.status !== "removed") return outcome;
  if (!canonicalRootUnchanged(configDir, identity)) return rootMoved;
  // The lock holder retired its own lock file on release; one that remains (Windows) is reported.
  const residualPaths = readdirSync(configDir).map(name => join(configDir, name));
  if (residualPaths.length > 0) {
    return {
      status: "partial",
      reason: "unowned files remain in the config directory",
      residualPaths,
    };
  }
  try {
    rmdirSync(configDir);
  } catch (error) {
    return {
      status: "partial",
      reason: `could not remove the empty config directory: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: [configDir],
    };
  }
  return { status: "removed", residualPaths: [] };
}
