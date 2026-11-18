import { CODEX_TEXT_GUARDED_BUDGET_POLICY, createRequestExecutionBudget, type RequestExecutionBudget } from "../../lib/request-execution-budget";
import { TRANSIENT_RETRY_MAX_ATTEMPTS, type TransientSendBudget } from "../../lib/upstream-retry";
import { GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST } from "../../oauth/generic-account-failover";
import type { RequestLogContext } from "../request-log";
import { attachRequestSpendTracker } from "../responses/request-spend";
import type { SpendAdmissionPolicy } from "../../lib/spend-reservation-ledger";

// Only ingress owns an expandable policy. Exact caller budgets and combo-derived scopes
// never enter this map, even when their policy happens to equal the default profile.
const oauthExpanded = new WeakSet<TransientSendBudget>();
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
  capturedPolicy?: SpendAdmissionPolicy,
): RequestExecutionBudget {
  const policy = { ...CODEX_TEXT_GUARDED_BUDGET_POLICY };
  const budget = createRequestExecutionBudget(policy, undefined, attachRequestSpendTracker(req, logCtx, undefined, capturedPolicy));
  ingressPolicies.set(budget, policy);
  return budget;
}

/**
 * Fund each account's normal transient ladder once, before the first physical send. The account
 * count is clamped here as well as at the caller, so no caller can raise the ceiling past
 * GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST × TRANSIENT_RETRY_MAX_ATTEMPTS.
 */
export function expandInferenceOAuthSendBudget(budget: TransientSendBudget | undefined, accounts: number): void {
  const fundedAccounts = Number.isSafeInteger(accounts) && accounts >= 2 ? Math.min(accounts, GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST) : 0;
  expandIngressSendBudget(budget, fundedAccounts * TRANSIENT_RETRY_MAX_ATTEMPTS);
}

/** Fund an explicitly configured standalone ChatGPT retry ladder before any send. */
export function fundChatGptRetryAttempts(budget: TransientSendBudget | undefined, attempts: number): void {
  if (Number.isInteger(attempts) && attempts > TRANSIENT_RETRY_MAX_ATTEMPTS && attempts <= 10) {
    expandIngressSendBudget(budget, attempts);
  }
}

function expandIngressSendBudget(budget: TransientSendBudget | undefined, sends: number): void {
  if (!budget) {
    return;
  }
  const policy = ingressPolicies.get(budget);
  if (!policy || oauthExpanded.has(budget) || budget.used !== 0 || ("physicalStarted" in budget && Number(budget.physicalStarted) > 0)) {
    return;
  }
  // One ingress expansion per request; the policy stays for the hosted-search allowance.
  oauthExpanded.add(budget);
  policy.baseSendAllowance = Math.max(policy.baseSendAllowance, sends);
  policy.maxTotalModelSends = Math.max(policy.maxTotalModelSends, sends);
}


/** Fund the loop's bounded generic HTTP sends before its first dispatch. */
export function expandInferenceSearchSendBudget(budget: TransientSendBudget | undefined, baseSends: number): void {
  const policy = budget && ingressPolicies.get(budget);
  if (!policy || baseSends <= policy.baseSendAllowance) return;
  policy.maxTotalModelSends += baseSends - policy.baseSendAllowance;
  policy.baseSendAllowance = baseSends;
}
