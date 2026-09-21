# 110 — the operator surface for the spend ceiling

Closes the gap `100_dev_tip_closure_assessment.md` identified as the last live half of
#4546. Written against `dev@88249ed750`. No local suite, typecheck, build or `ocx`
invocation was run for this unit, by explicit instruction for the lane; the evidence is
hosted CI at the exact head.

## What the gap actually was

Not a missing mechanism. The durable ledger has reserved, journaled and refused since
#4546, and #4707 gave it a production caller that books one entry per physical send. What
was missing was a way to say yes: `DEFAULT_SPEND_RESERVATION_POLICY` left every limit
undefined, the process-wide ledger was constructed with no `policy` argument at all, and
`src/types/config.ts` declared no spend key. `limitFor()` therefore answered `undefined`
for every scope on every install, which made the refusal branch unreachable in production
and the whole feature an observation.

The reporter's Phase 1 traffic passes every live ceiling by construction, because the live
ceilings are counts: 256 physical sends and 64 distinct children per ten-minute window
against a measured ~61 per ten minutes, while the ~8.7M uncached input tokens per ten
minutes met no ceiling at all.

## What shipped

A `spend` section with per-scope token ceilings, strictly validated; a
`configureSharedSpendLedger` seam that applies it at startup and can reconfigure a ledger
that already exists; and a refusal that names the scope and the number.

Four decisions are worth recording because each had a plausible alternative.

**No default figure.** Absent, empty and all-scopes-absent sections resolve to the same
unconfigured policy. The ledger is on and journaling by default, so any shipped ceiling
would begin refusing real traffic on the first upgrade that ran this code, against a
number nobody chose. `090_remaining_stack.md` called observational-first deliberate; this
is the configuration that was supposed to follow it, not a retroactive default.

**Reconfigure, do not rebuild.** Applying a policy to a live ledger replaces the policy
and keeps every figure already accounted. Rebuilding would replay the journal into a
second set of maps while the first still held this process's open reservations, and the
two would disagree about what is in flight. Raising a ceiling is therefore not a
forgiveness: the spend already booked still counts against the new number.

**Reservation-at-admission is not where the assessment put it.** `100` asked for the
admission path to pass `spend` at `src/server/index.ts`. It cannot, and the reason is
structural rather than incidental: a `WorkflowSpendRequest` needs an input token count and
an enforceable output ceiling, and at HTTP admission the body has not been read, no route
has been resolved, and no account has been picked. Reserving zero there would book a
journal record and consume a send id for a figure known to be wrong.

What admission CAN do without a token count is refuse a scope that is already spent, and
that is what it now does — the cheapest refusal in the path, taken before a body is
parsed. The reservation itself stays where the figures are, at the physical send, which is
where #4707 already put it. Identity and pool can only refuse there, because neither is
known until routing picks an account.

**Counts and tokens are an intersection, stated rather than emergent.** Counts are checked
first because a count check reads two integers this process already holds while a token
check may build the ledger and replay its journal. They can disagree, and the intersection
is what is enforced. A count denial is decided before any reservation is booked and a
token denial before any count is charged, so neither leaves the other to unwind — and
neither is ever relabelled as the other, because "sends exhausted" and "spend exhausted"
send an operator to two different remedies.

## The defect that would have made the whole thing inert

Adversarial review of the first cut found it, and it is worth recording because the feature
would have looked finished and refused nothing on the path that matters.

The canonical passthrough ladder does not reserve its physical sends. It sends, then reports
the count through `onSendsConsumed`, which assigns through `budget.used`, which calls
`observer.charge()` after the fact. The comment there already said the right thing — "the
ledger records them even past a ceiling it would have refused, because refusing after the
fact only hides spend that was really incurred" — and the ledger could not honour it:
`reserve()` refused anything over the limit, and a refused reservation books nothing.

That is a fixpoint, not a rounding error. The send that would cross the ceiling is dropped
from the total, the total stays one send short of the limit forever, the scope never reads
as exhausted, and every later request is admitted. With 142k-token requests against a 20M
root ceiling, accounting would stall near 19.9M and nothing would ever be refused.

The fix is `alreadySent` on a reservation: a send being RECORDED rather than admitted skips
the limit check and the durability refusal, takes the scope over its ceiling, and is marked
dispatched immediately so it cannot be handed back for free. Taking the total over the limit
is precisely what arms the next refusal.

The same review found the other half: the production tracker treated every non-limit denial
as permission to send, including `reserve-not-durable`. Durability before admission is the
reason this store is on disk, so that one now refuses — and because the ledger raises it only
when a limit is configured, an install that configured nothing is still never refused.

## Legibility, and why it needed work in three places

`workflowDenialSummary` already had a sentence for `workflow-spend-exhausted`, and it said
"the task reached a configured token ceiling" — true, and useless to someone who has to
find out which of three scopes fired and what the number was. The denial detail (scope,
limit, projected) now reaches the message, the refusal header, the synthetic request-log
row and the workflow event ring through the one function that owns all four.

The scope ID does not travel with it. Root ids are client thread headers and identity ids
are credentials; the ledger writes salted aliases for exactly that reason, and a 429 body
is no safer a place for one.

One case remains imperfect and is worth naming. The send that CROSSES a ceiling mid-request
is refused inside the request execution budget, which reduces every refusal to
`allowed: false` and answers through whichever dispatch path was asking — so the wire
still reports `request_send_budget_exhausted` for that one send. The request-log row and
the event ring are marked `workflow_spend_exhausted` with the scope and the ceiling, and
the NEXT request for that scope is refused legibly at admission. Carrying the denial
through the dispatch decision itself would touch four renderers in the responses path and
belongs to its own change.

## Known limitation carried forward, not fixed here

`logCtx.spendOutputCeilingTokens` is set only from an explicit `max_output_tokens`
(`src/server/responses/request-prepare.ts`), and is not clamped to the model's documented
cap. A caller that sends no `max_output_tokens` therefore reserves zero output tokens,
which under-reserves the in-flight guard relative to the contract stated in the ledger's
header. It does not under-count spend: settlement uses the real reported usage, so the
durable total is right either way. `resolveOutputCeiling` in
`src/server/responses/input-admission.ts` is the existing helper that would close it, and
it needs a route and a model, so the wiring is a separate unit.

## Deliberately not in scope

Finding 2 of `100` — cohort keying concentrating a fan-out onto the interactive account,
and the absent worker-lane account designation — is a consequence of a deliberate fix and
needs its own decision. Nothing here touches routing.

## Verification

Static reading plus two new test files: `tests/config/config-spend-ceilings.test.ts` for
the operator surface and `tests/lib/spend-ceiling-enforcement.test.ts` for the
reconfiguration, the admission gate, the count/token ordering and the legibility of the
refusal. The unconfigured case is pinned explicitly — no ledger resolved, no journal
opened, admission unchanged — because that is the property an upgrade can break silently.
