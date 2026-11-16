/**
 * How long a dashboard login keeps polling before it gives up and cancels.
 *
 * A browser login finishes in the same sitting, so its surfaces keep their own short budgets. A
 * device grant is different: the user leaves to type a code somewhere else, and the grant stays
 * valid for as long as the provider says — 15 minutes for Copilot, Kimi and Nous, up to 30 for
 * Meta Muse. A dashboard that stopped at five minutes cancelled logins that were still valid.
 *
 * This is a backstop only. The provider's own expiry ends a device login first, through the
 * status error the poll already handles; the budget just has to outlast the longest grant.
 */
export const DEVICE_LOGIN_POLL_BUDGET_MS = 31 * 60_000;

/**
 * Poll attempts a browser login gets on every dashboard surface (five minutes at the 2-second
 * interval). A first-time sign-in with 2FA or e-mail verification easily runs past three minutes,
 * and the providers page and the add-provider form must not disagree about when it ends (#8618).
 */
export const BROWSER_LOGIN_POLL_ATTEMPTS = 150;

/** Poll attempts for a login, stretched to the device budget once the flow shows a device code. */
export function loginPollAttempts(isDeviceFlow: boolean, intervalMs: number, browserAttempts: number): number {
  if (!isDeviceFlow) return browserAttempts;
  return Math.max(browserAttempts, Math.ceil(DEVICE_LOGIN_POLL_BUDGET_MS / intervalMs));
}
