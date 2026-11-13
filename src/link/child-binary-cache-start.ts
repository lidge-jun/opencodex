import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { ConfigUninstallInProgressError, configPathOwnership, registerOwnedConfigPath } from "../lib/config-ownership";
import { packageVersion } from "../lib/package-version";
import { CHILD_FILL_DIR, fillChildBinaryCacheOnStart, type ChildCacheClaimRefusal, type ChildCacheFillOptions, type ChildCacheFillOutcome } from "./child-binary-cache-fill.mjs";

/** true: absent; false: a directory with no entries; null: anything else (entries, a file, a link). */
function absentOrEmpty(path: string): boolean | null {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() && readdirSync(path).length === 0 ? false : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/**
 * Claims the fill's own directory, <OPENCODEX_HOME>/ocx-child-builds, for uninstall before the fill
 * creates it. A new Home lists it from the start (INITIAL_OWNED_PATHS, like every other name OpenCodex
 * may create there); an older Home registers it while it is absent or still empty, so nothing that
 * holds data is adopted. One the manifest does not list that already holds entries was not created by
 * OpenCodex: the fill leaves it alone (foreign_directory). The operator's cache/ is never claimed or
 * written. A Home without ownership metadata fills as before (its uninstall removes nothing). An
 * uninstall in progress, a full manifest or a busy ownership lock stops this start before any write.
 */
export function claimChildBinaryCache(configDir: string): ChildCacheClaimRefusal | null {
  const dir = join(configDir, CHILD_FILL_DIR);
  try {
    const ownership = configPathOwnership(configDir, dir);
    if (ownership === "listed") return null;
    // Unowned: registering creates ownership only in an empty Home (where this directory cannot exist yet)
    // and otherwise records nothing, so the fill proceeds as before.
    if (ownership === "unlisted" && absentOrEmpty(dir) === null) return "foreign_directory";
    return registerOwnedConfigPath(configDir, dir) === "full" ? "ownership_unavailable" : null;
  } catch (error) {
    return error instanceof ConfigUninstallInProgressError ? "uninstall_in_progress" : "ownership_unavailable";
  }
}

/**
 * The Home's startup step for the ocx-child cache (src/server/index.ts, background work; lane O2).
 * A client runtime does nothing. Otherwise the fill runs its gates (opt-out, source checkout, version,
 * platform, digests, the Home directory's own safety, downgrade) and then, before it creates its
 * directory, {@link claimChildBinaryCache}. The fill gets the running code's own version, so a
 * package.json that does not match it (an install still extracting) records nothing.
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
