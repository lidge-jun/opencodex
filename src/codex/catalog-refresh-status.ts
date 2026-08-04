/** Treat an incomplete catalog rewrite or cache invalidation as a refresh failure. */
export function assertCodexCatalogRefreshComplete(
  result: void | {
    catalogExists: boolean;
    catalogWritten?: boolean;
    cacheSynced?: boolean;
  },
): void {
  if (
    result?.catalogExists === false
    || result?.catalogWritten === false
    || result?.cacheSynced === false
  ) {
    throw new Error("Codex catalog was not refreshed");
  }
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
    try {
      await refresh();
      return false;
    } catch {
      // Retry once. Failure details may contain provider or filesystem data, so
      // the terminal warning below stays generic.
    }
  }

  console.warn("[opencodex] Codex catalog refresh is pending; run `ocx sync` to retry.");
  return true;
}
