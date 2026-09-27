# wp2: Desktop quota, Reserve and Send disposition

This phase makes no production source change. The available evidence does not localize the P1 both-exhausted Send failure to OpenCodex ingress, and #5879 cannot be used as a repair for it.

## Current → desired evidence

| Item | Current observation | Required next evidence or redesign |
| --- | --- | --- |
| #4878 P1 | Issue reports ordinary and Reserve both exhausted, picker reopens and Send stays disabled. A later Windows check found provider-blind Desktop composer predicates and successful independent proxy inference, but did not capture the exact both-exhausted transition or correlate Enter with ingress. | One isolated, affected run with installed Desktop/app-server/OpenCodex builds, selected replacement model and effective provider/auth mode, non-empty text-only prompt, Send and Enter results, and time-correlated Desktop → app-server → proxy ingress. Distinguish ordinary-available, ordinary-exhausted/Reserve-available, both-exhausted and recovery. If an independently credentialed replacement request reaches proxy and fails, diagnose the proxy status; if no request is emitted, keep the client gate owner. |
| #5879 | Opt-in quota-driven `codexDesktopAuthless` toggling is draft/conflicting. The candidate worker can fail to apply an injection after persisting the target state and may infer recovery from absent cached usage. Its automatic transition also differs from the manual route's catalog convergence. | Before a future carry: keep desired and applied state separately or retry failed application; require a fresh, credential-bound quota observation for recovery; define manual override ownership; refresh catalog and injector together. Negative tests must trigger injector failure and absent quota read and show no false success. |
| #4961 | `src/codex/loopback-target.ts:50` and `src/codex/catalog/reserve.ts:19` tie Reserve availability to Desktop authless. | Design a separate Reserve capability and migration for existing configurations, with catalog and request authorization using the same eligibility predicate. Do not silently enable Reserve by deleting one flag check. |
| #4869 | Per-thread provider routing is a client integration proposal distinct from account failover. | Obtain evidence that the affected Desktop turn reaches OpenCodex and identify the effective provider/auth context before changing this lane's proxy selection. |

## Exact GitHub writes

After checking the issue states again, post one English comment on #4878 with the four-state reproduction matrix, source-level inference versus unobserved boundary, and why #5879 is not closure evidence. Post concise English hold comments on #4961 and #4869 and on PR #5879, linking this roadmap and naming the testable redesign. Keep all open. No issue title/body edit and no synthetic account exhaustion.

## Verification

Read the posted comment URLs and issue/PR states back through GitHub. Record the comment links and the absence of a production diff in `000_plan.md`. A passing proxy unit test cannot prove the Desktop composer gate; do not claim it does.
