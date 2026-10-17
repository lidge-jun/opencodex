import { spawnSync } from "node:child_process";
import { createUpdateServiceHomePolicy, inspectUpdateServiceHome, type UpdateServiceHomeInspector } from "./service-home-authority";
import { UPDATE_PACKAGE_ONLY_EXIT_CODE } from "./service-home-policy.mjs";
import { currentServiceHomes } from "../service/state";
import { probeUpdatePackageOnlyLauncher, updateHomeProbeEnvironment } from "./service-home-probe.mjs";

/** Refuse old launchers without executing their pre-dispatch bootstrap. */
export function automaticUpdateLauncherSupported(launcher: string, node: string): boolean {
  try {
    const env = updateHomeProbeEnvironment(process.env, currentServiceHomes());
    return probeUpdatePackageOnlyLauncher(launcher, spawnSync, node, env);
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
  if (installer === "npm" || installer === "pnpm" || policy.packageOnly) {
    if (!compatible(launcher, node)) {
      report("Automatic update refused: guarded recovery protocol unavailable. Check 'ocx service status' and update this CLI manually before retrying.");
      return null;
    }
  }
  if (policy.packageOnly) {
    // The package-only protocol promises this restrictive flag is honored by both Node and Bun updaters.
    command.bin = node;
    command.args = [launcher, "update", "--tag", channel, "--update-package-only"];
    command.display = `ocx update --tag ${channel} --update-package-only`;
  }
  if (installer === "npm" || installer === "pnpm" || policy.packageOnly) command.args.push("--update-worker-result");
  return policy;
}

/** A restricted-success status is meaningful only from our package-only protocol update launcher. */
export function packageOnlyUpdateSucceeded(command: { args: string[] }, status: number | null, parentPackageOnly: boolean) {
  return status === 0 && parentPackageOnly
    || status === UPDATE_PACKAGE_ONLY_EXIT_CODE && command.args.includes("--update-worker-result");
}
