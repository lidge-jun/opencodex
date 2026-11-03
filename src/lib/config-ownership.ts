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
const OWNERSHIP_LOCK_WAIT_MS = 2_000;

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

function manifestIdentity(configDir: string): string | undefined {
  try {
    const entry = lstatSync(join(configDir, CONFIG_UNINSTALL_MANIFEST), { bigint: true });
    return entry.isFile() ? `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}` : undefined;
  } catch {
    return undefined;
  }
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
    && paths.length <= MANIFEST_MAX_PATHS
    && paths.every(path => typeof path === "string")
    && (uninstallStartedAt === undefined || Number.isSafeInteger(uninstallStartedAt));
}

function canonicalRoot(configDir: string): string {
  return realpathSync.native(resolve(configDir));
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (
    rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
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
    const read = readBoundedJsonSized(manifestPath, METADATA_MAX_BYTES + TOMBSTONE_RESERVE_BYTES);
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
  // Manifest first, owner marker second: the reverse of uninstall's deletion order. A root holding
  // only the owner marker is therefore a stopped uninstall, never an initialization in progress,
  // and leftover recovery cannot remove a home that is still being created.
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

/** Under the lock no manifest write is in progress, so any such temporary file is abandoned. */
function removeAbandonedManifestTemps(configDir: string): void {
  for (const name of readdirSync(configDir)) {
    if (!MANIFEST_TEMP_PATTERN.test(name)) continue;
    const path = join(configDir, name);
    const entry = lstatSync(path);
    if (entry.isFile() && !entry.isSymbolicLink()) unlinkSync(path);
  }
}

/** Room the `uninstallStartedAt` tombstone needs on top of a registration's manifest. */
const TOMBSTONE_RESERVE_BYTES = 64;

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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Never lock (and so never create the lock file in) a root without an owner marker.
    if (!existsSync(ownerPath)) return undefined;
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
      database.exec(`PRAGMA busy_timeout = ${OWNERSHIP_LOCK_WAIT_MS}; BEGIN IMMEDIATE`);
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
      try { database.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
      try { database.close(); } catch { /* the OS lock is released with the handle */ }
      // A holder that finds the metadata gone (a finished uninstall) does not leave the lock behind.
      if (!existsSync(ownerPath)) {
        try { removeOwnershipLockFile(configDir); } catch { /* uninstall reports what remains */ }
      }
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

function removeOwnershipLockFile(configDir: string): void {
  for (const suffix of ["", ...OWNERSHIP_LOCK_SIDECARS]) {
    try { unlinkSync(join(configDir, `${CONFIG_OWNERSHIP_LOCK}${suffix}`)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function removeOwnedEntry(root: string, path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (!entry.isDirectory()) {
    unlinkSync(path);
    return;
  }

  const realDirectory = realpathSync.native(path);
  if (!isWithinRoot(root, realDirectory)) {
    throw new Error(`owned directory resolves outside the config root: ${path}`);
  }
  for (const name of readdirSync(path)) {
    removeOwnedEntry(root, join(path, name));
  }
  rmdirSync(path);
}

/** Initialize only an empty or already-owned root; do not claim a candidate path. */
export function initializeConfigOwnership(configDir: string): boolean {
  const cacheKey = ownershipCacheKey(configDir);
  if (!existsSync(configDir)) {
    ownershipCache.delete(cacheKey);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  let ownership = ownershipCache.get(cacheKey);
  if (ownership === undefined) {
    ownership = loadOwnership(configDir) ?? createOwnership(configDir);
    ownershipCache.set(cacheKey, ownership);
  }
  return ownership !== null;
}

export function recordOwnedConfigPath(configDir: string, candidatePath: string): boolean {
  const rel = manifestRelativePath(configDir, candidatePath);
  if (!rel) return false;
  if (!initializeConfigOwnership(configDir)) return false;
  const cacheKey = ownershipCacheKey(configDir);
  const ownership = ownershipCache.get(cacheKey);
  if (!ownership) return false;
  if (ownership.manifest.paths.includes(rel)) {
    const seen = lockedManifestIdentity.get(cacheKey);
    if (seen !== undefined && seen === manifestIdentity(configDir)) return true;
  }
  // Read-modify-write against the manifest on disk, never the cache: another process may have
  // recorded paths or started an uninstall since this one cached it (#8093).
  const locked = withOwnershipLock(configDir, () => {
    const current = loadOwnership(configDir);
    if (!current) return null;
    if (current.manifest.uninstallStartedAt !== undefined) throw new ConfigUninstallInProgressError();
    if (current.manifest.paths.includes(rel)) return { ownership: current, recorded: true, identity: manifestIdentity(configDir) };
    const manifest = { ...current.manifest, paths: [...current.manifest.paths, rel].sort() };
    // A manifest over either cap would fail validation and strand every recorded path. The byte
    // check leaves room for the tombstone uninstall adds later.
    if (manifest.paths.length > MANIFEST_MAX_PATHS
      || Buffer.byteLength(serializeManifest(manifest)) + TOMBSTONE_RESERVE_BYTES > METADATA_MAX_BYTES) {
      return { ownership: current, recorded: false, identity: manifestIdentity(configDir) };
    }
    writeManifest(configDir, manifest);
    return { ownership: { owner: current.owner, manifest }, recorded: true, identity: manifestIdentity(configDir) };
  });
  if (!locked?.value) {
    ownershipCache.delete(cacheKey);
    lockedManifestIdentity.delete(cacheKey);
    return false;
  }
  ownershipCache.set(cacheKey, locked.value.ownership);
  if (locked.value.identity === undefined) lockedManifestIdentity.delete(cacheKey);
  else lockedManifestIdentity.set(cacheKey, locked.value.identity);
  if (!locked.value.recorded && !warnedFullManifest.has(cacheKey)) {
    warnedFullManifest.add(cacheKey);
    // Uninstall still reports such a file as a residual path; it just cannot remove it.
    console.warn("[opencodex] The config ownership manifest is full; new files will not be removed by uninstall.");
  }
  return locked.value.recorded;
}

/**
 * What uninstall's last step can leave when it stops after deleting the manifest: the owner marker
 * and lock files, and nothing else. Uninstall deletes the manifest first, so its absence means the
 * snapshot was already removed. Windows also keeps a lock file another process holds open.
 */
function onlyOwnershipLeftoversRemain(configDir: string): boolean {
  if (existsSync(join(configDir, CONFIG_UNINSTALL_MANIFEST))) return false;
  const names = readdirSync(configDir);
  const allowed = new Set([CONFIG_OWNER_FILE, CONFIG_OWNERSHIP_LOCK, ...OWNERSHIP_LOCK_SIDECARS.map(suffix => `${CONFIG_OWNERSHIP_LOCK}${suffix}`)]);
  if (names.length === 0 || !names.every(name => allowed.has(name))) return false;
  for (const name of names) {
    const entry = lstatSync(join(configDir, name));
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
  }
  if (!names.includes(CONFIG_OWNER_FILE)) return true;
  try {
    const owner = readBoundedJson(join(configDir, CONFIG_OWNER_FILE));
    return isOwner(owner) && samePath(owner.root, canonicalRoot(configDir));
  } catch {
    return false;
  }
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
  if (!loadOwnership(configDir)) {
    // A rerun after uninstall stopped between deleting the manifest and removing the root: only
    // this module's own marker and lock files remain, so finish the removal.
    if (onlyOwnershipLeftoversRemain(configDir)) {
      try {
        try { unlinkSync(join(configDir, CONFIG_OWNER_FILE)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        removeOwnershipLockFile(configDir);
        rmdirSync(configDir);
        return { status: "removed", residualPaths: [] };
      } catch (error) {
        return {
          status: "partial",
          reason: `could not remove ownership metadata: ${error instanceof Error ? error.message : String(error)}`,
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

  // Under the lock: validate, write the tombstone, snapshot. A registration either committed before
  // this point and is in the snapshot, or it sees the tombstone and refuses. An interrupted
  // uninstall leaves the tombstone in place, so registrations keep refusing until a rerun finishes.
  let snapshot: { paths: string[] } | { refused: string };
  try {
    const locked = withOwnershipLock(configDir, (): { paths: string[] } | { refused: string } => {
      const ownership = loadOwnership(configDir);
      if (!ownership) return { refused: "config ownership metadata is missing or invalid" };
      for (const rel of ownership.manifest.paths) {
        if (manifestRelativePath(configDir, join(configDir, ...rel.split("/"))) !== rel) {
          return { refused: "config ownership manifest contains an unsafe path" };
        }
      }
      if (ownership.manifest.uninstallStartedAt === undefined) {
        writeManifest(configDir, { ...ownership.manifest, uninstallStartedAt: Date.now() });
      }
      removeAbandonedManifestTemps(configDir);
      return { paths: [...ownership.manifest.paths] };
    });
    snapshot = locked?.value ?? { refused: "config ownership metadata is missing or invalid" };
  } catch (error) {
    snapshot = { refused: `could not record uninstall in the ownership manifest: ${error instanceof Error ? error.message : String(error)}` };
  }
  if ("refused" in snapshot) {
    return { status: "refused", reason: snapshot.refused, residualPaths: [configDir] };
  }

  const rootPath = canonicalRoot(configDir);
  for (const rel of snapshot.paths) {
    const path = join(configDir, ...rel.split("/"));
    if (!existsSync(path)) continue;
    try {
      removeOwnedEntry(rootPath, path);
    } catch (error) {
      return {
        status: "partial",
        reason: `could not remove owned path ${rel}: ${error instanceof Error ? error.message : String(error)}`,
        residualPaths: [path],
      };
    }
  }

  try {
    withOwnershipLock(configDir, () => {
      unlinkSync(join(configDir, CONFIG_UNINSTALL_MANIFEST));
      unlinkSync(join(configDir, CONFIG_OWNER_FILE));
    });
    removeOwnershipLockFile(configDir);
  } catch (error) {
    return {
      status: "partial",
      reason: `could not remove ownership metadata: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: readdirSync(configDir).map(name => join(configDir, name)),
    };
  }
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
