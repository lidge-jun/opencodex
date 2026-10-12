import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether the served dashboard bundle predates the sources it was built from.
 *
 * The dashboard is a build artifact: `AGENTS.md` records that `gui/` is served from `gui/dist`,
 * so a checkout that moves forward without `bun run build:gui` keeps serving the previous bundle.
 * Nothing fails when that happens. The proxy answers, the page loads, and every feature added since
 * the last build is simply absent — which reads as the feature being broken rather than unbuilt.
 * A five-day-old bundle hid the entire menu-bar and widget section of the Usage page this way.
 *
 * This reports; it never rebuilds. A proxy that compiled a frontend while starting would trade a
 * silent staleness for a slow, surprising start, and the rebuild belongs to whoever moved the
 * checkout.
 */
export interface GuiBundleFreshness {
  /** Absolute path of the served bundle, or null when no bundle was found. */
  bundlePath: string | null;
  /** Newest mtime under the bundle, in epoch milliseconds. */
  bundleModifiedMs: number | null;
  /** Newest mtime under the GUI sources, in epoch milliseconds. */
  sourceModifiedMs: number | null;
  /** True only when both sides are known and the sources are strictly newer. */
  stale: boolean;
}

/** Directory entries that never carry meaningful build input or output timestamps. */
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".vite", ".cache"]);

/**
 * Newest mtime beneath `root`, or null when the tree is missing or empty.
 *
 * Walking is bounded by `maxEntries` because this runs on a status path: a pathological tree must
 * cost a predictable amount rather than stalling the command that reports on it. Hitting the bound
 * yields the newest value seen so far, which can only make the comparison more conservative.
 */
export function newestModifiedMs(root: string, maxEntries = 20_000): number | null {
  if (!existsSync(root)) return null;
  let newest: number | null = null;
  let seen = 0;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) return newest;
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      try {
        const mtime = statSync(full).mtimeMs;
        if (newest === null || mtime > newest) newest = mtime;
      } catch {
        // A file that vanished mid-walk cannot make the bundle look fresher than it is.
      }
    }
  }
  return newest;
}

/**
 * Compare the built bundle against its sources.
 *
 * Unknown is not stale. A packaged install has no `gui/src` beside it, and a missing bundle is a
 * different condition with its own message elsewhere; neither should produce a rebuild warning.
 */
export function inspectGuiBundleFreshness(input: {
  bundlePath: string | null;
  sourcePath: string;
}): GuiBundleFreshness {
  const bundleModifiedMs = input.bundlePath === null ? null : newestModifiedMs(input.bundlePath);
  const sourceModifiedMs = newestModifiedMs(input.sourcePath);
  const stale = bundleModifiedMs !== null
    && sourceModifiedMs !== null
    && sourceModifiedMs > bundleModifiedMs;
  return {
    bundlePath: input.bundlePath,
    bundleModifiedMs,
    sourceModifiedMs,
    stale,
  };
}

/** Operator-facing lines for a stale bundle; empty when the bundle is current or unknown. */
export function staleGuiBundleLines(freshness: GuiBundleFreshness): string[] {
  if (!freshness.stale) return [];
  return [
    "Dashboard bundle is older than the GUI sources, so the page is missing everything built since.",
    "Rebuild it with: bun run build:gui",
  ];
}
