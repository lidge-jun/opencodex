import { CODEX_TEXT_GUARDED_BUDGET_POLICY, createRequestExecutionBudget, type RequestExecutionBudget } from "../../lib/request-execution-budget";
import { TRANSIENT_RETRY_MAX_ATTEMPTS, type TransientSendBudget } from "../../lib/upstream-retry";
import { GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST } from "../../oauth/generic-account-failover";
import type { RequestLogContext } from "../request-log";
import { attachRequestSpendTracker } from "../responses/request-spend";

// Only ingress owns an expandable policy. Exact caller budgets and combo-derived scopes
// never enter this map, even when their policy happens to equal the default profile.
const ingressPolicies = new WeakMap<TransientSendBudget, {
  maxTotalModelSends: number;
  baseSendAllowance: number;
}>();

/**
 * The one construction of an ingress-owned send budget: the default guarded policy, no logical
 * request id, and this request's spend tracker as the send observer. Attaching the tracker
 * parks it on `logCtx`, so callers that inherit a holder must not call this at all.
 */
export function createInferenceSendBudget(
  req: Pick<Request, "headers">,
  logCtx: RequestLogContext,
): RequestExecutionBudget {
  const policy = { ...CODEX_TEXT_GUARDED_BUDGET_POLICY };
  const budget = createRequestExecutionBudget(policy, undefined, attachRequestSpendTracker(req, logCtx));
  ingressPolicies.set(budget, policy);
  return budget;
}

/**
 * Fund each account's normal transient ladder once, before the first physical send. The account
 * count is clamped here as well as at the caller, so no caller can raise the ceiling past
 * GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST × TRANSIENT_RETRY_MAX_ATTEMPTS.
 */
export function expandInferenceOAuthSendBudget(budget: TransientSendBudget | undefined, accounts: number): void {
  if (!budget) return;
  const policy = ingressPolicies.get(budget);
  if (!policy || budget.used !== 0) return;
  ingressPolicies.delete(budget);
  if (accounts < 2 || !Number.isSafeInteger(accounts)) return;
  const sends = Math.min(accounts, GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST) * TRANSIENT_RETRY_MAX_ATTEMPTS;
  policy.baseSendAllowance = Math.max(policy.baseSendAllowance, sends);
  policy.maxTotalModelSends = Math.max(policy.maxTotalModelSends, sends);
}
