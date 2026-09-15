import { CODEX_TEXT_GUARDED_BUDGET_POLICY, type RequestExecutionBudget, type RequestExecutionBudgetPolicy, type SingleUseDispatchPermit } from "../../lib/request-execution-budget";

/**
 * Sends one combo target may run on its own before the ladder moves on. A target is a whole
 * request as far as its own provider is concerned, so this is the guarded profile's base
 * allowance rather than a separate number to keep in sync.
 */
export const COMBO_TARGET_BASE_SENDS = CODEX_TEXT_GUARDED_BUDGET_POLICY.baseSendAllowance;

/**
 * A combo's execution policy is DECLARED by the combo, not inherited from the single-target
 * profile.
 *
 * `maxTargetTransitions: 1` and `maxAlternateTargetSends: 1` describe an account move, and
 * applying them to a combo would refuse the second hop of a three-target combo -- which is why
 * combo was left off `reserveDispatch` when the per-request split landed. The transitions a
 * combo may make are exactly the targets it declares minus the one it starts on. What stays
 * capped is the TOTAL: the first target's full ladder, one send for every further declared
 * target, and the one shared final-recovery reserve. A one-target combo reduces to the guarded
 * profile exactly, and a three-target combo whose every target fails hard reaches upstream six
 * times instead of the twelve #4546 measured.
 */
export function comboExecutionBudgetPolicy(declaredTargets: number): RequestExecutionBudgetPolicy {
  const targets = Math.max(1, Math.trunc(declaredTargets));
  const hops = targets - 1;
  const reserve = CODEX_TEXT_GUARDED_BUDGET_POLICY.finalRecoveryAllowance;
  const total = COMBO_TARGET_BASE_SENDS + hops + reserve;
  return {
    maxTotalModelSends: total,
    baseSendAllowance: total - reserve,
    finalRecoveryAllowance: reserve,
    maxAlternateTargetSends: Math.max(1, hops),
    maxTargetTransitions: Math.max(1, hops),
  };
}

/**
 * A budget scope that keeps its own recovery ledgers but spends the SAME request-wide counter.
 *
 * The factory shares both charged sends and pending external reports. Forwarding `used` alone
 * cannot share reservation checks held in the factory closure, and would let each target
 * refill its allowance. The reserve, alternate-target and transition ledgers stay
 * per-scope on purpose: a combo target's account failover is its own recovery decision, while
 * the request total still bounds every target together.
 */
export function deriveSendBudgetScope(
  parent: RequestExecutionBudget,
  policy: RequestExecutionBudgetPolicy,
  prepaid?: SingleUseDispatchPermit,
): RequestExecutionBudget {
  return parent.deriveScope(policy, prepaid);
}

/**
 * The ladder one combo target may run, expressed as an allowance on the request-wide counter.
 *
 * `used + COMBO_TARGET_BASE_SENDS` gives this target its own ladder from wherever the request
 * already stands, and the clamp holds back one send for each target still declared after it: a
 * first target that 5xx-streaks must not eat the send the last declared target is entitled to.
 * That guarantee is the difference between a per-target policy and a shared pool the first
 * target drains.
 */
export function comboTargetSendBudget(
  comboScope: RequestExecutionBudget,
  targetsDeclaredAfterThisOne: number,
  prepaid?: SingleUseDispatchPermit,
): RequestExecutionBudget {
  const policy = comboScope.policy;
  const heldForLaterTargets = Math.max(0, targetsDeclaredAfterThisOne);
  const ceiling = Math.min(policy.maxTotalModelSends,
    Math.max(comboScope.used, 1, policy.maxTotalModelSends - heldForLaterTargets));
  return deriveSendBudgetScope(comboScope, {
    maxTotalModelSends: ceiling,
    baseSendAllowance: Math.min(ceiling, comboScope.used - (prepaid ? 1 : 0) + COMBO_TARGET_BASE_SENDS),
    finalRecoveryAllowance: policy.finalRecoveryAllowance,
    // Within one target the account-move shape is unchanged: three same-account sends plus one
    // alternate is the recovery live traffic depends on, and a combo does not widen it.
    maxAlternateTargetSends: CODEX_TEXT_GUARDED_BUDGET_POLICY.maxAlternateTargetSends,
    maxTargetTransitions: CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTargetTransitions,
  }, prepaid);
}
