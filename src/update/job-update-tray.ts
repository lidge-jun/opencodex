import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "./tray-update-plan.mjs";

/**
 * Production tray handoff for the GUI update worker: stop the own foreground tray before
 * package replacement, restoring it best-effort when the stop cannot be confirmed.
 * runGuiUpdateWorker reaches this only on Windows; focused tests inject
 * GuiUpdateWorkerIo.trayHandoffFn instead. Sibling of job-update-home.ts because
 * job.ts itself is at the repository file-size cap.
 */
export async function defaultWorkerTrayHandoff(capturePlan?: (plan: ReturnType<typeof planWindowsTrayUpdate>) => void) {
  const { getWindowsTrayStatus, startWindowsTray, stopWindowsTray } = await import("../tray/windows");
  const status = getWindowsTrayStatus();
  capturePlan?.(planWindowsTrayUpdate(status)); // Preserve pre-stop evidence even if stop/status/restore throws.
  return handoffWindowsTrayForUpdate(status, {
    stop: () => {
      const stopped = stopWindowsTray();
      return { exitStatus: 0, running: stopped.running };
    },
    start: () => startWindowsTray(),
  });
}
