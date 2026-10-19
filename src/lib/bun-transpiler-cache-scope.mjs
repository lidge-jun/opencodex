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
 */
export const TRANSPILER_CACHE_ENV = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

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
  if (typeof runtimeVersion !== "string" || !VERSION.test(runtimeVersion)) return env;
  const scoped = { ...env };
  for (const variant of names) delete scoped[variant];
  scoped[TRANSPILER_CACHE_ENV] = join(cache, `bun-${runtimeVersion}`);
  return scoped;
}

