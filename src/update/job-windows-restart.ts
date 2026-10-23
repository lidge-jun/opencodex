import { join } from "node:path";
import { getConfigDir } from "../config";
import { killWindowsSchedulerWrappers } from "../lib/windows-service-wrappers";
import { stopWinswService } from "../lib/winsw";
import { readServiceBackend, stopWindows } from "../service";

/** Stop the installed Windows backend and best-effort kill surviving :loop wrappers. */
export function stopWindowsServiceWrappersBestEffort(): void {
  if (process.platform !== "win32") return;
  try {
    if (readServiceBackend() === "native") {
      stopWinswService();
      return;
    }
    stopWindows();
  } catch { /* already stopped */ }
  killWindowsServiceWrapperProcesses();
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
function killWindowsServiceWrapperProcesses(): void {
  killWindowsSchedulerWrappers({
    scriptPath: join(getConfigDir(), "opencodex-service.cmd"),
    launcherPath: join(getConfigDir(), "opencodex-service-launcher.vbs"),
  });
}
