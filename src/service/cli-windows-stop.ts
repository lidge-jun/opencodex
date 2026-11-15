/**
 * ocx service stop / uninstall / remove on Windows (#7771, 030 "Where it sits").
 *
 * - stop: Part A instead of stopWindows; a result other than stopped/absent refuses and
 *   leaves the proxy alone. Then a teardown receipt is claimed before the tracked proxy is
 *   stopped, so the proxy defers the shared teardown to this command. When the claim fails
 *   while this home owns the shared teardown, no undeferred child stop is sent: a wrapper
 *   appearing later could relaunch the proxy after its own teardown ran. Part B replaces
 *   the legacy survivor check after a Part A stopped. With an absent Part A every candidate
 *   endpoint must be proven dead before restore; the receipt is kept otherwise.
 * - uninstall / remove: Part A before the task is deleted (a looping wrapper used to
 *   outlive its task, #764), refusing on anything but stopped/absent, then a receipt that
 *   carries Part A's record before the tracked proxy stop (Part A leaves the task
 *   registered, so a receipt-less POST answers 409 respawnable_service), then Part B. The
 *   receipt is kept until the caller's restore succeeds.
 */
import { clearPendingTeardown, claimPendingTeardown } from "../config/pending-teardown";
import { readClientConnectionState } from "../client/state";
import type { ProbeEndpoint } from "../cli/uninstall-plan";
import { probeEndpointLiveness, type EndpointLiveness } from "../server/proxy-liveness";
import { resolveTrackedProxyTarget, stopTrackedProxyForServiceCommand } from "./orchestration";
import {
  confirmWindowsServiceStop,
  describeWindowsPartA,
  describeWindowsPartB,
  endpointsAllDead,
  runWindowsServiceStopPartA,
  windowsPartARecord,
  windowsRemovalEndpoints,
  windowsServiceStopPort,
  windowsStopAdmission,
  windowsStopRemainingMs,
} from "./windows-service-stop";
import { WINDOWS_STOP_CAPS } from "./windows-stop-budget";

