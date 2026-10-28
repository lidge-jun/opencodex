import { spyOn } from "bun:test";
import { join, resolve } from "node:path";
import * as clientLifecycle from "../../src/client/lifecycle-lock";

const realSync = clientLifecycle.withClientLifecycleSync;
const realAsync = clientLifecycle.withClientLifecycle;

/** Keep real SQLite exclusion and leases, without sharing the OS user's Desktop lock. */
export function isolateClientLifecycleLock(root: string) {
  const acquisitions: Array<{ kind: "sync" | "async"; path: string }> = [];
  function isolatedDeps(kind: "sync" | "async", deps?: clientLifecycle.ClientLifecycleLockDeps) {
    const lockPath = deps?.lockPath ?? join(root, "locks", "lifecycle.sqlite");
    acquisitions.push({ kind, path: resolve(lockPath) });
    return { ...deps, lockPath };
  }
  const sync = spyOn(clientLifecycle, "withClientLifecycleSync").mockImplementation(
    (work, deps) => realSync(work, isolatedDeps("sync", deps)),
  );
  const async = spyOn(clientLifecycle, "withClientLifecycle").mockImplementation(
    (work, deps) => realAsync(work, isolatedDeps("async", deps)),
  );
  return {
    acquisitions,
    restore() { async.mockRestore(); sync.mockRestore(); },
  };
}
