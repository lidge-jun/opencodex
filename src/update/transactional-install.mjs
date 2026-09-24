/**
 * Transactional npm self-update: stage -> verify -> swap -> rollback (#1942 / #1849).
 *
 * The legacy path ran `npm install -g` straight into the live global tree, so a
 * failure after npm removed the old files left a file-less package skeleton with no
 * recovery. This module stages the new version into a SIBLING directory of the live
 * package (same volume, so directory renames are atomic-ish and never cross devices),
 * verifies the staged tree with a manifest before anything live is touched, then swaps
 * live -> backup -> stage-into-live with a reverse-rename rollback on failure and a
 * recovery marker on double fault.
 *
 * Layout (siblings, never children — a child would travel WITH the live rename and the
 * live dir cannot move into its own subtree):
 *   <scopeDir>/opencodex                      live package
 *   <scopeDir>/.ocx-staging-<ts>/             npm --prefix root (contains node_modules/...)
 *   <scopeDir>/.ocx-backup-<ts>/opencodex     previous live tree during/after the swap
 *   <scopeDir>/.ocx-recovery.json             double-fault marker with a one-line restore
 *
 * A staging directory is created exclusively and immediately carries an ownership marker
 * (`.ocx-update-owner.json`). Only a marked staging directory is ever swept by a later
 * update; anything else next to the package — an unmarked stage from an older updater, npm's
 * own `.<name>-<random>` rename-aside, a link — is reported and left alone (#5624).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Dependency lookup confined to the candidate's OWN tree. This is the npm contract and it
 * must stay lexical: Node's resolver walks the ancestor directory chain, so a global npm
 * candidate at <prefix>/lib/node_modules/@scope/pkg could satisfy its bundled-Bun
 * requirement from <prefix>/lib/node_modules/bun, which belongs to a different package.
 * That verdict is not cosmetic — it accepts a stage that cannot start (D2), skips the
 * post-swap rollback, and lets bootRestoreProbe reap the only known-good backup.
 */
function candidateTreeDependencyDir(packageDir, name) {
  const dir = join(packageDir, "node_modules", ...name.split("/"));
  return existsSync(join(dir, "package.json")) ? dir : undefined;
}

/**
 * The candidate's own bun directory, whether or not it carries a readable package.json.
 * The size gate keys on the DIRECTORY, matching the pre-carry verifier: a half-extracted
 * node_modules/bun holding a truncated binary and no manifest is still a broken tree, and
 * bun is not always among the sentinels, so the sentinel loop cannot be relied on to catch it.
 */
function ownTreeBunDir(packageDir) {
  const dir = join(packageDir, "node_modules", "bun");
  return existsSync(dir) ? dir : undefined;
}

/** The node_modules directory a package sits directly inside, or undefined. */
function enclosingNodeModules(packageDir) {
  const parent = dirname(packageDir);
  if (basename(parent) === "node_modules") return parent;
  // Scoped packages live one level deeper: <node_modules>/@scope/name.
  const grandparent = dirname(parent);
  if (basename(parent).startsWith("@") && basename(grandparent) === "node_modules") return grandparent;
  return undefined;
}

/** pnpm's own bookkeeping at the root of a node_modules tree it manages. */
function isPnpmManagedRoot(nodeModulesDir) {
  if (!nodeModulesDir) return false;
  if (nodeModulesDir.split(/[\\/]/).includes(".pnpm")) return true;
  return existsSync(join(nodeModulesDir, ".pnpm")) || existsSync(join(nodeModulesDir, ".modules.yaml"));
}

/**
 * Dependency roots this package INSTANCE owns. pnpm exposes dependencies in several shapes —
 * symlinks inside the package's own node_modules, a package root that is itself a symlink into
 * the virtual store, or a hoisted group root — so the npm rule alone rejects healthy trees.
 * Ownership is still bounded: an enclosing node_modules counts only when pnpm's own metadata
 * says pnpm manages it, which keeps an unrelated ancestor installation out.
 */
function ownedDependencyRoots(packageDir) {
  const roots = [];
  const add = dir => { if (dir && !roots.includes(dir)) roots.push(dir); };
  const lexicalGroup = enclosingNodeModules(packageDir);
  add(join(packageDir, "node_modules"));
  let real;
  try { real = realpathSync(packageDir); } catch { /* keep the lexical path only */ }
  if (real && real !== packageDir) add(join(real, "node_modules"));
  if (isPnpmManagedRoot(lexicalGroup)) add(lexicalGroup);
  const realGroup = real ? enclosingNodeModules(real) : undefined;
  if (isPnpmManagedRoot(realGroup)) add(realGroup);
  return roots;
}

