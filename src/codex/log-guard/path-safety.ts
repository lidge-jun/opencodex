import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

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
 * The first version of this re-canonicalized the requested path and compared the two
 * canonical forms. That was wrong, and the Windows shard proved it: the caller already
 * passes `realpathSync.native(requested)` as `realPath`, so re-resolving the request
 * produced the same value on BOTH sides and a symlinked database compared equal. The
 * widening let through exactly what the guard exists to refuse.
 *
 * The comparison is therefore link-aware. A short-name expansion rewrites the spelling of
 * components that are all still directories on the same chain, so it is enough to require
 * that no component of the request is a link: with none present, any remaining difference
 * is the OS's own canonical spelling. A symlink or junction anywhere in the chain fails
 * closed as before.
 */
function sameWindowsCanonicalPath(realPath: string, requestedPath: string): boolean {
  if (process.platform !== "win32") return false;
  try {
    if (pathChainContainsLink(requestedPath)) return false;
    return samePathIdentity(realPath, realpathSync.native(requestedPath));
  } catch {
    return false;
  }
}

/** Is any component of this path a symlink or junction? Fails closed on an unreadable one. */
function pathChainContainsLink(path: string): boolean {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
