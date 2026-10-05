import { realpathSync, statSync } from "node:fs";
import { readClientConnectionState } from "../client/state";
import { readConfigDiagnostics } from "../config/diagnostics";
import { getConfigDir } from "../config/paths";
import { currentCodexHome, resolveServiceOwnership, resolveServiceState } from "../service/state";

export interface UpdateRestartHome {
  config: { path: string; dev: number; ino: number };
  codex: { path: string; dev: number; ino: number };
  revision: number;
}

function physicalDirectory(path: string): UpdateRestartHome["config"] {
  const canonical = realpathSync.native(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory()) throw new Error("update_restart_home_unverified");
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

/** Only an unclaimed standalone home is eligible for this narrow update path. */
export function readUpdateRestartHome(): UpdateRestartHome {
  const state = resolveServiceState();
  const owner = resolveServiceOwnership();
  if (state.kind !== "none" || owner.kind !== "none") throw new Error("update_restart_owner_unverified");
  return { config: physicalDirectory(getConfigDir()), codex: physicalDirectory(currentCodexHome()), revision: owner.revision };
}

export function assertUpdateRestartHome(expected: UpdateRestartHome): void {
  const current = readUpdateRestartHome();
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("update_restart_home_changed");
}

/** Read-only eligibility shared by parent pre-stop and child admission. */
export function assertUpdateRestartConfiguration(hostname: string): void {
  const diagnostics = readConfigDiagnostics();
  if (readClientConnectionState().kind !== "disconnected" || diagnostics.error
    || (diagnostics.config.hostname ?? "") !== hostname) throw new Error("update_restart_configuration_changed");
}
