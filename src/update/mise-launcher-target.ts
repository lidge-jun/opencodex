import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  observePackageManifestAt,
  packageManifestPathIn,
  runningPackageRoot,
} from "../lib/package-tree-integrity";
import type { LauncherTarget, ResolveLauncherTarget } from "../lib/package-tree-retarget";
import { readServiceInstallState, SERVICE_MANAGED_ENV } from "../service/state";
import { detectInstallOwnershipFromPath, type InstallOwnership } from "./install-detection.mjs";

const PACKAGE_DIR = join("@bitkyc08", "opencodex");

/**
 * The package launcher mise's npm backend creates in `<toolRoot>/<selector>/node_modules/.bin`,
 * beside the package it starts. This is the layout `detectInstallOwnershipFromPath` verifies as
 * mise-owned; a launcher in any other layout is not followed.
 */
const LAUNCHER_BIN = join("node_modules", ".bin");
const LAUNCHER_PACKAGE_DIR = join("node_modules", PACKAGE_DIR);

export interface MiseLauncherTargetDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  ownership?: () => InstallOwnership;
  launcherPath?: () => string | undefined;
  runningRoot?: () => string;
  realpath?: (path: string) => string;
}

export interface MiseLauncherTargetWatchPlan {
  runningRoot: string;
  resolveTarget: ResolveLauncherTarget;
}

function canonical(path: string, realpath: (path: string) => string): string | null {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

/**
 * Map a recorded service launcher to the package directory it starts, when it is one of mise's
 * own package launchers for this tool. A mise shim (`<data>/shims/ocx`) resolves to the mise
 * binary and names no package, and anything outside `<toolRoot>/<selector>/` is not a launcher
 * this install owns, so both are unsupported and return null.
 */
function launcherPackageEntry(launcherPath: string, toolRoot: string, realpath: (path: string) => string): string | null {
  if (!isAbsolute(launcherPath)) return null;
  const binDir = dirname(launcherPath);
  const canonicalToolRoot = canonical(toolRoot, realpath);
  if (canonicalToolRoot === null) return null;
  if (!binDir.endsWith(`/${LAUNCHER_BIN}`)) return null;
  const selectorDir = binDir.slice(0, binDir.length - LAUNCHER_BIN.length - 1);
  if (canonical(dirname(selectorDir), realpath) !== canonicalToolRoot) return null;
  return join(selectorDir, LAUNCHER_PACKAGE_DIR);
}

/**
 * Decide whether this process should watch its service launcher for a mise upgrade, and build the
 * resolver when it should.
 *
 * Eligible only when every one of these holds:
 * - Linux. launchd services always run pinned package paths (see the stable-launcher contract),
 *   and Windows services have no launcher, so neither can follow a moved `latest` link.
 * - The process is the managed service job itself (`OCX_SERVICE_MANAGED=1`). `OCX_SERVICE=1`
 *   alone is also set on proxies `ocx claude`/`ocx opencode` spawn, and a foreground proxy must
 *   never restart itself because a service record exists.
 * - The running package has a verified mise owner, and the recorded launcher is one of that
 *   tool's package launchers.
 * - At boot, the launcher resolves to exactly the running package. That proves the supervisor
 *   started this process through it, so a restart through it converges instead of looping.
 */
export function planMiseLauncherTargetWatch(deps: MiseLauncherTargetDeps = {}): MiseLauncherTargetWatchPlan | null {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  if ((deps.env ?? process.env)[SERVICE_MANAGED_ENV] !== "1") return null;
  const realpath = deps.realpath ?? realpathSync;
  const runningRoot = canonical((deps.runningRoot ?? runningPackageRoot)(), realpath);
  if (runningRoot === null) return null;
  const ownership = (deps.ownership ?? (() => detectInstallOwnershipFromPath(runningRoot)))();
  if (ownership.installer !== "mise" || !ownership.owner) return null;
  const owner = ownership.owner;
  const launcherPath = (deps.launcherPath ?? (() => readServiceInstallState()?.launcherPath))();
  if (!launcherPath) return null;
  const entry = launcherPackageEntry(launcherPath, owner.toolRoot, realpath);
  const toolRoot = canonical(owner.toolRoot, realpath);
  if (entry === null || toolRoot === null) return null;

  const resolveTarget = (): LauncherTarget | null => {
    const root = canonical(entry, realpath);
    // A floating link repointed outside this tool's installs is not a mise upgrade of it.
    if (root === null || !root.startsWith(`${toolRoot}/`)) return null;
    const manifest = observePackageManifestAt(packageManifestPathIn(root));
    return manifest === null ? null : { root, manifest };
  };
  if (resolveTarget()?.root !== runningRoot) return null;
  return { runningRoot, resolveTarget };
}
