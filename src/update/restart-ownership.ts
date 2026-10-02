import { resolveServiceOwnership } from "../service";
import type { ServiceOwnershipResolution } from "../service";
import { serviceStatePaths } from "../service/state";
import {
  acquireOwnershipMutationLease,
  OWNERSHIP_MUTATION_LEASE_TOKEN_ENV,
} from "../service/ownership-mutation-lease.mjs";
import { planUpdateRuntimeHandling } from "./runtime-ownership.mjs";

export type { ServiceOwnershipResolution };

/**
 * Why a dashboard update must not restart a runtime it did not stop.
 *
 * The worker defaults to restarting. When the package updater it just ran left a
 * foreign-owned runtime alone — which is the correct behaviour under a desktop takeover —
 * the sidecar's unchanged pid fails the worker's restart evidence, so it reclaims the port,
 * runs the repair that now refuses, and falls through to a direct start. The app's runtime
 * ends up replaced by an npm proxy immediately after the update declined to touch it.
 *
 * Returns the line to report, or null when the restart may proceed. It lives beside the
 * worker rather than inside it because `src/update/job.ts` is one line under the repository
 * size cap.
 */
export function updateRestartVeto(
  resolve: () => ServiceOwnershipResolution = resolveServiceOwnership,
): string | null {
  const owner = resolve();
  const plan = planUpdateRuntimeHandling({
    ownership: owner.kind === "owned" ? owner.ownership : null,
    ownershipUnknown: owner.kind === "unknown",
    // The restart decision does not refresh the service; only the stop veto is read here.
    serviceInstalled: false,
  });
  if (plan.mayStopRuntime) return null;
  return plan.notice ?? "The background runtime is owned elsewhere; it was left running.";
}

/**
 * The lease boundary inside a running restart, handed to `restart`.
 *
 * `ocx service repair` re-activates the OS service manager — Task Scheduler, launchd
 * or systemd — and that `ocx start` child is not a descendant of this process: it runs
 * with the stored registration environment, carries no delegated token, and can never
 * join the lease held here. Held through the repair's serving wait, the lease keeps
 * that child from ever starting (#5760; the npm lane releases at this boundary). The
 * veto is the decision the lease must cover — the reclaim and kills it authorizes —
 * so the fallthrough takes the lease back before re-running it: anything between the
 * service refresh and the direct start would otherwise mutate the port unleased.
 */
export interface UpdateRestartLeaseControl {
  /** Free the lease before a service-manager-mediated start that cannot join it. Idempotent. */
  releaseForServiceManager(): void;
  /**
   * Take the lease back before the fallthrough mutates the port, then re-run the veto
   * under it. A lease that stays claimed (a live claimant mid-mutation) fails closed:
   * the returned notice stops the restart before any kill or start, and `failed` marks
   * the job failed — the refresh just before this did not produce a serving proxy, so
   * nothing is known to be running. An ownership veto is not a failure.
   */
  reacquireForDirectStart(): UpdateRestartStop | null;
  /** Re-run the recorded-owner veto; a non-null notice must stop the restart there. */
  vetoAgain(): string | null;
}

/** Why the direct-start fallthrough stopped; `failed` means no proxy is known to be serving. */
export interface UpdateRestartStop {
  readonly notice: string;
  readonly failed: boolean;
}

/**
 * Long enough to outlast one service-wrapper respawn cycle (5 s) of the managed child the
 * refresh just started, which briefly holds the lease while it binds and publishes.
 */
const REACQUIRE_WAIT_MS = 10_000;

export async function runUpdateRestartWithOwnershipLease<T>(
  resolve: (() => ServiceOwnershipResolution) | undefined,
  restart: (lease: UpdateRestartLeaseControl) => Promise<T>,
): Promise<{ readonly kind: "veto"; readonly notice: string } | { readonly kind: "ran"; readonly value: T }> {
  let lease = acquireOwnershipMutationLease(serviceStatePaths());
  const previous = process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
  process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV] = lease.token;
  let heldNow = true;
  const restoreEnv = () => {
    if (previous === undefined) delete process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
    else process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV] = previous;
  };
  const release = () => {
    if (!heldNow) return;
    heldNow = false;
    restoreEnv();
    lease.release();
  };
  const reacquireForDirectStart = (): UpdateRestartStop | null => {
    if (!heldNow) {
      try {
        lease = acquireOwnershipMutationLease(serviceStatePaths(), { waitMs: REACQUIRE_WAIT_MS });
      } catch {
        return {
          failed: true,
          notice: "Update installed, but another process kept the runtime ownership lease claimed, so no proxy was started. "
            + "Run 'ocx service status', then 'ocx service repair' or 'ocx start'.",
        };
      }
      heldNow = true;
      process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV] = lease.token;
    }
    const veto = updateRestartVeto(resolve);
    return veto ? { notice: veto, failed: false } : null;
  };
  try {
    const veto = updateRestartVeto(resolve);
    return veto
      ? { kind: "veto", notice: veto }
      : {
          kind: "ran",
          value: await restart({
            releaseForServiceManager: release,
            reacquireForDirectStart,
            vetoAgain: () => updateRestartVeto(resolve),
          }),
        };
  } finally {
    release();
  }
}