/**
 * pnpm dependency lookup. Probing the owned roots directly, rather than filtering whatever
 * Node's resolver returned, is deliberate: require.resolve reports the REALPATH of the
 * resolved file, so a dependency reached through pnpm's own node_modules symlink comes back
 * as a virtual-store path that no lexical ownership test can recognise. existsSync follows
 * the symlink, which is exactly the pnpm graph edge that proves ownership.
 */
function pnpmOwnedDependencyDir(packageDir, name) {
  for (const root of ownedDependencyRoots(packageDir)) {
    const dir = join(root, ...name.split("/"));
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return undefined;
}

/** Verification manifest for a staged (or live) package tree. */
function verifyTreeWithDependencyLookup(packageDir, expectedVersion, dependencyDir) {
  const failures = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch (error) {
    return { ok: false, failures: ["package.json unreadable: " + (error?.message ?? String(error))] };
  }
  if (expectedVersion && pkg.version !== expectedVersion) {
    failures.push("package.json version " + pkg.version + " != expected " + expectedVersion);
  }
  const launcher = join(packageDir, "bin", "ocx.mjs");
  try {
    const st = statSync(launcher);
    if (!st.isFile() || st.size < 1024) failures.push("bin/ocx.mjs missing or truncated");
  } catch {
    failures.push("bin/ocx.mjs absent");
  }
  // The bundled Bun binary is the load-bearing artifact: without it the launcher exits
  // before serving anything, and a boot probe that called this tree healthy would reap
  // the only backup (review High 3). Size-gate the real binary, not just its package.json.
  const bunPkgDir = dependencyDir(packageDir, "bun") ?? ownTreeBunDir(packageDir);
  if (bunPkgDir) {
    const bunBinary = findLargestFile(bunPkgDir);
    if (!bunBinary || bunBinary.size < 10 * 1024 * 1024) {
      failures.push("bundled Bun binary missing or truncated (< 10MB)");
    }
  }
  // Sentinel direct deps: each must have an intact package.json. The bundled Bun dep is
  // the load-bearing one — without it the launcher cannot start the proxy at all.
  const deps = Object.keys(pkg.dependencies ?? {});
  const sentinels = deps.filter(name => name === "bun" || name === "zod").length > 0
    ? deps.filter(name => name === "bun" || name === "zod")
    : deps.slice(0, 2);
  for (const name of sentinels) {
    if (!dependencyDir(packageDir, name)) failures.push("sentinel dependency missing: " + name);
  }
  return failures.length === 0 ? { ok: true, failures: [] } : { ok: false, failures };
}

/**
 * npm (and every recovery decision): the candidate must be self-contained. Used by
 * transactionalNpmUpdate's stage and post-swap checks and by bootRestoreProbe.
 */
export function verifyInstallTree(packageDir, expectedVersion) {
  return verifyTreeWithDependencyLookup(packageDir, expectedVersion, candidateTreeDependencyDir);
}

/**
 * Verify a package exposed through pnpm's global virtual store. pnpm 10/11 may use an
 * isolated virtual store, a custom virtualStoreDir, global virtual-store links, or a
 * hoisted linker, so the dependency may sit outside the package directory — but it must
 * still be reachable through a root this package instance owns.
 */
export function verifyPnpmInstallTree(packageDir, expectedVersion) {
  return verifyTreeWithDependencyLookup(packageDir, expectedVersion, pnpmOwnedDependencyDir);
}

function stampedName(prefix) {
  return prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-");
}

export const UPDATE_OWNER_MARKER = ".ocx-update-owner.json";
const STAGE_PREFIX = ".ocx-staging-";
/**
 * A marked stage younger than this is left alone by the sweep. npm's staging install is bounded
 * at three minutes by the launcher; the floor is far above it so an update running from another
 * home against the same global prefix never loses its in-flight stage.
 */
export const STALE_STAGE_MIN_AGE_MS = 30 * 60 * 1000;
const RETRYABLE_REMOVE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/** Create a fresh staging directory that did not exist before, and mark it as ours. */
function createOwnedStage(scopeDir, pkgName, deps = {}) {
  const mkdir = deps.mkdir ?? mkdirSync;
  const stageRoot = join(scopeDir, stampedName(".ocx-staging") + "-" + randomBytes(4).toString("hex"));
  // Not recursive: an existing directory of the same name must fail, never be reused.
  mkdir(stageRoot);
  try {
    writeFileSync(join(stageRoot, UPDATE_OWNER_MARKER), JSON.stringify({
      schema: 1,
      kind: "staging",
      pkgName,
      pid: process.pid,
      createdAt: (deps.now ?? Date.now)(),
    }), { flag: "wx" });
  } catch (error) {
    // Still empty and created by this call: remove it rather than leave an unmarked stage.
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* reported by the caller */ }
    throw error;
  }
  return stageRoot;
}

