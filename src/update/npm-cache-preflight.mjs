import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_CACHE_ENTRIES = 50_000;
const DEFAULT_CACHE_SCAN_TIMEOUT_MS = 10_000;

/** Extract a stable filesystem error code without serializing the full error. */
function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "unknown error";
}

/** Find the first cache entry whose uid differs from the current user. */
export function findForeignOwnedNpmCacheEntry(cachePath, expectedUid, io = {}) {
  const lstat = io.lstat ?? lstatSync;
  const readdir = io.readdir ?? (path => readdirSync(path, { encoding: "utf8" }));
  const realpath = io.realpath ?? realpathSync;
  const now = io.now ?? (() => Date.now());
  const maxEntries = Number.isFinite(io.maxEntries) && io.maxEntries > 0
    ? Math.trunc(io.maxEntries)
    : DEFAULT_MAX_CACHE_ENTRIES;
  const maxDurationMs = Number.isFinite(io.maxDurationMs) && io.maxDurationMs > 0
    ? Math.trunc(io.maxDurationMs)
    : DEFAULT_CACHE_SCAN_TIMEOUT_MS;
  const startedAt = now();
  let cacheRoot;
  try {
    // npm follows a configured cache-root symlink. Resolve only that root; nested
    // symlinks remain lstat-only and are never traversed.
    cacheRoot = realpath(resolve(cachePath));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        kind: "error",
        path: resolve(cachePath),
        reason: "npm cache root does not exist",
      };
    }
    return {
      kind: "error",
      path: resolve(cachePath),
      reason: `could not resolve npm cache root (${errorCode(error)})`,
    };
  }
  const stack = [cacheRoot];
  let discoveredEntries = 1;

  const elapsedBudgetIssue = path => (
    now() - startedAt > maxDurationMs
      ? {
          kind: "error",
          path,
          reason: `npm cache inspection exceeded its ${maxDurationMs}ms time budget`,
        }
      : null
  );

  while (stack.length > 0) {
    const path = stack.pop();
    const beforeStatBudget = elapsedBudgetIssue(path);
    if (beforeStatBudget) return beforeStatBudget;
    let stat;
    try {
      stat = lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      return {
        kind: "error",
        path,
        reason: `could not inspect npm cache entry (${errorCode(error)})`,
      };
    }
    const afterStatBudget = elapsedBudgetIssue(path);
    if (afterStatBudget) return afterStatBudget;

    if (Number.isInteger(stat.uid) && stat.uid !== expectedUid) {
      return { kind: "foreign-owner", path, actualUid: stat.uid };
    }
    if (path === cacheRoot && !stat.isDirectory()) {
      return { kind: "error", path, reason: "npm cache root is not a directory" };
    }
    if (!stat.isDirectory()) continue;

    const beforeReadBudget = elapsedBudgetIssue(path);
    if (beforeReadBudget) return beforeReadBudget;
    let entries;
    try {
      entries = readdir(path);
    } catch (error) {
      return {
        kind: "error",
        path,
        reason: `could not read npm cache directory (${errorCode(error)})`,
      };
    }
    const afterReadBudget = elapsedBudgetIssue(path);
    if (afterReadBudget) return afterReadBudget;
    for (const entry of entries) {
      const entryPath = resolve(path, entry);
      const iterationBudget = elapsedBudgetIssue(entryPath);
      if (iterationBudget) return iterationBudget;
      if (discoveredEntries >= maxEntries) {
        return {
          kind: "error",
          path: entryPath,
          reason: `npm cache inspection exceeded its ${maxEntries}-entry budget`,
        };
      }
      discoveredEntries += 1;
      stack.push(entryPath);
    }
  }

  return null;
}

/** Redact path segments that commonly carry secrets before they reach update logs. */
function sanitizePathSegments(path) {
  return path
    .split(/[\\/]/)
    .map(segment => /(?:secret|password|passwd|token|api[-_]?key|apikey|credential|email)/i.test(segment)
      ? "[REDACTED]"
      : segment)
    .join("/");
}

/** Render paths home-relative, or hide absolute paths outside the current home. */
function displayUserPath(path) {
  const absolute = resolve(path);
  const home = resolve(homedir());
  const fromHome = relative(home, absolute);
  if (fromHome === "") return "~";
  if (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome)) {
    return `~/${sanitizePathSegments(fromHome)}`;
  }
  return "[configured npm cache]";
}

/** Prefer a cache-relative entry while preserving the same account-name redaction. */
function displayCacheEntry(cachePath, entryPath) {
  const fromCache = relative(resolve(cachePath), resolve(entryPath));
  if (fromCache === "") return displayUserPath(cachePath);
  if (fromCache !== ".." && !fromCache.startsWith(`..${sep}`) && !isAbsolute(fromCache)) {
    return `${displayUserPath(cachePath)}/${sanitizePathSegments(fromCache)}`;
  }
  return displayUserPath(entryPath);
}

/**
 * npm can abort after it has retired the installed package when its cache contains
 * root-owned entries. Detect that state before an updater stops the running proxy.
 */
export function checkNpmCacheOwnership(options = {}) {
  const platform = options.platform ?? process.platform;
  const getuid = options.getuid ?? process.getuid;
  if (platform === "win32" || typeof getuid !== "function") {
    return { ok: "skipped", reason: "uid ownership is unavailable on this platform" };
  }

  const expectedUid = getuid();
  const npmBin = options.npmBin ?? "npm";
  const spawn = options.spawn ?? spawnSync;
  let result;
  try {
    result = spawn(npmBin, ["config", "get", "cache"], {
      encoding: "utf8",
      timeout: 12_000,
      windowsHide: true,
      shell: options.shell ?? false,
    });
  } catch (error) {
    return {
      ok: false,
      expectedUid,
      reason: `could not resolve the npm cache (${errorCode(error)})`,
    };
  }
  if (result.status !== 0) {
    const detail = result.error ? errorCode(result.error) : `status ${result.status ?? "timeout"}`;
    return {
      ok: false,
      expectedUid,
      reason: `could not resolve the npm cache (${detail})`,
    };
  }

  const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
  const cachePath = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  if (!cachePath || cachePath === "undefined" || cachePath === "null") {
    return { ok: false, expectedUid, reason: "npm did not report a cache path" };
  }

  const issue = findForeignOwnedNpmCacheEntry(cachePath, expectedUid, options);
  if (!issue) return { ok: true, cachePath: resolve(cachePath) };
  if (issue.kind === "foreign-owner") {
    return {
      ok: false,
      cachePath: resolve(cachePath),
      entryPath: issue.path,
      expectedUid,
      actualUid: issue.actualUid,
      reason: "npm cache entry ownership does not match the current user",
    };
  }
  return {
    ok: false,
    cachePath: resolve(cachePath),
    entryPath: issue.path,
    expectedUid,
    reason: issue.reason,
  };
}

/** Format an actionable update error without persisting an OS account name. */
export function formatNpmCacheOwnershipFailure(result) {
  const entry = result.entryPath
    ? displayCacheEntry(result.cachePath ?? result.entryPath, result.entryPath)
    : null;
  return [
    "npm cache ownership pre-flight failed before stopping the proxy.",
    entry ? `${result.reason}: ${entry}` : result.reason,
    ...(result.cachePath ? [`Cache: ${displayUserPath(result.cachePath)}`] : []),
    "Correct the cache ownership or configure a user-owned npm cache, then retry.",
  ].join("\n");
}
