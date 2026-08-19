import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { samePathIdentity } from "../user-identity";

const TRUSTED_DARWIN_SYSTEM_ALIASES = [
  { alias: "/var", canonical: "/private/var" },
  { alias: "/tmp", canonical: "/private/tmp" },
] as const;

export function normalizeTrustedDarwinSystemAlias(path: string): string {
  const requested = resolve(path);
  if (process.platform !== "darwin") return requested;

  for (const entry of TRUSTED_DARWIN_SYSTEM_ALIASES) {
    if (requested !== entry.alias && !requested.startsWith(`${entry.alias}${sep}`)) continue;

    let actualAliasTarget: string;
    try {
      actualAliasTarget = realpathSync.native(entry.alias);
    } catch {
      // If the platform alias is absent or unreadable, keep the strict spelling check.
      return requested;
    }
    if (!samePathIdentity(actualAliasTarget, entry.canonical, "darwin")) return requested;
    return `${entry.canonical}${requested.slice(entry.alias.length)}`;
  }

  return requested;
}

/**
 * Compare a canonical realpath with a requested Log Guard path without treating
 * macOS's OS-owned /var and /tmp aliases as user-controlled redirections.
 * Arbitrary ancestor symlinks remain refused.
 */
export function sameLogGuardPathIdentity(realPath: string, requestedPath: string): boolean {
  const requested = normalizeTrustedDarwinSystemAlias(requestedPath);
  if (samePathIdentity(realPath, requested)) return true;
  return sameWindowsCanonicalPath(realPath, requested);
}

/**
 * On Windows, is the difference between these two spellings the OS canonicalizing the
 * request rather than a redirection?
 *
 * `realpathSync.native` expands 8.3 short components — the `RUNNER~1` form that appears
 * throughout `%TEMP%` — so the canonical path and the requested path can disagree as
 * strings while naming the same file. Reading that as an ancestor-symlink redirection made
 * every Log Guard mutation refuse with `unsafe_path` on Windows, which is what the CI shards
 * were reporting.
 *
 * The comparison is still identity-based, not string-based: it re-canonicalizes the
 * REQUESTED path through the same call and requires the two canonical forms to agree. A
 * genuine symlink or junction resolves somewhere else and still fails, so the guard keeps
 * refusing exactly what it was built to refuse.
 */
function sameWindowsCanonicalPath(realPath: string, requestedPath: string): boolean {
  if (process.platform !== "win32") return false;
  try {
    return samePathIdentity(realPath, realpathSync.native(requestedPath));
  } catch {
    return false;
  }
}
