/**
 * Shared, side-effect-free contract for preserving the Windows tray across all
 * updater entry points (package launcher, CLI updater, and GUI worker).
 */
export function planWindowsTrayUpdate(status) {
  const installed = status?.installed === true;
  const running = status?.running === true;
  return {
    installed,
    running,
    stopBeforeReplacement: running,
    restoreOnFailure: running,
    refreshAfterReplacement: installed,
    installArgs: ["tray", "install", ...(!running ? ["--no-start"] : [])],
  };
}

export function windowsTrayStopConfirmed(exitStatus, stillRunning) {
  return exitStatus === 0 && !stillRunning;
}

/** Stop before replacement and restore best-effort when the handoff cannot be confirmed. */
export function handoffWindowsTrayForUpdate(status, io) {
  const plan = planWindowsTrayUpdate(status);
  if (!plan.stopBeforeReplacement) return plan;
  try {
    const stopped = io.stop();
    if (!windowsTrayStopConfirmed(stopped.exitStatus, stopped.running)) {
      throw new Error("the tray still reports running after shutdown");
    }
    return plan;
  } catch (error) {
    if (plan.restoreOnFailure) {
      try { io.start(); } catch { /* preserve the handoff failure */ }
    }
    throw error;
  }
}
