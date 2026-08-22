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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GenerationContext } from "./state-store-sweeper";
import { renameAtomicFile } from "./windows-atomic-replace";

export const CONFIG_OWNER_FILE = ".opencodex-owner.json";
export const CONFIG_UNINSTALL_MANIFEST = ".opencodex-uninstall.json";

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
const INITIAL_OWNED_PATHS = [
  ".star-prompted",
  "artifacts",
  "auth.json",
  "auth.store.lock",
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
  "crash.log",
  "kimi-device-id",
  "mimo-client-id",
  "ocx.pid",
  "opencodex-service-launcher.vbs",
  "opencodex-service-task.xml",
  "opencodex-service.cmd",
  "opencodex-tray-offline.ico",
  "opencodex-tray-online.ico",
  "opencodex-tray-warning.ico",
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
  return normalized;
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

export function recordOwnedConfigPath(configDir: string, candidatePath: string): boolean {
  const rel = manifestRelativePath(configDir, candidatePath);
  if (!rel) return false;
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
  if (!ownership) return false;
  if (ownership.manifest.paths.includes(rel)) return true;
  const manifest = {
    ...ownership.manifest,
    paths: [...ownership.manifest.paths, rel].sort(),
  };
  writeManifest(configDir, manifest);
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
