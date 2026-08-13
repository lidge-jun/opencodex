import type { FabricPatchExecutor, FabricPatchExecutorInput, TrustedFabricPatchExecutor } from "../lab/fabric/types";

const HOST_ISSUED_EXECUTORS = new WeakSet<object>();

/**
 * Trusted host integration boundary for CL-07 exact-route fabric patch production.
 *
 * @internal host integration only
 */
export function createHostIssuedFabricPatchExecutor(
  executorModulePath: string,
  execute: FabricPatchExecutor,
): TrustedFabricPatchExecutor {
  const capability: TrustedFabricPatchExecutor = Object.freeze({
    executorModulePath,
    execute: (input: FabricPatchExecutorInput) => Promise.resolve(execute(input)),
  });
  HOST_ISSUED_EXECUTORS.add(capability);
  return capability;
}

/** Internal recognition check consumed by the read-only authority facade. */
export function isHostIssuedFabricPatchExecutor(value: unknown): value is TrustedFabricPatchExecutor {
  if (typeof value !== "object" || value === null || !HOST_ISSUED_EXECUTORS.has(value as object)) return false;
  const capability = value as TrustedFabricPatchExecutor;
  return typeof capability.executorModulePath === "string"
    && capability.executorModulePath.length > 0
    && typeof capability.execute === "function";
}
