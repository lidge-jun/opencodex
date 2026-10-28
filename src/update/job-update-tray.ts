import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "./tray-update-plan.mjs";
import type { UpdateMutationAuthorizer } from "./mutation-guard.mjs";

/**
 * Production tray handoff for the GUI update worker: stop the own foreground tray before
 * package replacement, restoring it best-effort when the stop cannot be confirmed.
 * runGuiUpdateWorker reaches this only on Windows; focused tests inject
 * GuiUpdateWorkerIo.trayHandoffFn instead. Sibling of job-update-home.ts because
 * job.ts itself is at the repository file-size cap.
 */
export async function defaultWorkerTrayHandoff(capturePlan?: (plan: ReturnType<typeof planWindowsTrayUpdate>) => void,
  authorizeMutation: UpdateMutationAuthorizer = () => false) {
  const { getWindowsTrayStatus, guardedStartWindowsTray, guardedStopWindowsTray } = await import("./guarded-tray-ops");
  const status = getWindowsTrayStatus();
  // No handoff or restoration is authorized if the import lost authority before any stop.
  if (!authorizeMutation("tray")) throw new Error("Automatic update tray handoff refused; check 'ocx service status'.");
  let stopAttempted = false;
  return handoffWindowsTrayForUpdate(status, {
    stop: () => {
      if (!authorizeMutation("tray")) throw new Error("Automatic update tray handoff refused; check 'ocx service status'.");
      stopAttempted = true;
      try {
        const stopped = guardedStopWindowsTray(authorizeMutation);
        return { exitStatus: 0, running: stopped.running };
      } finally { capturePlan?.(planWindowsTrayUpdate(status)); } // An attempted stop retains its cleanup evidence.
    },
    start: () => { if (stopAttempted && authorizeMutation("own-tray")) return guardedStartWindowsTray(authorizeMutation); },
  });
}
