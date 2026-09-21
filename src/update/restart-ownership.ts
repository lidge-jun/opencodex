import { resolveServiceOwnership } from "../service";
import type { ServiceOwnershipResolution } from "../service";
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
  if (plan.stopRuntime) return null;
  return plan.notice ?? "The background runtime is owned elsewhere; it was left running.";
}
