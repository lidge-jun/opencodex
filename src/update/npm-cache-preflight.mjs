import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_CACHE_ENTRIES = 50_000;
const DEFAULT_CACHE_SCAN_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_LOOKUP_TIMEOUT_MS = 12_000;
const CACHE_SCAN_WORKER_ARG = "__scan-npm-cache-ownership";

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

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
  const maxEntries = positiveInteger(io.maxEntries, DEFAULT_MAX_CACHE_ENTRIES);
  const maxDurationMs = positiveInteger(io.maxDurationMs, DEFAULT_CACHE_SCAN_TIMEOUT_MS);
  const startedAt = now();
  let cacheRoot;
  try {
    // npm follows a configured cache-root symlink. Resolve only that root;
    // nested symlinks are rejected below and never traversed.
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
    if (stat.isSymbolicLink()) {
      // Only the configured cache root is canonicalized. Traversing a nested
      // link could hide a foreign-owned target, so fail closed instead.
      return {
        kind: "error",
        path,
        reason: "npm cache contains a nested symbolic link",
      };
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

function parseOwnershipIssue(output, cachePath) {
  try {
    const parsed = JSON.parse(output);
    if (parsed === null) return null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.path !== "string") throw new Error("invalid issue");
    if (parsed.kind === "foreign-owner" && Number.isInteger(parsed.actualUid)) return parsed;
    if (parsed.kind === "error" && typeof parsed.reason === "string") return parsed;
  } catch { /* convert malformed worker output into a fail-closed result below */ }
  return {
    kind: "error",
    path: resolve(cachePath),
    reason: "npm cache inspection returned invalid output",
  };
}

/** Run the blocking filesystem walk out-of-process so its wall-clock deadline is enforceable. */
function scanNpmCacheOwnership(cachePath, expectedUid, options) {
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_CACHE_ENTRIES);
  const maxDurationMs = positiveInteger(options.maxDurationMs, DEFAULT_CACHE_SCAN_TIMEOUT_MS);
  const scanSpawn = options.scanSpawn ?? spawnSync;
  let result;
  try {
    result = scanSpawn(
      options.scanBin ?? process.execPath,
      [options.scanScript ?? fileURLToPath(import.meta.url), CACHE_SCAN_WORKER_ARG],
      {
        encoding: "utf8",
        input: JSON.stringify({ cachePath, expectedUid, maxEntries, maxDurationMs }),
        timeout: maxDurationMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        shell: false,
      },
    );
  } catch (error) {
    return {
      kind: "error",
      path: resolve(cachePath),
      reason: `could not inspect npm cache (${errorCode(error)})`,
    };
  }
  if (result.status !== 0) {
    const timedOut = result.status === null || errorCode(result.error) === "ETIMEDOUT";
    return {
      kind: "error",
      path: resolve(cachePath),
      reason: timedOut
        ? `npm cache inspection exceeded its ${maxDurationMs}ms time budget`
        : `could not inspect npm cache (${result.error ? errorCode(result.error) : `status ${result.status}`})`,
    };
  }
  const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
  return parseOwnershipIssue(output, cachePath);
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
  const lookupTimeoutMs = positiveInteger(options.lookupTimeoutMs, DEFAULT_CACHE_LOOKUP_TIMEOUT_MS);
  let result;
  try {
    result = spawn(npmBin, ["config", "get", "cache"], {
      encoding: "utf8",
      timeout: lookupTimeoutMs,
      killSignal: "SIGKILL",
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

  const issue = scanNpmCacheOwnership(cachePath, expectedUid, options);
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

/** Format an actionable update error without persisting account ids or arbitrary local paths. */
export function formatNpmCacheOwnershipFailure(result) {
  return [
    "npm cache ownership pre-flight failed before stopping the proxy.",
    result.reason,
    "Run 'npm config get cache' to locate the configured cache.",
    "Correct the cache ownership or configure a user-owned npm cache, then retry.",
  ].join("\n");
}

function runCacheScanWorker() {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    if (typeof payload?.cachePath !== "string" || !Number.isInteger(payload?.expectedUid)) {
      process.exitCode = 2;
      return;
    }
    const issue = findForeignOwnedNpmCacheEntry(payload.cachePath, payload.expectedUid, {
      maxEntries: payload.maxEntries,
      maxDurationMs: payload.maxDurationMs,
    });
    process.stdout.write(JSON.stringify(issue));
  } catch {
    process.exitCode = 2;
  }
}

const thisModulePath = fileURLToPath(import.meta.url);
if (process.argv[2] === CACHE_SCAN_WORKER_ARG && resolve(process.argv[1] ?? "") === resolve(thisModulePath)) {
  runCacheScanWorker();
}
