import { mutatePersistedConfig } from "../config";
import { captureConfigGeneration, registerStateSweepAfterTick } from "../lib/state-store-sweeper";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { normalizeResetAt } from "../providers/quota-wire";
import { providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";
import { reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import { isCodexAccountPaused } from "./account-pause";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import { getValidCodexToken, isCodexAccountGenerationLive } from "./account-store";
import { codexAccountLogLabel } from "./account-label";
import { getMainAccountToken, getValidMainAccountToken, MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { isMainAccountHardLocked } from "./main-account-hard-lock";
import { tryAcquireNativeMainProfileClaim } from "./native-main-admission";
import { withNativeMainSharedClaim } from "./native-main-claim";
import { resolveNativeProfileContext } from "./native-profile-store";
import { captureMainQuotaWriter } from "./main-account-cache";
import { applyAccountQuotaFromUpstreamHeaders, getAccountQuota, type StoredAccountQuota } from "./quota";
import { CodexWarmupError, codexWarmupFailureReason, warmCodexAccount } from "./warmup";
import {
  completedByAccount, retryAfterByAccount, scheduledByAccount, quotaRefreshAfterByAccount,
  resetCodexQuotaAutoRefreshStateForTests,
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
  refreshQuota?: (config: OcxConfig, accountId: string) => Promise<void>;
  /** Only false means skipped; existing void callbacks still report a successful warmup. */
  warmAccount?: (config: OcxConfig, accountId: string) => Promise<void | false>;
  persistCompleted?: (
    config: OcxConfig,
    accountId: string,
    completed: CodexQuotaAutoRefreshWindows,
  ) => boolean;
}

let inFlight: Promise<void> | null = null;

/** Report upstream window availability separately from persisted spending intent. */
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

/** Select retained, enabled boundaries newer than both durable and in-memory completions. */
export function dueCodexQuotaAutoRefreshWindows(
  config: OcxConfig,
  accountId: string,
  quota: StoredAccountQuota | null,
  now: number,
  completed = completedByAccount.get(accountId),
): CodexQuotaAutoRefreshWindows | null {
  const saved = config.codexQuotaAutoRefresh?.[accountId];
  const scheduled = scheduledByAccount.get(accountId) ?? (
    saved?.nextFiveHourResetAt !== undefined || saved?.nextWeeklyResetAt !== undefined
      ? { fiveHour: saved.nextFiveHourResetAt, weekly: saved.nextWeeklyResetAt } : undefined
  );
  const due: CodexQuotaAutoRefreshWindows = {};
  const shortResetAt = normalizeResetAt(scheduled ? scheduled.fiveHour : quota?.shortResetAt);
  const weeklyResetAt = normalizeResetAt(scheduled ? scheduled.weekly : quota?.weeklyResetAt);
  if (saved?.fiveHour === true
    && (scheduled?.fiveHour !== undefined || saved.nextFiveHourResetAt !== undefined
      || quota?.shortWindowSeconds === FIVE_HOUR_WINDOW_SECONDS)
    && shortResetAt !== undefined
    && shortResetAt <= now
    && shortResetAt > (normalizeResetAt(saved.lastFiveHourResetAt) ?? -1)
    && shortResetAt > (normalizeResetAt(completed?.fiveHour) ?? -1)) {
    due.fiveHour = shortResetAt;
  }
  if (saved?.weekly === true
    && weeklyResetAt !== undefined
    && weeklyResetAt <= now
    && weeklyResetAt > (normalizeResetAt(saved.lastWeeklyResetAt) ?? -1)
    && weeklyResetAt > (normalizeResetAt(completed?.weekly) ?? -1)) {
    due.weekly = weeklyResetAt;
  }
  return due.fiveHour === undefined && due.weekly === undefined ? null : due;
}

/** Retain the earliest uncompleted observation, including across process restarts. */
function rememberWindows(config: OcxConfig, accountId: string, quota: StoredAccountQuota | null): void {
  const saved = config.codexQuotaAutoRefresh?.[accountId];
  if (!saved) return;
  const completed = completedByAccount.get(accountId);
  const previous = scheduledByAccount.get(accountId) ?? {
    fiveHour: normalizeResetAt(saved.nextFiveHourResetAt),
    weekly: normalizeResetAt(saved.nextWeeklyResetAt),
  };
  const next: CodexQuotaAutoRefreshWindows = {};
  for (const window of ["fiveHour", "weekly"] as const) {
    if (!saved[window]) continue;
    const done = normalizeResetAt(completed?.[window]
      ?? (window === "fiveHour" ? saved.lastFiveHourResetAt : saved.lastWeeklyResetAt));
    const observed = normalizeResetAt(window === "fiveHour"
      ? quota?.shortWindowSeconds === FIVE_HOUR_WINDOW_SECONDS ? quota.shortResetAt : undefined
      : quota?.weeklyResetAt);
    const candidates = [normalizeResetAt(previous[window]), observed]
      .filter((value): value is number => value !== undefined && (done === undefined || value > done));
    if (candidates.length) next[window] = Math.min(...candidates);
  }
  scheduledByAccount.set(accountId, next);
  if (normalizeResetAt(saved.nextFiveHourResetAt) === next.fiveHour
    && normalizeResetAt(saved.nextWeeklyResetAt) === next.weekly) return;
  try {
    const outcome = mutatePersistedConfig(persisted => {
      const current = persisted.codexQuotaAutoRefresh?.[accountId];
      if (!current) return { changed: false, value: null };
      const setting = { ...current };
      // A settings change that raced this sweep remains authoritative.
      delete setting.nextFiveHourResetAt;
      delete setting.nextWeeklyResetAt;
      if (current.fiveHour && next.fiveHour !== undefined) setting.nextFiveHourResetAt = next.fiveHour;
      if (current.weekly && next.weekly !== undefined) setting.nextWeeklyResetAt = next.weekly;
      persisted.codexQuotaAutoRefresh = { ...persisted.codexQuotaAutoRefresh, [accountId]: setting };
      return { changed: true, value: setting };
    });
    if (outcome.status !== "unavailable" && outcome.value) {
      config.codexQuotaAutoRefresh = { ...config.codexQuotaAutoRefresh, [accountId]: outcome.value };
    }
  } catch {
    // Keep the in-memory deadline and retry its narrow persistence on the next tick.
  }
}

/** Load metadata recovery only when an opted-in account actually needs a probe. */
async function refreshQuota(config: OcxConfig, accountId: string): Promise<void> {
  const { refreshCodexQuotaForActivation } = await import("./auth-api");
  await refreshCodexQuotaForActivation(config, accountId);
}

/** Keep billable main-account work behind the current pause, reauth and hard-lock policy. */
function mainWarmupRestricted(config: OcxConfig): boolean {
  return isMainAccountHardLocked(config)
    || isCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID)
    || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
}

/** Warm the exact account and fence quota/reauth publication to the dispatched credential. */
async function warmAccount(config: OcxConfig, accountId: string): Promise<void | false> {
  const writerGeneration = captureConfigGeneration();
  if (accountId !== MAIN_CODEX_ACCOUNT_ID) {
    const token = await getValidCodexToken(accountId);
    if (isCodexAccountPaused(config, accountId) || isAccountNeedsReauth(accountId)) return false;
    try {
      await warmCodexAccount({ ...token, onCompleted: headers => {
        if (isCodexAccountGenerationLive(accountId, token.generation)) {
          applyAccountQuotaFromUpstreamHeaders(accountId, headers, writerGeneration);
        }
      } });
    } catch (error) {
      if (error instanceof CodexWarmupError && error.status === 401) {
        markAccountNeedsReauth(accountId, writerGeneration, token.generation);
      }
      throw error;
    }
    if (!isCodexAccountGenerationLive(accountId, token.generation)) return false;
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
      const writer = captureMainQuotaWriter(token.chatgptAccountId);
      try {
        await warmCodexAccount({ ...token, onCompleted: headers => {
          if (writer) applyAccountQuotaFromUpstreamHeaders(accountId, headers, writerGeneration, writer);
        } });
      } catch (error) {
        if (error instanceof CodexWarmupError && error.status === 401
          && getMainAccountToken()?.accessToken === token.accessToken) {
          markAccountNeedsReauth(accountId, writerGeneration);
        }
        throw error;
      }
    });
  } finally {
    lease.release();
  }
}

