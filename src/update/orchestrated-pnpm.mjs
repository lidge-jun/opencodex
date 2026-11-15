import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPnpmGlobalPackage, resolvePnpmGlobalOwner } from "./pnpm-global-install.mjs";
import { verifyPnpmInstallTree } from "./transactional-install.mjs";

const PACKAGE_NAME = "@bitkyc08/opencodex";

const OWNER_PATHS = ["commandPath", "packagePath", "globalDir", "globalRoot", "globalBinDir"];

/**
 * Freeze physical owner paths at observation time; failure to resolve any path refuses the update.
 * A global-store owner also carries its canonical store, lexical store path and virtual-store
 * directories; a legacy group carries none of them.
 */
export function canonicalOrchestratedPnpmOwner(owner) {
  const base = Object.fromEntries(OWNER_PATHS.map(field => [field, realpathSync.native(owner[field])]));
  if (!owner.globalStore) {
    if (owner.store !== undefined || owner.storePath !== undefined) throw new Error("pnpm legacy owner carries a store");
    return base;
  }
  if (!Array.isArray(owner.virtualStoreDirs)) throw new Error("pnpm virtual-store configuration is unpinned");
  const storePath = resolve(owner.storePath);
  const store = realpathSync.native(owner.store);
  if (realpathSync.native(storePath) !== store) throw new Error("pnpm store path changed");
  return { ...base, store, storePath,
    virtualStoreDirs: owner.virtualStoreDirs.map(path => realpathSync.native(path)) };
}

export function matchesOrchestratedPnpmOwner(expected, owner) {
  if (!expected || !owner) return false;
  try {
    const actual = canonicalOrchestratedPnpmOwner(owner);
    const equal = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    if (!OWNER_PATHS.every(field => equal(actual[field], expected[field]))) return false;
    if ((expected.store === undefined) !== (actual.store === undefined)) return false;
    if (actual.store === undefined) return true;
    return equal(actual.store, expected.store)
      && equal(actual.storePath, expected.storePath)
      && Array.isArray(expected.virtualStoreDirs) && actual.virtualStoreDirs.length === expected.virtualStoreDirs.length
      && actual.virtualStoreDirs.every((path, index) => equal(path, expected.virtualStoreDirs[index]));
  } catch { return false; }
}

/** Re-resolve the selected pnpm group and verify its active tree and generated shims. */
export function verifyOrchestratedPnpmInstall({ owner, activeRoot, version, runPnpm }) {
  try {
    const key = path => {
      const result = realpathSync.native(path);
      return process.platform === "win32" ? result.toLowerCase() : result;
    };
    // The lexical store path is compared without following links, folded like matchesOrchestratedPnpmOwner.
    const lexicalKey = path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    const verify = (path, expected, store, globalRoot, lexicalStore) => {
      try {
        const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
        const source = statSync(join(path, "src", "cli", "index.ts"));
        return { ok: manifest.version === expected && Boolean(manifest.dependencies?.bun && manifest.dependencies?.zod)
          && source.isFile() && source.size > 0 && verifyPnpmInstallTree(path, expected, store, globalRoot, lexicalStore).ok };
      } catch { return { ok: false }; }
    };
    const resolved = resolvePnpmGlobalOwner({ packageName: PACKAGE_NAME, packagePath: activeRoot,
      commandPaths: [owner.commandPath], runPnpm, verify, requireStoreProof: owner.globalStore === true });
    if (!resolved.ok || key(resolved.owner.globalDir) !== key(owner.globalDir)
      || key(resolved.owner.globalRoot) !== key(owner.globalRoot)
      || key(resolved.owner.globalBinDir) !== key(owner.globalBinDir)
      || Boolean(resolved.owner.globalStore) !== Boolean(owner.globalStore)) return false;
    if (owner.globalStore && (key(resolved.owner.store) !== key(owner.store)
      || lexicalKey(resolved.owner.storePath) !== lexicalKey(owner.storePath)
      || !Array.isArray(owner.virtualStoreDirs) || !Array.isArray(resolved.owner.virtualStoreDirs)
      || owner.virtualStoreDirs.length !== resolved.owner.virtualStoreDirs.length
      || owner.virtualStoreDirs.some((path, index) => key(path) !== key(resolved.owner.virtualStoreDirs[index])))) return false;
    const active = readPnpmGlobalPackage(PACKAGE_NAME,
      (args, capture) => runPnpm(owner.commandPath, args, capture, owner), verify,
      { owner, expectedPackagePath: activeRoot, expectedGlobalRoot: owner.globalRoot, globalBinDir: owner.globalBinDir });
    return active.ok && active.version === version && key(active.path) === key(activeRoot);
  } catch { return false; }
}
