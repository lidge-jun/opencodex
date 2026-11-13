import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { packageVersion } from "../lib/package-version";
import { fillChildBinaryCacheOnStart, type ChildCacheFillOptions, type ChildCacheFillOutcome } from "./child-binary-cache-fill.mjs";

/**
 * The Home's startup step for the ocx-child cache (src/server/index.ts, background work; lane O2).
 * A client runtime does nothing. Otherwise `<OPENCODEX_HOME>/cache` is recorded as owned config state
 * first, so `ocx uninstall` removes the directories the fill creates (a new Home owns it from the start
 * through INITIAL_OWNED_PATHS), and the fill gets the running code's own version, so a package.json
 * that does not match it (an install still extracting) records nothing.
 */
export async function startChildBinaryCacheFill(
  runtimeRole: string | undefined,
  options: Partial<ChildCacheFillOptions> & { readonly configDir?: string } = {},
  out?: { log: (line: string) => void; warn: (line: string) => void },
): Promise<ChildCacheFillOutcome | null> {
  if ((runtimeRole ?? "standalone") === "client") return null;
  const { configDir = getConfigDir(), ...fill } = options;
  try { recordOwnedConfigPath(configDir, join(configDir, "cache")); } catch { /* uninstall then names cache/ as unowned, as before */ }
  return fillChildBinaryCacheOnStart({ opencodexHome: configDir, bundledVersion: packageVersion("0.0.0"), ...fill }, out);
}
