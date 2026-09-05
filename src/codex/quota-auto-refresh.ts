import { mutatePersistedConfig } from "../config";
import { registerStateSweepAfterTick } from "../lib/state-store-sweeper";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { normalizeResetAt } from "../providers/quota-wire";
import { providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";
import { reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import { isCodexAccountPaused } from "./account-pause";
import { isAccountNeedsReauth } from "./account-runtime-state";
import { getValidCodexToken } from "./account-store";
import { getMainAccountToken, getValidMainAccountToken, MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { isMainAccountHardLocked } from "./main-account-hard-lock";
import { tryAcquireNativeMainProfileClaim } from "./native-main-admission";
import { withNativeMainSharedClaim } from "./native-main-claim";
import { resolveNativeProfileContext } from "./native-profile-store";
import { getAccountQuota, type StoredAccountQuota } from "./quota";
import { warmCodexAccount } from "./warmup";
import {
  completedByAccount, retryAfterByAccount, resetCodexQuotaAutoRefreshStateForTests,
  type CodexQuotaAutoRefreshWindows,
} from "./quota-auto-refresh-state";
export type { CodexQuotaAutoRefreshWindows } from "./quota-auto-refresh-state";
export { forgetCodexQuotaAutoRefreshAccount } from "./quota-auto-refresh-state";

export const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const RETRY_MS = 5 * 60_000;
const CONCURRENCY = 4;

export interface CodexQuotaAutoRefreshStatus {
  fiveHourAvailable: boolean;
  weeklyAvailable: boolean;
  fiveHourEnabled: boolean;
  weeklyEnabled: boolean;
}

export interface CodexQuotaAutoRefreshRunDeps {
  getQuota?: (accountId: string) => StoredAccountQuota | null;
  /** Only false means skipped; existing void callbacks still report a successful warmup. */
  warmAccount?: (config: OcxConfig, accountId: string) => Promise<void | false>;
  persistCompleted?: (
    config: OcxConfig,
    accountId: string,
    completed: CodexQuotaAutoRefreshWindows,
  ) => boolean;
}

let inFlight: Promise<void> | null = null;

export function codexQuotaAutoRefreshStatus(
  config: OcxConfig,
  accountId: string,
  quota: StoredAccountQuota | null,
): CodexQuotaAutoRefreshStatus {
  const saved = config.codexQuotaAutoRefresh?.[accountId];
  return {
    fiveHourAvailable: quota?.shortWindowSeconds === FIVE_HOUR_WINDOW_SECONDS
      && typeof quota.shortResetAt === "number",
    weeklyAvailable: typeof quota?.weeklyResetAt === "number",
    fiveHourEnabled: saved?.fiveHour === true,
    weeklyEnabled: saved?.weekly === true,
  };
}

export function dueCodexQuotaAutoRefreshWindows(
  config: OcxConfig,
  accountId: string,
  quota: StoredAccountQuota | null,
  now: number,
  completed = completedByAccount.get(accountId),
): CodexQuotaAutoRefreshWindows | null {
  if (!quota) return null;
  const saved = config.codexQuotaAutoRefresh?.[accountId];
  const due: CodexQuotaAutoRefreshWindows = {};
  const shortResetAt = normalizeResetAt(quota.shortResetAt);
  const weeklyResetAt = normalizeResetAt(quota.weeklyResetAt);
  if (saved?.fiveHour === true
    && quota.shortWindowSeconds === FIVE_HOUR_WINDOW_SECONDS
    && shortResetAt !== undefined
    && shortResetAt <= now
    && normalizeResetAt(saved.lastFiveHourResetAt) !== shortResetAt
    && normalizeResetAt(completed?.fiveHour) !== shortResetAt) {
    due.fiveHour = shortResetAt;
  }
  if (saved?.weekly === true
    && weeklyResetAt !== undefined
    && weeklyResetAt <= now
    && normalizeResetAt(saved.lastWeeklyResetAt) !== weeklyResetAt
    && normalizeResetAt(completed?.weekly) !== weeklyResetAt) {
    due.weekly = weeklyResetAt;
  }
  return due.fiveHour === undefined && due.weekly === undefined ? null : due;
}

function mainWarmupRestricted(config: OcxConfig): boolean {
  return isMainAccountHardLocked(config)
    || isCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID)
    || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
}

async function warmAccount(config: OcxConfig, accountId: string): Promise<void | false> {
  if (accountId !== MAIN_CODEX_ACCOUNT_ID) {
    await warmCodexAccount(await getValidCodexToken(accountId));
    return;
  }
  const lease = tryAcquireNativeMainProfileClaim();
  if (!lease) throw new Error("native main busy");
  try {
    reconcileMainCodexAccountRuntimeState();
    if (mainWarmupRestricted(config)) return false;
    // Refresh may need exclusive ownership. Finish it before the warmup's shared ownership.
    const prepared = await getValidMainAccountToken({ preserveReauth: true });
    if (!prepared) throw new Error("main account unavailable");
    return await withNativeMainSharedClaim(resolveNativeProfileContext(), async (): Promise<void | false> => {
      const token = getMainAccountToken();
      if (!token || token.accessToken !== prepared.accessToken
        || token.chatgptAccountId !== prepared.chatgptAccountId) return false;
      if (mainWarmupRestricted(config)) return false;
      await warmCodexAccount(token);
    });
  } finally {
    lease.release();
  }
}

function persistCompleted(
  config: OcxConfig,
  accountId: string,
  completed: CodexQuotaAutoRefreshWindows,
): boolean {
  try {
    const outcome = mutatePersistedConfig(persisted => {
      const saved = persisted.codexQuotaAutoRefresh?.[accountId];
      if (!saved) return { changed: false, value: null };
      const next = {
        ...saved,
        ...(completed.fiveHour !== undefined ? { lastFiveHourResetAt: completed.fiveHour } : {}),
        ...(completed.weekly !== undefined ? { lastWeeklyResetAt: completed.weekly } : {}),
      };
      persisted.codexQuotaAutoRefresh = { ...persisted.codexQuotaAutoRefresh, [accountId]: next };
      return { changed: true, value: next };
    });
    if (outcome.status === "unavailable" || !outcome.value) return false;
    config.codexQuotaAutoRefresh = { ...config.codexQuotaAutoRefresh, [accountId]: outcome.value };
    return true;
  } catch {
    return false;
  }
}

function retryPendingMarkers(
  config: OcxConfig,
  persist: NonNullable<CodexQuotaAutoRefreshRunDeps["persistCompleted"]>,
): void {
  for (const [accountId, completed] of completedByAccount) {
    const saved = config.codexQuotaAutoRefresh?.[accountId];
    if (!saved) continue;
    if ((completed.fiveHour === undefined
      || normalizeResetAt(saved.lastFiveHourResetAt) === normalizeResetAt(completed.fiveHour))
      && (completed.weekly === undefined
        || normalizeResetAt(saved.lastWeeklyResetAt) === normalizeResetAt(completed.weekly))) continue;
    persist(config, accountId, completed);
  }
}

export async function runCodexQuotaAutoRefresh(
  config: OcxConfig,
  now = Date.now(),
  deps: CodexQuotaAutoRefreshRunDeps = {},
): Promise<void> {
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!openai || openai.disabled === true || !isCanonicalOpenAiForwardProvider(openai)) return;
  if (providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool") return;
  if (inFlight) return inFlight;
  const quotaFor = deps.getQuota ?? getAccountQuota;
  const warm = deps.warmAccount ?? warmAccount;
  const persist = deps.persistCompleted ?? persistCompleted;
  inFlight = (async () => {
    retryPendingMarkers(config, persist);
    const accountIds = [
      MAIN_CODEX_ACCOUNT_ID,
      ...(config.codexAccounts ?? []).filter(isSelectableCodexPoolAccount).map(account => account.id),
    ];
    const due = accountIds.flatMap(accountId => {
      if (isCodexAccountPaused(config, accountId)
        || isAccountNeedsReauth(accountId)
        || (accountId === MAIN_CODEX_ACCOUNT_ID && isMainAccountHardLocked(config))
        || (retryAfterByAccount.get(accountId) ?? 0) > now) return [];
      const windows = dueCodexQuotaAutoRefreshWindows(config, accountId, quotaFor(accountId), now);
      return windows ? [{ accountId, windows }] : [];
    });
    for (let index = 0; index < due.length; index += CONCURRENCY) {
      await Promise.all(due.slice(index, index + CONCURRENCY).map(async ({ accountId, windows }) => {
        try {
          if (await warm(config, accountId) === false) return;
          retryAfterByAccount.delete(accountId);
          const completed = { ...completedByAccount.get(accountId), ...windows };
          completedByAccount.set(accountId, completed);
          persist(config, accountId, completed);
        } catch {
          retryAfterByAccount.set(accountId, now + RETRY_MS);
        }
      }));
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

export function registerCodexQuotaAutoRefreshWorker(config: OcxConfig): () => void {
  return registerStateSweepAfterTick({
    name: "codex-quota-auto-refresh",
    afterTick: () => { void runCodexQuotaAutoRefresh(config); },
  });
}

export function resetCodexQuotaAutoRefreshForTests(): void {
  inFlight = null;
  resetCodexQuotaAutoRefreshStateForTests();
}
