import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "unknown error";
}

/** Find the first cache entry whose uid differs from the current user. */
export function findForeignOwnedNpmCacheEntry(cachePath, expectedUid, io = {}) {
  const lstat = io.lstat ?? lstatSync;
  const readdir = io.readdir ?? (path => readdirSync(path, { encoding: "utf8" }));
  const stack = [resolve(cachePath)];

  while (stack.length > 0) {
    const path = stack.pop();
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

    if (Number.isInteger(stat.uid) && stat.uid !== expectedUid) {
      return { kind: "foreign-owner", path, actualUid: stat.uid };
    }
    if (!stat.isDirectory()) continue;

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
    for (const entry of entries) stack.push(resolve(path, entry));
  }

  return null;
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
      reason: `npm cache entry is owned by uid ${issue.actualUid}; expected uid ${expectedUid}`,
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

export function formatNpmCacheOwnershipFailure(result) {
  return [
    "npm cache ownership pre-flight failed before stopping the proxy.",
    result.entryPath ? `${result.reason}: ${result.entryPath}` : result.reason,
    ...(result.cachePath ? [`Cache: ${result.cachePath}`] : []),
    "Correct the cache ownership or configure a user-owned npm cache, then retry.",
  ].join("\n");
}
