import { mutatePersistedConfig } from "../config";
import { registerStateSweepAfterTick } from "../lib/state-store-sweeper";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";
import { isCodexAccountPaused } from "./account-pause";
import { isAccountNeedsReauth } from "./account-runtime-state";
import { getValidCodexToken } from "./account-store";
import { getValidMainAccountToken, MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { tryAcquireNativeMainProfileClaim } from "./native-main-admission";
import { withNativeMainSharedClaim } from "./native-main-claim";
import { resolveNativeProfileContext } from "./native-profile-store";
import { getAccountQuota, type StoredAccountQuota } from "./quota";
import { warmCodexAccount } from "./warmup";

export const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const RETRY_MS = 5 * 60_000;
const CONCURRENCY = 4;

export type CodexQuotaAutoRefreshWindows = { fiveHour?: number; weekly?: number };

export interface CodexQuotaAutoRefreshStatus {
  fiveHourAvailable: boolean;
  weeklyAvailable: boolean;
  fiveHourEnabled: boolean;
  weeklyEnabled: boolean;
}

export interface CodexQuotaAutoRefreshRunDeps {
  getQuota?: (accountId: string) => StoredAccountQuota | null;
  warmAccount?: (config: OcxConfig, accountId: string) => Promise<void>;
  persistCompleted?: (
    config: OcxConfig,
    accountId: string,
    completed: CodexQuotaAutoRefreshWindows,
  ) => boolean;
}

let inFlight: Promise<void> | null = null;
const completedByAccount = new Map<string, CodexQuotaAutoRefreshWindows>();
const retryAfterByAccount = new Map<string, number>();

function resetAtMs(resetAt: number): number {
  // WHAM reports seconds; quota parsed from response headers may already be milliseconds.
  return resetAt < 100_000_000_000 ? resetAt * 1000 : resetAt;
}

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
  if (saved?.fiveHour === true
    && quota.shortWindowSeconds === FIVE_HOUR_WINDOW_SECONDS
    && typeof quota.shortResetAt === "number"
    && resetAtMs(quota.shortResetAt) <= now
    && saved.lastFiveHourResetAt !== quota.shortResetAt
    && completed?.fiveHour !== quota.shortResetAt) {
    due.fiveHour = quota.shortResetAt;
  }
  if (saved?.weekly === true
    && typeof quota.weeklyResetAt === "number"
    && resetAtMs(quota.weeklyResetAt) <= now
    && saved.lastWeeklyResetAt !== quota.weeklyResetAt
    && completed?.weekly !== quota.weeklyResetAt) {
    due.weekly = quota.weeklyResetAt;
  }
  return due.fiveHour === undefined && due.weekly === undefined ? null : due;
}

async function warmAccount(config: OcxConfig, accountId: string): Promise<void> {
  if (accountId !== MAIN_CODEX_ACCOUNT_ID) {
    await warmCodexAccount(await getValidCodexToken(accountId));
    return;
  }
  const lease = tryAcquireNativeMainProfileClaim();
  if (!lease) throw new Error("native main busy");
  try {
    await withNativeMainSharedClaim(resolveNativeProfileContext(), async () => {
      const token = await getValidMainAccountToken();
      if (!token) throw new Error("main account unavailable");
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
    if ((completed.fiveHour === undefined || saved.lastFiveHourResetAt === completed.fiveHour)
      && (completed.weekly === undefined || saved.lastWeeklyResetAt === completed.weekly)) continue;
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
        || (retryAfterByAccount.get(accountId) ?? 0) > now) return [];
      const windows = dueCodexQuotaAutoRefreshWindows(config, accountId, quotaFor(accountId), now);
      return windows ? [{ accountId, windows }] : [];
    });
    for (let index = 0; index < due.length; index += CONCURRENCY) {
      await Promise.all(due.slice(index, index + CONCURRENCY).map(async ({ accountId, windows }) => {
        try {
          await warm(config, accountId);
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

export function forgetCodexQuotaAutoRefreshAccount(accountId: string): void {
  completedByAccount.delete(accountId);
  retryAfterByAccount.delete(accountId);
}

export function resetCodexQuotaAutoRefreshForTests(): void {
  inFlight = null;
  completedByAccount.clear();
  retryAfterByAccount.clear();
}