/** Patch completion markers without replacing concurrent account-setting changes. */
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

/** Retry failed marker persistence without sending another billable warmup. */
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

/** Coalesce sweeps, refresh stale metadata and activate due accounts with bounded concurrency. */
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
  const refresh = deps.refreshQuota ?? refreshQuota;
  inFlight = (async () => {
    retryPendingMarkers(config, persist);
    const accountIds = [
      MAIN_CODEX_ACCOUNT_ID,
      ...(config.codexAccounts ?? []).filter(isSelectableCodexPoolAccount).map(account => account.id),
    ];
    /** Recheck spending authorization after asynchronous metadata work. */
    const eligible = (accountId: string) => {
      const setting = config.codexQuotaAutoRefresh?.[accountId];
      const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
      return provider?.disabled !== true && isCanonicalOpenAiForwardProvider(provider)
        && providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, provider) === "pool"
        && (accountId === MAIN_CODEX_ACCOUNT_ID || config.codexAccounts?.some(
          account => account.id === accountId && isSelectableCodexPoolAccount(account)))
        && (setting?.fiveHour === true || setting?.weekly === true)
        && !isCodexAccountPaused(config, accountId) && !isAccountNeedsReauth(accountId)
        && !(accountId === MAIN_CODEX_ACCOUNT_ID && isMainAccountHardLocked(config));
    };
    for (let index = 0; index < accountIds.length; index += CONCURRENCY) {
      await Promise.all(accountIds.slice(index, index + CONCURRENCY).map(async accountId => {
        if (!eligible(accountId)) return;
        // Capture before WHAM can move an idle window's reset into the future.
        rememberWindows(config, accountId, quotaFor(accountId));
        const quota = quotaFor(accountId);
        if ((!quota || now - quota.updatedAt >= RETRY_MS)
          && (quotaRefreshAfterByAccount.get(accountId) ?? 0) <= now) {
          quotaRefreshAfterByAccount.set(accountId, now + RETRY_MS);
          try { await refresh(config, accountId); } catch { /* Retry metadata at the bounded cadence. */ }
        }
        if (!eligible(accountId)) return;
        rememberWindows(config, accountId, quotaFor(accountId));
        if ((retryAfterByAccount.get(accountId) ?? 0) > now) return;
        const windows = dueCodexQuotaAutoRefreshWindows(config, accountId, quotaFor(accountId), now);
        if (!windows) return;
        try {
          if (await warm(config, accountId) === false) return;
          retryAfterByAccount.delete(accountId);
          const completed = { ...completedByAccount.get(accountId), ...windows };
          completedByAccount.set(accountId, completed);
          persist(config, accountId, completed);
          rememberWindows(config, accountId, quotaFor(accountId));
        } catch (error) {
          retryAfterByAccount.set(accountId, now + RETRY_MS);
          const account = config.codexAccounts?.find(candidate => candidate.id === accountId);
          const label = account ? codexAccountLogLabel(account) : "main";
          console.warn(`[codex-quota-auto-refresh] ${label}: ${codexWarmupFailureReason(error)}; ${
            isAccountNeedsReauth(accountId) ? "reauthentication required" : "retry in five minutes"
          }`);
        }
      }));
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Attach activation to the shared minute sweep and return its owner-scoped cleanup. */
export function registerCodexQuotaAutoRefreshWorker(config: OcxConfig): () => void {
  return registerStateSweepAfterTick({
    name: "codex-quota-auto-refresh",
    afterTick: () => { void runCodexQuotaAutoRefresh(config); },
  });
}

/** Clear scheduling and single-flight state between isolated test cases. */
export function resetCodexQuotaAutoRefreshForTests(): void {
  inFlight = null;
  resetCodexQuotaAutoRefreshStateForTests();
}
