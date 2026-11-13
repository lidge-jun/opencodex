import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, win32 } from "node:path";
import { pnpmInvocationForPath } from "./pnpm-invocation.mjs";
import { pnpmPackageUsesGlobalStoreLinks, verifyPnpmInstallTree } from "./transactional-install.mjs";

export const PNPM_BUILD_APPROVAL = "--allow-build=bun";

/**
 * pnpm majors whose global virtual-store install and `store path --dir=<pnpm home>` were checked to
 * select the same store (11.20.0, 12.16.1). Another major refuses rather than assumes the same rules.
 */
const VERIFIED_GLOBAL_STORE_MAJORS = new Set([11, 12]);

/** Characters cmd.exe re-parses after quoting (same set as the npm cache preflight). */
const WINDOWS_CMD_METACHARACTERS = /["%!^&|<>]/;

/**
 * On Windows pnpm.cmd re-parses its arguments in cmd.exe after quoting, so a global-store owner whose
 * pnpm home, global directory or global bin directory carries one of these characters is refused
 * before any owner-pinned pnpm command receives them (the npm cache preflight refuses the same set).
 */
function windowsCmdPathRefusal(owner, env, platform) {
  if (platform !== "win32") return null;
  const paths = [owner?.homeAnchor ?? pnpmHomeAnchor(env, platform), owner?.globalDir, owner?.globalBinDir];
  return paths.some(path => WINDOWS_CMD_METACHARACTERS.test(String(path ?? "")))
    ? { ok: false, reason: "pnpm path contains a character cmd.exe cannot pass safely" } : null;
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

function pathKey(value, platform = process.platform) {
  const raw = String(value).replaceAll("\\", "/");
  const normalise = path => {
    const result = path.replaceAll("\\", "/");
    return platform === "win32" ? result.toLowerCase() : result;
  };
  try {
    return normalise(realpathSync.native(raw));
  } catch {
    return normalise(resolve(raw));
  }
}

function lexicalPathKey(value, platform = process.platform) {
  const result = resolve(String(value).replaceAll("\\", "/")).replaceAll("\\", "/");
  return platform === "win32" ? result.toLowerCase() : result;
}

function samePath(left, right, platform = process.platform) {
  return pathKey(left, platform) === pathKey(right, platform)
    || lexicalPathKey(left, platform) === lexicalPathKey(right, platform);
}

function singleAbsoluteCommandPath(runPnpm, commandPath, args, platform = process.platform) {
  let result;
  try {
    result = runPnpm(commandPath, args, true);
  } catch {
    return null;
  }
  if (result?.status !== 0) return null;
  const lines = outputText(result.stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1 || /^(?:undefined|null)$/i.test(lines[0])) return null;
  return isAbsolutePath(lines[0], platform) ? lines[0] : null;
}

function configPathValue(runPnpm, commandPath, key, platform = process.platform) {
  return singleAbsoluteCommandPath(runPnpm, commandPath, ["config", "get", key], platform);
}

function absoluteConfigPath(value, platform = process.platform) {
  return typeof value === "string" && isAbsolutePath(value, platform) ? value : null;
}

function isAbsolutePath(value, platform = process.platform) {
  if (typeof value !== "string") return false;
  return isAbsolute(value) || (
    platform === "win32"
    && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String(value))
  );
}

function pathDirname(value, platform = process.platform) {
  return platform === "win32" ? win32.dirname(String(value)) : dirname(value);
}

function pathBasename(value, platform = process.platform) {
  return platform === "win32" ? win32.basename(String(value)) : basename(value);
}

/** Normalize pnpm list/root output to the versioned global group, not its node_modules root. */
function normaliseGlobalRoot(value, platform = process.platform) {
  if (!isAbsolutePath(value, platform)) return null;
  const trimmed = String(value).replace(/[\\/]+$/, "");
  return pathBasename(trimmed, platform).toLowerCase() === "node_modules"
    ? pathDirname(trimmed, platform)
    : trimmed;
}

/** pnpm's --global-dir is the base; pnpm appends the major-version group below it. */
function globalDirFromRoot(globalRoot, platform = process.platform) {
  const separator = platform === "win32" ? /[\\/]/ : /\//;
  const match = String(globalRoot).match(new RegExp(`^(.*)${separator.source}(?:v)?\\d+$`, "i"));
  return match?.[1] || globalRoot;
}

function globalRootMatchesDir(globalRoot, globalDir, platform = process.platform) {
  return samePath(globalRoot, globalDir, platform)
    || samePath(pathDirname(globalRoot, platform), globalDir, platform);
}

/** Resolve manager-owned global paths, including pnpm defaults that config get leaves undefined. */
function resolveGlobalPaths(commandPath, runPnpm, listedRoot, platform = process.platform) {
  const listedGlobalRoot = normaliseGlobalRoot(listedRoot, platform);
  const commandGlobalRoot = normaliseGlobalRoot(
    singleAbsoluteCommandPath(runPnpm, commandPath, ["root", "-g"], platform),
    platform,
  );
  if (listedGlobalRoot && commandGlobalRoot && !samePath(listedGlobalRoot, commandGlobalRoot, platform)) {
    return null;
  }
  const globalRoot = commandGlobalRoot ?? listedGlobalRoot;
  if (!globalRoot) return null;

  const configuredGlobalDir = absoluteConfigPath(configPathValue(runPnpm, commandPath, "global-dir", platform), platform);
  const globalDir = configuredGlobalDir ?? globalDirFromRoot(globalRoot, platform);
  const configuredGlobalBinDir = absoluteConfigPath(configPathValue(runPnpm, commandPath, "global-bin-dir", platform), platform);
  const globalBinDir = configuredGlobalBinDir
    ?? absoluteConfigPath(singleAbsoluteCommandPath(runPnpm, commandPath, ["bin", "-g"], platform), platform);
  if (!globalDir || !globalBinDir || !globalRootMatchesDir(globalRoot, globalDir, platform)) return null;
  return { globalDir, globalRoot, globalBinDir };
}

function packageEntryFromRoot(root, packageName) {
  const maps = [root?.dependencies, root?.devDependencies, root?.optionalDependencies];
  for (const dependencies of maps) {
    if (!dependencies || typeof dependencies !== "object") continue;
    const direct = dependencies[packageName];
    if (direct && typeof direct === "object") return direct;
  }
  return null;
}

function inspectListOutput(stdout, packageName) {
  let roots;
  try {
    roots = JSON.parse(outputText(stdout));
  } catch {
    return null;
  }
  if (!Array.isArray(roots)) return null;
  for (const root of roots) {
    const entry = packageEntryFromRoot(root, packageName);
    if (entry) return { root, entry };
  }
  return null;
}

function ownerGlobalArgs(args, owner) {
  const input = [...args];
  if (!owner) return input;
  const command = input[0];
  if (!["add", "install", "update", "list", "remove", "uninstall"].includes(command)) return input;
  const rest = [];
  for (let index = 1; index < input.length; index += 1) {
    const arg = input[index];
    // The owner is authoritative. Remove an accidentally inherited/supplied value rather
    // than relying on duplicate pnpm flags having stable precedence across pnpm 10/11.
    if (arg === "--global-dir" || arg.startsWith("--global-dir=")) {
      if (arg === "--global-dir") index += 1;
      continue;
    }
    if (arg === "--config.global-bin-dir" || arg.startsWith("--config.global-bin-dir=")) {
      if (arg === "--config.global-bin-dir") index += 1;
      continue;
    }
    if (owner.storePath && (arg === "--store-dir" || arg.startsWith("--store-dir=")
      || arg === "--config.store-dir" || arg.startsWith("--config.store-dir="))) {
      if (arg === "--store-dir" || arg === "--config.store-dir") index += 1;
      continue;
    }
    rest.push(arg);
  }
  return [
    command,
    `--global-dir=${owner.globalDir}`,
    `--config.global-bin-dir=${owner.globalBinDir}`,
    ...(["add", "install", "update", "remove", "uninstall"].includes(command) && owner.storePath ? [`--store-dir=${owner.storePath}`] : []),
    ...rest,
  ];
}

/** Add the selected pnpm global group and bin directory to a command's config. */
export function pnpmGlobalCommandArgs(args, owner) {
  return ownerGlobalArgs(args, owner);
}

/**
 * Add the owning global bin directory to PATH for commands such as pnpm's bin
 * validation. Do not replace PATH: registry auth and the selected pnpm executable
 * can depend on the rest of the inherited environment.
 */
export function pnpmOwnerEnvironment(owner, env = process.env, platform = process.platform) {
  const key = platform === "win32" && env.Path !== undefined && env.PATH === undefined ? "Path" : "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const existing = env[key] ?? env.PATH ?? env.Path ?? "";
  const entries = String(existing).split(delimiter).filter(Boolean);
  if (!entries.some(entry => samePath(entry, owner.globalBinDir, platform))) entries.unshift(owner.globalBinDir);
  return { ...env, [key]: entries.join(delimiter) };
}

/** Build an invocation for the already-selected pnpm executable and global group. */
export function pnpmOwnerInvocation(owner, args, platform = process.platform, env = process.env) {
  const ownerEnv = pnpmOwnerEnvironment(owner, env, platform);
  const invocation = pnpmInvocationForPath(
    owner.commandPath,
    ownerGlobalArgs(args, owner),
    platform,
    ownerEnv,
  );
  return invocation ? { ...invocation, env: ownerEnv } : null;
}

function shimNames(platform) {
  return platform === "win32"
    ? ["ocx.cmd", "ocx.ps1", "opencodex.cmd", "opencodex.ps1"]
    : ["ocx", "opencodex"];
}

function targetVariants(packageDir, globalBinDir, platform) {
  const packageCandidates = [packageDir];
  try { packageCandidates.push(realpathSync(packageDir)); } catch { /* keep lexical path */ }
  const binCandidates = [globalBinDir];
  try { binCandidates.push(realpathSync(globalBinDir)); } catch { /* keep lexical path */ }
  const launcherCandidates = packageCandidates.map(candidate => join(candidate, "bin", "ocx.mjs"));
  const relativeCandidates = binCandidates.flatMap(bin => launcherCandidates.map(candidate => relative(bin, candidate)));
  return [...new Set([...launcherCandidates, ...relativeCandidates].map(value => {
    const normalised = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
    return platform === "win32" ? normalised.toLowerCase() : normalised;
  }))].filter(Boolean);
}

function shimPointsToPackage(shimPath, packageDir, globalBinDir, platform) {
  try {
    if (samePath(shimPath, join(packageDir, "bin", "ocx.mjs"), platform)) return true;
  } catch { /* fall through to text inspection */ }
  let text;
  try {
    text = readFileSync(shimPath, "utf8").replaceAll("\\", "/");
    if (platform === "win32") text = text.toLowerCase();
  } catch {
    return false;
  }
  // A comment containing the new path is not a launcher. Generated cmd/PowerShell
  // shims are simple enough that the target appears on an executable line; discard
  // shebang/hash and REM lines before matching so a stale or hand-edited shim cannot
  // pass verification by mentioning the right package in a comment.
  const executableText = text.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith("#") && !/^rem(?:\s|$)/i.test(trimmed);
  }).join("\n");
  const expectedLauncher = join(packageDir, "bin", "ocx.mjs");
  if (shimTargetPaths(shimPath, executableText, platform).some(target => samePath(target, expectedLauncher, platform))) {
    return true;
  }
  return targetVariants(packageDir, globalBinDir, platform).some(target => executableText.includes(target));
}

