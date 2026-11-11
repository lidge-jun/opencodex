/**
 * Logins the proxy drives itself in its own isolated browser window — currently
 * `src/oauth/m365-copilot-browser.ts`. The window, the callback capture and the
 * 120-second web-session poll all live on the server, so such a flow outlives
 * the dashboard tab that started it: a pagehide, an unmount or a poll budget
 * sized for a same-sitting browser login must not cancel a login the user is
 * still completing in that window.
 */
const SERVER_OWNED_LOGINS = new Set(["m365-copilot"]);

/**
 * `captureM365BrowserCode` 10-minute budget plus `readM365BrowserWebSession` 120-second poll.
 * shortcut: hardcoded mirror of the server budgets; update if src/oauth/m365-copilot-browser.ts changes.
 */
export const SERVER_OWNED_LOGIN_BUDGET_MS = 12 * 60_000 + 30_000;

export function isServerOwnedLogin(provider: string): boolean {
  return SERVER_OWNED_LOGINS.has(provider);
}

/** Poll attempts that outlast a server-owned flow instead of cutting it short. */
export function serverOwnedLoginAttempts(intervalMs: number): number {
  return Math.ceil(SERVER_OWNED_LOGIN_BUDGET_MS / intervalMs);
}
