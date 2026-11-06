import { probeSpawnSync } from "./mutation-guard.mjs";
import { createUpdateServiceHomePolicy, inspectUpdateServiceHome, type UpdateServiceHomeInspector } from "./service-home-authority";
import { UPDATE_PACKAGE_ONLY_EXIT_CODE, UPDATE_WORKER_HOME_FLAG, updateWorkerHomeArgv } from "./service-home-policy.mjs";
import { currentServiceHomes } from "../service/state";
import { probeUpdatePackageOnlyLauncher, updateHomeProbeEnvironment } from "./service-home-probe.mjs";

/** Refuse old launchers without executing their pre-dispatch bootstrap. */
export function automaticUpdateLauncherSupported(launcher: string, node: string): boolean {
  try {
    const env = updateHomeProbeEnvironment(process.env, currentServiceHomes());
    return probeUpdatePackageOnlyLauncher(launcher, probeSpawnSync, node, env);
  } catch { return false; }
}


/** Keep a worker's no-control decision across delegation, including the otherwise raw Bun lane. */
export function prepareWorkerUpdateHome(command: { bin: string; args: string[]; display: string },
  installer: string, launcher: string, node: string, channel: string,
  report: (message: string) => void,
  inspect: UpdateServiceHomeInspector = inspectUpdateServiceHome,
  compatible: (launcher: string, node: string) => boolean = automaticUpdateLauncherSupported) {
  const policy = createUpdateServiceHomePolicy(inspect, report);
  if (!policy.checkPackage()) return null;
  // npm/pnpm and restricted workers delegate through the guarded Node launcher, which can
  // receive argv. The raw package-manager lane (e.g. `bun add -g`) cannot: the worker
  // rechecks the same baseline itself at the replacement boundary instead.
  const delegated = installer === "npm" || installer === "pnpm" || policy.packageOnly;
  if (delegated) {
    if (!compatible(launcher, node)) {
      report("Automatic update refused: guarded recovery protocol unavailable. Check 'ocx service status' and update this CLI manually before retrying.");
      return null;
    }
  }
  if (policy.packageOnly) {
    // The package-only protocol promises this restrictive flag is honored by both Node and Bun updaters.
    command.bin = node;
    command.args = [launcher, "update", "--tag", channel, "--update-package-only"];
    // Persist the already-sanitized shape renderSafeCommand produces: a raw launcher path
    // with spaces would still split on \s and be withheld, and `node.exe` is not a recognized
    // tool token either. `command.bin`/`command.args` keep the real spawn target unchanged.
    command.display = `node <path> update --tag ${channel} --update-package-only`;
  }
  if (delegated) {
    // Pin the verified baseline: without it the child inspects fresh and an unknown or
    // matching read could mint authority the parent never held. v2 children refuse a
    // malformed baseline and v2 parents refuse v1 children, so mixed-version delegation
    // fails closed before either side runs.
    const baseline = updateWorkerHomeArgv(policy.initial);
    if (baseline === null) {
      report("Automatic update refused: the observed service registration baseline could not be delegated.");
      return null;
    }
    command.args.push(UPDATE_WORKER_HOME_FLAG, baseline, "--update-worker-result");
  }
  return policy;
}

/** A restricted-success status is meaningful only from our package-only protocol update launcher. */
export function packageOnlyUpdateSucceeded(command: { args: string[] }, status: number | null, parentPackageOnly: boolean) {
  return status === 0 && parentPackageOnly
    || status === UPDATE_PACKAGE_ONLY_EXIT_CODE && command.args.includes("--update-worker-result");
}
