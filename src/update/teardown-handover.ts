import {
  clearPendingTeardown,
  isPendingTeardownAbandoned,
  listPendingTeardowns,
  pendingTeardownPathFor,
  pendingTeardownsAreExactly,
  readPendingTeardown,
} from "../config/pending-teardown";
import { isLikelyOcxProcess } from "../config/process-state";
import { isProcessAlive } from "../lib/process-control";

/**
 * Update teardown handover (#7423).
 *
 * An update stops the proxy before replacing the package. That stop used to restore native
 * Codex, which puts the pristine catalog back and removes every routed row. The new proxy
 * appends them again when it starts, but a Codex process that loads the catalog in between
 * keeps treating routed models as unknown until it is restarted. On a long-context model
 * that silent fallback metadata turned into a compaction loop.
 *
 * When the caller is going to restart the proxy, it sets this variable on the update
 * child. The `ocx stop` that the update runs then keeps its teardown receipt instead of
 * restoring, and the proxy that honours the deferral keeps its client config on exit.
 * Ownership stays explicit: the receipt is the same durable obligation any deferred stop
 * writes, so a replacement that never starts leaves it for the next `ocx stop` to finish.
 *
 * An ordinary `ocx stop` never sees the variable and still restores native routing.
 */
export const UPDATE_TEARDOWN_HANDOVER_ENV = "OCX_UPDATE_TEARDOWN_HANDOVER";

/**
 * `publishesOnStart` answers whether the restarted proxy will run its startup Codex sync.
 * Without one it can never discharge the receipt, so the stop restores as usual; an
 * unreadable answer is treated the same way.
 */
export function updateTeardownHandoverRequested(
  env: NodeJS.ProcessEnv = process.env,
  publishesOnStart: () => boolean = () => true,
): boolean {
  if (env[UPDATE_TEARDOWN_HANDOVER_ENV] !== "1") return false;
  try { return publishesOnStart(); } catch { return false; }
}

/** An identity-aware "is that stop still running", the rule handleStop uses for receipts. */
export function teardownOwnerStillRunning(pid: number): boolean {
  return isProcessAlive(pid) && isLikelyOcxProcess(pid);
}

/**
 * Is an update handover waiting for this starting proxy? True when a valid, exact handover
 * receipt exists whose stop has exited: that stop kept Codex routing for the replacement.
 */
export function updateTeardownHandoverPending(ownerStillRunning: (pid: number) => boolean = teardownOwnerStillRunning): boolean {
  return listPendingTeardowns().some(read => read.state === "valid"
    && read.receipt.handover === "update-restart" && read.receipt.endpointSource === "exact"
    && isPendingTeardownAbandoned(read, ownerStillRunning));
}

/** The environment for an update child whose caller will restart the proxy afterwards. */
export function withUpdateTeardownHandover(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [UPDATE_TEARDOWN_HANDOVER_ENV]: "1" };
}

/** The environment for an update child that must restore as usual, whatever this process inherited. */
export function withoutUpdateTeardownHandover(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child[UPDATE_TEARDOWN_HANDOVER_ENV];
  return child;
}

/**
 * Drop the marker from a starting proxy. The updater lanes pass their environment to the
 * recovery and replacement starts they spawn; a proxy that kept it would hand it to every
 * dashboard update worker it launches later, including ones that never restart.
 */
export function forgetUpdateTeardownHandover(env: NodeJS.ProcessEnv = process.env): void {
  delete env[UPDATE_TEARDOWN_HANDOVER_ENV];
}

/** The facts `ocx stop` has already settled when it reaches the shared restore. */
export type StopHandoverFacts = {
  requested: boolean;
  restoreBlocked: boolean;
  nonce: string | undefined;
  stopFailed: boolean;
  recoveredCount: number;
  proxy: string;
  /** What the service-manager stop returned; a manager can take the proxy down itself. */
  service?: string;
  /**
   * The proxy this run stopped answered `deferred` before exiting. Any fallback (a failed
   * or unconfirmed /api/stop, then a signal) lets a standalone proxy's exit cleanup restore
   * native Codex and the pristine catalog, so nothing is left to hand over.
   */
  deferralHonored?: boolean;
};

