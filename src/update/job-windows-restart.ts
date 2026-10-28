import { join } from "node:path";
import { getConfigDir } from "../config";
import { guardedStopWinsw, guardedStopWindows, guardedKillWindowsWrappers } from "./guarded-runtime-ops";
import { readServiceBackend } from "../service";
import type { UpdateMutationAuthorizer } from "./mutation-guard.mjs";

/** Stop the installed Windows backend and best-effort kill surviving :loop wrappers. */
export function stopWindowsServiceWrappersBestEffort(authorizeMutation: UpdateMutationAuthorizer): void {
  if (process.platform !== "win32") return;
  try {
    if (readServiceBackend() === "native") {
      if (!authorizeMutation("service")) return;
      guardedStopWinsw(authorizeMutation);
      return;
    }
    if (!authorizeMutation("service")) return;
    guardedStopWindows(authorizeMutation);
  } catch { /* already stopped */ }
  if (!authorizeMutation("service")) return;
  killWindowsServiceWrapperProcesses(authorizeMutation);
}

/**
 * Best-effort termination of surviving Windows scheduler launcher/wrapper processes.
 * `schtasks /end` ends the task instance but often leaves wscript/cmd running the
 * `:loop` batch, which brings the proxy back during post-update reclaim.
 *
 * This used to match the bare filenames with -like '*name*', which could stop a
 * wrapper belonging to a DIFFERENT OpenCodex home under the same account. The
 * shared killer scopes to this home's canonical paths as complete tokens.
 */
function killWindowsServiceWrapperProcesses(authorizeMutation: UpdateMutationAuthorizer): void {
  const paths = {
    scriptPath: join(getConfigDir(), "opencodex-service.cmd"),
    launcherPath: join(getConfigDir(), "opencodex-service-launcher.vbs"),
  };
  if (!authorizeMutation("service")) return;
  guardedKillWindowsWrappers(authorizeMutation, paths);
}