/** The marker of a real (non-link) staging directory this updater created, or null. */
function readOwnedStageMarker(dir, pkgName) {
  try {
    const dirStat = lstatSync(dir);
    // A symlink or junction is never ours to delete: removing through it reaches its target.
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const markerPath = join(dir, UPDATE_OWNER_MARKER);
    if (!lstatSync(markerPath).isFile()) return null;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker?.schema !== 1 || marker.kind !== "staging" || marker.pkgName !== pkgName) return null;
    if (typeof marker.createdAt !== "number" || !Number.isFinite(marker.createdAt)) return null;
    return marker;
  } catch {
    return null;
  }
}

function removeWithRetry(rm, target, attempts = 3) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rm(target, { recursive: true, force: true });
      return null;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "EUNKNOWN";
      if (!RETRYABLE_REMOVE_CODES.has(code) || attempt >= attempts - 1) return code;
      const until = Date.now() + 100 * (attempt + 1);
      while (Date.now() < until) { /* brief synchronous backoff, as renameWithRetry */ }
    }
  }
}

/**
 * Remove an owned staging directory. The marker goes last and only once everything else is
 * gone, so a tree held open by a running executable (the reported locked `bunx.exe`) stays
 * provably ours and the next update can finish the job.
 */
export function removeOwnedStage(stageRoot, deps = {}) {
  const rm = deps.rm ?? rmSync;
  let names;
  try {
    names = readdirSync(stageRoot);
  } catch (error) {
    return error?.code === "ENOENT" ? { removed: true } : { removed: false, code: error?.code ?? "EUNKNOWN" };
  }
  let failure = null;
  for (const name of names) {
    if (name === UPDATE_OWNER_MARKER) continue;
    const code = removeWithRetry(rm, join(stageRoot, name));
    if (code && !failure) failure = code;
  }
  if (failure) return { removed: false, code: failure };
  const markerCode = removeWithRetry(rm, join(stageRoot, UPDATE_OWNER_MARKER));
  if (markerCode) return { removed: false, code: markerCode };
  const dirCode = removeWithRetry(rm, stageRoot);
  return dirCode ? { removed: false, code: dirCode } : { removed: true };
}

/**
 * Clear what earlier update attempts left next to the package, without ever deleting anything
 * this updater cannot prove it created. Never throws and never fails the update: every stage is
 * a fresh, uniquely named directory, so a leftover can only cost disk space, not block staging.
 */
export function sweepUpdateLeftovers({ packageDir, pkgName, log = () => {}, deps = {} }) {
  const scopeDir = dirname(packageDir);
  const now = (deps.now ?? Date.now)();
  const result = { removed: [], inUse: [], recent: [], notOwned: [] };
  let names = [];
  try {
    names = readdirSync(scopeDir);
  } catch {
    return result;
  }
  // npm renames a package it is replacing to ".<name>-<random>" during a direct global install.
  const renameAsidePrefix = "." + basename(packageDir) + "-";
  for (const name of names.sort()) {
    const full = join(scopeDir, name);
    if (name.startsWith(STAGE_PREFIX)) {
      const marker = readOwnedStageMarker(full, pkgName);
      if (!marker) {
        result.notOwned.push(full);
      } else if (now - marker.createdAt < STALE_STAGE_MIN_AGE_MS) {
        result.recent.push(full);
      } else {
        const removal = removeOwnedStage(full, deps);
        if (removal.removed) result.removed.push(full);
        else result.inUse.push({ path: full, code: removal.code });
      }
    } else if (name.startsWith(renameAsidePrefix)) {
      result.notOwned.push(full);
    }
  }
  // Names only: the full path under a user-scoped npm prefix carries the account name, and
  // this logger is the launcher's console.
  for (const path of result.removed) log("Removed a staging directory left by an earlier update: " + basename(path));
  for (const entry of result.inUse) {
    log("Left an earlier update's staging directory in place (" + entry.code + "; a file inside is still in use); the next update retries it: " + basename(entry.path));
  }
  for (const path of result.notOwned) {
    log("Not removing " + basename(path) + " next to the package: this updater did not create it. Delete it by hand once no OpenCodex process is running from it.");
  }
  return result;
}

/** Whether the launcher that ran this npm update can still drive service/tray recovery. */
export function launcherUsableAfterNpmUpdate(tx) {
  return Boolean(tx?.ok || tx?.rolledBack === true || ["stage", "verify", "swap-backup"].includes(tx?.phase));
}

