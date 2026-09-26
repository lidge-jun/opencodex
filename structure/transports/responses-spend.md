# Responses Spend Reservations

How the Responses data plane reserves credential hops and durable spend before dispatch, and what a
spent budget tells the client. Dispatch and retry behavior is in
[Responses transport](responses.md) and [Responses failover](responses-failover.md).

## Credential-hop reservations

A credential rotation inside one provider's roster reserves a hop from the request's shared send
budget before it knows whether a rotation is even possible, because the reservation is the charge:
`reserveDispatch` spends, `permit.use()` only confirms which leg sent, and `permit.release()` is
idempotent and a no-op once used. Every ladder therefore owes the budget an answer on every exit.

Generic OAuth snapshots the eligible roster at request ingress before dispatch. Its rotation ceiling
is `max(3, min(eligibleCount, 6) - 1)`; live selection still removes accounts in cooldown, so the snapshot
sets the number of possible moves without making a cooled account selectable. Only the ingress-owned
default execution budget expands when at least two accounts are eligible: its base and total ceilings
cover up to `TRANSIENT_RETRY_MAX_ATTEMPTS` sends per eligible account (currently three), for at most
`GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST` (six) accounts, so the default ingress ceiling is 18 sends
whatever the roster size. A single
eligible account keeps the existing base ceiling of three and total ceiling of four. Explicit caller
ceilings and combo-derived scopes keep their existing limits.

A helper recovery's prepaid hop remains part of the full leg attempt allowance. An adapter-owned
pending hop reconciles the actual target synchronously: a regional endpoint change refunds the old
reservation and re-reserves the new transition, so the transition cap is enforced without charging
or sending twice. Diagnostic key changes alone are not transitions; a real destination change is.

