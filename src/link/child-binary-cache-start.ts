import { lstatSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { ConfigUninstallInProgressError, configPathOwnership, initializeConfigOwnership, registerOwnedConfigPath } from "../lib/config-ownership";
import { packageVersion } from "../lib/package-version";
import { CHILD_FILL_DIR, fillChildBinaryCacheOnStart, type ChildCacheClaimRefusal, type ChildCacheFillOptions, type ChildCacheFillOutcome } from "./child-binary-cache-fill.mjs";

/** "absent"; "ours": an empty real directory owned by this user that nobody else can write; else "other". */
function inspect(path: string): "absent" | "ours" | "other" {
  let st;
  try { st = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const private_ = st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o022) === 0;
  return private_ && readdirSync(path).length === 0 ? "ours" : "other";
}

/**
 * Claims the fill's own directory, <OPENCODEX_HOME>/ocx-child-builds, for uninstall. The manifest lists
 * it only once OpenCodex has created it: an absent directory is created here (exclusively, 0700) and
 * then registered, and removed again if the registration does not succeed, so a listing always names a
 * directory OpenCodex made or adopted. An unlisted directory is adopted only when it is empty, a real directory,
 * owned by this user and writable by nobody else (what an interruption between creation and
 * registration leaves); any other one was not created by OpenCodex, and the fill leaves it alone
 * (foreign_directory). A failed registration removes only a directory this call created, and a Home whose
 * metadata disappeared between the check and the registration (an uninstall) stops the fill. The operator's cache/ is never claimed or written. A Home without ownership
 * metadata fills as before (its uninstall removes nothing). An uninstall in progress, a full manifest or
 * a busy ownership lock stops this start before any write.
 */
export function claimChildBinaryCache(configDir: string): ChildCacheClaimRefusal | null {
  const dir = join(configDir, CHILD_FILL_DIR);
  try {
    let ownership = configPathOwnership(configDir, dir);
    // A Home still empty gets its ownership metadata first, as any other first write would create it.
    if (ownership === "unowned" && initializeConfigOwnership(configDir)) ownership = configPathOwnership(configDir, dir);
    if (ownership !== "unlisted") return null;
    const found = inspect(dir);
    if (found === "other") return "foreign_directory";
    const created = found === "absent";
    if (created) {
      try { mkdirSync(dir, { mode: 0o700 }); } catch { return "foreign_directory"; }
    }
    // The Home was owned a moment ago, so "unowned" now means an uninstall removed its metadata in between.
    let registered: ReturnType<typeof registerOwnedConfigPath> | "failed" = "failed";
    try { registered = registerOwnedConfigPath(configDir, dir); } finally {
      // Only a directory this call created is removed; an adopted one stays as it was found.
      if (registered !== "recorded" && created) { try { rmdirSync(dir); } catch { /* an empty directory left; the next start adopts it */ } }
    }
    if (registered === "unowned") return "uninstall_in_progress";
    return registered === "full" ? "ownership_unavailable" : null;
  } catch (error) {
    return error instanceof ConfigUninstallInProgressError ? "uninstall_in_progress" : "ownership_unavailable";
  }
}

/**
 * The Home's startup step for the ocx-child cache (src/server/index.ts, background work; lane O2).
 * A client runtime does nothing. Otherwise the fill runs its gates (opt-out, source checkout, version,
 * platform, digests, the Home directory's own safety, downgrade) and then, before it writes,
 * {@link claimChildBinaryCache}. The fill gets the running code's own version, so a package.json that
 * does not match it (an install still extracting) records nothing.
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