/**
 * May this stop skip the restore and hand its teardown to the restarted proxy?
 *
 * Only when the update asked for it, this run's own receipt is the single obligation in
 * the home, and the proxy it named is down: stopped by this run, or gone after a clean
 * service-manager stop (a launchd/systemd/scheduler child exits with its manager, and its
 * own exit cleanup keeps routing because it runs with OCX_SERVICE). A recovered or foreign
 * receipt, a blocked restore or a stop that failed on the way all take the ordinary
 * restore instead. The exclusivity check is what lets the updater treat the outstanding
 * receipt as expected; the updater still probes the endpoint itself before replacing files.
 */
export function stopHandsTeardownOver(facts: StopHandoverFacts): boolean {
  const managerStopped = facts.service === "stopped" || facts.service === "stopped-respawnable";
  const proxyDown = ((facts.proxy === "stopped" || facts.proxy === "stopped-orphan") && facts.deferralHonored === true)
    || (facts.proxy === "not-running" && managerStopped);
  return facts.requested && !facts.restoreBlocked && facts.nonce !== undefined && !facts.stopFailed
    && facts.recoveredCount === 0 && proxyDown && pendingTeardownsAreExactly([facts.nonce])
    && handoverReceiptIsRecoverable(facts.nonce);
}

/**
 * A handed-over receipt must be one a later `ocx stop` can finish on its own if no
 * replacement ever starts. A `guessed` endpoint fails closed into manual recovery there,
 * so a stop that could only record the configured address restores instead.
 */
function handoverReceiptIsRecoverable(nonce: string): boolean {
  const read = readPendingTeardown(nonce);
  return read.state === "valid" && read.receipt.endpointSource === "exact" && read.receipt.handover === "update-restart";
}

export function announceStopHandover(log: Pick<Console, "log"> = console): void {
  log.log("↪️  Codex routing, its catalog and the Grok config stay in place for the updated proxy, which releases them after its first sync.");
  log.log("   If it does not start, run 'ocx start' to take them over or 'ocx stop' to restore native Codex.");
}

/**
 * Release handover receipts once this proxy has published its own routing.
 *
 * Called after a successful startup sync, when Codex config and catalog point at the
 * running proxy again, so the restore the stop handed over is no longer owed. Only a
 * handover receipt whose owning stop has exited is released: an ordinary deferred stop
 * still has to run its own restore, and a stop that is still running owns its receipt.
 */
export function dischargeUpdateTeardownHandovers(ownerStillRunning: (pid: number) => boolean): {
  discharged: string[];
  failed: string[];
} {
  const discharged: string[] = [];
  const failed: string[] = [];
  for (const read of listPendingTeardowns()) {
    if (read.state !== "valid" || read.receipt.handover !== "update-restart") continue;
    if (!isPendingTeardownAbandoned(read, ownerStillRunning)) continue;
    if (clearPendingTeardown(read.receipt.nonce)) discharged.push(read.receipt.nonce);
    else failed.push(read.receipt.nonce);
  }
  return { discharged, failed };
}

/** Startup half: after this proxy published its own routing, release what the update kept. */
export function completeUpdateTeardownHandover(
  ownerStillRunning: (pid: number) => boolean,
  log: Pick<Console, "log" | "error"> = console,
): void {
  const handover = dischargeUpdateTeardownHandovers(ownerStillRunning);
  if (handover.discharged.length > 0) log.log("   Took over the Codex routing an update kept in place.");
  for (const nonce of handover.failed) {
    log.error(`⚠️  Could not remove the update handover receipt ${pendingTeardownPathFor(nonce)}; the next 'ocx stop' finishes it.`);
  }
}
