import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation } from "./npm-invocation.mjs";

const WORKER_ARG = "--ocx-npm-cache-preflight-worker";
const PROTOCOL_VERSION = 1;
const WORKER_TIMEOUT_MS = 10_000;
const NPM_CONFIG_TIMEOUT_MS = 5_000;
const INSPECTION_TIMEOUT_MS = 7_500;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;

const RESULT_REASONS = new Set([
  "cache_accessible",
  "cache_entry_foreign_owner",
  "cache_entry_inaccessible",
  "cache_path_malformed",
  "inspection_incomplete",
  "npm_config_failed",
  "npm_unavailable",
]);

function inaccessibleByMode(stat) {
  if (stat.isSymbolicLink()) return false;
  const ownerBits = stat.mode & 0o700;
  if (stat.isDirectory()) return (ownerBits & 0o700) !== 0o700;
  return (ownerBits & 0o400) === 0;
}

/**
 * Inspect an existing Unix npm cache without following symlinks. The limits are
 * deliberately part of the result contract: an incomplete inspection cannot prove
 * that replacing the live package will succeed.
 */
export function inspectNpmCacheDirectory(cachePath, options = {}) {
  const expectedUid = options.expectedUid ?? process.getuid?.();
  const deadline = (options.nowMs ?? Date.now)() + (options.timeoutMs ?? INSPECTION_TIMEOUT_MS);
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const nowMs = options.nowMs ?? Date.now;
  // Injected uid seam. A test cannot create a genuinely foreign-owned file without a second
  // account, and without this the symlink-before-ownership rule cannot be pinned: `!isDirectory`
  // skips a link anyway, so removing the rule leaves every assertion green.
  const uidOf = options.uidOf ?? ((_path, stat) => stat.uid);
  const stack = [{ path: cachePath, depth: 0 }];
  let inspected = 0;
  let rootResolved = false;

  while (stack.length > 0) {
    // Budget exhausted is NOT a failure. A mature npm cache legitimately holds hundreds of
    // thousands of entries — this machine's has ~256k — and treating "we ran out of time to
    // look" as "your cache is broken" would block updates for ordinary users, which is worse
    // than the bug this preflight exists to prevent. We looked at a bounded prefix, found
    // nothing wrong, and let the update proceed.
    if (inspected >= maxEntries || nowMs() > deadline) {
      return { ok: true, reason: "inspection_incomplete" };
    }
    const current = stack.pop();
    let stat;
    try {
      stat = lstatSync(current.path);
    } catch (error) {
      if (current.depth === 0 && error?.code === "ENOENT") {
        return { ok: true, reason: "cache_accessible" };
      }
      return { ok: false, reason: "cache_entry_inaccessible" };
    }
    inspected += 1;

    // A symlinked cache ROOT used to be rejected outright, but pointing ~/.npm at another volume
    // is ordinary npm configuration, and blocking those users would be the same false-positive
    // failure this preflight exists to avoid. Resolve the root once and inspect the target;
    // only an unresolvable root is a real problem. Nested links are still never followed.
    if (current.depth === 0 && stat.isSymbolicLink()) {
      // Resolve exactly once. realpath already collapses a chain, so a second pass would only
      // happen if the target is itself reported as a link — treat that as unresolvable rather
      // than looping.
      if (rootResolved) return { ok: false, reason: "cache_entry_inaccessible" };
      rootResolved = true;
      let resolved;
      try {
        resolved = (options.realpathFn ?? realpathSync)(current.path);
      } catch {
        return { ok: false, reason: "cache_entry_inaccessible" };
      }
      stack.push({ path: resolved, depth: 0 });
      continue;
    }
    // A nested symlink is not. npm creates them constantly below _npx, node_modules and .bin,
    // and we never follow them — so its owner is irrelevant and must not abort the update.
    // This has to come BEFORE the ownership check: a foreign-owned but never-followed link is
    // exactly the false positive that made the previous attempt at this feature unusable.
    if (stat.isSymbolicLink()) continue;

    if (expectedUid !== undefined && uidOf(current.path, stat) !== expectedUid) {
      return { ok: false, reason: "cache_entry_foreign_owner" };
    }
    if (inaccessibleByMode(stat)) {
      return { ok: false, reason: "cache_entry_inaccessible" };
    }
    if (!stat.isDirectory()) continue;
    // Same reasoning as the entry budget: too deep to finish is not evidence of a bad cache.
    if (current.depth >= maxDepth) return { ok: true, reason: "inspection_incomplete" };

    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      return { ok: false, reason: "cache_entry_inaccessible" };
    }
    for (const entry of entries) {
      stack.push({ path: resolve(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  return { ok: true, reason: "cache_accessible" };
}

function workerResult() {
  const invocation = npmInvocation(["config", "get", "cache"]);
  if (!invocation) return { ok: false, reason: "npm_unavailable" };
  const npm = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    timeout: NPM_CONFIG_TIMEOUT_MS,
    windowsHide: true,
    ...invocation.options,
  });
  if (npm.status !== 0) return { ok: false, reason: "npm_config_failed" };

  const output = typeof npm.stdout === "string" ? npm.stdout.trim() : "";
  if (!output || output.length > 4096 || output.includes("\0") || /[\r\n]/.test(output) || !isAbsolute(output)) {
    return { ok: false, reason: "cache_path_malformed" };
  }
  return inspectNpmCacheDirectory(output);
}

// Reasons that legitimately accompany `ok: true`. The parser below cross-checks the flag against
// this set so a worker cannot claim success with a failure reason (or the reverse). It is a SET,
// not a single value: a bounded inspection that ran out of budget without finding a problem is a
// pass, and hardcoding `cache_accessible` here silently rejected exactly that — the pass never
// reached the caller and every large cache still failed, as `worker_output_malformed`.
const OK_REASONS = new Set([
  "cache_accessible",
  "inspection_incomplete",
  "windows_skip",
]);

function parseWorkerOutput(stdout) {
  if (typeof stdout !== "string" || stdout.length > 1024) return null;
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || parsed.protocol !== PROTOCOL_VERSION || typeof parsed.ok !== "boolean") return null;
    if (typeof parsed.reason !== "string" || !RESULT_REASONS.has(parsed.reason)) return null;
    if (parsed.ok !== OK_REASONS.has(parsed.reason)) return null;
    if (Object.keys(parsed).sort().join(",") !== "ok,protocol,reason") return null;
    return { ok: parsed.ok, reason: parsed.reason };
  } catch {
    return null;
  }
}

