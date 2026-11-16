import type { SpendScopes } from "../../lib/spend-reservation-ledger";
import type { RequestLogContext } from "../request-log";

type PhysicalSpendTarget = SpendScopes & { targetKey?: string };
const targets = new WeakMap<RequestLogContext, () => PhysicalSpendTarget>();
const hostedAdvisorTargets = new WeakMap<RequestLogContext, () => PhysicalSpendTarget>();

/** A prepared candidate can own admission without overwriting the last physical send's log. */
export function bindResponsesSpendTarget(context: RequestLogContext, target?: () => PhysicalSpendTarget): void {
  if (target) targets.set(context, target);
  else { targets.delete(context); hostedAdvisorTargets.delete(context); }
}

/** Optional hosted work checks an admitted identity without changing main-model accounting. */
export function bindResponsesHostedAdvisorSpendTarget(context: RequestLogContext, target: () => PhysicalSpendTarget): void {
  hostedAdvisorTargets.set(context, target);
}

export function responsesHostedAdvisorSpendTarget(context: RequestLogContext, fallbackPool?: string): PhysicalSpendTarget {
  return hostedAdvisorTargets.get(context)?.() ?? responsesSpendTarget(context, fallbackPool);
}

/** Resolve late, after queued negotiation; ordinary callers retain their original pool fallback. */
export function responsesSpendTarget(context: RequestLogContext, fallbackPool?: string): PhysicalSpendTarget {
  return targets.get(context)?.() ?? {
    poolId: context.spendPoolId ?? fallbackPool ?? context.provider,
    identityId: context.accountLogLabel,
  };
}
