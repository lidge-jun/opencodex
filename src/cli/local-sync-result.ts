import type { CodexSyncResult } from "../codex/sync";
import { FOREIGN_CODEX_HOME_OWNER_MESSAGE, UNKNOWN_CODEX_HOME_OWNER_MESSAGE,
  unbackedRoutedRemovalMessage } from "../codex/catalog/routed-removal";

/** Safe local evidence; callers own required versus opportunistic sync policy. */
export interface LocalSyncResult {
  status: CodexSyncResult["status"] | "not-running" | "not-attempted" | "failed";
  ok: boolean;
  /** Only the catalog owner's fixed, path-free safety guidance; never a raw warning. */
  warning?: string;
  configApplied?: boolean;
  catalog?: { exists: boolean; written: boolean; cacheSynced: boolean; converged: boolean };
}

/** Project only the catalog owner's path-free safety guidance, not arbitrary sync errors. */
function catalogSafetyWarning(warning: string | undefined): string | undefined {
  if (!warning) return undefined;
  for (const message of [FOREIGN_CODEX_HOME_OWNER_MESSAGE, UNKNOWN_CODEX_HOME_OWNER_MESSAGE]) {
    if (warning.startsWith(message)) return message;
  }
  const countText = /^Codex catalog left unchanged: this refresh would remove the routed models of (\d+) /.exec(warning)?.[1];
  if (!countText) return undefined;
  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count < 1) return undefined;
  const message = unbackedRoutedRemovalMessage(count);
  return warning.startsWith(message) ? message : undefined;
}

/** No discovery, sync, logging, private paths or raw warning/error projection. */
export function projectLocalSyncResult(result: CodexSyncResult): LocalSyncResult {
  const warning = catalogSafetyWarning(result.warning);
  const converged = result.catalogExists && result.refreshOutcome !== "refused" && !warning;
  return {
    status: result.status,
    ...(warning ? { warning } : {}),
    ok: result.ok && (result.status === "skipped" || (result.status !== "refused" && converged)),
    configApplied: result.status === "applied" && result.ok,
    catalog: { exists: result.catalogExists, written: result.catalogWritten,
      cacheSynced: result.cacheSynced, converged },
  };
}
