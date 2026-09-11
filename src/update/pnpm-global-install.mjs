import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { pnpmInvocationForPath } from "./pnpm-invocation.mjs";
import { verifyPnpmInstallTree } from "./transactional-install.mjs";

export const PNPM_BUILD_APPROVAL = "--allow-build=bun";

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
    rest.push(arg);
  }
  return [
    command,
    `--global-dir=${owner.globalDir}`,
    `--config.global-bin-dir=${owner.globalBinDir}`,
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
  try {
    tree = verify(packagePath, version);
  } catch {
    return { ok: false, reason: "the active pnpm package could not be verified" };
  }
  if (!tree?.ok) return { ok: false, reason: "the active pnpm package failed verification" };

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
}) {
  if (!isAbsolutePath(packagePath, platform)) return { ok: false, reason: "running pnpm package path is not absolute" };
  let lastReason = "no pnpm global installation owns the running package";

  for (const commandPath of commandPaths ?? []) {
    const list = listGlobalPackage(commandPath, packageName, runPnpm);
    if (list?.status !== 0) continue;
    const inspected = inspectListOutput(list.stdout, packageName);
    const listedPath = typeof inspected?.entry?.path === "string" ? inspected.entry.path : "";
    if (!listedPath || !isAbsolutePath(listedPath, platform) || !samePath(listedPath, packagePath, platform)) continue;

    const paths = resolveGlobalPaths(commandPath, runPnpm, inspected?.root?.path, platform);
    if (!paths) {
      lastReason = "pnpm owns the running package but did not report its global group and bin directory";
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
        lastReason = "pnpm package owner did not match the running global shim";
        continue;
      }
    }

    const owner = { commandPath, packagePath: listedPath, globalDir, globalRoot, globalBinDir };
    const active = readPnpmGlobalPackage(
      packageName,
      (args, capture = false) => runPnpm(commandPath, args, capture),
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
      },
    );
    if (active.ok) return { ok: true, owner: { ...owner, packagePath: active.path, version: active.version } };
    lastReason = active.reason;
  }
  return { ok: false, reason: lastReason };
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
  if (
    !owner?.commandPath
    || !owner?.globalDir
    || !owner?.globalRoot
    || !owner?.globalBinDir
    || !isAbsolutePath(owner.commandPath, platform)
    || !isAbsolutePath(owner.globalDir, platform)
    || !isAbsolutePath(owner.globalBinDir, platform)
  ) {
    return { ok: false, phase: "preflight", error: "pnpm global owner was not pinned" };
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
  if (!before.ok) return { ok: false, phase: "preflight", error: before.reason };
  if (currentVersion && before.version !== currentVersion) {
    return { ok: false, phase: "preflight", error: "pnpm's active package does not match the running package" };
  }

  const requested = targetVersion || tag;
  const spec = packageSpec(packageName, requested);
  log(`Updating ${spec} with pnpm…`);
  let install;
  try {
    install = runPnpm(ownerGlobalArgs(["add", "-g", PNPM_BUILD_APPROVAL, spec], owner), false);
  } catch {
    install = { status: 1 };
  }

  // The package path may switch to a different group link, so only constrain
  // the group/bin pair after the command; the active package path is intentionally open.
  const after = readPnpmGlobalPackage(
    packageName,
    runPnpm,
    verify,
    { ...constraints, expectedPackagePath: undefined },
  );
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
      : "pnpm update completed but the active package failed verification";

  // A failed command may have left the original active group intact. Do not create a
  // second update transaction in that case; the verified previous package is already safe.
  if (after.ok && after.version === before.version) {
    return {
      ok: false,
      phase: "install",
      rolledBack: true,
      activePath: after.path,
      globalDir: owner.globalDir,
      globalBinDir: owner.globalBinDir,
      error: `${installReason}; previous version remains active`,
    };
  }

  log(`Restoring ${packageName}@${before.version} with pnpm…`);
  let rollback;
  try {
    rollback = runPnpm(ownerGlobalArgs(["add", "-g", PNPM_BUILD_APPROVAL, packageSpec(packageName, before.version)], owner), false);
  } catch {
    rollback = { status: 1 };
  }
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
      activePath: restored.path,
      globalDir: owner.globalDir,
      globalBinDir: owner.globalBinDir,
      error: `${installReason}; previous version restored`,
    };
  }
  return {
    ok: false,
    phase: "rollback",
    rolledBack: false,
    ...(restored.ok ? { activePath: restored.path } : {}),
    globalDir: owner.globalDir,
    globalBinDir: owner.globalBinDir,
    error: `${installReason}; previous version could not be verified after rollback`,
  };
}
