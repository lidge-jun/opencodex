/**
 * ocx service stop / uninstall / remove on Windows (#7771, 030 "Where it sits").
 *
 * - stop: Part A instead of stopWindows; a result other than stopped/absent refuses and
 *   leaves the proxy alone. Then a teardown receipt is claimed before the tracked proxy is
 *   stopped, so the proxy defers the shared teardown to this command. When the claim fails
 *   while this home owns the shared teardown, no undeferred child stop is sent: a wrapper
 *   appearing later could relaunch the proxy after its own teardown ran. Part B replaces
 *   proxyStillLiveAfterStop after a Part A stopped; the receipt is completed only after the
 *   restore ran, and kept for recovery otherwise.
 * - uninstall / remove: Part A before the task is deleted (a looping wrapper used to
 *   outlive its task, #764), refusing on anything but stopped/absent, then a receipt that
 *   carries Part A's record before the tracked proxy stop (Part A leaves the task
 *   registered, so a receipt-less POST answers 409 respawnable_service), then Part B. The
 *   receipt is kept until the caller's restore succeeds.
 */
import { clearPendingTeardown, claimPendingTeardown } from "../config/pending-teardown";
import { readRuntimePort } from "../config/process-state";
import { loadConfig } from "../config";
import { readClientConnectionState } from "../client/state";
import { proxyStillLiveAfterStop, stopTrackedProxyForServiceCommand } from "./orchestration";
import {
  confirmWindowsServiceStop,
  describeWindowsPartA,
  describeWindowsPartB,
  runWindowsServiceStopPartA,
  windowsPartARecord,
  windowsServiceStopPort,
  windowsStopAdmission,
  windowsStopRemainingMs,
} from "./windows-service-stop";

export interface WindowsServiceStopCommandIo {
  ownsSharedTeardown?: () => boolean;
  claim?: typeof claimPendingTeardown;
  stopTracked?: typeof stopTrackedProxyForServiceCommand;
  survivor?: typeof proxyStillLiveAfterStop;
}

function receiptEndpoint(): { endpoint: { hostname: string; port: number }; source: "exact" | "guessed" } {
  const runtime = readRuntimePort();
  if (runtime?.port) return { endpoint: { hostname: runtime.hostname ?? "127.0.0.1", port: runtime.port }, source: "exact" };
  try {
    const config = loadConfig();
    return { endpoint: { hostname: config.hostname ?? "127.0.0.1", port: typeof config.port === "number" && config.port > 0 ? config.port : 10100 }, source: "guessed" };
  } catch {
    return { endpoint: { hostname: "127.0.0.1", port: 10100 }, source: "guessed" };
  }
}

/** Shared teardown belongs to this home unless a client connection owns the routing. */
function ownsSharedTeardownByDefault(): boolean {
  try {
    return readClientConnectionState().kind !== "connected";
  } catch {
    return true;
  }
}

function withNonce(nonce: string | undefined): { ok: true; nonce?: string } {
  return nonce ? { ok: true, nonce } : { ok: true };
}

/**
 * Everything ocx service stop does before its restore. ok=false means the command fails
 * and restores nothing; nonce is the receipt to complete once the restore succeeded.
 */
