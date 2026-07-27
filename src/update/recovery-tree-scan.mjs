import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_MAX_RECOVERY_TREE_ENTRIES = 50_000;
export const DEFAULT_MAX_RECOVERY_TREE_SCAN_MS = 5_000;
export const RECOVERY_TREE_SCAN_WORKER_ARG = "__scan-recovery-tree";

function isPathInside(parent, child) {
  const fromParent = relative(parent, child);
  return fromParent !== ""
    && fromParent !== ".."
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent);
}

function hasTrustedRecoveryOwner(uid) {
  const currentUid = process.getuid?.();
  return currentUid === undefined || uid === currentUid || uid === 0;
}

function hasTrustedRecoveryPermissions(stat) {
  if (!hasTrustedRecoveryOwner(stat.uid)) return false;
  return process.getuid === undefined || (stat.mode & 0o022) === 0;
}

function hasTrustedRecoveryPath(packageRoot) {
  let path = packageRoot;
  while (true) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || !hasTrustedRecoveryOwner(stat.uid)
      || (
        process.getuid !== undefined
        && (stat.mode & 0o022) !== 0
        && (stat.mode & 0o1000) === 0
      )
    ) return false;
    const parent = dirname(path);
    if (parent === path) return true;
    path = parent;
  }
}

/**
 * Scan a candidate package tree without executing any package code. The caller
 * runs this in a short-lived worker so a stalled filesystem syscall is bounded
 * by the parent process as well as by the between-entry budget below.
 */
export function scanTrustedRecoveryTree(
  packageRoot,
  {
    maxEntries = DEFAULT_MAX_RECOVERY_TREE_ENTRIES,
    maxDurationMs = DEFAULT_MAX_RECOVERY_TREE_SCAN_MS,
  } = {},
) {
  try {
    const canonicalRoot = realpathSync(packageRoot);
    const scopeRoot = dirname(canonicalRoot);
    const scopeStat = lstatSync(scopeRoot);
    if (
      !scopeStat.isDirectory()
      || scopeStat.isSymbolicLink()
      || !hasTrustedRecoveryPermissions(scopeStat)
      || !hasTrustedRecoveryPath(canonicalRoot)
    ) return false;

    const entryLimit = Number.isFinite(maxEntries) && maxEntries > 0
      ? Math.trunc(maxEntries)
      : DEFAULT_MAX_RECOVERY_TREE_ENTRIES;
    const durationLimit = Number.isFinite(maxDurationMs) && maxDurationMs > 0
      ? Math.trunc(maxDurationMs)
      : DEFAULT_MAX_RECOVERY_TREE_SCAN_MS;
    const deadline = Date.now() + durationLimit;
    const pending = [canonicalRoot];
    const visited = new Set();
    let inspected = 0;
    while (pending.length > 0) {
      if (Date.now() > deadline || inspected >= entryLimit) return false;
      const path = pending.pop();
      inspected += 1;
      const entryStat = lstatSync(path);
      let canonicalPath = path;
      let canonicalStat = entryStat;
      if (entryStat.isSymbolicLink()) {
        // npm creates node_modules/.bin links. Permit only trusted-owner links
        // whose immediate and final targets remain inside this package.
        if (!hasTrustedRecoveryOwner(entryStat.uid)) return false;
        const directTarget = resolve(dirname(path), readlinkSync(path));
        if (!isPathInside(canonicalRoot, directTarget)) return false;
        canonicalPath = realpathSync(path);
        if (!isPathInside(canonicalRoot, canonicalPath)) return false;
        canonicalStat = lstatSync(canonicalPath);
      }
      if (!hasTrustedRecoveryPermissions(canonicalStat)) return false;
      if (visited.has(canonicalPath)) continue;
      visited.add(canonicalPath);
      if (canonicalStat.isFile()) continue;
      if (!canonicalStat.isDirectory()) return false;
      for (const name of readdirSync(canonicalPath, { encoding: "utf8" })) {
        pending.push(join(canonicalPath, name));
      }
    }
    return true;
  } catch {
    return false;
  }
}

function runWorker() {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    if (typeof payload?.packageRoot !== "string") {
      process.stdout.write("0\n");
      return;
    }
    process.stdout.write(scanTrustedRecoveryTree(payload.packageRoot, payload) ? "1\n" : "0\n");
  } catch {
    process.stdout.write("0\n");
  }
}

if (process.argv[2] === RECOVERY_TREE_SCAN_WORKER_ARG) runWorker();
