import { existsSync, readFileSync } from "node:fs";
import {
  atomicWriteFile,
  getConfigPath,
  saveConfigPreservingClaudeCode,
  withConfigMutationLockSync,
} from "../config";
import { removeCodexAccountCredential } from "./account-store";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { getMainChatgptAccountId } from "./auth-collision";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./main-account";
import { clearAccountQuota } from "./quota";
import { clearCodexUpstreamHealthForAccount, clearThreadAccountMapForAccount } from "./routing";
import { invalidateCodexWebSocketsForAccount } from "./websocket-registry";
import { clearMainAccountCredentialPresence, clearMainAccountInfoCache } from "./main-account-cache";
import { forgetCodexAccountPause } from "./account-pause";
import { clearCodexAccountPin, forgetCodexAccountPriority } from "./account-priority";
import { codexAccountNamespaceEntries, codexAccountPickerEnabled } from "./account-namespaces";
import type { OcxConfig } from "../types";

let observedMainChatgptAccountId: string | undefined;

export class CodexAccountDeleteCleanupError extends Error {
  constructor() {
    super("Account deletion was saved, but local credential cleanup did not complete. Retry removal.");
    this.name = "CodexAccountDeleteCleanupError";
  }
}

export class CodexAccountDeleteRollbackError extends Error {
  constructor() {
    super("Account deletion failed and the previous config could not be restored. Restart before retrying.");
    this.name = "CodexAccountDeleteRollbackError";
  }
}

export function purgeCodexAccountRuntimeState(accountId: string): void {
  clearAccountNeedsReauth(accountId);
  clearAccountQuota(accountId);
  clearThreadAccountMapForAccount(accountId);
  clearCodexUpstreamHealthForAccount(accountId);
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    clearMainAccountInfoCache();
    clearMainAccountCredentialPresence();
  }
}

function purgeMainCodexAccountRuntimeState(): void {
  purgeCodexAccountRuntimeState(MAIN_CODEX_ACCOUNT_ID);
  setMainAccountPlan(null);
  invalidateCodexWebSocketsForAccount(MAIN_CODEX_ACCOUNT_ID);
}

/**
 * The main Codex login is stored under the stable `__main__` alias, while
 * `~/.codex/auth.json` can be replaced with credentials for another physical
 * ChatGPT account. Drop alias-keyed runtime state when that identity changes so
 * cooldown, quota, reauth, and thread affinity do not leak across accounts.
 */
export function reconcileMainCodexAccountRuntimeState(): boolean {
  const currentAccountId = getMainChatgptAccountId();
  // A missing/malformed auth.json is an unknown identity, not a confirmed account switch. Keep the
  // prior observation and its safety state until a real account id can be read again.
  if (currentAccountId === null) return false;
  const previousAccountId = observedMainChatgptAccountId;
  observedMainChatgptAccountId = currentAccountId;
  if (previousAccountId === undefined || previousAccountId === currentAccountId) return false;

  purgeMainCodexAccountRuntimeState();
  return true;
}

/**
 * Apply a transaction-confirmed physical native-login change without waiting for
 * a later auth.json observation. The caller owns credential commit/rollback.
 */
export function applyConfirmedMainCodexAccountTransition(
  fromAccountId: string,
  toAccountId: string,
): boolean {
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
    if (toAccountId) observedMainChatgptAccountId = toAccountId;
    return false;
  }
  observedMainChatgptAccountId = toAccountId;
  purgeMainCodexAccountRuntimeState();
  return true;
}

export function resetMainCodexAccountIdentityTrackingForTests(): void {
  observedMainChatgptAccountId = undefined;
  clearMainAccountCredentialPresence();
}

function restoreRuntimeConfig(target: OcxConfig, snapshot: OcxConfig): void {
  for (const key of Object.keys(target) as Array<keyof OcxConfig>) delete target[key];
  Object.assign(target, snapshot);
}

function restorePersistedConfig(configPath: string, previousBytes: string): void {
  try {
    if (readFileSync(configPath, "utf8") === previousBytes) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  atomicWriteFile(configPath, previousBytes);
}

/**
 * Delete a stored account while retaining its selector binding.
 *
 * When the runtime config is backed by an existing config.json, commit the config deletion before
 * credentials or runtime state are destroyed. Transient callers intentionally skip durable config
 * persistence because they have no durable account row to protect. The whole sequence shares the
 * config mutation coordinator so a cooperating writer cannot re-add a persisted account between
 * the durable config commit and credential cleanup.
 *
 * Returns true when a picker-visible row disappeared and the catalog must converge.
 */
export function deleteCodexAccount(runtimeConfig: OcxConfig, accountId: string): boolean {
  let cleanupFailed = false;
  const pickerVisibilityChanged = withConfigMutationLockSync(() => {
    const previousConfig = structuredClone(runtimeConfig);
    const configPath = getConfigPath();
    const hasPersistedConfig = existsSync(configPath);
    const previousPersistedConfig = hasPersistedConfig ? readFileSync(configPath, "utf8") : undefined;
    const hadStoredAccount = (runtimeConfig.codexAccounts ?? [])
      .some(account => !account.isMain && account.id === accountId);
    const hadVisiblePickerBinding = hadStoredAccount
      && codexAccountPickerEnabled(runtimeConfig)
      && codexAccountNamespaceEntries(runtimeConfig)
        .some(([, boundAccountId]) => boundAccountId === accountId);

    runtimeConfig.codexAccounts = (runtimeConfig.codexAccounts ?? [])
      .filter(account => account.isMain || account.id !== accountId);
    forgetCodexAccountPause(runtimeConfig, accountId);
    forgetCodexAccountPriority(runtimeConfig, accountId);
    clearCodexAccountPin(runtimeConfig, accountId);
    if (runtimeConfig.activeCodexAccountId === accountId) runtimeConfig.activeCodexAccountId = undefined;

    if (previousPersistedConfig !== undefined) {
      try {
        // Persist first for durable configs. Destructive cleanup below must never run for a
        // deletion that failed to commit. Transient configs intentionally skip this write.
        saveConfigPreservingClaudeCode(runtimeConfig);
      } catch (error) {
        restoreRuntimeConfig(runtimeConfig, previousConfig);
        try {
          restorePersistedConfig(configPath, previousPersistedConfig);
        } catch {
          throw new CodexAccountDeleteRollbackError();
        }
        throw error;
      }
    }

    try {
      removeCodexAccountCredential(accountId);
      purgeCodexAccountRuntimeState(accountId);
      invalidateCodexWebSocketsForAccount(accountId);
    } catch {
      // Do not throw through the mutation coordinator after config.json committed: that would roll
      // back only the SQLite generation transaction, not the already-atomic file replacement.
      cleanupFailed = true;
    }

    return hadVisiblePickerBinding;
  });

  if (cleanupFailed) throw new CodexAccountDeleteCleanupError();
  return pickerVisibilityChanged;
}
