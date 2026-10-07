import type { OcxConfig } from "../types";
import { codexUsageLimitResetAt, isCodexAccountHeldForCredits } from "./account-credit-use";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { isSelectableCodexPoolAccount } from "./account-id";
import { getAccountQuota } from "./quota";

export type PoolCreditPolicyConfig = Readonly<Pick<OcxConfig, "creditCodexAccountIds" | "codexAccounts">>;
type PoolContext = { kind: "pool"; accountId: string };

// Keep live policy references private: they must not enter DTOs or serialized auth context.
const policies = new WeakMap<object, {
  config: PoolCreditPolicyConfig;
  policy: PoolCreditPolicyConfig;
}>();

/** Read cached usage only. This helper never opens or refreshes a credential. */
export function poolCreditHoldResetAt(
  policy: PoolCreditPolicyConfig,
  accountId: string,
  catalog: PoolCreditPolicyConfig = policy,
  now = Date.now(),
): number | undefined {
  // Native main has an independent identity-bound quota policy. Never read its physical plan.
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return undefined;
  const quota = getAccountQuota(accountId);
  const plan = catalog.codexAccounts
    ?.find(account => isSelectableCodexPoolAccount(account) && account.id === accountId)?.plan;
  if (!isCodexAccountHeldForCredits(policy, accountId, quota, plan, now)) return undefined;
  return codexUsageLimitResetAt(quota, plan, now);
}

/** Remember policy by reference so later credential materialization rechecks current values. */
export function bindPoolCreditPolicy<T extends PoolContext>(
  context: T,
  config: PoolCreditPolicyConfig,
  policy: PoolCreditPolicyConfig = config,
): T {
  policies.set(context, { config, policy });
  return context;
}

/**
 * Carry the resolver's live policy onto a context rebuilt by spread copy. The WeakMap keys on
 * object identity, so `{ ...ctx }` alone loses the binding and every caller that omits an
 * explicit override would skip credit-hold enforcement on the copy. A source with no binding
 * leaves the target unbound rather than inventing a policy.
 */
export function rebindPoolCreditPolicy<S extends PoolContext, T extends object>(source: S, target: T): T {
  const bound = policies.get(source);
  if (bound) policies.set(target, bound);
  return target;
}

/** Explicit policy wins; omitted materialization options retain the resolver's policy. */
export function poolContextCreditHoldResetAt(
  context: PoolContext,
  override?: PoolCreditPolicyConfig,
  now = Date.now(),
): number | undefined {
  const bound = policies.get(context);
  const policy = override ?? bound?.policy;
  // Unbound contexts skip credit-hold enforcement entirely: callers that require
  // enforcement must supply `override` (or resolve through bindPoolCreditPolicy).
  if (!policy) return undefined;
  const catalog = override?.codexAccounts ? override : bound?.config ?? policy;
  return poolCreditHoldResetAt(policy, context.accountId, catalog, now);
}
