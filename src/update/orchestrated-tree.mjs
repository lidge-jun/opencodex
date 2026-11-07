import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyInstallTree } from "./transactional-install.mjs";

/** npm and Bun verification reads the active tree only; retained backup siblings are irrelevant. */
export function verifyOrchestratedInstall(root, version, installer) {
  if (installer !== "npm" && installer !== "bun") return false;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (manifest.version !== version || !manifest.dependencies?.bun || !manifest.dependencies?.zod) return false;
    const source = statSync(join(root, "src", "cli", "index.ts"));
    return source.isFile() && source.size > 0 && verifyInstallTree(root, version).ok;
  } catch { return false; }
}
