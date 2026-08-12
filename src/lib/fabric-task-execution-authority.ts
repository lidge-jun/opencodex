import type { TrustedFabricPatchExecutor } from "../lab/fabric/types";
import { isHostIssuedFabricPatchExecutor } from "./fabric-task-host";

/** Trusted exact-route fabric patch executor recognition facade. */
export function isTrustedFabricPatchExecutor(value: unknown): value is TrustedFabricPatchExecutor {
  return isHostIssuedFabricPatchExecutor(value);
}