The hop pays for a replay that some *other* layer dispatches, so which layer settles the
reservation follows the dispatcher, not the ladder. A helper-routed replay reports the same
physical send back through `onSendsConsumed`; that is what `countedExternally: true` names, and the
reporter's first send settles the pending booking instead of adding a second charge. An adapter
that owns its transport — Kiro's reset ladder, Cursor's transport ladder, or Devin's bounded
pre-output stated-reset replay — reserves once per physical send instead, so no reporter ever
arrives. Those ladders are handed
`adapterDispatchBudget`, a live delegating view of the same budget that spends a permit passed down
through `pendingHopPermit` on the adapter's first reservation and closes the booking through
`permit.assumeCharge()`. Letting both charge is how one physical send became two charges, and how a
spent allowance answered a 429 with a synthetic error instead of the rate limit it was recovering
from (#4709).

`run-turn-execution.ts` passes the same physical-send and recovery-withheld observers used by the
request-building adapter path. Devin builds one `createAdapterPhysicalSend` for the whole
`GetChatMessage` invocation. Its helper supports at most two pre-output replays, but the adapter sets
zero wait allowance, so positive reset delays surface immediately. The outer runTurn records ordinal 1; the shared observer
adds only ordinals above 1 to `sendCount`; the execution budget still reserves every ordinal. A
replay reserves only after its server-stated wait. If admission is refused, no inference I/O occurs,
`retry-send-budget` is recorded, and the preceding provider 429 remains the returned error.

Confirmation happens at the dispatch boundary rather than at the rotation. `adapter-dispatch.ts`
passes an `onDispatch` callback that the rebuild invokes immediately before the wire, and skips it
when the adapter owns dispatch: settling there first would hand that adapter a dead permit, which
it reads as an exhausted request and stops sending on. `adapter-continuation.ts` never confirms,
because its replay is the next loop iteration. `run-turn-execution.ts` always hands the reservation
down, because a runTurn adapter is by definition the layer that sends. The passthrough ladder keeps
the shape it already had: reserve with `countedExternally: true` and pass the permit to the rebuild.

An explicit provider `transientRetryOn5xx.attempts` value is the exact physical-send total for that
request. Once spent, a passthrough rebuild receives no final-recovery reserve and returns the
original upstream response. The guarded profile's shared reserve remains available only when the
provider leaves that transient policy unconfigured; its existing hop-permit settlement is unchanged.

What must not happen is a ladder that charges and then returns through a path that neither confirms
nor releases. That is not a lost send; it is a send the request never made, spending an allowance a
later recovery in the same request then cannot have. `tests/lib/execution-budget-permits.test.ts`
pins the settlement rule and every ladder shape against exactly that, and
`tests/responses/responses-core-modules.test.ts` pins the adapter view's live delegation.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

A combo derives a policy scope per target, and that derivation has to happen inside the budget
factory. Overriding the public `used` property shares only what callers read from outside:
`remainingBaseSends`, the total check and the reserve test all consult the factory's own private
counter, which an overridden property cannot reach. Each derived scope therefore admitted
dispatches as though the request had spent nothing, and the per-target holdback in
`comboTargetSendBudget` — expressed against `maxTotalModelSends` — had nothing to hold back from,
so a long failover combo could exhaust the allowance before its later declared targets were ever
attempted. `deriveRequestExecutionBudget` binds the scope to the parent's real ledger instead.

Three things travel on that shared ledger and have to travel together. The spend and the pending
externally-counted bookings, because a pending booking is a send already counted in the total and
waiting for its reporter, so sharing one without the other would either charge that send twice or
never charge it. And the durable-spend observer below, because it books by watching this counter
move: a derived scope that spent the counter without carrying the observer would move it without
booking, and a combo child's sends would go missing from the ledger. `permit.assumeCharge()`
closes its booking on the same shared ledger, so the adapter handoff above and the combo
derivation agree rather than each settling against a counter the other cannot see.

What stays per-scope is deliberate: the reserve, alternate-target and transition ledgers are each
target's own recovery decision, while the physical-send total is what binds every target together.

## Durable spend reservations

The request's send budget bounds how many times it may reach upstream; the spend ledger bounds
what those sends may cost, and it is the only bound here that survives a restart. Its production
caller is `request-spend.ts`, installed on the execution budget at genuine ingress in `core.ts`
and parked on the log context so `addFinalRequestLog` can settle it. Native Chat installs the same tracker before its independent physical-send ladder and charges it immediately before each dispatch, so that fast path cannot bypass root, identity or provider-pool ceilings.

The Responses path books by observing the budget's own send counter rather than calling each dispatch site; Native Chat directly charges messages, tool definitions and the output ceiling. That counter moves exactly once per physical send — a reservation increments it, a
refund decrements it, and an externally reported send settles against a booking already counted —
so one ledger entry per increment is one entry per send, and a dispatch path added later cannot
forget to book. The previous attempt at this wiring shipped the whole reserve/dispatch/settle
vocabulary with no caller at all (#4707), which is the failure mode this shape rules out.

A booking is confirmed dispatched only once a LATER send exists, because that later send proves
the earlier one left. The newest booking stays open, so a reservation the budget hands back
during this process's lifetime can still be released for free.

Settlement follows what the request learned. The terminal usage belongs to the last send that
left, so that one settles with the real figure; every earlier send failed without reporting usage
of its own and may still have been billed, so it becomes unresolved spend rather than free. A
request that reports no usage at all leaves all of them unresolved. If deferred settlement reaches a tracker with reserved sends after its ledger lease ends, only `SPEND_LEDGER_OWNER_NOT_HELD` is dropped with the discarded ledger. Other owner and storage failures propagate with pending send IDs intact so settlement can be retried.

Replay resolves what nobody is left to settle, and resolves it as unresolved spend whatever state
it was in. Giving an undispatched one its tokens back would assume the journal is complete up to
the crash, and the torn-tail rule says it is not: a send can dispatch and die before its dispatch
record lands. It would also reset a ceiling that had already fired, and an exhausted scope
staying exhausted across a restart is the whole reason this store is on disk. Both are journaled,
so a second restart has nothing to redo.
`tests/responses/responses-spend-ledger-wiring.test.ts` pins the
booking, the settlement split, the refund, a ceiling that refuses a dispatch rather than
describing it afterwards, and the restart.

The default policy still sets no token ceiling on any scope, so an unconfigured install accounts
and reports without refusing. An operator turns enforcement on with the `spend` section in
config.json, which `src/lib/spend-reservation-ledger.ts` resolves through
`spendPolicyFromConfig` and applies with `configureSharedSpendLedger` at startup. There is no
default figure and there deliberately never will be: this ledger is on and journaling by
default, so a shipped ceiling would start refusing real traffic on the first upgrade that ran
it, against a number nobody chose. Absent, empty and all-scopes-absent sections are the same
thing -- observe only.

The shared journal has one live writer per state directory. `startServer` acquires the
`src/lib/spend-ledger-owner.ts` SQLite lease before configuration and before any listener binds;
`sharedSpendLedger` asserts that lease before construction because replay can append `lost`
records, and `configureSharedSpendLedger` asserts it before changing a live singleton. This applies
identically with and without configured ceilings: observe-only still appends, settles and compacts.
Two servers in one process and one directory share a reference-counted lease; that process cannot
hold two directories at once. Sequential ownership is allowed and concurrent ownership is not:
releasing the final reference discards the singleton, so a later directory replays its own
journal instead of inheriting figures. A ledger records the ownership it was built under and
proves that exact identity on every accounting read and change, so a handle kept across a release
and a reacquire of the same directory is refused rather than resuming over writes another owner
may have made. File-backed journal and salt writers are owner-bound at construction, and a
directory entry that is a link -- including one whose target does not exist -- is refused instead
of followed. A separate process may use a separate directory. SQLite crash release permits the
next owner without stale-PID or TTL reclamation.

The journal survives an ordinary process restart once its writes reached the filesystem. It does
not claim host power-loss durability: the append path does not fsync each record, so power loss can
drop recently acknowledged filesystem writes. A torn final line remains the only replay corruption
that may be discarded quietly.

Applying a policy to a ledger that already exists reconfigures it rather than rebuilding it.
Every figure already accounted survives, so raising, lowering or clearing a ceiling changes what
is refused from here on and never what was spent. A rebuild would replay the journal into a
second set of maps while the first still held this process's open reservations, and the two
would then disagree about what is in flight.

With a ceiling configured, three places can refuse and they are ordered cheapest first. HTTP
admission refuses a root scope that is ALREADY spent, before the body is parsed, because that
question needs no token count; the pre-dispatch check in `createResponsesSendBudget` asks the
same question beside the existing send-count one; and the reservation itself refuses the send
that would CROSS a ceiling, which is the only one of the three that can see the identity and
pool scopes, since neither is known until routing picks an account. Count caps and token
ceilings are an intersection: a request passes only when every count and every ceiling admits
it, a count denial is decided before any reservation is booked, and a token denial before any
count is charged, so neither leaves the other's accounting to unwind.

## What a spent budget tells the client

A refusal this proxy made is reported as HTTP 429 with the code `request_send_budget_exhausted`,
on every dispatch path. The three paths used to disagree: passthrough answered 429 and declined
to blame the provider, the adapter paths fell through `describeUpstreamConnectFailure` and
answered 502 "Provider unreachable", and runTurn pushed an unstructured message that was inferred
back to 502 under HTTP 200.

The status is the load-bearing half. The Codex client retries 5xx and does not retry a direct
429, so reporting a local refusal as 502 makes the caller send the whole turn again — the
amplification the budget exists to stop. Encoding it as a quota code instead would stop the
client for the wrong stated reason, and the retryable streaming rate-limit codes would restart
the stream, so neither is available.

The distinct code is what an operator reads afterwards. `classifyError` keeps it by matching the
supplied type rather than the status, so an upstream 429 still classifies as
`rate_limit_exceeded` and only this proxy's own refusal carries the other code. Once a response
is committed the refusal travels as a structured terminal event — status, `errorType` and
`code` on the event itself — because an unstructured message is inferred back to 502.

A local 429 must not look like a provider one to our own routing. `rotateRunTurnAdapterOnPreflight429`
returns early on the code, before it reads the status, so a refusal cannot rotate a credential or
write a cooldown against an account that rate-limited nothing; that fake signal would outlive the
request and misroute later ones. The terminal-guard continuation loop now consults
`sendBudgetExhausted()` before it cancels the upstream body, matching the main recovery loop, so
a spent request keeps the real 429 instead of replaying on a live stream.

This is the proxy's own accounting only. Classifying an upstream 429 as org or project spend
exhaustion is a separate contract with a separate owner.
Adapter-owned retries enter the same pending dispatch metadata path as initial key sends.
The actual dispatch commits their count and recovery label once; unsent pending metadata
is discarded on process exit and is not usage evidence. See [key attribution](../dashboard-and-usage.md#upstream-key-account-attribution).
Generic refetches record metadata inside each admitted retry callback, retaining the
transient recovery reason when present and otherwise the outer recovery reason.
