import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPnpmGlobalPackage, resolvePnpmGlobalOwner } from "./pnpm-global-install.mjs";
import { verifyPnpmInstallTree } from "./transactional-install.mjs";

const PACKAGE_NAME = "@bitkyc08/opencodex";

const OWNER_PATHS = ["commandPath", "packagePath", "globalDir", "globalRoot", "globalBinDir", "store"];

/** Freeze physical owner paths at observation time; failure to resolve any path refuses the update. */
export function canonicalOrchestratedPnpmOwner(owner) {
  if (!Array.isArray(owner.virtualStoreDirs)) throw new Error("pnpm virtual-store configuration is unpinned");
  return { ...Object.fromEntries(OWNER_PATHS.map(field => [field, realpathSync.native(owner[field])])),
    virtualStoreDirs: owner.virtualStoreDirs.map(path => realpathSync.native(path)) };
}

export function matchesOrchestratedPnpmOwner(expected, owner) {
  if (!expected || !owner) return false;
  try {
    const actual = canonicalOrchestratedPnpmOwner(owner);
    const equal = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    return OWNER_PATHS.every(field => equal(actual[field], expected[field]))
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
    const verify = (path, expected, store, globalRoot) => {
      try {
        const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
        const source = statSync(join(path, "src", "cli", "index.ts"));
        return { ok: manifest.version === expected && Boolean(manifest.dependencies?.bun && manifest.dependencies?.zod)
          && source.isFile() && source.size > 0 && verifyPnpmInstallTree(path, expected, store, globalRoot).ok };
      } catch { return { ok: false }; }
    };
    const resolved = resolvePnpmGlobalOwner({ packageName: PACKAGE_NAME, packagePath: activeRoot,
      commandPaths: [owner.commandPath], runPnpm, verify });
    if (!resolved.ok || key(resolved.owner.globalDir) !== key(owner.globalDir)
      || key(resolved.owner.globalRoot) !== key(owner.globalRoot)
      || key(resolved.owner.globalBinDir) !== key(owner.globalBinDir)
      || key(resolved.owner.store) !== key(owner.store)
      || !Array.isArray(owner.virtualStoreDirs) || !Array.isArray(resolved.owner.virtualStoreDirs)
      || owner.virtualStoreDirs.length !== resolved.owner.virtualStoreDirs.length
      || owner.virtualStoreDirs.some((path, index) => key(path) !== key(resolved.owner.virtualStoreDirs[index]))) return false;
    const active = readPnpmGlobalPackage(PACKAGE_NAME,
      (args, capture) => runPnpm(owner.commandPath, args, capture, owner), verify,
      { owner, expectedPackagePath: activeRoot, expectedGlobalRoot: owner.globalRoot, globalBinDir: owner.globalBinDir });
    return active.ok && active.version === version && key(active.path) === key(activeRoot);
  } catch { return false; }
}