/** Run the bounded cache inspection in an isolated, synchronously-timeboxed worker. */
export function runNpmCachePreflight(options = {}) {
  if ((options.platform ?? process.platform) === "win32") {
    return { ok: true, reason: "windows_skip" };
  }
  const spawn = options.spawnSyncFn ?? spawnSync;
  const result = spawn(
    options.execPath ?? process.execPath,
    [fileURLToPath(import.meta.url), WORKER_ARG],
    {
      encoding: "utf8",
      timeout: options.timeoutMs ?? WORKER_TIMEOUT_MS,
      windowsHide: true,
      env: options.env ?? process.env,
    },
  );
  if (result.status === null) return { ok: false, reason: "worker_timeout" };
  if (result.status !== 0) return { ok: false, reason: "worker_failed" };
  return parseWorkerOutput(result.stdout) ?? { ok: false, reason: "worker_output_malformed" };
}

/** Fixed operator guidance; worker/npm output is intentionally never interpolated. */
export function npmCachePreflightFailureMessage(reason) {
  return `npm cache access pre-flight failed (${reason}); fix cache ownership and permissions, then retry`;
}

const isWorker = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && process.argv[2] === WORKER_ARG;
if (isWorker) {
  let result;
  try {
    result = workerResult();
  } catch {
    result = { ok: false, reason: "cache_entry_inaccessible" };
  }
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }));
}