function shimIsRunnable(shimPath, platform) {
  if (platform === "win32") return true;
  try {
    return (statSync(shimPath).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function shimTargetPaths(shimPath, text, platform) {
  const targets = [];
  const launcherPattern = /((?:\$basedir(?:_win)?|\$PSScriptRoot|%~dp0|[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^"'`\r\n]*[\\/]bin[\\/]ocx\.mjs)/gi;
  const shimDir = pathDirname(shimPath, platform);
  for (const match of text.matchAll(launcherPattern)) {
    let target = match[1];
    target = target.replace(/\$basedir_win|\$basedir|\$PSScriptRoot|%~dp0/gi, shimDir);
    target = target.replaceAll("\\", "/");
    targets.push(isAbsolutePath(target, platform)
      ? target
      : platform === "win32" ? win32.resolve(shimDir, target) : resolve(shimDir, target));
  }
  return targets;
}

/**
 * Verify both generated command names and all launcher forms pnpm supports for
 * the current platform. A package list/tree check is not enough: a stale shim
 * can still execute the old global group after pnpm changes the active link.
 */
export function verifyPnpmGlobalShims(
  packageDir,
  globalBinDir,
  platform = process.platform,
  exists = existsSync,
) {
  if (!isAbsolutePath(globalBinDir, platform)) {
    return { ok: false, reason: "pnpm global bin directory is not absolute" };
  }
  const missing = [];
  for (const name of shimNames(platform)) {
    const path = join(globalBinDir, name);
    if (
      !exists(path)
      || !shimIsRunnable(path, platform)
      || !shimPointsToPackage(path, packageDir, globalBinDir, platform)
    ) missing.push(name);
  }
  return missing.length === 0
    ? { ok: true }
    : { ok: false, reason: `pnpm generated shim verification failed (${missing.join(", ")})` };
}

function commandLines(result) {
  return outputText(result?.stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/**
 * The directory pnpm loads its global configuration from (pnpm home): PNPM_HOME, then
 * XDG_DATA_HOME/pnpm, then the platform default. It is read from the environment the pnpm
 * commands receive, so the anchor and the commands agree.
 */
export function pnpmHomeAnchor(env = process.env, platform = process.platform) {
  const value = key => typeof env?.[key] === "string" && env[key].trim() ? env[key] : null;
  const joinPath = platform === "win32" ? win32.join : join;
  let anchor = null;
  if (value("PNPM_HOME")) anchor = value("PNPM_HOME");
  else if (value("XDG_DATA_HOME")) anchor = joinPath(value("XDG_DATA_HOME"), "pnpm");
  else if (platform === "win32") anchor = value("LOCALAPPDATA") ? win32.join(value("LOCALAPPDATA"), "pnpm") : null;
  else if (value("HOME")) {
    anchor = platform === "darwin" ? join(value("HOME"), "Library", "pnpm") : join(value("HOME"), ".local", "share", "pnpm");
  }
  // A control character could split a cmd.exe command line on Windows; such a home is never trusted.
  return anchor && isAbsolutePath(anchor, platform) && !/[\u0000-\u001f\u007f]/.test(anchor) ? anchor : null;
}

/**
 * Classify a spelling used as a confinement root (pnpm home, store path, global group). It is trusted
 * only when it is already canonical: no "." or ".." segment (path.resolve would delete them without
 * visiting the links they cross), no link or junction component, and realpath returns the same path.
 * Case is folded for the last comparison only; a case-only symlink is caught by the component walk.
 * Returns "link", "noncanonical" or "ok"; throws when the path is missing or not a directory.
 */
function spellingTrust(path) {
  const raw = String(path);
  const { root } = parse(raw);
  const parts = raw.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (!root || parts.some(part => part === "." || part === "..")) return "noncanonical";
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) return "link";
  }
  if (!statSync(raw).isDirectory()) throw new Error("not a directory");
  const fold = value => resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return fold(realpathSync.native(raw)) === fold(raw) ? "ok" : "noncanonical";
}

/** Map a spelling's trust to the refusal reason for the named root, or null when trusted. */
function spellingRefusal(path, label) {
  const trust = spellingTrust(path);
  if (trust === "link") return label + " has a symbolic link component";
  if (trust === "noncanonical") return label + " is not a canonical path";
  return null;
}

/** Appended to a store-proof refusal for an install whose path looks like a pnpm global store. */
const STORE_PROOF_HINT = "; this install's path looks like a pnpm global store (a store links directory or pnpm store markers), "
  + "so the updater accepts it only when pnpm 11 or 12 names that store. Update with pnpm itself: "
  + "pnpm add -g @bitkyc08/opencodex@latest";

/** Filesystem identity of a directory (device and inode), or null when it is not a readable directory. */
function directoryIdentity(path) {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch { return null; }
}

/**
 * A store owner's store and global group are pinned by filesystem identity for one update transaction, so a
 * directory replaced at the same canonical path between the proof and a pnpm mutation (install or rollback)
 * stops the transaction instead of receiving the mutation.
 */
function pinStoreOwnerIdentity(owner) {
  const group = directoryIdentity(owner.globalRoot), store = directoryIdentity(owner.store);
  return {
    refusal() {
      if (!group || directoryIdentity(owner.globalRoot) !== group) return "pnpm global group was replaced or could not be read";
      if (!store || directoryIdentity(owner.store) !== store) return "pnpm configured store was replaced or could not be read";
      return null;
    },
  };
}

/** Store-proof failures are configuration facts, not package-tree failures. */
function isStoreProofFailure(reason) {
  return typeof reason === "string" && (reason.startsWith("pnpm configured store")
    || reason.startsWith("pnpm virtual-store") || reason.startsWith("pnpm store path")
    || reason.startsWith("pnpm home") || reason.startsWith("pnpm global-store behavior")
    // A global group that lost its canonical spelling is a configuration fact too: no rollback through it.
    || reason.startsWith("pnpm global group"));
}

/**
 * Ask the selected pnpm which store it uses for its global configuration. The answer counts only
 * when the pnpm version is one whose global-store behavior was checked, the anchor is a real
 * directory with no symbolic link component, and pnpm prints exactly one absolute versioned path.
 * The lexical path and its canonical target are pinned separately and both must stay unchanged.
 */
function readPnpmStore(runPnpm, owner, platform, env = process.env) {
  const unsafe = windowsCmdPathRefusal(owner, env, platform);
  if (unsafe) return unsafe;
  let pnpmVersion;
  try {
    const result = runPnpm(["--version"], true);
    const lines = commandLines(result);
    if (result?.status === 0 && lines.length === 1) pnpmVersion = lines[0];
  } catch { /* refused below */ }
  const major = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/.exec(pnpmVersion ?? "")?.[1];
  if (!major || !VERIFIED_GLOBAL_STORE_MAJORS.has(Number(major))) {
    return { ok: false, reason: "pnpm global-store behavior is not verified for this pnpm version" };
  }

  const homeAnchor = owner?.homeAnchor ?? pnpmHomeAnchor(env, platform);
  if (!homeAnchor) return { ok: false, reason: "pnpm home could not be determined" };
  try {
    const refusal = spellingRefusal(homeAnchor, "pnpm home");
    if (refusal) return { ok: false, reason: refusal };
  } catch {
    return { ok: false, reason: "pnpm home could not be resolved" };
  }

  let storePath;
  try {
    const probe = runPnpm(["store", "path", `--dir=${homeAnchor}`], true);
    const lines = commandLines(probe);
    if (probe?.status === 0 && lines.length === 1 && isAbsolutePath(lines[0], platform)
      && /^v\d+$/.test(pathBasename(lines[0], platform))) storePath = lines[0];
  } catch { /* refused below */ }
  if (!storePath) return { ok: false, reason: "pnpm store path is not one absolute versioned path" };
  if (platform === "win32" && WINDOWS_CMD_METACHARACTERS.test(storePath)) {
    return { ok: false, reason: "pnpm path contains a character cmd.exe cannot pass safely" };
  }
  // A link inside the store spelling would widen the root every later hop is confined to.
  try {
    const refusal = spellingRefusal(storePath, "pnpm store path");
    if (refusal) return { ok: false, reason: refusal };
  } catch {
    return { ok: false, reason: "pnpm store path could not be resolved" };
  }
  let store;
  try {
    store = realpathSync.native(storePath);
    if (!statSync(store).isDirectory()) throw new Error();
  } catch {
    return { ok: false, reason: "pnpm store path could not be resolved" };
  }
  if (owner?.storePath && lexicalPathKey(storePath, platform) !== lexicalPathKey(owner.storePath, platform)) {
    return { ok: false, reason: "pnpm configured store changed" };
  }
  if (owner?.store && lexicalPathKey(store, platform) !== lexicalPathKey(owner.store, platform)) {
    return { ok: false, reason: "pnpm configured store changed" };
  }
  const virtualStoreDirs = [];
  for (const key of ["virtual-store-dir", "global-virtual-store-dir"]) {
    let value;
    try {
      const args = ["config", "get", key, "-g", `--config.global-dir=${owner.globalDir}`, `--config.global-bin-dir=${owner.globalBinDir}`];
      const result = runPnpm(args, true);
      const lines = outputText(result?.stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (result?.status !== 0 || lines.length !== 1) throw new Error();
      value = lines[0];
    } catch { return { ok: false, reason: "pnpm virtual-store configuration could not be resolved" }; }
    if (/^(?:undefined|null)$/i.test(value)) continue;
    if (!isAbsolutePath(value, platform)) return { ok: false, reason: "pnpm virtual-store directory is not absolute" };
    let path;
    try { path = realpathSync.native(value); if (!statSync(path).isDirectory()) throw new Error(); }
    catch { return { ok: false, reason: "pnpm virtual-store directory could not be resolved" }; }
    const rel = relative(store, path);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
      return { ok: false, reason: "pnpm virtual-store directory is outside the selected store" };
    }
    virtualStoreDirs.push(path);
  }
  if (owner?.virtualStoreDirs && (owner.virtualStoreDirs.length !== virtualStoreDirs.length
    || virtualStoreDirs.some((path, index) => lexicalPathKey(path, platform) !== lexicalPathKey(owner.virtualStoreDirs[index], platform)))) {
    return { ok: false, reason: "pnpm virtual-store configuration changed" };
  }
  return { ok: true, store, storePath, virtualStoreDirs, homeAnchor };
}

function isPackageInGlobalStore(packagePath, store) {
  const path = realpathSync.native(packagePath);
  const rel = relative(store, path);
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}

/**
 * Read and verify the package manager's active global link. `owner` constraints
 * make the listing a proof of the group selected during preflight, not merely a
 * successful listing from whichever pnpm happens to be first on PATH.
 */
export function readPnpmGlobalPackage(
  packageName,
  runPnpm,
  verify = verifyPnpmInstallTree,
  constraints = {},
) {
  const platform = constraints.platform ?? process.platform;
  const expectedGlobalDir = constraints.expectedGlobalDir ?? constraints.owner?.globalDir;
  const expectedGlobalRoot = constraints.expectedGlobalRoot ?? constraints.owner?.globalRoot;
  const globalBinDir = constraints.globalBinDir ?? constraints.owner?.globalBinDir;
  if (constraints.owner?.globalStore === true) {
    const unsafe = windowsCmdPathRefusal(constraints.owner, constraints.env, platform);
    if (unsafe) return unsafe;
  }
  let result;
  try {
    result = runPnpm(ownerGlobalArgs(["list", "-g", "--depth=0", "--json", packageName], constraints.owner), true);
  } catch {
    return { ok: false, reason: "pnpm global package listing failed" };
  }
  if (result?.status !== 0) return { ok: false, reason: "pnpm global package listing failed" };

  const inspected = inspectListOutput(result.stdout, packageName);
  const entry = inspected?.entry;
  const version = typeof entry?.version === "string" ? entry.version.trim() : "";
  const packagePath = typeof entry?.path === "string" ? entry.path : "";
  if (!version || !packagePath || !isAbsolutePath(packagePath, platform)) {
    return { ok: false, reason: "pnpm did not report a valid active global package" };
  }
  if (constraints.expectedPackagePath && !samePath(packagePath, constraints.expectedPackagePath, platform)) {
    return { ok: false, reason: "pnpm active package is not the running package" };
  }

  const rootPath = normaliseGlobalRoot(inspected?.root?.path, platform);
  if (expectedGlobalRoot || expectedGlobalDir) {
    // pnpm versions have reported either the global group or its node_modules root;
    // accept both, but require the root when the caller is proving ownership. Without
    // it a successful package listing cannot distinguish a command that ignored the
    // pinned group from the selected group.
    if (!rootPath) return { ok: false, reason: "pnpm did not report the selected global group" };
    const rootMatches = expectedGlobalRoot
      ? samePath(rootPath, expectedGlobalRoot, platform)
      : globalRootMatchesDir(rootPath, expectedGlobalDir, platform);
    if (!rootMatches) return { ok: false, reason: "pnpm listed a different global group" };
  }

  let tree;
  // A legacy global group keeps the verification it had before global-store support: no store
  // query, no store argument. The verifier still refuses any package that uses store links
  // without a selected store, so a global-store layout cannot pass on this branch.
  const globalStore = constraints.owner?.globalStore === true;
  let storeResult = { ok: true };
  if (globalStore) {
    storeResult = readPnpmStore(runPnpm, constraints.owner, platform, constraints.env);
    if (!storeResult.ok) return storeResult;
    // The global group is the other hop root; a link in its spelling would widen it the same way.
    try {
      const refusal = rootPath ? spellingRefusal(rootPath, "pnpm global group") : "pnpm global group has a symbolic link component";
      if (refusal) return { ok: false, reason: refusal };
    } catch { return { ok: false, reason: "pnpm global group could not be resolved" }; }
    try {
      if (!isPackageInGlobalStore(packagePath, storeResult.store)) return { ok: false, reason: "pnpm global-store package is outside the selected store" };
    } catch { return { ok: false, reason: "pnpm active package path could not be resolved" }; }
  }
  const verifyPath = path => globalStore
    ? verify(path, version, storeResult.store, rootPath, storeResult.storePath)
    : verify(path, version);
  try {
    tree = verifyPath(packagePath);
    if (tree?.ok && constraints.expectedPackagePath && constraints.expectedPackagePath !== packagePath) {
      tree = verifyPath(constraints.expectedPackagePath);
    }
  } catch {
    return { ok: false, reason: "the active pnpm package could not be verified" };
  }
  if (!tree?.ok) return { ok: false, reason: tree?.failures?.[0] ?? "the active pnpm package failed verification" };

  // A valid package tree/group is enough to bind the owner before an update. The
  // existing shim may be stale from an older pnpm run; post-update and rollback
  // reads leave this enabled so a successful transaction must produce fresh shims.
  if (globalBinDir && constraints.checkShims !== false) {
    const shims = (constraints.verifyShims ?? verifyPnpmGlobalShims)(
      packagePath,
      globalBinDir,
      platform,
    );
    if (!shims?.ok) return { ok: false, reason: shims?.reason ?? "pnpm global shims failed verification" };
  }
  return {
    ok: true,
    version,
    path: packagePath,
    globalDir: expectedGlobalDir,
    globalRoot: rootPath || expectedGlobalRoot,
    globalBinDir,
    ...(globalStore ? {
      store: storeResult.store,
      storePath: storeResult.storePath,
      virtualStoreDirs: storeResult.virtualStoreDirs,
      homeAnchor: storeResult.homeAnchor,
    } : {}),
  };
}

function statusText(status) {
  return status === null || status === undefined ? "?" : String(status);
}

function packageSpec(packageName, versionOrTag) {
  return `${packageName}@${versionOrTag}`;
}

function listGlobalPackage(commandPath, packageName, runPnpm) {
  try {
    return runPnpm(commandPath, ["list", "-g", "--depth=0", "--json", packageName], true);
  } catch {
    return null;
  }
}

/**
 * Find the pnpm executable and global group that own the running package. Every
 * candidate is inspected independently; this matters when two pnpm homes expose
 * the same pnpm version but only one owns the current package/shim.
 */
export function resolvePnpmGlobalOwner({
  packageName,
  packagePath,
  commandPaths,
  runningShimPath,
  runPnpm,
  verify = verifyPnpmInstallTree,
  platform = process.platform,
  env = process.env,
  // Re-resolving an owner already pinned to a store (orchestrated post-update verification) always runs
  // the store proof, whatever the new tree's spelling, so a pinned store owner is never demoted.
  requireStoreProof = false,
}) {
  if (!isAbsolutePath(packagePath, platform)) return { ok: false, reason: "running pnpm package path is not absolute" };
  let lastReason = "no pnpm global installation owns the running package";
  // A running package that looks like a pnpm global store gets the remedy even when no pnpm candidate lists
  // it (a failed listing, or another path), so every refusal of a store-like install says what to run.
  let runningClassified;
  try { runningClassified = requireStoreProof === true || pnpmPackageUsesGlobalStoreLinks(packagePath); }
  catch { runningClassified = true; }
  const withRunningHint = reason => runningClassified && typeof reason === "string" && !reason.endsWith(STORE_PROOF_HINT)
    ? reason + STORE_PROOF_HINT : reason;

  for (const commandPath of commandPaths ?? []) {
    const list = listGlobalPackage(commandPath, packageName, runPnpm);
    if (list?.status !== 0) continue;
    const inspected = inspectListOutput(list.stdout, packageName);
    const listedPath = typeof inspected?.entry?.path === "string" ? inspected.entry.path : "";
    if (!listedPath || !isAbsolutePath(listedPath, platform) || !samePath(listedPath, packagePath, platform)) continue;

    // Classification only decides which proof is required. Either spelling of the running package
    // that passes through pnpm store links demands the store proof; nothing here accepts a package.
    // It runs before any refusal below so every refusal of a store-like install carries the remedy.
    let globalStore;
    try {
      globalStore = requireStoreProof === true
        || pnpmPackageUsesGlobalStoreLinks(listedPath) || pnpmPackageUsesGlobalStoreLinks(packagePath);
    } catch { globalStore = true; }
    // A path that looks like a pnpm global store is accepted only on pnpm's own store answer. Every refusal of
    // such an install says so, so a user whose group merely sits under a store-like directory, or whose pnpm
    // home cannot be passed safely, knows why and what to run instead. The original reason stays the prefix.
    const refusal = reason => globalStore && typeof reason === "string" ? reason + STORE_PROOF_HINT : reason;

    const paths = resolveGlobalPaths(commandPath, runPnpm, inspected?.root?.path, platform);
    if (!paths) {
      lastReason = refusal("pnpm owns the running package but did not report its global group and bin directory");
      continue;
    }
    const { globalDir, globalRoot, globalBinDir } = paths;

    // If the process was entered through a generated command shim, its directory is
    // another owner fact. This disambiguates two pnpm homes that expose the same pnpm
    // version and (for example after a copied prefix) report the same package path.
    // Direct `node bin/ocx.mjs` and Windows shims that invoke the package path do not
    // provide a usable shim path, so they continue to rely on the package/group proof.
    if (runningShimPath) {
      const shimName = String(runningShimPath).replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
      const isCommandShim = ["ocx", "opencodex", "ocx.cmd", "opencodex.cmd", "ocx.ps1", "opencodex.ps1"].includes(shimName ?? "");
      if (isCommandShim && !samePath(dirname(runningShimPath), globalBinDir, platform)) {
        lastReason = refusal("pnpm package owner did not match the running global shim");
        continue;
      }
    }

    const owner = { commandPath, packagePath: listedPath, globalDir, globalRoot, globalBinDir, ...(globalStore ? { globalStore: true } : {}) };
    const active = readPnpmGlobalPackage(
      packageName,
      (args, capture = false) => runPnpm(commandPath, args, capture, owner),
      verify,
      {
        owner,
        expectedPackagePath: packagePath,
        expectedGlobalDir: globalDir,
        expectedGlobalRoot: globalRoot,
        globalBinDir,
        // Owner binding must remain possible when an older pnpm invocation left
        // the top-level shim stale; the transaction verifies it after mutation.
        checkShims: false,
        platform,
        env,
      },
    );
    if (active.ok) {
      return { ok: true, owner: { ...owner, packagePath: active.path, version: active.version,
        ...(globalStore ? { store: active.store, storePath: active.storePath, virtualStoreDirs: active.virtualStoreDirs, homeAnchor: active.homeAnchor } : {}) } };
    }
    lastReason = refusal(active.reason);
  }
  return { ok: false, reason: withRunningHint(lastReason) };
}

/**
 * Update a pnpm global package through pnpm itself. Never rename or remove files in
 * the pnpm store. Every command is pinned to the owner discovered before the proxy
 * is stopped. The pre-update proof accepts an existing stale shim; success and
 * rollback require a valid tree plus fresh generated shims.
 */
export function runPnpmGlobalUpdate({
  packageName,
  currentVersion,
  targetVersion,
  tag,
  owner,
  runningPackagePath,
  runPnpm,
  verify = verifyPnpmInstallTree,
  verifyShims = verifyPnpmGlobalShims,
  platform = process.platform,
  log = () => {},
}) {
  // A store owner's refusals during the update carry the same cause and remedy as discovery's.
  const storeOwnerRefusal = reason => owner?.globalStore === true && typeof reason === "string" ? reason + STORE_PROOF_HINT : reason;
  if (
    !owner?.commandPath
    || !owner?.globalDir
    || !owner?.globalRoot
    || !owner?.globalBinDir
    || !isAbsolutePath(owner.commandPath, platform)
    || !isAbsolutePath(owner.globalDir, platform)
    || !isAbsolutePath(owner.globalBinDir, platform)
    || (owner.globalStore && (
      !isAbsolutePath(owner.store, platform)
      || !isAbsolutePath(owner.storePath, platform)
      || !isAbsolutePath(owner.homeAnchor, platform)
      || !Array.isArray(owner.virtualStoreDirs)))
    || (!owner.globalStore && (owner.store !== undefined || owner.storePath !== undefined))
  ) {
    return { ok: false, phase: "preflight", error: storeOwnerRefusal("pnpm global owner was not pinned") };
  }
  const constraints = {
    owner,
    expectedPackagePath: runningPackagePath ?? owner.packagePath,
    expectedGlobalDir: owner.globalDir,
    expectedGlobalRoot: owner.globalRoot,
    globalBinDir: owner.globalBinDir,
    verifyShims,
    platform,
  };
  const before = readPnpmGlobalPackage(
    packageName,
    runPnpm,
    verify,
    { ...constraints, checkShims: false },
  );
  if (!before.ok) return { ok: false, phase: "preflight", error: storeOwnerRefusal(before.reason) };
  if (currentVersion && before.version !== currentVersion) {
    return { ok: false, phase: "preflight", error: storeOwnerRefusal("pnpm's active package does not match the running package") };
  }
  const identity = owner.globalStore ? pinStoreOwnerIdentity(owner) : null;
  const identityRefusal = identity?.refusal();
  if (identityRefusal) return { ok: false, phase: "preflight", error: storeOwnerRefusal(identityRefusal) };

  const requested = targetVersion || tag;
  const spec = packageSpec(packageName, requested);
  log(`Updating ${spec} with pnpm…`);
  let install;
  try {
    install = runPnpm(ownerGlobalArgs(["add", "-g", PNPM_BUILD_APPROVAL, spec], owner), false);
  } catch {
    install = { status: null, processTreeExited: false };
  }
  if (!Number.isInteger(install?.status) || install?.processTreeExited === false || install?.groupExited === false) return { ok: false, phase: "install", processTreeExited: false, rolledBack: false, uncertain: true,
    error: "installer-termination-unconfirmed" };

  // The package path may switch to a different group link, so only constrain
  // the group/bin pair after the command; the active package path is intentionally open.
  const after = readPnpmGlobalPackage(
    packageName,
    runPnpm,
    verify,
    { ...constraints, expectedPackagePath: undefined },
  );
  if (!after.ok && isStoreProofFailure(after.reason)) {
    return { ok: false, phase: "install", rolledBack: false, error: storeOwnerRefusal(after.reason) };
  }
  const targetMatches = after.ok && (!targetVersion || after.version === targetVersion);
  if (install?.status === 0 && targetMatches) {
    return {
      ok: true,
      phase: "done",
      version: after.version,
      path: after.path,
      globalDir: owner.globalDir,
      globalBinDir: owner.globalBinDir,
    };
  }

  const installReason = install?.status !== 0
    ? `pnpm update failed (${statusText(install?.status)})`
    : after.ok
      ? "pnpm update produced an unexpected active package version"
      : `pnpm update completed but the active package failed verification: ${after.reason}`;

  // A failed command may have left the original active group intact. Do not create a
  // second update transaction in that case; the verified previous package is already safe.
  if (after.ok && after.version === before.version) {
    return {
      ok: false,
      phase: "install",
      rolledBack: true,
      rollbackPerformed: false,
      activePath: after.path,
      globalDir: owner.globalDir,
      globalBinDir: owner.globalBinDir,
      error: storeOwnerRefusal(`${installReason}; previous version remains active`),
    };
  }

  // A failed listing says nothing about the effective store: bind it again before
  // issuing a rollback mutation, independently of whether readback succeeded.
  if (owner.globalStore) {
    const rollbackStore = readPnpmStore(runPnpm, owner, platform);
    if (!rollbackStore.ok) return { ok: false, phase: "rollback", rolledBack: false, error: storeOwnerRefusal(rollbackStore.reason) };
    // The global group is the other root every link hop is confined to: a rollback must not write through a
    // group that has gained a link component or lost its canonical spelling since discovery.
    let groupRefusal;
    try { groupRefusal = spellingRefusal(owner.globalRoot, "pnpm global group"); }
    catch { groupRefusal = "pnpm global group could not be resolved"; }
    if (groupRefusal) return { ok: false, phase: "rollback", rolledBack: false, error: storeOwnerRefusal(groupRefusal) };
    const replaced = identity?.refusal();
    if (replaced) return { ok: false, phase: "rollback", rolledBack: false, error: storeOwnerRefusal(replaced) };
  }
  log(`Restoring ${packageName}@${before.version} with pnpm…`);
  let rollback;
  try {
    rollback = runPnpm(ownerGlobalArgs(["add", "-g", PNPM_BUILD_APPROVAL, packageSpec(packageName, before.version)], owner), false);
  } catch {
    rollback = { status: null, processTreeExited: false };
  }
  if (!Number.isInteger(rollback?.status) || rollback?.processTreeExited === false || rollback?.groupExited === false) return { ok: false, phase: "rollback", processTreeExited: false, rolledBack: false, uncertain: true,
    error: "installer-termination-unconfirmed" };
  const restored = readPnpmGlobalPackage(
    packageName,
    runPnpm,
    verify,
    { ...constraints, expectedPackagePath: undefined },
  );
  if (rollback?.status === 0 && restored.ok && restored.version === before.version) {
    return {
      ok: false,
      phase: "rollback",
      rolledBack: true,
      rollbackPerformed: true,
      activePath: restored.path,
      globalDir: owner.globalDir,
      globalBinDir: owner.globalBinDir,
      error: storeOwnerRefusal(`${installReason}; previous version restored`),
    };
  }
  // The readback's own reason (a store-proof failure included) leads, so the user sees why first.
  const unverifiedPrefix = restored.ok || typeof restored.reason !== "string" ? "" : `${restored.reason}; `;
  return {
    ok: false,
    phase: "rollback",
    rolledBack: false,
    rollbackPerformed: false,
    ...(restored.ok ? { activePath: restored.path } : {}),
    globalDir: owner.globalDir,
    globalBinDir: owner.globalBinDir,
    error: storeOwnerRefusal(`${unverifiedPrefix}${installReason}; previous version could not be verified after rollback`),
  };
}
