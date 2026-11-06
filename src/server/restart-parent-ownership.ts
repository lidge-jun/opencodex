import { lstatSync } from "node:fs";
import {
  getPidPath, getRuntimePortPath, readPidFileValue, readRuntimePort, removePid, removeRuntimePort,
} from "../config/process-state";
import { acquireOwnershipMutationLease } from "../service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../service/state";

function refusal(): Error {
  return Object.assign(new Error("Restart parent ownership could not be retired safely"), {
    code: "RESTART_PARENT_OWNERSHIP_UNVERIFIED",
  });
}

/** Only ENOENT proves absence; an unreadable, malformed or linked record is not ours to retire. */
function recordExists(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw refusal();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw refusal();
  }
}

/**
 * Called only after completed drain and successful listener stop, before waiting for child health.
 * The parent is still alive, but no longer owns a listener or startup recovery. Retire only this
 * process's records under the same lease that serializes child recovery and publication. Ordinary
 * live/unknown owners retain the startup fence; no child marker grants an exemption from it.
 */
export function retireRestartParentOwnership(port?: number): void {
  const lease = acquireOwnershipMutationLease(serviceStatePaths());
  try {
    const pidPath = getPidPath(), runtimePath = getRuntimePortPath();
    const hasPid = recordExists(pidPath), hasRuntime = recordExists(runtimePath);
    const runtime = readRuntimePort();
    if ((hasPid && readPidFileValue() !== process.pid)
      || (hasRuntime && (!runtime || runtime.pid !== process.pid
        || (port !== undefined && runtime.port !== port)))) throw refusal();
    // Keep the alive-PID fence if runtime retirement fails. The helpers also recheck the PID
    // immediately before unlink, so a successor's record is never unconditional cleanup.
    if (hasRuntime) removeRuntimePort(process.pid);
    if (recordExists(runtimePath)) throw refusal();
    if (hasPid) removePid(process.pid);
    if (recordExists(pidPath)) throw refusal();
  } finally {
    lease.release();
  }
}
