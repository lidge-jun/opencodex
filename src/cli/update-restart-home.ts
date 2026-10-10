import { realpathSync, statSync } from "node:fs";
import { readClientConnectionState } from "../client/state";
import { readConfigDiagnostics } from "../config/diagnostics";
import { getConfigDir } from "../config/paths";
import { currentCodexHome } from "../service/state";
import { captureUpdateRestartServiceRecord, type UpdateRestartServiceRecord, type UpdateRestartServiceRecordDeps } from "./update-restart-service-record";
import { probeUpdateRestartSupervision, type UpdateRestartSupervisionDeps } from "./update-restart-supervision";

export interface UpdateRestartHome {
  config: { path: string; dev: number; ino: number };
  codex: { path: string; dev: number; ino: number };
  revision: number;
  serviceRecord: UpdateRestartServiceRecord;
}

function physicalDirectory(path: string): UpdateRestartHome["config"] {
  const canonical = realpathSync.native(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory()) throw new Error("update_restart_home_unverified");
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

export interface UpdateRestartHomeDeps {
  record?: UpdateRestartServiceRecordDeps;
  supervision?: UpdateRestartSupervisionDeps;
}

/** Capture eligibility from the same bytes that supply the frozen fingerprint. */
export function readUpdateRestartHome(deps: UpdateRestartHomeDeps = {}): UpdateRestartHome {
  const { serviceRecord, state, owner } = captureUpdateRestartServiceRecord(deps.record);
  const platform = deps.record?.platform ?? process.platform;
  if (owner.kind !== "none" || (state.kind === "state" && platform !== "darwin" && platform !== "linux")) {
    throw new Error("update_restart_owner_unverified");
  }
  return { config: physicalDirectory(getConfigDir()), codex: physicalDirectory(currentCodexHome()), revision: owner.revision, serviceRecord };
}

export function assertUpdateRestartHome(expected: UpdateRestartHome, deadlineAt = Date.now() + 2000, deps: UpdateRestartHomeDeps = {}): void {
  try {
    const current = readUpdateRestartHome(deps);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("changed");
  } catch { throw new Error("update_restart_home_changed"); }
  if (probeUpdateRestartSupervision(deadlineAt, deps.supervision) !== "inactive") throw new Error("update_restart_supervision_unverified");
  // Manager commands may yield to an external writer even though this guard is synchronous.
  try {
    if (JSON.stringify(readUpdateRestartHome(deps)) !== JSON.stringify(expected)) throw new Error("changed");
  } catch { throw new Error("update_restart_home_changed"); }
  if ((deps.supervision?.now ?? Date.now)() >= deadlineAt) throw new Error("update_restart_deadline_expired");
}

/** Read-only eligibility shared by parent pre-stop and child admission. */
export function assertUpdateRestartConfiguration(hostname: string): void {
  const diagnostics = readConfigDiagnostics();
  if (readClientConnectionState().kind !== "disconnected" || diagnostics.error
    || (diagnostics.config.hostname ?? "") !== hostname) throw new Error("update_restart_configuration_changed");
}