export async function windowsServiceStopBeforeRestore(io: WindowsServiceStopCommandIo = {}): Promise<{ ok: boolean; nonce?: string }> {
  const port = windowsServiceStopPort();
  const partA = await runWindowsServiceStopPartA({ admission: windowsStopAdmission({ orphanDiscovery: true }) });
  if (partA.outcome !== "stopped" && partA.outcome !== "absent") {
    console.error("❌ service stop did not take effect: the Windows service could not be proven stopped (" + partA.outcome + ").");
    console.error("   " + describeWindowsPartA(partA));
    console.error("   The proxy was left running and native Codex was NOT restored.");
    return { ok: false };
  }
  let nonce: string | undefined;
  if ((io.ownsSharedTeardown ?? ownsSharedTeardownByDefault)()) {
    const { endpoint, source } = receiptEndpoint();
    try {
      nonce = (io.claim ?? claimPendingTeardown)(endpoint, source, process.pid, undefined, windowsPartARecord(partA)).nonce;
    } catch (error) {
      console.error("❌ service stop could not record its deferred-teardown receipt: " + (error instanceof Error ? error.message : String(error)));
      console.error("   The proxy was left running: stopping it without the receipt would let it tear down client config while a wrapper can still relaunch it.");
      return { ok: false };
    }
  }
  await (io.stopTracked ?? stopTrackedProxyForServiceCommand)({
    ...(nonce ? { deferSharedTeardownNonce: nonce } : {}),
    skipPortWait: partA.outcome === "stopped",
  });
  if (partA.outcome === "absent") {
    const survivor = await (io.survivor ?? proxyStillLiveAfterStop)();
    if (!survivor) return withNonce(nonce);
    console.error("❌ service stop did not take effect: a proxy is still listening on port " + survivor.port + ".");
    console.error("   Native Codex was NOT restored. Check for a manually started proxy, then re-run 'ocx service stop'.");
    return { ok: false };
  }
  const partB = await confirmWindowsServiceStop({ port, remainingMs: windowsStopRemainingMs() });
  if (partB.outcome === "freed") return withNonce(nonce);
  if (partB.outcome === "port-held-by-foreign") {
    console.warn("⚠️  " + describeWindowsPartB(partB));
    return withNonce(nonce);
  }
  console.error("❌ service stop did not take effect: " + describeWindowsPartB(partB));
  console.error("   Native Codex was NOT restored; the teardown receipt is kept so a later stop can finish it.");
  return { ok: false };
}

/** After a successful restore: the obligation the receipt recorded is discharged. */
export function completeWindowsServiceStopReceipt(nonce: string | undefined, clear: (nonce: string) => boolean = clearPendingTeardown): void {
  if (!nonce) return;
  if (!clear(nonce)) console.warn("⚠️  The deferred-teardown receipt could not be removed; the next 'ocx stop' will finish it.");
}

/**
 * ocx service uninstall / remove: stop and confirm before the task is deleted.
 *
 * Part A leaves the scheduler task registered, so a receipt-less POST still answers
 * `respawnable_service` (409) and the uninstall then refuses with the proxy left running.
 * The receipt is therefore claimed with Part A's record before the child stop, exactly as
 * `ocx service stop` does, and kept until the caller's restore succeeds.
 */
export async function windowsServiceRemovalStop(
  io: Pick<WindowsServiceStopCommandIo, "stopTracked" | "ownsSharedTeardown" | "claim"> = {},
): Promise<{ ok: boolean; nonce?: string }> {
  const port = windowsServiceStopPort();
  const partA = await runWindowsServiceStopPartA({ admission: windowsStopAdmission({ orphanDiscovery: true }) });
  if (partA.outcome !== "stopped" && partA.outcome !== "absent") {
    console.error("❌ Service uninstall refused: the Windows service could not be proven stopped (" + partA.outcome + "), so the task was not deleted.");
    console.error("   " + describeWindowsPartA(partA));
    return { ok: false };
  }
  let nonce: string | undefined;
  if ((io.ownsSharedTeardown ?? ownsSharedTeardownByDefault)()) {
    const { endpoint, source } = receiptEndpoint();
    try {
      nonce = (io.claim ?? claimPendingTeardown)(endpoint, source, process.pid, undefined, windowsPartARecord(partA)).nonce;
    } catch (error) {
      console.error("❌ Service uninstall could not record its deferred-teardown receipt: " + (error instanceof Error ? error.message : String(error)));
      console.error("   The proxy was left running: stopping it without the receipt would let it tear down client config while the task can still relaunch it.");
      return { ok: false };
    }
  }
  await (io.stopTracked ?? stopTrackedProxyForServiceCommand)({
    ...(nonce ? { deferSharedTeardownNonce: nonce } : {}),
    skipPortWait: partA.outcome === "stopped",
  });
  if (partA.outcome !== "stopped") return withNonce(nonce);
  const partB = await confirmWindowsServiceStop({ port, remainingMs: windowsStopRemainingMs() });
  if (partB.outcome === "freed") return withNonce(nonce);
  if (partB.outcome === "port-held-by-foreign") {
    console.warn("⚠️  " + describeWindowsPartB(partB));
    return withNonce(nonce);
  }
  console.error("❌ Service uninstall refused: " + describeWindowsPartB(partB) + " The task was not deleted.");
  console.error("   The teardown receipt is kept so a later stop can finish it.");
  return { ok: false };
}
