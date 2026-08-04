import { debugProviderDiagnostic } from "../lib/debug";

export type CodexCatalogRefreshCompletion = {
  catalogExists: boolean;
  catalogWritten?: boolean;
  cacheSynced?: boolean;
};

type CodexCatalogRefreshFailureReason = "missing" | "unwritten" | "cache_unsynced";

class CodexCatalogRefreshIncompleteError extends Error {
  constructor(readonly reason: CodexCatalogRefreshFailureReason) {
    super("Codex catalog was not refreshed");
    this.name = "CodexCatalogRefreshIncompleteError";
  }
}

/** Treat an incomplete catalog rewrite or cache invalidation as a refresh failure. */
export function assertCodexCatalogRefreshComplete(
  result: void | CodexCatalogRefreshCompletion,
): void {
  if (result?.catalogExists === false) throw new CodexCatalogRefreshIncompleteError("missing");
  if (result?.catalogWritten === false) throw new CodexCatalogRefreshIncompleteError("unwritten");
  if (result?.cacheSynced === false) throw new CodexCatalogRefreshIncompleteError("cache_unsynced");
}

/**
 * Refresh the Codex catalog, retrying once after a failure.
 *
 * Returns true only when both attempts fail. The mutation that requested the
 * refresh has already been persisted, so callers can report a recoverable
 * pending state instead of rolling back durable configuration.
 */
export async function refreshCodexCatalogWithRetry(
  refresh: () => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await Bun.sleep(50);
    try {
      await refresh();
      return false;
    } catch (error) {
      // Log only an internal classification. Raw failures can contain credentials,
      // account identifiers, provider URLs, or filesystem paths.
      debugProviderDiagnostic("codex", "catalog-refresh-failed", {
        attempt: attempt + 1,
        reason: error instanceof CodexCatalogRefreshIncompleteError ? error.reason : "exception",
      });
    }
  }

  console.warn("[opencodex] Codex catalog refresh is pending; run `ocx sync` to retry.");
  return true;
}
