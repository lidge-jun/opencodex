import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { readClientConnectionState } from "../client/state";
import { readConfigDiagnostics } from "../config/diagnostics";
import { getConfigDir } from "../config/paths";
import { currentCodexHome } from "../service/state";
import { captureUpdateRestartServiceRecord, type UpdateRestartServiceRecord, type UpdateRestartServiceRecordDeps } from "./update-restart-service-record";
import { probeUpdateRestartSupervision, type UpdateRestartSupervisionDeps } from "./update-restart-supervision";

/**
 * `fileId` is the exact identity ("dev:ino" from a bigint stat). `dev` and `ino` are doubles and
 * cannot be: an NTFS file id carries the MFT sequence in its high bits, so above 2^53 a replacement
 * directory with a nearby MFT index can round to the same `ino` as the one it replaced.
 */
export interface UpdateRestartDirectory { path: string; dev: number; ino: number; fileId: string }

export interface UpdateRestartHome {
  config: UpdateRestartDirectory;
  codex: UpdateRestartDirectory;
  revision: number;
  serviceRecord: UpdateRestartServiceRecord;
}

export type UpdateRestartDirectoryStat = Pick<BigIntStats, "dev" | "ino" | "isDirectory">;

function physicalDirectory(path: string, stat: (path: string) => UpdateRestartDirectoryStat): UpdateRestartDirectory {
  const canonical = realpathSync.native(path);
  const observed = stat(canonical);
  if (!observed.isDirectory()) throw new Error("update_restart_home_unverified");
  return { path: canonical, dev: Number(observed.dev), ino: Number(observed.ino), fileId: `${observed.dev}:${observed.ino}` };
}

export interface UpdateRestartHomeDeps {
  record?: UpdateRestartServiceRecordDeps;
  supervision?: UpdateRestartSupervisionDeps;
  /** Test seam for the directory identity source; production reads a bigint stat. */
  statDirectory?: (path: string) => UpdateRestartDirectoryStat;
}

/** Capture eligibility from the same bytes that supply the frozen fingerprint. */
export function readUpdateRestartHome(deps: UpdateRestartHomeDeps = {}): UpdateRestartHome {
  const { serviceRecord, state, owner } = captureUpdateRestartServiceRecord(deps.record);
  const platform = deps.record?.platform ?? process.platform;
  if (owner.kind !== "none" || (state.kind === "state" && platform !== "darwin" && platform !== "linux")) {
    throw new Error("update_restart_owner_unverified");
  }
  const stat = deps.statDirectory ?? (path => statSync(path, { bigint: true }));
  return { config: physicalDirectory(getConfigDir(), stat), codex: physicalDirectory(currentCodexHome(), stat), revision: owner.revision, serviceRecord };
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
