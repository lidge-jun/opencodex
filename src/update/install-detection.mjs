import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";

const OPENCODEX_MISE_BACKEND = "npm:@bitkyc08/opencodex";
const OPENCODEX_MISE_BACKEND_DIR = "npm-bitkyc08-opencodex";
/** mise's core Node runtime. npm -g under it is an npm install that mise did not make. */
const MISE_NODE_RUNTIME = { tool: "node", backend: "core:node" };
const OPENCODEX_PACKAGE_SEGMENT = "/node_modules/@bitkyc08/opencodex";

/**
 * @typedef {{
 *   tool: string;
 *   backend: string;
 *   installPath: string;
 *   toolRoot: string;
 * }} MiseInstallOwner
 */

/**
 * @typedef {{
 *   installer: "bun" | "npm" | "pnpm" | "source";
 * } | {
 *   installer: "mise";
 *   owner: MiseInstallOwner | null;
 *   error?: "metadata_unreadable" | "metadata_inconsistent";
 * }} InstallOwnership
 */

/**
 * Infer the package manager from the path of the running package.
 *
 * PATH is deliberately not consulted here. A machine can have npm, pnpm, and Bun
 * installed at the same time; the package layout is the evidence of which manager owns
 * the files that the updater must change. The legacy `global/<version>` spelling is only
 * accepted when the adjacent filesystem metadata also looks like a pnpm global group.
 *
 * The real path is considered in addition to the spelling visible to the module loader.
 * This matters when Node is launched with preserved symlinks: a pnpm package can be
 * exposed through an npm-looking prefix while its target is still under pnpm's global
 * virtual store.
 */
export function detectInstallFromPath(packagePath, deps = {}) {
  return detectInstallOwnershipFromPath(packagePath, deps).installer;
}

/**
 * Infer the outer owner of the running package.
 *
 * mise's npm backend deliberately contains an ordinary npm/aube installation, so
 * package-manager layout alone reports npm. The adjacent backend record is the
 * stronger ownership signal: it identifies the mise alias and canonical backend,
 * while containment proves that the running package belongs to that installation.
 *
 * @param {string} packagePath
 * @param {{
 *   exists?: (path: string) => boolean;
 *   probe?: (path: string) => "present" | "absent" | "unreadable";
 *   readFile?: (path: string) => string;
 *   realpath?: (path: string) => string;
 * }} deps
 * @returns {InstallOwnership}
 */
export function detectInstallOwnershipFromPath(packagePath, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const probe = deps.probe ?? probeMetadata;
  const readFile = deps.readFile ?? (path => readFileSync(path, "utf8"));
  const candidates = [String(packagePath)];
  try {
    const resolved = (deps.realpath ?? realpathSync)(String(packagePath));
    if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
  } catch {
    // Synthetic paths in source-level checks, and a partially removed install, have no
    // realpath. The lexical path still carries the evidence when it is available.
  }

  let detectedManager = "source";
  /** @type {MiseInstallOwner[]} */
  const miseOwners = [];
  /** @type {"metadata_unreadable" | "metadata_inconsistent" | undefined} */
  let miseError;
  for (const candidate of candidates) {
    const mise = detectMiseOwner(candidate, { probe, readFile });
    if (mise.recognized) {
      if (mise.owner) miseOwners.push(mise.owner);
      else miseError = mise.error;
    }
    const detected = detectInstallCandidate(candidate, exists);
    if (detected === "pnpm" || detected === "bun") detectedManager = detected;
    else if (detected === "npm" && detectedManager === "source") detectedManager = "npm";
  }
  // Any recognized ownership error on either spelling takes precedence over every verified
  // owner. Keeping a command from the other candidate could authorize mutation across a
  // lexical/resolved-path mismatch, so fail closed without recovery guidance.
  if (miseError) return { installer: "mise", owner: null, error: miseError };
  const miseOwner = miseOwners.at(-1);
  if (miseOwner) {
    // The lexical and resolved spellings of one install differ when an ancestor such as the
    // mise data directory is a symlink (macOS /var -> /private/var). Both still name the same
    // physical tool directory and the same backend file, so compare canonical directories;
    // any other disagreement stays inconsistent.
    const realpath = deps.realpath ?? realpathSync;
    const consistent = miseOwners.every(owner =>
      owner.tool === miseOwner.tool
      && owner.backend === miseOwner.backend
      && sameDirectory(owner.toolRoot, miseOwner.toolRoot, realpath)
    );
    return consistent
      ? { installer: "mise", owner: miseOwner }
      : { installer: "mise", owner: null, error: "metadata_inconsistent" };
  }
  return { installer: detectedManager };
}

function parseBackendMetadata(content) {
  const fields = new Map();
  for (const line of String(content).split(/\r?\n/)) {
    const match = /^\s*(short|full)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1])) return null;
    try {
      fields.set(
        match[1],
        match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].slice(1, -1),
      );
    } catch {
      return null;
    }
  }
  const tool = fields.get("short");
  const backend = fields.get("full");
  return typeof tool === "string" && typeof backend === "string"
    ? { tool, backend }
    : null;
}

