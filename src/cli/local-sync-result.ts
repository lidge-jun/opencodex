import type { CodexSyncResult } from "../codex/sync";

/** Safe local evidence; callers own required versus opportunistic sync policy. */
export interface LocalSyncResult {
  status: CodexSyncResult["status"] | "not-running" | "not-attempted" | "failed";
  ok: boolean;
  configApplied?: boolean;
  catalog?: { exists: boolean; written: boolean; cacheSynced: boolean; converged: boolean };
}

/** No discovery, sync, logging, private paths or raw warning/error projection. */
export function projectLocalSyncResult(result: CodexSyncResult): LocalSyncResult {
  const converged = result.catalogExists && result.refreshOutcome !== "refused";
  return {
    status: result.status,
    ok: result.ok && (result.status === "skipped" || (result.status !== "refused" && converged)),
    configApplied: result.status === "applied" && result.ok,
    catalog: { exists: result.catalogExists, written: result.catalogWritten,
      cacheSynced: result.cacheSynced, converged },
  };
}
