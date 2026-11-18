import { isProcessAlive, killProxy, waitForExit } from "../lib/process-control";
import { openVerifiedPidfd } from "../service/health-sentinel-linux";
import { windowsProcessNative } from "../service/windows-process-native";
import { unsupportedConnectedStop } from "./stop-restore";

/** Terminate the attested Child only, including at the escalation and port-reclaim boundaries. */
export function terminateAttestedClient(pid: number, start: string, verify: () => void): void {
  if (!isProcessAlive(pid)) return;
  verify();
  if (process.platform === "linux") {
    const target = openVerifiedPidfd(pid, () => { verify(); return true; });
    if (target.kind === "refused") throw unsupportedConnectedStop();
    if (target.kind === "bound") {
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
  killProxy(pid, () => { verify(); return true; });
}
