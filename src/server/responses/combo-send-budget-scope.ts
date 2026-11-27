import { deriveRequestExecutionBudget } from "../../lib/request-execution-budget";
import type { RequestExecutionBudget, RequestExecutionBudgetPolicy } from "../../lib/request-execution-budget";

/**
 * A budget scope that keeps its own recovery ledgers but spends the SAME request-wide counter.
 *
 * The sharing has to happen inside the factory. Redefining `used` as an accessor onto the parent
 * only shared what callers read from the outside: `remainingBaseSends`, the total check and the
 * reserve test all consult the factory's own private counter, which an overridden property
 * cannot reach. Each derived scope therefore admitted dispatches as though the request had spent
 * nothing, and the per-target holdback (`comboTargetSendBudget` in core-combo.ts) -- expressed
 * against `maxTotalModelSends` -- had nothing to hold back from.
 *
 * `deriveRequestExecutionBudget` binds the scope to the parent's real ledger, including pending
 * externally-counted bookings and the durable-spend observer, all of which must travel together.
 * A pending booking is a send already counted in the total and waiting for its reporter, and the
 * observer books by watching that same counter move (#4707) -- so a scope that spent the counter
 * without carrying the observer would move it without booking, and this combo's child sends
 * would go missing from the spend ledger. The reserve, alternate-target and transition ledgers
 * stay per-scope on purpose: a combo target's account failover is its own recovery decision,
 * while the request total still bounds every target together.
 */
export function deriveSendBudgetScope(
  parent: RequestExecutionBudget,
  policy: RequestExecutionBudgetPolicy,
): RequestExecutionBudget {
  return deriveRequestExecutionBudget(parent, policy);
}
