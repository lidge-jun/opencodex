# 020 — wfc: a refusal an operator can read, name and clear

## Today

The refusal is a 429 with `workflow_budget_exhausted` and a sentence about the
task's send budget. Two problems, and the first one cost hours.

A 429 from a proxy that also forwards provider 429s is ambiguous. There is nothing
on the record that says which one this was, so the first move is always to go look
at the provider. This is the same defect #4639 fixed for the synthetic 503: a
locally generated refusal presented under a field an operator reads as upstream.
The fix there was provenance on the record, and it applies unchanged here.

The second is that there is no way out. `resetWorkflowBudgetsForTest` is named for
its audience and `workflowBudgetSnapshot` has no caller outside the module, so the
state that decided the refusal cannot be read and cannot be cleared except by
restarting the proxy — which drops every other root's accounting with it.

## The change

Name the ceiling. The denial type already distinguishes
`workflow-sends-exhausted` from `workflow-children-exhausted` and the rest; carry
that through to the error body and onto the request log instead of collapsing it
into one sentence.

Mark it local. The request log gains the same origin treatment #4639 introduced, so
a proxy refusal and an upstream 429 are distinguishable on the record and on the
management read surface.

Expose and allow clearing. `GET` the root's budget through the management API so an
operator can see a ceiling approaching rather than discovering it, and allow a
bounded, recorded clear of one root. Clearing one root is not the same as
restarting: it is scoped, it is logged, and it leaves every other root's accounting
intact.

## What must not change

The clear is an operator action on the operator's own proxy, not a path a request
can take. It goes through the management surface, which already requires a
dashboard session or the admin token, and it must not be reachable from the data
plane. A fan-out cannot be allowed to clear its own ceiling — that would make the
budget a suggestion, which is the failure #4546 spent a release removing.

## Acceptance

1. The refusal body and the request log name which ceiling fired.
2. The record marks the refusal as proxy-origin, distinguishable from an upstream 429.
3. An operator can read one root's budget and clear it through the management API.
4. The clear is scoped to one root, is recorded, and is not reachable from the data plane.

