/**
 * Single-flight wrapper for manual archived cleanup (management API).
 *
 * Shares the CODEX_HOME storage-mutation coordinator with trash restore and
 * (Phase 3) policy-driven cleanup.
 */
import { resolveCodexHomeDir } from "../codex/home";
import {
  executeArchivedCleanup,
  type CleanupResult,
  type ExecuteCleanupOptions,
} from "./cleanup";
import {
  resetStorageMutationCoordinatorForTests,
  setStorageMutationCoordinatorTestHooks,
  withStorageMutationSlot,
  type StorageMutationCoordinatorTestHooks,
} from "./storage-mutation-coordinator";

export type CleanupJobTestHooks = StorageMutationCoordinatorTestHooks;

export function setArchivedCleanupJobTestHooks(hooks: CleanupJobTestHooks | null): void {
  setStorageMutationCoordinatorTestHooks(hooks);
}

export function resetArchivedCleanupJobForTests(): void {
  resetStorageMutationCoordinatorForTests();
}

/**
 * Run archived cleanup under the shared storage-mutation gate.
 * Returns immediately with `storage_mutation_busy` when restore or another
 * cleanup is in flight for the same CODEX_HOME.
 */
export async function runArchivedCleanupJob(
  options: ExecuteCleanupOptions,
): Promise<CleanupResult> {
  const codexHome = options.codexHome ?? resolveCodexHomeDir();
  const mode = options.mode;
  const percent = options.percent;
  const result = await withStorageMutationSlot("cleanup", codexHome, () =>
    executeArchivedCleanup(options),
  );
  if (result && typeof result === "object" && "ok" in result && result.ok === false
    && "error" in result && result.error === "storage_mutation_busy") {
    return {
      ok: false,
      mode,
      percent,
      count: 0,
      bytes: 0,
      removedPaths: [],
      error: "storage_mutation_busy",
    };
  }
  return result as CleanupResult;
}