export interface WindowsServiceStopCommandIo {
  ownsSharedTeardown?: () => boolean;
  claim?: typeof claimPendingTeardown;
  stopTracked?: typeof stopTrackedProxyForServiceCommand;
  resolveTarget?: typeof resolveTrackedProxyTarget;
  /**
   * Tri-state probe of an endpoint. Only a definitive "dead" on EVERY candidate permits
   * deleting the task; "live" and "unknown" refuse and keep the receipt.
   */
  endpointLiveness?: (endpoint: { hostname: string; port: number }) => Promise<EndpointLiveness>;
  /**
   * Every endpoint this home could be serving on, for the absent-Part-A proof. Defaults to
   * `endpointsToProve(readRuntimePort(), loadConfig())` — the set `ocx uninstall` proves.
   */
  endpoints?: () => ProbeEndpoint[];
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
  const target = await (io.resolveTarget ?? resolveTrackedProxyTarget)();
  if (target && (io.ownsSharedTeardown ?? ownsSharedTeardownByDefault)()) {
    if (!target.endpoint) { console.error("❌ service stop cannot defer teardown without the target's endpoint."); return { ok: false }; }
    try {
      nonce = (io.claim ?? claimPendingTeardown)(target.endpoint, "exact", process.pid, undefined, windowsPartARecord(partA)).nonce;
    } catch (error) {
      console.error("❌ service stop could not record its deferred-teardown receipt: " + (error instanceof Error ? error.message : String(error)));
      console.error("   The proxy was left running: stopping it without the receipt would let it tear down client config while a wrapper can still relaunch it.");
      return { ok: false };
    }
  }
  const endpoints = partA.outcome === "absent" ? (io.endpoints ?? windowsRemovalEndpoints)() : [];
  if (target?.endpoint && partA.outcome === "absent" && !endpoints.some(e => e.hostname === target.endpoint!.hostname && e.port === target.endpoint!.port)) endpoints.push(target.endpoint);
  await (io.stopTracked ?? stopTrackedProxyForServiceCommand)({
    target,
    ...(nonce ? { deferSharedTeardownNonce: nonce } : {}),
    skipPortWait: partA.outcome === "stopped",
    orphanDiscoveryCapMs: WINDOWS_STOP_CAPS.orphanDiscovery,
  });
  if (partA.outcome === "absent") {
    const proof = await endpointsAllDead(endpoints, io.endpointLiveness ?? probeEndpointLiveness);
    if (proof.dead) return withNonce(nonce);
    console.error(proof.live.length ? "❌ service stop did not take effect: a proxy is still listening on port " + proof.live.join(", ") + "."
      : "❌ service stop did not take effect: endpoint liveness could not be confirmed on port " + proof.unknown.join(", ") + ".");
    console.error("   Native Codex was NOT restored; the teardown receipt is kept for a later stop.");
    return { ok: false };
  }
  const partB = await confirmWindowsServiceStop({ port: target?.endpoint?.port ?? port, remainingMs: windowsStopRemainingMs() });
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
  io: Pick<WindowsServiceStopCommandIo, "stopTracked" | "resolveTarget" | "ownsSharedTeardown" | "claim" | "endpointLiveness" | "endpoints"> = {},
): Promise<{ ok: boolean; nonce?: string }> {
  const port = windowsServiceStopPort();
  const partA = await runWindowsServiceStopPartA({ admission: windowsStopAdmission({ orphanDiscovery: true }) });
  if (partA.outcome !== "stopped" && partA.outcome !== "absent") {
    console.error("❌ Service uninstall refused: the Windows service could not be proven stopped (" + partA.outcome + "), so the task was not deleted.");
    console.error("   " + describeWindowsPartA(partA));
    return { ok: false };
  }
  let nonce: string | undefined;
  const target = await (io.resolveTarget ?? resolveTrackedProxyTarget)();
  const endpoints = partA.outcome === "absent" ? (io.endpoints ?? windowsRemovalEndpoints)() : [];
  if (target?.endpoint && partA.outcome === "absent" && !endpoints.some(e => e.hostname === target.endpoint!.hostname && e.port === target.endpoint!.port)) endpoints.push(target.endpoint);
  if (target && (io.ownsSharedTeardown ?? ownsSharedTeardownByDefault)()) {
    if (!target.endpoint) { console.error("❌ Service uninstall cannot defer teardown without the target's endpoint."); return { ok: false }; }
    try {
      nonce = (io.claim ?? claimPendingTeardown)(target.endpoint, "exact", process.pid, undefined, windowsPartARecord(partA)).nonce;
    } catch (error) {
      console.error("❌ Service uninstall could not record its deferred-teardown receipt: " + (error instanceof Error ? error.message : String(error)));
      console.error("   The proxy was left running: stopping it without the receipt would let it tear down client config while the task can still relaunch it.");
      return { ok: false };
    }
  }
  await (io.stopTracked ?? stopTrackedProxyForServiceCommand)({
    target,
    ...(nonce ? { deferSharedTeardownNonce: nonce } : {}),
    skipPortWait: partA.outcome === "stopped",
    orphanDiscoveryCapMs: WINDOWS_STOP_CAPS.orphanDiscovery,
  });
  if (partA.outcome === "absent") {
    // "absent" says no manager is registered, not that nothing is serving. `findLiveProxy`
    // inside the tracked stop can return null when its discovery cap runs out while the
    // endpoint is live, and `proxyStillLiveAfterStop` returns that same null for a probe
    // that timed out or failed — which the old branch read as success. Ask the endpoints
    // themselves, tri-state, and delete the task only when EVERY candidate is definitively
    // "dead": the receipt endpoint is only one of the addresses this home can serve on, and
    // a stale runtime record pointing at a closed port used to prove removal while the
    // configured port had a live listener. No respawn hold: with no manager registered
    // there is nothing to relaunch the proxy.
    const proof = await endpointsAllDead(endpoints, io.endpointLiveness ?? probeEndpointLiveness);
    if (proof.dead) return withNonce(nonce);
    console.error(proof.live.length > 0
      ? "❌ Service uninstall refused: a proxy is still listening on port " + proof.live.join(", ") + "."
      : "❌ Service uninstall refused: the endpoint on port " + (proof.unknown.join(", ") || port) + " could not be confirmed down.");
    console.error("   The task was not deleted. Stop that proxy, then re-run 'ocx service uninstall'.");
    return { ok: false };
  }
  const partB = await confirmWindowsServiceStop({ port: target?.endpoint?.port ?? port, remainingMs: windowsStopRemainingMs() });
  if (partB.outcome === "freed") return withNonce(nonce);
  if (partB.outcome === "port-held-by-foreign") {
    console.warn("⚠️  " + describeWindowsPartB(partB));
    return withNonce(nonce);
  }
  console.error("❌ Service uninstall refused: " + describeWindowsPartB(partB) + " The task was not deleted.");
  console.error("   The teardown receipt is kept so a later stop can finish it.");
  return { ok: false };
}
