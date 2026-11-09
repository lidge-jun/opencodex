import { AsyncLocalStorage } from "node:async_hooks";
import type { MuseNativeRuntimePool } from "./runtime-pool";

const scope = new AsyncLocalStorage<MuseNativeRuntimePool>();

/** Bind each HTTP request to its server's own native-runner pool. */
export function withMuseNativeRuntimePool<T>(pool: MuseNativeRuntimePool, work: () => T): T {
  return scope.run(pool, work);
}

export function currentMuseNativeRuntimePool(): MuseNativeRuntimePool | undefined {
  return scope.getStore();
}
