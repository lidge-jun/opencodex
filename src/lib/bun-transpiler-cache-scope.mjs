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
 * A disabled cache ("0" or empty), an unset one, or an unknown version is left as given.
 * Windows environment names are case-insensitive (Bun's lookup too) while this object is not,
 * so on win32 every spelling of the name is matched and replaced by one scoped entry.
 * A cache that is already scoped (a launcher started from a launched process) is re-scoped in
 * place, never nested, so the same runtime keeps reaching the same warm directory.
 */
export const TRANSPILER_CACHE_ENV = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";

// Semver core, optional prerelease and build metadata (findPathBun accepts `+build`). The
// alphabet has no separator, drive colon or NUL, so the segment cannot leave the cache.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SCOPED_TAIL = /^(.*?)([\\/]+)(bun-[^\\/]+)[\\/]*$/;

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
  const tail = SCOPED_TAIL.exec(cache);
  // At a filesystem or drive root ("/", "C:\\") keep one separator: a bare "C:" is drive-relative.
  const base = !tail || !validVersion(tail[3].slice(4)) ? cache
    : tail[1] === "" || /^[A-Za-z]:$/.test(tail[1]) ? tail[1] + tail[2][0] : tail[1];
  const scoped = { ...env };
  for (const variant of names) delete scoped[variant];
  scoped[TRANSPILER_CACHE_ENV] = join(base, `bun-${runtimeVersion}`);
  return scoped;
}

