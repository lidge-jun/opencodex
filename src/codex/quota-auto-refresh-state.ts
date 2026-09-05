/** Shared bookkeeping leaf; lifecycle cleanup must not load warmup/credential owners. */
/** Completed/due markers use epoch milliseconds; persisted legacy markers may use seconds. */
export type CodexQuotaAutoRefreshWindows = { fiveHour?: number; weekly?: number };

export const completedByAccount = new Map<string, CodexQuotaAutoRefreshWindows>();
export const retryAfterByAccount = new Map<string, number>();

export function forgetCodexQuotaAutoRefreshAccount(accountId: string): void {
  completedByAccount.delete(accountId);
  retryAfterByAccount.delete(accountId);
}

export function resetCodexQuotaAutoRefreshStateForTests(): void {
  completedByAccount.clear();
  retryAfterByAccount.clear();
}
