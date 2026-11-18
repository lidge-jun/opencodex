import { pathToFileURL } from "node:url";
import { repoPath } from "./repo-root";

/**
 * Import a private, instrumented copy of a src/update module from its source text.
 *
 * A data: URL has no base to resolve relative specifiers against, so every relative
 * "./x.mjs" import is pinned to the shipped file's file: URL. A copy that still carries an
 * unpinned relative import is refused here rather than failing only on the Windows lane
 * (#8534 added "./windows-installer-marker.mjs" and "./test-home-guard.mjs" to npm-install.mjs,
 * and the copies that rewrote only "./mutation-guard.mjs" broke on every Windows shard).
 */
export async function importUpdateModuleCopy<T>(source: string): Promise<T> {
  const pinned = source.replace(/(from\s+)"\.\/([\w.-]+\.mjs)"/g,
    (_match, from: string, file: string) => `${from}${JSON.stringify(pathToFileURL(repoPath("src/update", file)).href)}`);
  if (/(?:from\s+|import\s*\()["']\.\.?\//.test(pinned)) throw new Error("update module copy still has an unpinned relative import");
  return await import("data:text/javascript;base64," + Buffer.from(pinned).toString("base64")) as T;
}
