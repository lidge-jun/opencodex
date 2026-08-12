import type { LabRouteExecutor, TrustedLabRouteExecutor } from "../lab/live/types";
import { REQUIRED_LAB_SANDBOX_BOUNDARIES } from "../lab/live/types";

const HOST_ISSUED_EXECUTORS = new WeakSet<object>();

/**
 * Trusted host integration boundary for CL-03 exact-route execution.
 *
 * This module is intentionally not re-exported from the Lab public surface. The host owns
 * enforcement of every mandatory sandbox boundary and therefore supplies no caller-controlled
 * boundary list. Adapters/providers receive only the resulting opaque capability.
 *
 * @internal host integration only
 */
export function createHostIssuedLabRouteExecutor(execute: LabRouteExecutor): TrustedLabRouteExecutor {
  const capability: TrustedLabRouteExecutor = Object.freeze({
    execute,
    enforcedBoundaries: Object.freeze([...REQUIRED_LAB_SANDBOX_BOUNDARIES]),
  });
  HOST_ISSUED_EXECUTORS.add(capability);
  return capability;
}

/** Internal recognition check consumed by the read-only authority facade. */
export function isHostIssuedLabRouteExecutor(value: unknown): value is TrustedLabRouteExecutor {
  if (typeof value !== "object" || value === null || !HOST_ISSUED_EXECUTORS.has(value as object)) return false;
  const capability = value as TrustedLabRouteExecutor;
  return capability.enforcedBoundaries.length === REQUIRED_LAB_SANDBOX_BOUNDARIES.length
    && REQUIRED_LAB_SANDBOX_BOUNDARIES.every((boundary, index) => capability.enforcedBoundaries[index] === boundary);
}
