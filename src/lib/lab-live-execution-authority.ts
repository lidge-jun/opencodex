import type { TrustedLabRouteExecutor } from "../lab/live/types";
import { isHostIssuedLabRouteExecutor } from "./lab-live-host";

/**
 * Read-only trust check used by the Lab executor.
 *
 * Capability issuance intentionally does not live in this authority module: callers cannot
 * self-attest sandbox boundary names here. Only the dedicated trusted host integration may
 * construct and register an evidence-eligible route executor.
 */
export function isTrustedLabRouteExecutor(value: unknown): value is TrustedLabRouteExecutor {
  return isHostIssuedLabRouteExecutor(value);
}
