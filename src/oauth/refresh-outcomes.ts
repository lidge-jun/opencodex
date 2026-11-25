/**
 * Last upstream token-refresh result per OAuth account, for the account diagnostics route.
 *
 * Process-local and bounded by the configured accounts: a restart starts with no result, which
 * the route reports as `lastRefresh: null`. A failure is reduced to a fixed reason (and an HTTP
 * status when the error carries one); no error message, token or account email is kept.
 */
import { oauthCredentialSlot } from "./credential-siblings";

export type OAuthRefreshFailureReason = "rejected" | "upstream_error" | "network" | "timeout" | "aborted" | "error";
export interface OAuthRefreshOutcome {
  at: number;
  ok: boolean;
  reason?: OAuthRefreshFailureReason;
  status?: number;
}

const outcomes = new Map<string, OAuthRefreshOutcome>();
// Rows that share one login (Kimi and Kimi (Responses)) share one refresh result.
const key = (provider: string, accountId: string) => `${oauthCredentialSlot(provider)}\0${accountId}`;

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = typeof record.status === "number" ? record.status : record.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
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
  outcomes.set(key(provider, accountId), outcome);
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

export function lastOAuthRefreshOutcome(provider: string, accountId: string): OAuthRefreshOutcome | null {
  return outcomes.get(key(provider, accountId)) ?? null;
}

/** Tests only. */
export function clearOAuthRefreshOutcomes(): void {
  outcomes.clear();
}
