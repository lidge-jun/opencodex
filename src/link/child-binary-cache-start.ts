import { lstatSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { ConfigUninstallInProgressError, configPathOwnership, registerOwnedConfigPath } from "../lib/config-ownership";
import { packageVersion } from "../lib/package-version";
import { fillChildBinaryCacheOnStart, type ChildCacheClaimRefusal, type ChildCacheFillOptions, type ChildCacheFillOutcome } from "./child-binary-cache-fill.mjs";

function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

/**
 * Claims for uninstall only what the fill is about to create, never what is already there: cache/ when
 * it is absent, else cache/ocx-child when that is absent. An existing cache/ocx-child the manifest does
 * not list is an operator's (the planter reads builds placed by hand), so the fill leaves it alone. A
 * Home without ownership metadata fills as before: its uninstall removes nothing anyway. An uninstall in
 * progress, a full manifest or a busy ownership lock stops this start before anything is written.
 */
export function claimChildBinaryCache(configDir: string): ChildCacheClaimRefusal | null {
  const cache = join(configDir, "cache");
  const root = join(cache, "ocx-child");
  try {
    const ownership = configPathOwnership(configDir, root);
    if (ownership === "listed") return null;
    const target = absent(cache) ? cache : absent(root) ? root : null;
    if (target === null) return ownership === "unowned" ? null : "operator_cache";
    return registerOwnedConfigPath(configDir, target) === "full" ? "ownership_unavailable" : null;
  } catch (error) {
    return error instanceof ConfigUninstallInProgressError ? "uninstall_in_progress" : "ownership_unavailable";
  }
}

/**
 * The Home's startup step for the ocx-child cache (src/server/index.ts, background work; lane O2).
 * A client runtime does nothing. Otherwise the fill runs its gates (opt-out, source checkout, version,
 * platform, digests, downgrade) and then, before its first write, {@link claimChildBinaryCache}, so
 * `ocx uninstall` removes exactly the directories the fill created. The fill gets the running code's
 * own version, so a package.json that does not match it (an install still extracting) records nothing.
 */
export async function startChildBinaryCacheFill(
  runtimeRole: string | undefined,
  options: Partial<ChildCacheFillOptions> & { readonly configDir?: string } = {},
  out?: { log: (line: string) => void; warn: (line: string) => void },
): Promise<ChildCacheFillOutcome | null> {
  if ((runtimeRole ?? "standalone") === "client") return null;
  const { configDir = getConfigDir(), ...fill } = options;
  return fillChildBinaryCacheOnStart({ opencodexHome: configDir, bundledVersion: packageVersion("0.0.0"), claimCache: () => claimChildBinaryCache(configDir), ...fill }, out);
}
