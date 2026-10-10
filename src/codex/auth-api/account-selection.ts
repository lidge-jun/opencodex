import type { OcxConfig } from "../../types";
import { getConfigPath, initializePersistedConfigIfMissing, mutatePersistedConfig } from "../../config";
import { mergeConfigDefaults, readConfigFileSnapshot, validateConfigCandidate } from "../../config/diagnostics";
import { adoptPersistedCodexAccountSelection, claudeCodeBaselineArmed } from "../../config/live-reconcile";
import { deleteConfigTopLevelKey, fileBackedConfigPath, recordFileBackedConfig } from "../../config/rebase-provenance";
import { MAIN_CODEX_ACCOUNT_ID, hasLegacyMainCodexPoolAccount, isSelectableCodexPoolAccount, isValidCodexAccountId } from "../account-id";
import { isCodexAccountPaused } from "../account-pause";
import { readCodexAccountRecord } from "../account-store";
import { codexAccountPinDrainReason, resetCodexRoutingForManualSelection } from "../routing";
import { jsonResponse } from "./http";

class SelectionRejected extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function validateSelection(config: OcxConfig, accountId: string | null): void {
  if (accountId === null) return;
  if (accountId === MAIN_CODEX_ACCOUNT_ID && hasLegacyMainCodexPoolAccount(config.codexAccounts)) {
    throw new SelectionRejected("Remove the legacy __main__ pool row before selecting the Desktop account", 409);
  }
  if (isCodexAccountPaused(config, accountId)) throw new SelectionRejected("Account is paused", 409);
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return;
  if (!isValidCodexAccountId(accountId)) throw new SelectionRejected("Invalid account id format", 400);
  if (!(config.codexAccounts ?? []).some(account => isSelectableCodexPoolAccount(account) && account.id === accountId)) {
    throw new SelectionRejected("Account not found", 400);
  }
  if (readCodexAccountRecord(accountId)?.codexValidationPending) {
    throw new SelectionRejected("Account validation is pending. Refresh quota after recovery to validate it.", 409);
  }
}

function applySelection(config: OcxConfig, accountId: string | null): boolean {
  const changed = config.activeCodexAccountId !== (accountId ?? undefined)
    || config.activeCodexAccountPinned !== (accountId ?? undefined);
  if (accountId === null) {
    deleteConfigTopLevelKey(config, "activeCodexAccountId");
    deleteConfigTopLevelKey(config, "activeCodexAccountPinned");
  } else {
    config.activeCodexAccountId = accountId;
    config.activeCodexAccountPinned = accountId;
  }
  return changed;
}

/** A manual selection is an explicit command, even when equal to the live merge baseline. */
export function persistCodexAccountSelection(config: OcxConfig, accountId: string | null): Response {
  const unknown = () => jsonResponse({
    error: "Account selection could not be confirmed; reload settings before retrying",
    code: "account_selection_unavailable",
  }, 409);
  const configPath = getConfigPath();
  const sourcePath = fileBackedConfigPath(config);
  if (sourcePath !== undefined && sourcePath !== configPath) return unknown();
  let committed: OcxConfig;
  let warning = false;
  try {
    // Do not activate a newly disk-only account that the running proxy has not adopted.
    validateSelection(config, accountId);
    const before = readConfigFileSnapshot();
    if (before.diagnostics.source === "default" && !fileBackedConfigPath(config) && !claudeCodeBaselineArmed(config)) {
      // Preserve transient/initial callers without recreating a deleted live configuration.
      // The create-only owner cannot replace a competing writer's newly published config.
      const normalized = validateConfigCandidate(mergeConfigDefaults(config));
      if (!normalized.ok) return unknown();
      const initial = normalized.config;
      applySelection(initial, accountId);
      initializePersistedConfigIfMissing(initial);
    }
    const result = mutatePersistedConfig(persisted => {
      // This callback is re-run under the mutation lock immediately before publication.
      // A removed or paused account must not be resurrected by a stale UI snapshot.
      validateSelection(config, accountId);
      validateSelection(persisted, accountId);
      return { changed: applySelection(persisted, accountId), value: persisted };
    });
    if (result.status === "unavailable") return unknown();
    committed = result.value;
  } catch (error) {
    if (error instanceof SelectionRejected) return jsonResponse({ error: error.message }, error.status);
    // Atomic publication may succeed before generation/bookkeeping fails. Confirm the exact
    // durable selection instead of rolling live state back behind an already published write.
    const snapshot = readConfigFileSnapshot();
    if (snapshot.raw === undefined) return unknown();
    try {
      const strict = validateConfigCandidate(JSON.parse(snapshot.raw.replace(/^\uFEFF/, "")));
      if (!strict.ok) return unknown();
      validateSelection(config, accountId);
      validateSelection(strict.config, accountId);
      if (strict.config.activeCodexAccountId !== (accountId ?? undefined)
        || strict.config.activeCodexAccountPinned !== (accountId ?? undefined)) return unknown();
      committed = strict.config;
      warning = true;
    } catch { return unknown(); }
  }
  adoptPersistedCodexAccountSelection(config, committed);
  recordFileBackedConfig(config, configPath);
  // No failed save may clear affinity, spend the manual preference, or move the RR cursor.
  resetCodexRoutingForManualSelection(accountId ?? MAIN_CODEX_ACCOUNT_ID);
  const pinDrainReason = accountId === null ? undefined : codexAccountPinDrainReason(config, accountId);
  return jsonResponse({
    ok: true,
    activeCodexAccountId: config.activeCodexAccountId ?? null,
    appliesImmediately: true,
    ...(pinDrainReason !== undefined ? { pinDrained: true, pinDrainReason } : {}),
    ...(warning ? { warning: "config_bookkeeping_failed" } : {}),
  });
}
