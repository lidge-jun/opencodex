import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation } from "./npm-invocation.mjs";

const WORKER_ARG = "--ocx-npm-cache-preflight-worker";
const ROOT_ONLY_ARG = "--root-only";
const PROTOCOL_VERSION = 1;
// Windows starts npm through cmd.exe and is routinely slowed by on-access scanning, so the
// same `npm config get cache` that takes well under a second on POSIX can take several there.
const WORKER_TIMEOUT_MS = process.platform === "win32" ? 25_000 : 10_000;
const NPM_CONFIG_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;
const INSPECTION_TIMEOUT_MS = 7_500;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;

const RESULT_REASONS = new Set([
  "cache_accessible",
  "cache_entry_foreign_owner",
  "cache_entry_inaccessible",
  "cache_path_malformed",
  "cache_root_dangling_link",
  "cache_root_not_directory",
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
 * Check that npm can create or use its cache ROOT (#6288). This is the part of the inspection
 * that is meaningful on every platform: npm's first action is `mkdir -p <cache>`, and it fails
 * with ENOTDIR when the root — or the nearest existing ancestor npm would create it under — is
 * a file, or a link/junction whose target is gone. A Windows directory junction relocated to
 * another volume is ordinary configuration; only an unresolvable one is a problem.
 */
export function inspectNpmCacheRoot(cachePath, options = {}) {
  const lstat = options.lstatFn ?? lstatSync;
  const stat = options.statFn ?? statSync;
  let current = resolve(cachePath);
  let entry;
  for (;;) {
    try {
      entry = lstat(current);
      break;
    } catch (error) {
      // A file somewhere above the root: POSIX reports ENOTDIR here, which is exactly the
      // ENOTDIR npm's own mkdir would hit. Windows reports ENOENT and the walk reaches the file.
      if (error?.code === "ENOTDIR") return { ok: false, reason: "cache_root_not_directory" };
      if (error?.code !== "ENOENT") return { ok: false, reason: "cache_entry_inaccessible" };
      const parent = dirname(current);
      // Nothing on the path exists at all (a missing drive root); npm cannot mkdir there either.
      if (parent === current) return { ok: false, reason: "cache_root_not_directory" };
      current = parent;
    }
  }
  let target = entry;
  if (entry.isSymbolicLink()) {
    try {
      target = stat(current);
    } catch (error) {
      return {
        ok: false,
        reason: error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP"
          ? "cache_root_dangling_link"
          : "cache_entry_inaccessible",
      };
    }
  }
  if (!target.isDirectory()) return { ok: false, reason: "cache_root_not_directory" };
  return { ok: true, reason: "cache_accessible" };
}

/**
 * Inspect an existing Unix npm cache without following symlinks. The limits are
 * deliberately part of the result contract: an incomplete inspection cannot prove
 * that replacing the live package will succeed.
 */
export function inspectNpmCacheDirectory(cachePath, options = {}) {
  const root = inspectNpmCacheRoot(cachePath, options);
  if (!root.ok) return root;
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

// cmd.exe re-parses npm.cmd's %* after our quoting, so on Windows a pinned path must not carry
// characters that quoting cannot neutralize there. Such a path is refused, never escaped.
const WINDOWS_CMD_METACHARACTERS = /["%!^&|<>]/;

function validCachePath(value, platform = process.platform) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\0") && !/[\r\n]/.test(value) && isAbsolute(value)
    && !(platform === "win32" && WINDOWS_CMD_METACHARACTERS.test(value));
}

/**
 * Resolve the cache npm itself uses, with the operator's full npmrc chain. The transactional
 * stage pins this path with `--cache`: its `--prefix <stage>` moves npm's globalconfig to
 * `<stage>/etc/npmrc`, so without the pin a `cache=` from the global npmrc is silently dropped
 * and staging falls back to npm's default root — not the root this preflight checked (#6288).
 */
export function resolveNpmCachePath(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // Global mode, from the home directory: the staged install is `npm install -g`, which never
  // reads a project .npmrc, so a repository the user happens to run `ocx update` in must not be
  // able to choose the cache that install is pinned to.
  const invocation = (options.invocationFn ?? npmInvocation)(["config", "get", "cache", "--global"], platform, env);
  if (!invocation) return { ok: false, reason: "npm_unavailable" };
  const npm = (options.spawnSyncFn ?? spawnSync)(invocation.file, invocation.args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? NPM_CONFIG_TIMEOUT_MS,
    windowsHide: true,
    cwd: options.cwd ?? homedir(),
    ...invocation.options,
    env: invocation.options?.env ?? env,
  });
  if (npm?.status !== 0) return { ok: false, reason: "npm_config_failed" };
  const output = typeof npm.stdout === "string" ? npm.stdout.trim() : "";
  if (!validCachePath(output, platform)) return { ok: false, reason: "cache_path_malformed" };
  return { ok: true, path: output };
}

function workerResult(argv) {
  const rootOnly = argv.includes(ROOT_ONLY_ARG);
  const supplied = argv.find(arg => arg !== ROOT_ONLY_ARG);
  let cachePath;
  if (supplied !== undefined) {
    if (!validCachePath(supplied)) return { ok: false, reason: "cache_path_malformed" };
    cachePath = supplied;
  } else {
    const resolved = resolveNpmCachePath();
    if (!resolved.ok) return resolved;
    cachePath = resolved.path;
  }
  // Windows has no uid and no Unix owner bits, so the deep ownership/mode walk proves nothing
  // there; the root check is the part of the contract that holds on every platform.
  return rootOnly ? inspectNpmCacheRoot(cachePath) : inspectNpmCacheDirectory(cachePath);
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

/**
 * Run the bounded cache inspection in an isolated, synchronously-timeboxed worker. Pass
 * `cachePath` (from {@link resolveNpmCachePath}) to inspect exactly the root a later stage pins;
 * without it the worker resolves npm's cache itself.
 */
export function runNpmCachePreflight(options = {}) {
  const result = runPreflightWorker(options);
  // Before #6288 Windows skipped this gate entirely. Only the root shapes that make npm's own
  // mkdir fail with ENOTDIR may now refuse an update there; a slow or unavailable npm, a worker
  // timeout, or any other inconclusive result keeps the previous behavior instead of blocking.
  if ((options.platform ?? process.platform) === "win32" && !result.ok
    && !WINDOWS_BLOCKING_REASONS.has(result.reason)) {
    return { ok: true, reason: "windows_skip" };
  }
  return result;
}

const WINDOWS_BLOCKING_REASONS = new Set(["cache_root_dangling_link", "cache_root_not_directory"]);

function runPreflightWorker(options) {
  const workerArgs = [fileURLToPath(import.meta.url), WORKER_ARG];
  if ((options.platform ?? process.platform) === "win32") workerArgs.push(ROOT_ONLY_ARG);
  if (options.cachePath !== undefined) workerArgs.push(options.cachePath);
  const spawn = options.spawnSyncFn ?? spawnSync;
  const result = spawn(
    options.execPath ?? process.execPath,
    workerArgs,
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

/** Fixed operator guidance; worker/npm output and the cache path are intentionally never interpolated. */
export function npmCachePreflightFailureMessage(reason) {
  if (reason === "cache_root_dangling_link") {
    return `npm cache access pre-flight failed (${reason}); npm's cache folder (see 'npm config get cache') is a link or junction whose target is missing — recreate the target folder or remove the link, then retry`;
  }
  if (reason === "cache_root_not_directory") {
    return `npm cache access pre-flight failed (${reason}); npm's cache folder (see 'npm config get cache') or a folder above it is a file or an unavailable drive, so npm would fail with ENOTDIR on mkdir — fix that path or set a different cache, then retry`;
  }
  return `npm cache access pre-flight failed (${reason}); fix cache ownership and permissions, then retry`;
}

const isWorker = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && process.argv[2] === WORKER_ARG;
if (isWorker) {
  let result;
  try {
    result = workerResult(process.argv.slice(3));
  } catch {
    result = { ok: false, reason: "cache_entry_inaccessible" };
  }
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }));
}
