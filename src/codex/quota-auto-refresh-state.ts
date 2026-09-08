/** Shared bookkeeping leaf; lifecycle cleanup must not load warmup/credential owners. */
/** Completed/due markers use epoch milliseconds; persisted legacy markers may use seconds. */
export type CodexQuotaAutoRefreshWindows = { fiveHour?: number; weekly?: number };

export const completedByAccount = new Map<string, CodexQuotaAutoRefreshWindows>();
export const retryAfterByAccount = new Map<string, number>();
export const scheduledByAccount = new Map<string, CodexQuotaAutoRefreshWindows>();
export const quotaRefreshAfterByAccount = new Map<string, number>();

/** Drop every activation record when its account is removed. */
export function forgetCodexQuotaAutoRefreshAccount(accountId: string): void {
  completedByAccount.delete(accountId);
  retryAfterByAccount.delete(accountId);
  scheduledByAccount.delete(accountId);
  quotaRefreshAfterByAccount.delete(accountId);
}

/** Clear the dependency-free activation bookkeeping for isolated tests. */
export function resetCodexQuotaAutoRefreshStateForTests(): void {
  completedByAccount.clear();
  retryAfterByAccount.clear();
  scheduledByAccount.clear();
  quotaRefreshAfterByAccount.clear();
}
