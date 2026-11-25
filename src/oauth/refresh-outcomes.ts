/**
 * Last upstream token-refresh result per OAuth account, for the account diagnostics route.
 *
 * Process-local and scoped to the config home: a restart, or a server for another home, starts with
 * no result, which the route reports as `lastRefresh: null`. The route also hides a result older than
 * the account's `addedAt`, so a removed and re-added login never shows its predecessor's outcome. At
 * most `MAX_OUTCOMES` entries are kept, least recently written first out. A failure is reduced to a
 * fixed reason (and an HTTP status when the error carries one); no error text, token or email is kept.
 */
import { getConfigDir } from "../config/paths";
import { oauthCredentialSlot } from "./credential-siblings";

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
const key = (provider: string, accountId: string) => `${getConfigDir()}\0${oauthCredentialSlot(provider)}\0${accountId}`;

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

export function recordOAuthRefreshOutcome(provider: string, accountId: string, outcome: OAuthRefreshOutcome): void {
  const entry = key(provider, accountId);
  outcomes.delete(entry);
  outcomes.set(entry, outcome);
  while (outcomes.size > MAX_OAUTH_REFRESH_OUTCOMES) outcomes.delete(outcomes.keys().next().value!);
}

/** Await one upstream refresh call and record its result; the call's value or error passes through unchanged. */
export async function observeOAuthRefresh<T>(provider: string, accountId: string, refresh: () => Promise<T>): Promise<T> {
  try {
    const value = await refresh();
    recordOAuthRefreshOutcome(provider, accountId, { at: Date.now(), ok: true });
    return value;
  } catch (error) {
    recordOAuthRefreshOutcome(provider, accountId, { at: Date.now(), ok: false, ...classifyOAuthRefreshFailure(error) });
    throw error;
  }
}

/** The last result for this account in the current config home, ignoring one older than `since`. */
export function lastOAuthRefreshOutcome(provider: string, accountId: string, since = 0): OAuthRefreshOutcome | null {
  const outcome = outcomes.get(key(provider, accountId));
  return outcome && outcome.at >= since ? outcome : null;
}

/** Tests only. */
export function clearOAuthRefreshOutcomes(): void {
  outcomes.clear();
}

export function oauthRefreshOutcomeCountForTests(): number {
  return outcomes.size;
}
