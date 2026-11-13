import { vendorContextWindow } from "../codex/catalog/vendor-context";
import { OAUTH_ACCOUNT_LOG_LABEL_RE } from "../codex/account-label";
import type { ContextBreakdownV1 } from "./context-breakdown";

/**
 * Per-account state of a multi-account OAuth pool, captured once when the final request row is
 * written. Labels are the same hashed `o<hex6>` labels `accountLogLabel` carries; no account id,
 * email or credential ever appears here. In-memory only: the usage.jsonl projection in
 * request-log.ts rebuilds its row field by field and never copies this.
 */
export type AccountRosterState =
  | "available"
  | "paused"
  | "needs-reauth"
  | "cooldown"
  | "quota-exhausted"
  | "model-unlisted";

export interface AccountRosterV1 {
  /** Base provider name whose account pool this is. */
  provider: string;
  /** At most 16 entries in account-set order. */
  accounts: Array<{ label: string; state: AccountRosterState }>;
  truncated?: true;
}

export interface AccountRosterEntryField {
  accountRoster?: AccountRosterV1;
}

export type AccountRosterProbe = (providerName: string, model: string, now: number) => AccountRosterV1 | undefined;

/**
 * Registered by the OAuth layer at module load. request-log must not import `src/oauth`, and an
 * install that never loads it keeps a null probe, so the final log path costs one null check.
 */
let probe: AccountRosterProbe | null = null;

export function registerAccountRosterProbe(fn: AccountRosterProbe | null): void {
  probe = fn;
}

/**
 * The roster for the account that served a request, or `{}`. The `o` label gate is the cheap,
 * IO-free test for "a generic multi-account OAuth provider served this": only
 * `stampOAuthAccountLabel` mints it, and it skips Codex and Anthropic pools.
 */
export function accountRosterField(
  served: { provider?: string; model?: string; accountLogLabel?: string } | undefined,
  now = Date.now(),
): AccountRosterEntryField {
  if (!probe || !served?.provider || !OAUTH_ACCOUNT_LOG_LABEL_RE.test(served.accountLogLabel ?? "")) return {};
  try {
    const accountRoster = probe(served.provider, served.model ?? "", now);
    return accountRoster ? { accountRoster } : {};
  } catch {
    // A diagnostic must never fail request logging.
    return {};
  }
}

/** Request-scoped timing the live routing view reads; both are measured, never derived. */
export interface RouteLiveTimingContext {
  /** Epoch ms the final physical attempt started; set by whoever opens the attempt. */
  activeAttemptStartedAt?: number;
  /** ms a privacy redactor spent rewriting the client body, when one ran. */
  privacyRedactionMs?: number;
}

export interface RouteLiveTimingEntryField {
  /** ms from request start until the final attempt started; includes earlier failed attempts. */
  upstreamSendMs?: number;
  privacyRedactionMs?: number;
}

export function routeLiveTimingField(logCtx: RouteLiveTimingContext, start: number): RouteLiveTimingEntryField {
  const sendAt = logCtx.activeAttemptStartedAt;
  const upstreamSendMs = sendAt !== undefined && Number.isFinite(sendAt) && Number.isFinite(start) && sendAt >= start
    ? sendAt - start : undefined;
  const redaction = logCtx.privacyRedactionMs;
  return {
    ...(upstreamSendMs !== undefined ? { upstreamSendMs } : {}),
    ...(redaction !== undefined && Number.isFinite(redaction) && redaction >= 0 ? { privacyRedactionMs: redaction } : {}),
  };
}

/** The client body's context-window breakdown, set once at the inbound entry (context-breakdown.ts). */
export interface ContextBreakdownContext {
  contextBreakdown?: ContextBreakdownV1;
}

export interface ContextBreakdownEntryField {
  contextBreakdown?: ContextBreakdownV1;
  /** The serving model's context window in tokens, when the route's adapter knows it. */
  contextWindow?: number;
}

/**
 * Carries the breakdown to the final row, with the window of the model that served it. The window
 * lookup is the caller's own (request-log.ts owns it) and runs only when a breakdown exists.
 */
export function contextBreakdownField(
  logCtx: ContextBreakdownContext,
  served: { adapter: string; model?: string } | undefined,
  windowOf: (adapter: string, model: string | undefined) => number | undefined,
): ContextBreakdownEntryField {
  const contextBreakdown = logCtx.contextBreakdown;
  if (!contextBreakdown) return {};
  // The adapter-specific window wins; otherwise the bundled vendor table names most hosted models.
  const contextWindow = served
    ? windowOf(served.adapter, served.model) ?? (served.model ? vendorContextWindow(served.model) : undefined)
    : undefined;
  return {
    contextBreakdown,
    ...(contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
  };
}
