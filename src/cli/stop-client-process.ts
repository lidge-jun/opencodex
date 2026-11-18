import { isProcessAlive, ProxyOwnershipRefusedError, waitForExit } from "../lib/process-control";
import { openVerifiedPidfd } from "../service/health-sentinel-linux";
import { windowsProcessNative } from "../service/windows-process-native";
import { unsupportedConnectedStop } from "./stop-restore";

/** Terminate the attested Child only, including at the escalation and port-reclaim boundaries. */
export function terminateAttestedClient(pid: number, start: string, verify: () => void): void {
  if (!isProcessAlive(pid)) return;
  verify();
  if (process.platform === "linux") {
    const target = openVerifiedPidfd(pid, () => { verify(); return true; });
    if (target.kind !== "bound") {
      throw new ProxyOwnershipRefusedError(
        `Link Child forced stop refused: could not bind a Linux pidfd (${target.reason}). Use a kernel and environment that permit pidfd operations, or stop a managed Child through its supervisor. Then retry ocx stop to complete restoration.`,
        "connected_client_stop_unsupported",
      );
    }
    const { handle } = target;
    try {
      for (const signal of [15, 9] as const) {
        if (!isProcessAlive(pid)) return;
        verify();
        const result = handle.terminate(signal);
        if (result === "not_target") return;
        if (result !== "terminated") throw unsupportedConnectedStop();
        if (waitForExit(pid, 5000)) return;
      }
      throw new Error(`process ${pid} did not exit`);
    } finally { handle.close(); }
  }
  if (process.platform === "win32") {
    const ticks = /^win32:(\d{1,20})$/.exec(start)?.[1];
    const native = windowsProcessNative();
    if (!ticks || !native) throw unsupportedConnectedStop();
    const result = native.terminate(pid, BigInt(ticks));
    if (result.status === "gone") return;
    if (result.status !== "terminated") throw unsupportedConnectedStop();
    if (!waitForExit(pid, 5000)) throw new Error(`process ${pid} did not exit`);
    return;
  }
  if (process.platform !== "darwin") throw unsupportedConnectedStop();
  // The native macOS Child has no authenticated shutdown endpoint. Keep its
  // orderly signal path, with no numeric-PID escalation after the wait.
  process.kill(pid, "SIGTERM");
  if (waitForExit(pid, 5000)) return;
  verify();
  throw new ProxyOwnershipRefusedError(
    "Link Child did not exit after SIGTERM. Inspect its foreground terminal for the shutdown refusal or check its supervisor, repair the reported evidence, then retry ocx stop.",
    "connected_client_stop_unsupported",
  );
}
