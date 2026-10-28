/**
 * Scope an inherited Bun runtime transpiler cache to the Bun version this launcher starts.
 *
 * Bun keys `.pile` entries by source-content hash alone and stamps them with a format
 * version that changes between releases (1.4.2 writes 28, 1.4.3 writes 34). A reader that
 * finds the other format deletes and rewrites the entry. When one explicit cache directory
 * is shared by two Bun versions, each start of one evicts what the other just wrote, so
 * neither ever runs warm. That is the CI shape: the test runner (`testRunnerBun`) and the
 * bundled runtime this launcher starts share the shard's `BUN_RUNTIME_TRANSPILER_CACHE_PATH`,
 * and every launcher spawn re-transpiled its whole CLI graph from nothing.
 *
 * A per-version subdirectory keeps each runtime's entries stable. Bun creates the directory.
 *
 * The scoped directory is always beneath the configured path: `bun-<version>` is appended as a
 * new leaf, and a basename is never treated as a reason to rewrite the path to its parent. A
 * configured `.../bun-9.9.9` is an ordinary directory that gains a child — the operator's
 * parent is not handed to another version. Only when the path's own final segment is exactly
 * `bun-<version>` of the runtime being started is it kept unchanged, so a launcher started
 * from a launched process reaches the same warm directory. A chain that changes versions
 * therefore nests inward — `cache/bun-A` started on B yields `cache/bun-A/bun-B` — while an
 * independent launch configured with the original base still lands one level down.
 * A disabled cache ("0" or empty), an unset one, or an unknown version is left as given.
 * Windows environment names are case-insensitive (Bun's lookup too) while this object is not,
 * so on win32 every spelling of the name is matched and replaced by one scoped entry.
 */
export const TRANSPILER_CACHE_ENV = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";

// Semver core, optional prerelease and build metadata (findPathBun accepts `+build`). The
// alphabet has no separator, drive colon or NUL, so the segment cannot leave the cache.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DRIVE = /^[A-Za-z]:$/;
const WIN_TAIL = /^(?:.*[\\/])?([^\\/]+)[\\/]*$/;
const POSIX_TAIL = /^(?:.*\/)?([^/]+)\/*$/;

/**
 * The path's final segment the way the running platform parses it — "/" and "\\" separate on
 * Windows while "/" alone does on POSIX, where a backslash is an ordinary character. A bare
 * drive-letter prefix is a boundary, so "C:bun-1.4.3" is the drive-relative leaf "bun-1.4.3".
 * A bare root has no segment and returns null.
 */
function leaf(cache, isWindows) {
  const tail = (isWindows ? WIN_TAIL : POSIX_TAIL).exec(cache);
  if (!tail) return null;
  const name = tail[1];
  return isWindows && name.length > 2 && DRIVE.test(name.slice(0, 2)) ? name.slice(2) : name;
}

/** @param {unknown} version */
function validVersion(version) {
  return typeof version === "string" && version.length <= 64 && VERSION.test(version);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string | null | undefined} runtimeVersion
 * @param {(...parts: string[]) => string} join
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string | undefined>}
 */
export function scopeTranspilerCacheToRuntime(env, runtimeVersion, join, platform = process.platform) {
  const wanted = TRANSPILER_CACHE_ENV.toLowerCase();
  const names = platform === "win32"
    ? Object.keys(env).filter(name => name.toLowerCase() === wanted)
    : Object.hasOwn(env, TRANSPILER_CACHE_ENV) ? [TRANSPILER_CACHE_ENV] : [];
  const name = names.includes(TRANSPILER_CACHE_ENV) ? TRANSPILER_CACHE_ENV : names[0];
  const cache = name === undefined ? undefined : env[name];
  if (typeof cache !== "string" || cache === "" || cache === "0") return env;
  if (!validVersion(runtimeVersion)) return env;
  const segment = `bun-${runtimeVersion}`;
  const isWindows = platform === "win32";
  const current = leaf(cache, isWindows);
  // The filesystems that fold the environment name's case fold the leaf's too.
  const alreadyScoped = current !== null
    && (isWindows ? current.toLowerCase() === segment.toLowerCase() : current === segment);
  const scoped = { ...env };
  for (const variant of names) delete scoped[variant];
  // join("C:", x) yields "C:\\x"; a drive-relative path must stay drive-relative.
  scoped[TRANSPILER_CACHE_ENV] = alreadyScoped ? cache
    : DRIVE.test(cache) ? cache + segment : join(cache, segment);
  return scoped;
}

