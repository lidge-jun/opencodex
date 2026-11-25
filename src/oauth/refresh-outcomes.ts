/**
 * Last upstream token-refresh result per OAuth account, for the account diagnostics route.
 *
 * Process-local and keyed by config home, login slot, account id and login incarnation (the account's
 * `loginId`, which every login mints anew). The incarnation is captured when the refresh is dispatched,
 * so a refresh that finishes after the login was replaced records under the old incarnation and never
 * shows on the new one. A restart, or a server for another home, starts with no result, which the
 * route reports as `lastRefresh: null`. At most `MAX_OAUTH_REFRESH_OUTCOMES` entries are kept, least
 * recently written first out. A failure is reduced to a
 * fixed reason (and an HTTP status when the error carries one); no error text, token or email is kept.
 */
import { getConfigDir } from "../config/paths";
import { oauthCredentialSlot } from "./credential-siblings";
import { peekAuthStore } from "./store";
import type { ProviderAccount } from "./types";

export type OAuthRefreshFailureReason = "rejected" | "upstream_error" | "network" | "timeout" | "aborted" | "error";
export interface OAuthRefreshOutcome {
  at: number;
  ok: boolean;
  reason?: OAuthRefreshFailureReason;
  status?: number;
}

export const MAX_OAUTH_REFRESH_OUTCOMES = 1024;
const outcomes = new Map<string, OAuthRefreshOutcome>();
// Rows that share one login (Kimi and Kimi (Responses)) share one refresh result.
const key = (provider: string, accountId: string, incarnation: string) =>
  `${getConfigDir()}\0${oauthCredentialSlot(provider)}\0${accountId}\0${incarnation}`;

/** Which login of this account a result belongs to: its `loginId`, else (legacy rows) its `addedAt`. */
export function oauthLoginIncarnation(account: Pick<ProviderAccount, "loginId" | "addedAt"> | undefined): string {
  if (typeof account?.loginId === "string" && account.loginId) return `login:${account.loginId}`;
  return typeof account?.addedAt === "number" ? `added:${account.addedAt}` : "";
}

/** The incarnation stored now, read observe-only (no hardening, no backup). */
function currentIncarnation(provider: string, accountId: string): string {
  try {
    return oauthLoginIncarnation(peekAuthStore()[oauthCredentialSlot(provider)]?.accounts.find(row => row.id === accountId));
  } catch {
    return "";
  }
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { status?: unknown; statusCode?: unknown; httpStatus?: unknown };
  // Provider token errors spell it differently (`AnthropicTokenError` and `KiroTokenRefreshError` use httpStatus).
  for (const status of [record.status, record.statusCode, record.httpStatus]) {
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

/** A fixed reason for a refresh failure; the error's own text never leaves this function. */
export function classifyOAuthRefreshFailure(error: unknown): Pick<OAuthRefreshOutcome, "reason" | "status"> {
  const status = errorStatus(error);
  if (status !== undefined) return { reason: status >= 500 ? "upstream_error" : "rejected", status };
  const name = error && typeof error === "object" ? String((error as { name?: unknown }).name ?? "") : "";
  const code = error && typeof error === "object" ? String((error as { code?: unknown }).code ?? "") : "";
  if (name === "TimeoutError" || code === "ETIMEDOUT") return { reason: "timeout" };
  if (name === "AbortError") return { reason: "aborted" };
  if (/^(ECONN|ENOTFOUND|EAI_|ENETUNREACH|EHOSTUNREACH|ConnectionRefused|FailedToOpenSocket)/.test(code)) return { reason: "network" };
  return { reason: "error" };
}

export function recordOAuthRefreshOutcome(
  provider: string, accountId: string, outcome: OAuthRefreshOutcome, incarnation = currentIncarnation(provider, accountId),
): void {
  const entry = key(provider, accountId, incarnation);
  outcomes.delete(entry);
  outcomes.set(entry, outcome);
  while (outcomes.size > MAX_OAUTH_REFRESH_OUTCOMES) outcomes.delete(outcomes.keys().next().value!);
}

/** Await one upstream refresh call and record its result; the call's value or error passes through unchanged. */
export async function observeOAuthRefresh<T>(provider: string, accountId: string, refresh: () => Promise<T>): Promise<T> {
  // Captured before dispatch: the login this refresh speaks for, even if it is replaced meanwhile.
  const incarnation = currentIncarnation(provider, accountId);
  try {
    const value = await refresh();
    recordOAuthRefreshOutcome(provider, accountId, { at: Date.now(), ok: true }, incarnation);
    return value;
  } catch (error) {
    recordOAuthRefreshOutcome(provider, accountId, { at: Date.now(), ok: false, ...classifyOAuthRefreshFailure(error) }, incarnation);
    throw error;
  }
}

/** The last result for this login of the account in the current config home. */
export function lastOAuthRefreshOutcome(
  provider: string, accountId: string, incarnation = currentIncarnation(provider, accountId),
): OAuthRefreshOutcome | null {
  return outcomes.get(key(provider, accountId, incarnation)) ?? null;
}

/** Tests only. */
export function clearOAuthRefreshOutcomes(): void {
  outcomes.clear();
}

export function oauthRefreshOutcomeCountForTests(): number {
  return outcomes.size;
}