function detectMiseOwner(packagePath, deps) {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(String(packagePath))
    || String(packagePath).startsWith("\\\\");
  const normalized = (windowsPath ? String(packagePath).replaceAll("\\", "/") : String(packagePath))
    .replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  let marker = -1;
  let installPath;
  let toolRoot;
  let metadataPath;
  while ((marker = lower.indexOf("/node_modules/", marker + 1)) >= 1) {
    installPath = normalized.slice(0, marker);
    const slash = installPath.lastIndexOf("/");
    if (slash < 1) continue;
    toolRoot = installPath.slice(0, slash);
    metadataPath = `${toolRoot}/.mise.backend.toml`;
    const metadataState = deps.probe(metadataPath);
    if (metadataState === "present") break;
    if (metadataState === "unreadable") {
      return { recognized: true, owner: null, error: "metadata_unreadable" };
    }
    metadataPath = undefined;
  }
  if (!metadataPath || !installPath || !toolRoot) return { recognized: false };

  let metadata;
  try {
    metadata = parseBackendMetadata(deps.readFile(metadataPath));
  } catch {
    return { recognized: true, owner: null, error: "metadata_unreadable" };
  }
  const toolDir = toolRoot.slice(toolRoot.lastIndexOf("/") + 1);
  // On Windows, npm -g under a mise-managed Node writes the package straight into
  // <mise>/installs/node/<version>/node_modules, so the adjacent record is Node's own
  // (short = "node", full = "core:node"), not a statement about OpenCodex. Only that exact
  // runtime record with the package directly in the runtime's global node_modules is an
  // npm install; any other backend or layout stays fail-closed below.
  if (
    metadata
    && metadata.tool === MISE_NODE_RUNTIME.tool
    && metadata.backend === MISE_NODE_RUNTIME.backend
    && samePath(toolDir, MISE_NODE_RUNTIME.tool, windowsPath)
    && isRuntimeGlobalPackage(normalized, installPath, windowsPath)
  ) {
    return { recognized: false };
  }
  const expectedToolDir = metadata?.tool === OPENCODEX_MISE_BACKEND
    ? OPENCODEX_MISE_BACKEND_DIR
    : metadata?.tool;
  if (
    !metadata
    || metadata.backend !== OPENCODEX_MISE_BACKEND
    || (metadata.tool !== OPENCODEX_MISE_BACKEND
      && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(metadata.tool))
    || !samePath(expectedToolDir, toolDir, windowsPath)
  ) {
    return { recognized: true, owner: null, error: "metadata_inconsistent" };
  }
  return {
    recognized: true,
    owner: {
      tool: metadata.tool,
      backend: metadata.backend,
      installPath,
      toolRoot,
    },
  };
}

/**
 * True when the package sits directly in the runtime's global node_modules:
 * <toolRoot>/<version>/node_modules/@bitkyc08/opencodex[/...].
 */
function isRuntimeGlobalPackage(packagePath, installPath, windowsPath) {
  const rest = packagePath.slice(installPath.length);
  const probe = windowsPath ? rest.toLowerCase() : rest;
  return probe === OPENCODEX_PACKAGE_SEGMENT || probe.startsWith(`${OPENCODEX_PACKAGE_SEGMENT}/`);
}

function probeMetadata(path) {
  try {
    statSync(path);
    return "present";
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
  }
}

function sameDirectory(left, right, realpath) {
  if (samePath(left, right)) return true;
  try {
    return samePath(realpath(left), realpath(right));
  } catch {
    return false;
  }
}

function samePath(left, right, windows = /^[A-Za-z]:\//.test(left) && /^[A-Za-z]:\//.test(right)) {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function detectInstallCandidate(packagePath, exists) {
  const path = String(packagePath);
  const normalized = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
    ? path.replaceAll("\\", "/")
    : path;
  const segments = normalized.split("/").filter(Boolean);
  // Windows paths are case-insensitive. Treating the structural marker this way also
  // keeps a preserved-symlink path from being downgraded merely because its casing came
  // from a Windows API or a user-created junction.
  if (!segments.some(segment => segment.toLowerCase() === "node_modules")) return "source";

  // Strong signatures survive normal symlink resolution: the v10 isolated virtual store
  // and v11 global virtual store are both manager-owned paths. Do not classify an arbitrary
  // npm prefix such as `/opt/global/v11` from its directory name alone.
  if (
    /(?:^|\/)node_modules\/\.pnpm(?:\/|$)/i.test(normalized)
    || /(?:^|\/)store\/v\d+\/links(?:\/|$)/i.test(normalized)
  ) return "pnpm";

  // `--preserve-symlinks` can leave a v10/v11 group path visible. Corroborate it with the
  // group's virtual store or the v11 global store before selecting pnpm.
  const globalMatch = normalized.match(/^(.*\/global\/(?:v)?\d+)(?:\/[^/]+)*\/node_modules(?:\/|$)/i);
  if (globalMatch && exists) {
    const globalRoot = globalMatch[1];
    const groupRoot = normalized.slice(0, normalized.toLowerCase().indexOf("/node_modules"));
    if (
      exists(`${groupRoot}/node_modules/.pnpm`)
      || exists(`${groupRoot}/node_modules/.modules.yaml`)
      || exists(`${groupRoot}/node_modules/.pnpm/lock.yaml`)
      || exists(`${globalRoot}/store`)
      || exists(`${globalRoot}/pnpm-lock.yaml`)
    ) return "pnpm";
  }

  // Bun's global layout is specifically `.bun/install/global/node_modules`. A bare `.bun`
  // directory is not enough: npm projects can quite legitimately live under a dot-directory
  // with that name, especially on Windows where package paths are often user-selected.
  if (/(?:^|\/)\.bun\/install\/global\/node_modules(?:\/|$)/i.test(normalized)) return "bun";

  return "npm";
}
