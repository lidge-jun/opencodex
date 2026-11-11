import { guardedStopWinsw, guardedStopWindowsChecked } from "./guarded-runtime-ops";
import { readServiceBackend } from "../service";
import type { UpdateMutationAuthorizer } from "./mutation-guard.mjs";

/** Why an automatic update restart stopped instead of starting a runtime over a live service. */
export const WINDOWS_SERVICE_STOP_ABORT = "Automatic update restart stopped: the Windows service could not be proven stopped, "
  + "so no runtime was started over it. Run 'ocx stop' from a terminal, then 'ocx start'.";

/**
 * Stop the installed Windows backend before the updater replaces or restarts the runtime.
 * Returns false when the restart must abort; true when nothing can relaunch the proxy.
 *
 * Task Scheduler uses Part A of the checked stop (#7771) through the authorizer-gated
 * variant: the service authorization runs at entry and before every terminate, and only
 * stopped or absent lets the restart go on. The native WinSW backend keeps today's stop
 * (WinSW has no :loop wrapper to end).
 */
export async function stopWindowsServiceForRestart(authorizeMutation: UpdateMutationAuthorizer): Promise<boolean> {
  if (process.platform !== "win32") return true;
  // An unreadable backend record falls through to Part A, which probes both backends itself.
  let backend: string;
  try { backend = readServiceBackend(); } catch { backend = "scheduler"; }
  if (backend === "native") {
    if (!authorizeMutation("service")) return false;
    try { guardedStopWinsw(authorizeMutation); } catch { /* already stopped */ }
    return true;
  }
  if (!authorizeMutation("service")) return false;
  try {
    const outcome = await guardedStopWindowsChecked(authorizeMutation);
    return outcome === "stopped" || outcome === "absent";
  } catch {
    // A refusal by the service authorizer (at entry or before a terminate) aborts too.
    return false;
  }
}