/** Largest regular file under a directory tree (bounded depth) — locates the Bun binary. */
function findLargestFile(root, depth = 3) {
  let best;
  let names = [];
  try { names = readdirSync(root); } catch { return undefined; }
  for (const name of names) {
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isFile()) {
      if (!best || st.size > best.size) best = { path: full, size: st.size };
    } else if (st.isDirectory() && depth > 0) {
      const sub = findLargestFile(full, depth - 1);
      if (sub && (!best || sub.size > best.size)) best = sub;
    }
  }
  return best;
}

/** Bounded Windows-class rename retry: EPERM/EBUSY/EACCES from AV/indexers clears in ms. */
function renameWithRetry(rename, from, to, attempts = 5) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = error?.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= attempts - 1) throw error;
      // Synchronous bounded backoff (launcher context has no async loop here).
      const until = Date.now() + 100 * (attempt + 1);
      while (Date.now() < until) { /* spin briefly; total worst case ~1.5s */ }
    }
  }
}

function recoveryMarkerPath(scopeDir) {
  return join(scopeDir, ".ocx-recovery.json");
}

/** Startup probe: restore a backup when the live tree is broken (D4 power-loss rows). */
export function bootRestoreProbe(packageDir, deps = {}) {
  const rename = deps.rename ?? renameSync;
  const scopeDir = dirname(packageDir);
  let backups = [];
  try {
    backups = readdirSync(scopeDir).filter(name => name.startsWith(".ocx-backup-")).sort();
  } catch {
    return { action: "none" };
  }
  if (backups.length === 0) return { action: "none" };
  const liveOk = existsSync(join(packageDir, "package.json"))
    && verifyInstallTree(packageDir).ok;
  const newestBackup = join(scopeDir, backups[backups.length - 1], "opencodex");
  if (liveOk) {
    // Live is healthy: the backups are leftovers from a completed swap. Reap them.
    for (const name of backups) {
      try { rmSync(join(scopeDir, name), { recursive: true, force: true }); } catch { /* keep */ }
    }
    try { rmSync(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* keep */ }
    return { action: "reaped", count: backups.length };
  }
  if (!existsSync(join(newestBackup, "package.json"))) return { action: "none" };
  try {
    try { rmSync(packageDir, { recursive: true, force: true }); } catch { /* may not exist */ }
    rename(newestBackup, packageDir);
    return { action: "restored", from: newestBackup };
  } catch (error) {
    return { action: "failed", error: error?.message ?? String(error) };
  }
}

/**
 * Run the transactional update. `runNpm(args, opts)` is injected so the caller keeps
 * its hardened npm resolution (npm-invocation.mjs) and logging.
 */
export function transactionalNpmUpdate({
  packageDir,
  pkgName,
  targetVersion,
  tag,
  runNpm,
  log = () => {},
  deps = {},
}) {
  const rename = deps.rename ?? renameSync;
  const scopeDir = dirname(packageDir);
  // Leftovers from earlier attempts are cleared or stepped around first; this never fails.
  try { sweepUpdateLeftovers({ packageDir, pkgName, log, deps }); } catch { /* report-only */ }
  let stageRoot;
  // GLOBAL-style staging (-g --prefix): npm nests the package's dependencies INSIDE the
  // package dir, exactly like the live global tree this stage will replace. A local-style
  // install would hoist bun/zod to stageRoot/node_modules — siblings that the swap would
  // leave behind, shipping a dependency-less live tree (release-audit blocker).
  // Layout: <stageRoot>/lib/node_modules/<pkg> on POSIX, <stageRoot>/node_modules/<pkg>
  // on Windows.

  // D1: stage to the side. --prefix keeps npm entirely inside stageRoot; the live tree
  // and the npm bin shims are untouched until the swap. A failure HERE (mkdir EACCES,
  // ENOSPC) must NOT fall back to the destructive legacy install (review High 4): the
  // caller sees a normal phase failure with live untouched.
  try {
    stageRoot = createOwnedStage(scopeDir, pkgName, deps);
  } catch (error) {
    return { ok: false, phase: "stage", error: "could not create staging directory: " + (error?.message ?? String(error)) };
  }
  const stagedCandidatesIn = root => [
    join(root, "lib", "node_modules", ...pkgName.split("/")),
    join(root, "node_modules", ...pkgName.split("/")),
  ];
  const discardStage = () => {
    const removal = removeOwnedStage(stageRoot, deps);
    if (!removal.removed) {
      log("Left this update's staging directory in place (" + removal.code + "; a file inside is still in use); the next update removes it: " + basename(stageRoot));
    }
  };
  const spec = pkgName + "@" + (targetVersion || tag);
  log("Staging " + spec + " into " + basename(stageRoot) + " next to the package");
  // npm 12 blocks lifecycle scripts by default. Bun's postinstall copies the selected
  // @oven/bun-* executable into bun/bin, so a successful npm exit without this narrow
  // approval leaves the staged tree intentionally incomplete. Allow only the package
  // whose executable the manifest verifies below; never broaden this to all scripts.
  const install = runNpm([
    "install", "-g", "--prefix", stageRoot,
    "--allow-scripts=bun", "--no-audit", "--no-fund", spec,
  ]);
  if (install.status !== 0) {
    discardStage();
    return { ok: false, phase: "stage", error: "npm staging install failed (" + (install.status ?? "?") + ")" };
  }
  const stagedPackage = stagedCandidatesIn(stageRoot).find(dir => existsSync(join(dir, "package.json")));
  if (!stagedPackage) {
    discardStage();
    return { ok: false, phase: "verify", error: "staged package directory not found under " + stageRoot };
  }

  // D2: verify INSIDE the stage. Live is still untouched on any failure here.
  const staged = verifyInstallTree(stagedPackage, targetVersion || undefined);
  if (!staged.ok) {
    discardStage();
    return { ok: false, phase: "verify", error: "staged tree failed verification: " + staged.failures.join("; ") };
  }

  // D3: swap. live -> backup, stage -> live, re-verify live, rollback on failure.
  const backupRoot = join(scopeDir, stampedName(".ocx-backup"));
  const backupPackage = join(backupRoot, "opencodex");
  try {
    mkdirSync(backupRoot, { recursive: true });
  } catch (error) {
    discardStage();
    return { ok: false, phase: "swap-backup", error: "could not create backup directory: " + (error?.message ?? String(error)) };
  }
  try {
    renameWithRetry(rename, packageDir, backupPackage);
  } catch (error) {
    discardStage();
    try { rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "swap-backup", error: "could not move live tree aside: " + (error?.message ?? String(error)) };
  }
  try {
    renameWithRetry(rename, stagedPackage, packageDir);
  } catch (error) {
    // Rollback: reverse the first rename. Double fault leaves the recovery marker.
    try {
      renameWithRetry(rename, backupPackage, packageDir);
      discardStage();
      try { rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, phase: "swap-live", rolledBack: true, error: "could not place staged tree: " + (error?.message ?? String(error)) };
    } catch (rollbackError) {
      writeFileSync(recoveryMarkerPath(scopeDir), JSON.stringify({
        at: new Date().toISOString(),
        backup: backupPackage,
        live: packageDir,
        restore: 'move "' + backupPackage + '" back to "' + packageDir + '"',
        error: String(error?.message ?? error),
        rollbackError: String(rollbackError?.message ?? rollbackError),
      }, null, 2));
      return { ok: false, phase: "double-fault", rolledBack: false, error: "swap and rollback both failed; recovery marker written at " + recoveryMarkerPath(scopeDir) };
    }
  }
  const liveCheck = verifyInstallTree(packageDir, targetVersion || undefined);
  if (!liveCheck.ok) {
    try {
      // Move the rejected tree into our own stage instead of deleting it in place: a file held
      // open there must not turn a clean rollback into a double fault. The stage's marker keeps
      // it sweepable by the next update.
      renameWithRetry(rename, packageDir, join(stageRoot, "rejected"));
      renameWithRetry(rename, backupPackage, packageDir);
      discardStage();
      try { rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, phase: "post-verify", rolledBack: true, error: "live tree failed post-swap verification: " + liveCheck.failures.join("; ") };
    } catch (rollbackError) {
      writeFileSync(recoveryMarkerPath(scopeDir), JSON.stringify({
        at: new Date().toISOString(),
        backup: backupPackage,
        live: packageDir,
        restore: 'move "' + backupPackage + '" back to "' + packageDir + '"',
        error: "post-swap verification failed: " + liveCheck.failures.join("; "),
        rollbackError: String(rollbackError?.message ?? rollbackError),
      }, null, 2));
      return { ok: false, phase: "double-fault", rolledBack: false, error: "post-verify rollback failed; recovery marker written" };
    }
  }
  // Success: stage scaffolding is disposable now; the backup stays until the next
  // healthy boot reaps it (bootRestoreProbe) — the process that spawned this update may
  // still hold the old cwd.
  discardStage();
  return { ok: true, phase: "done", backup: backupPackage };
}
