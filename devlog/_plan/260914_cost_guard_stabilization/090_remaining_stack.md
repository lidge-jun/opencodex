# 090 — what is left after 2.55.0, as a seven-layer stack

## Why this doc exists

`070_delivery.md` closed the 2.55.0 release record with a list of things the
release deliberately does not claim: the durable cross-restart reservation
ledger, V2 child first placement, the minimum quota/cache domain contract, the
transient half-open probe lease, combo hops on the shared budget, Cursor's inner
retries, and sends-per-logical-request surfacing. That list is accurate and it is
also unordered, which is the problem. Each item touches a different layer of the
same request path, and three of them change the same two files.

This doc fixes the order and the write scopes so the remaining work can ship as a
stack of independently revertible pull requests rather than one unreviewable diff.

## What is already true

Stating this once, because repeating the original problem statement as if nothing
landed is the failure mode this unit keeps hitting. On `dev@4f788f91`: a request
carries a guarded four-send profile with a three-send base allowance and one shared
final-recovery reserve (#4609); a zero budget no longer floors to one (#4613); the
workflow guard caps physical sends, distinct children and concurrency and reserves
an interactive slot (#4614); a healthy detour is promoted rather than discarded when
a hold expires, and `Retry-After` is honoured on the transient path (#4616).

So the remaining work is not "add a budget". It is: make the budget reach the
paths it still cannot see, make it correct under concurrency, and stop it from
being reset by a restart or side-stepped by a fresh identity.

## The stack

Listed in the order the branches are stacked, each one based on the branch above it.

| # | Layer | Branch | What it closes |
| --- | --- | --- | --- |
| 1 | wpc | `codex/4546-wpc-quota-cache-domains` | Auth identity, quota domain and cache domain as three separate values, plus conversational-state portability as its own check |
| 2 | wpe | `codex/4546-wpe-durable-reservation` | Token-and-output reservation at three scopes, unresolved spend, and a ledger that survives restart |
| 3 | wpf | `codex/4546-wpf-probe-lease-backpressure` | The half-open probe lease, `Retry-After` preserved past the local maximum, and pool-wide retry backpressure |
| 4 | wpd | `codex/4546-wpd-v2-lineage-placement` | V2 root/parent/thread lineage and child first placement onto the parent's current serving account |
| 5 | wpa | `codex/4546-wpa-dispatch-coverage` | The reset-retry counting seam, compact's routed fallback, the generic OAuth and Anthropic hops, the gated-400 ladder's relation to the shared cap, and permit atomicity |
| 6 | wpb | `codex/4546-wpb-combo-adapter-retries` | Combo's real hop and target transition under a per-target policy, and Cursor's and Kiro's inner retries |
| 7 | wpg | `codex/4546-wpg-spend-instrumentation` | Sends per logical request, reserved/settled/unresolved spend, cache provenance, and a no-account failure that explains itself |

Only two of those adjacencies are real dependencies. wpb needs wpa's permit
contract to be atomic before a second dispatcher may be wired to it, and wpg
reports what every earlier layer produces, so it is last by construction rather
than by importance. The rest are contract layers that introduce a module and its
tests without rewiring a call site, which is what makes them stackable in
readiness order and revertible one at a time.

That independence is deliberate and it is also the honest limitation of the first
three layers: wpc's classifier, wpe's ledger and wpf's lease are each landed
tested and, for now, partly unreferenced. Each one names in its own pull request
which later layer is obliged to call it. A module that nobody calls does not
protect anything, so the stack is not finished until the wiring layers land on
top of it.

## The three corrections this stack is built on

**"Passes the holder" and "limits every send" are different completion
conditions.** #4608 gave a combo child the budget object; #4609 gave the request a
policy. Neither makes a second combo target draw the remainder, because the
adapter's initial send still reads its own policy allowance. A layer that receives
the counter and does not consult it as a limit reintroduces the multiplier
silently.

**The permit is not yet atomic.** `reserveDispatch()` evaluates the remainder and
`permit.use()` charges it. Two legs that reserve concurrently against one
remaining send both receive a permit. The fix is to make the reservation the
charge and add an explicit release for an abandoned reservation, which is why wpa
has to land before anything else wires a new caller.

**A memory Map is not a budget.** The ledger lives in process memory, and cleanup
only protects roots with active requests, so an exhausted-but-idle root can be
deleted and recreated fresh under the same id. Until reservations are durable and
cleanup is exhaustion-aware, "this root is out of budget" means "out of budget
until something restarts".

## Verification posture

Unchanged from `070_delivery.md` and restated because it governs every layer here:
the local suite, typecheck, install and build are **not run**, by explicit
instruction. Pushes use `--no-verify`. The only proof is hosted CI at the exact
final head SHA of each branch, and a green run against an earlier commit is not
evidence for the head that merges. Each pull request states that posture in its
Verification section rather than implying a local green.

## What would make this fail

Landing wpe's refusal path with a default limit low enough to refuse an
unconfigured install. The count caps from #4614 are already live and permissive;
token accounting must start observational and only enforce behind explicit
operator configuration, or the first upgrade turns a cost guard into an outage.
