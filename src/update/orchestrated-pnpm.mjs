import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPnpmGlobalPackage, resolvePnpmGlobalOwner } from "./pnpm-global-install.mjs";
import { verifyPnpmInstallTree } from "./transactional-install.mjs";

const PACKAGE_NAME = "@bitkyc08/opencodex";

/** Re-resolve the selected pnpm group and verify its active tree and generated shims. */
export function verifyOrchestratedPnpmInstall({ owner, activeRoot, version, runPnpm }) {
  try {
    const key = path => {
      const result = realpathSync.native(path);
      return process.platform === "win32" ? result.toLowerCase() : result;
    };
    const verify = (path, expected) => {
      try {
        const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
        const source = statSync(join(path, "src", "cli", "index.ts"));
        return { ok: manifest.version === expected && Boolean(manifest.dependencies?.bun && manifest.dependencies?.zod)
          && source.isFile() && source.size > 0 && verifyPnpmInstallTree(path, expected).ok };
      } catch { return { ok: false }; }
    };
    const resolved = resolvePnpmGlobalOwner({ packageName: PACKAGE_NAME, packagePath: activeRoot,
      commandPaths: [owner.commandPath], runPnpm, verify });
    if (!resolved.ok || key(resolved.owner.globalDir) !== key(owner.globalDir)
      || key(resolved.owner.globalRoot) !== key(owner.globalRoot)
      || key(resolved.owner.globalBinDir) !== key(owner.globalBinDir)) return false;
    const active = readPnpmGlobalPackage(PACKAGE_NAME,
      (args, capture) => runPnpm(owner.commandPath, args, capture), verify,
      { owner, expectedPackagePath: activeRoot, expectedGlobalRoot: owner.globalRoot, globalBinDir: owner.globalBinDir });
    return active.ok && active.version === version && key(active.path) === key(activeRoot);
  } catch { return false; }
}
