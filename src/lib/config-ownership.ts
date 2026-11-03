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
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GenerationContext } from "./state-store-sweeper";
import { renameAtomicFile } from "./windows-atomic-replace";

export const CONFIG_OWNER_FILE = ".opencodex-owner.json";
export const CONFIG_UNINSTALL_MANIFEST = ".opencodex-uninstall.json";
/**
 * Paths recorded after home creation (#8093). Each path gets its own record file, named by the
 * hash of the path, so two processes can never erase each other's entry by rewriting one shared
 * manifest from a stale cache. Uninstall reads the base manifest together with these records.
 */
export const CONFIG_UNINSTALL_RECORDS = ".opencodex-uninstall.d";

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
};

const METADATA_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_PATHS = 1024;
const RECORD_MAX_BYTES = 4 * 1024;
const RECORD_SUFFIX = ".path";
// Concurrent first recordings can each pass the cap check, so reading tolerates a small overshoot.
const RECORD_READ_SLACK = 64;
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

function readBoundedJson(path: string): unknown {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("ownership metadata is not a regular file");
  }
  if (metadata.size > METADATA_MAX_BYTES) throw new Error("ownership metadata is too large");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
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
  const paths = (value as Record<string, unknown>).paths;
  return Array.isArray(paths)
    && paths.length <= MANIFEST_MAX_PATHS
    && paths.every(path => typeof path === "string");
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
  if (normalized === CONFIG_UNINSTALL_RECORDS || normalized.startsWith(`${CONFIG_UNINSTALL_RECORDS}/`)) return null;
  return normalized;
}

function recordFileName(rel: string): string {
  return `${createHash("sha256").update(rel, "utf8").digest("hex")}${RECORD_SUFFIX}`;
}

/** The record directory when it is a real directory inside the root; undefined when absent. */
function recordDirectory(configDir: string, create: boolean): string | undefined {
  const path = join(configDir, CONFIG_UNINSTALL_RECORDS);
  if (!existsSync(path) && !create) return undefined;
  if (!existsSync(path)) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !isWithinRoot(canonicalRoot(configDir), realpathSync.native(path))) {
    throw new Error("ownership records are not a real directory inside the config root");
  }
  return path;
}

/** Recorded relative paths; throws on any record that is not exactly what this module writes. */
function readOwnershipRecords(configDir: string): string[] {
  const dir = recordDirectory(configDir, false);
  if (!dir) return [];
  const names = readdirSync(dir).filter(name => name.endsWith(RECORD_SUFFIX));
  if (names.length > MANIFEST_MAX_PATHS + RECORD_READ_SLACK) throw new Error("too many ownership records");
  const paths: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > RECORD_MAX_BYTES) throw new Error("invalid ownership record");
    const rel = readFileSync(path, "utf8");
    if (recordFileName(rel) !== name || manifestRelativePath(configDir, join(configDir, ...rel.split("/"))) !== rel) {
      throw new Error("invalid ownership record");
    }
    paths.push(rel);
  }
  return paths;
}

function loadOwnership(configDir: string): { owner: ConfigOwner; manifest: ConfigUninstallManifest } | null {
  const ownerPath = join(configDir, CONFIG_OWNER_FILE);
  const manifestPath = join(configDir, CONFIG_UNINSTALL_MANIFEST);
  if (!existsSync(ownerPath) || !existsSync(manifestPath)) return null;
  try {
    const owner = readBoundedJson(ownerPath);
    const manifest = readBoundedJson(manifestPath);
    const root = canonicalRoot(configDir);
    if (
      !isOwner(owner)
      || !isManifest(manifest)
      || owner.ownerId !== manifest.ownerId
      || !samePath(owner.root, root)
      || !samePath(manifest.root, root)
    ) return null;
    const paths = [...new Set([...manifest.paths, ...readOwnershipRecords(configDir)])].sort();
    return { owner, manifest: { ...manifest, paths } };
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
  writeFileSync(join(configDir, CONFIG_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    writeFileSync(join(configDir, CONFIG_UNINSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    try { unlinkSync(join(configDir, CONFIG_OWNER_FILE)); } catch { /* incomplete metadata fails closed */ }
    throw error;
  }
  return { owner, manifest };
}

function writeManifest(configDir: string, manifest: ConfigUninstallManifest): void {
  const path = join(configDir, CONFIG_UNINSTALL_MANIFEST);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

/**
 * Publish one record without locks: the content is complete before the atomic rename makes it
 * visible, and a concurrent writer of the same path writes identical bytes under the same name,
 * so a replacement loses nothing. Rename replaces a link at the name instead of following it.
 */
function writeOwnershipRecord(configDir: string, rel: string): boolean {
  let dir: string;
  try {
    dir = recordDirectory(configDir, true)!;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== undefined) throw error;
    // A linked or foreign record directory is never written through.
    console.warn("Config ownership records are not a real directory; a path was not recorded for uninstall.");
    return false;
  }
  const final = join(dir, recordFileName(rel));
  if (!existsSync(final) && readdirSync(dir).filter(name => name.endsWith(RECORD_SUFFIX)).length >= MANIFEST_MAX_PATHS) {
    console.warn("Config ownership records are full; a path was not recorded for uninstall.");
    return false;
  }
  const temp = join(dir, `.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, rel, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    // Same Windows sharing-violation tolerance the config writer has: a scanner holding the
    // record must not turn uninstall bookkeeping into a hard failure.
    renameAtomicFile(temp, final, undefined, "config-ownership");
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
  return true;
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
  if (ownership.manifest.paths.includes(rel)) return true;
  if (!writeOwnershipRecord(configDir, rel)) return false;
  // The record alone makes the path durable. The manifest is also rewritten as the union of what
  // is on disk now, so readers of the manifest file (older versions included) see a complete list
  // whenever no other process is recording at the same moment, and it converges on the next write.
  const current = loadOwnership(configDir);
  const base = current && current.owner.ownerId === ownership.owner.ownerId ? current : ownership;
  const manifest = { ...base.manifest, paths: [...new Set([...base.manifest.paths, rel])].sort() };
  if (manifest.paths.length <= MANIFEST_MAX_PATHS) writeManifest(configDir, manifest);
  ownershipCache.set(cacheKey, { owner: ownership.owner, manifest });
  return true;
}

export function removeOwnedConfigState(configDir: string): ConfigRemovalResult {
  ownershipCache.delete(ownershipCacheKey(configDir));
  if (!existsSync(configDir)) return { status: "absent", residualPaths: [] };
  const root = lstatSync(configDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return {
      status: "refused",
      reason: "config ownership root is not a real directory",
      residualPaths: [configDir],
    };
  }
  const ownership = loadOwnership(configDir);
  if (!ownership) {
    return {
      status: "refused",
      reason: "config ownership metadata is missing or invalid",
      residualPaths: [configDir],
    };
  }

  for (const rel of ownership.manifest.paths) {
    const path = manifestRelativePath(configDir, join(configDir, ...rel.split("/")));
    if (path !== rel) {
      return {
        status: "refused",
        reason: "config ownership manifest contains an unsafe path",
        residualPaths: [configDir],
      };
    }
  }

  const rootPath = canonicalRoot(configDir);
  for (const rel of ownership.manifest.paths) {
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
    // Records go before the manifest, so an interrupted uninstall still has its base list.
    const records = join(configDir, CONFIG_UNINSTALL_RECORDS);
    if (existsSync(records)) removeOwnedEntry(rootPath, records);
    unlinkSync(join(configDir, CONFIG_UNINSTALL_MANIFEST));
    unlinkSync(join(configDir, CONFIG_OWNER_FILE));
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
