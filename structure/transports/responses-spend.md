# Responses Spend Reservations

How the Responses data plane reserves credential hops and durable spend before dispatch, and what a
spent budget tells the client. Dispatch and retry behavior is in
[Responses transport](responses.md) and [Responses failover](responses-failover.md).

## Prepaid initial sends

`src/server/responses/core-combo.ts` derives each target scope before reserving its initial send.
That reservation occupies the shared ceiling immediately; it is not a completed inference.
`comboInitialSend` hands only that child's single-use permit to `request-send-budget.ts`.
`initialSendAllowance` includes that one prepaid send while `remainingBaseSends` keeps every
booking spent. Other pending external bookings never become this child's free headroom.
Configured transient totals subtract an owner-local counter updated by physical receipts, adapter
observers and retry-helper reports, not shared-ledger deltas. Earlier Combo targets, later bookings
by other owners and the child's unsent booking do not consume that total; the shared ceiling and
later-target holdback still intersect it.

Initial passthrough and budgeted translated HTTP ladders report at the final executor admission,
after pacing, credential rebuild and local egress checks, rather than at retry callback entry.
The one-shot receipt survives rebuilt request init and nested executor wrappers. The WebSocket
receipt runs immediately before the frame is sent; a refused receipt sends no frame and never
permits SSE fallback.
Adapter-owned dispatch claims the prepaid permit once through the live adapter view and closes
its external booking with `assumeCharge`. A fresh derived scope binds its actual first endpoint
without consuming a recovery transition; later endpoint moves keep ordinary transition limits.
Unsent exits release once at Combo/ingress cleanup. Ordinary runTurn transfers cleanup at its first
attempt; hosted media transfers before returning its streaming Response and retains ownership until
its producer settles, including cancellation and synchronous failure before dispatch.
Native Chat includes only its owning prepaid send in its initial ladder and confirms that permit at
the final HTTP receipt; local egress refusal leaves it refundable. Initial-ladder receipts close their
own external booking with `assumeCharge`; later sends reserve their own capacity instead of settling
another owner's pending booking. Cleanup cannot refund real work. Detached judge budgets and leases stay separate.
`tests/responses/responses-first-send-reservation.test.ts` and
`tests/responses/responses-dispatch-receipt.test.ts` pin these boundaries.

`src/server/responses/sidecar-send-budget.ts` binds hosted search/image/video inference to this same
child-owned booking. Generic HTTP/WS uses the final physical-dispatch receipt; adapter-owned
`fetchResponse`/`runTurn` receives the live budget and observers instead, never both charge paths.
Receipt selection follows the actual iteration adapter after rotation. Hosted tool execution does
not itself settle the model's booking. Children without an owning initial permit keep their existing
accounting contract. The hosted reservation, producer and WS regression siblings in `tests/responses/`
assert real synthetic inference, explicit durable settlement and unsent release without widening caps.
Hosted credential hops stay open in this owner and the live pending-hop view until physical dispatch;
generic receipts consume that exact permit, adapters claim it through the view, and fetch-iteration
cleanup releases an unsent hop once, except while an asynchronous runTurn producer still owns it.
Producer settlement performs that release instead, clearing only the matching pending-hop reference.
Direct callers retain their prior hop reporting contract.

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
One exception: a rebuild that the caller itself performed mid-flight — Kiro's reset-triggered
credential rebuild retargeting the request to another region's canonical host — marks its admission
`rebasedTarget`. The physical destination is still recorded, but the move consumes neither the
single target transition nor the alternate-target allowance: it was authorized work, not a failover
decision, and the endpoint fallback keeps ownership of the one transition it may still need.
Admission, reservation and refund use the same alternate-target charging predicate. A validated
rebase remains eligible after that allowance is spent, while replay safety and the total-send cap still apply.
An externally reported rebase retains its exact pending receipt and prepaid proof. Releasing it
refunds only charges it made; reporting or assuming that receipt prevents a later refund.

The hop pays for a replay that some *other* layer dispatches, so which layer settles the
reservation follows the dispatcher, not the ladder. A helper-routed replay reports the same
physical send back through `onSendsConsumed`; that is what `countedExternally: true` names, and the
reporter's first send settles only its named pending permit instead of adding a second charge.
`transientSendReporter` captures that permit before entering a helper; a later handoff cannot
replace it. `reportDispatchSends` verifies shared-ledger ownership and consumes one receipt only.
Native Chat combo children carry the same exact permit to their physical-send boundary.
Reset-only generic combo helpers report their named prepaid receipt too, without changing
the selected retry cap; compaction reconciliation therefore does not count that source again.
Without enforced spend, numeric `used` updates and unnamed, foreign, released or already-reported permits charge
sends without consuming another reservation. Enforced spend accepts only claimed physical starts; extra retries remain full charges. Reports may arrive
out of reservation order; no FIFO ordering is required. An adapter
that owns its transport — Kiro's reset ladder, Cursor's transport ladder, or Devin's bounded
pre-output stated-reset replay — reserves once per physical send instead, so no reporter ever
arrives. Those ladders are handed
`adapterDispatchBudget`, a live delegating view of the same budget that spends a permit passed down
through `pendingHopPermit` on the adapter's first reservation. Claiming keeps that exact permit
refundable across pacing and `beforeDispatch`; `use()` or `assumeCharge()` closes its external
booking only at physical consumption. Both methods share the underlying single-use state, and
release remains idempotent. A used or released exact-owned permit cannot authorize another send.
When spend enforcement is inactive a combo-owned or compaction-prepaid send is settled by the
physical-dispatch receipt; when it is active the shared physical-send reporter keeps ownership, so
a send is never charged by both. Other callers keep early settlement only when enforcement is inactive;
enforced permits stay refundable until execution.
For a Codex WebSocket request, the receipt runs before the frame is sent and at most once across
the WS attempt and its HTTP fallback. If WS send then fails and HTTP refuses before dispatch, that
accepted booking remains charged even though no physical send occurred.
The existing `refundableAdapterDispatchBudget` view stays available to direct Antigravity search;
its legacy already-settled-hop replacement still requires a fresh admitted reservation.
`tests/responses/responses-hosted-send-unsent-hop.test.ts` covers real Vertex hosted-search queued
cancellation, search/image/video pre-dispatch failure, dispatched cancellation and transition admission.
Letting both layers charge is how one physical send became two charges, and how a
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
request (target-local inside a Combo). Once spent, a passthrough rebuild receives no final-recovery reserve and returns the
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

Unconfigured requests preserve the legacy counter observer: reservations increment the send
counter, refunds decrement it, and named reports reconcile prepaid sends. Enforced requests use
the seed and physical-start protocol below across Responses, native Messages and native Chat.
Each transport claims immediately before inference I/O and retains a producer through completion.

A request fixes its enforcement mode, token ceilings and physical-send limit L when it actually
starts. Configuration changes apply to requests that start afterward. An in-flight request keeps
its starting policy until completion, including when an operator enables, disables, raises or
lowers a ceiling. Changing policy never resets that request's physical-send allowance. A request
that starts observe-only keeps the existing observe-only path throughout its lifetime.
The shared tracker captures once at the first actual spend admission or start; constructing a
budget or reading its enforcement preview does not capture policy. Generic Responses paths that
omit retry reporters still invoke that same capture before the wire. Re-entry's token-ceiling
preflight and exact seed admission use the same frozen numeric policy and prepaid proof;
pool continuity validation and shared tracking-capacity safeguards remain active.

Provider-pool accounting uses the canonical routed provider identity, not the mutable display label
that may identify an OAuth account in request logs. Responses final-route normalization captures
that identity before credential selection labels the account, and replaces it when a fallback
selects another provider. Earlier reservations retain the pool they originally charged. Native
Messages therefore shares the same pool ceiling as Responses even when its Anthropic log label
includes an account ordinal; root and account identity scopes remain independent.
Before reserving each combo hop, `core-combo.ts` updates the parent tracker's pool to the resolved
target provider; child account labels and the logical `combo` label do not create separate pools.

### Historical pool continuity and rollback

`src/lib/spend-pool-continuity.ts` applies the current provider roster and top-level
`spendPoolAliases` mapping at read time. Each configured provider P automatically owns its
ordinary salted `pool` alias, so its canonical bucket counts only toward P's group. Explicit
mapping keys are exact salted historical aliases and values are current provider IDs. Other
historical labels, including account-ordinal labels, remain unbound until explicitly mapped.
Each positive unbound bucket overlays every candidate once; original counters and send targets
never move or double-count. Restart reconstructs the same view from the current roster and mapping.

Mappings and automatic self-bindings are read-time configuration, not journal metadata. Removing
a provider or mapping changes the next view without rewriting counters or persisting identity links.
`src/lib/spend-pool-alias-validation.ts` owns the salted hash and validates that P's own alias cannot
map to Q. Padded mapping values and destinations absent from the current roster are rejected at the
write boundary; hand-edited invalid mappings warn on load and refuse applicable pool admission with
`workflow_pool_history_unresolved`, keeping existing ceilings. Configuration writes, provider-set
changes, live reconfiguration and selected-provider admission enforce owner conflicts. Validation
reads an existing home salt without creating one.

Dormant unbound history expires only when its last activity is strictly before the configured
retention cutoff. Capacity pressure cannot expire positive unknown history early. Live reservations
and seed targets remain pinned, including zero-token targets. An ordinary v1 `drop` must persist
before admission uses a reduced total; the overlay is then rebuilt before group eviction decisions.
Mapped groups retain the existing active/exhausted protection and group-activity retention rules.

New bookings use the existing `pool` hash domain for the canonical routed provider. Writers emit
only ordinary v1 records and checkpoints, without `poolContinuity` metadata or a `pool-current`
domain. Contract C is compatibility with the shipped 2.80.0 reader's own record interpretation:
2.80.0 reads these counters, compacts them and expires them using its existing per-label rules.
Downgrade does not preserve canonical cross-alias aggregation or promise the allowance 2.80.0
would have computed for the same traffic without an upgrade. Keep the current journal and salt;
restoring an older copy omits subsequent spend. Re-upgrade applies current provider self-bindings and explicit mappings
to the original balances that survived ordinary old-version retention. There is no launch fence,
wrapper enrollment or reconciliation command. `tests/lib/spend-contract-c.test.ts` uses the complete
frozen 2.80.0 reader in `tests/fixtures/spend-ledger-2-80-0.ts.txt` for this contract.

Unpublished experimental journals containing `pool-current` aliases or `poolContinuity` bindings
are excluded from contract C, including later checkpoints that retain those opaque aliases. The
reader ignores the deprecated bindings but preserves original balances and send targets as
unbound history; it neither converts nor immediately deletes them. Ordinary durable retention
applies. `tests/lib/spend-experimental-history.test.ts` covers replay, compaction and expiry.

Compaction retains valid accounting even after a corrupt complete record. Configured admission
remains refused while corruption is recorded in the live ledger; replay of the clean compacted
journal restores enforcement, matching the shipped behavior. Complete final invalid JSON values
such as `null` are corruption. An unparseable torn final line retains the existing conservative
replay rule. Storage/corruption refusals use `workflow_spend_undurable`; unsafe-file and ownership
errors remain storage failures. `tests/lib/spend-corruption-compat.test.ts` checks these boundaries.

An ordinary observe-only reservation whose first write failed keeps bounded in-memory repair
metadata until it resolves or is evicted. Before reporting dispatch or terminal usage, the ledger
queues the missing ordinary reserve prefix ahead of those records. Later pruning or any admission,
including observe-only admission, retries that queue so recovered storage retains the reservation.
This grants no seed or overflow capacity and adds no journal record type or identity metadata.

For requests with an applicable root, identity or pool ceiling, each selected target/key first
obtains a normal-capacity pre-send seed through `reserveSeed`. A failed initial seed refuses the
wire call, including rootless passthrough and generic adapter ingress. Stable retries reuse that
seed; a real identity change must acquire its own normal seed. A prepaid combo child adopts only
its exact permit on the same shared send ledger, excluding that reservation once from preflight.
Reported additional sends reuse the seed's exact scope references through `reserveReportedFromSeed`
and allocate no new scope keys. Already-started sends remain booked even during persistence failure.

`src/lib/request-execution-budget.ts` shares a physical-start counter across derived budgets and
freezes the finite positive limit L when the request starts. The default guarded limit is four;
the initial bounded OAuth request profile allows at most eighteen.
`createPhysicalSendReporter` owns selected-seed start receipts, reports only claimed sends and
closes its producer after reconciliation. Adapter permits claim once at their physical boundary; their executor span keeps the start
rebindable until OAuth selection reaches the wire, then reports and closes it. Zed completion
requests and token-refresh replays use `src/adapters/physical-send.ts`; authentication exchanges
remain outside the inference count. Kiro retains this span through its executor-side rebuild.
Telemetry and raw numeric budget updates cannot create extra enforced send records. Native compact
uses the same unbound-history refusal explanation and workflow header as other Responses executors.
`request-spend.ts` waits for producers before terminal settlement, marks unknown usage lost, then
persists ordinary `forget` records before releasing seeds. Each tracker waits only for its own
reporters, so overlapping traffic cannot pin a completed request. Storage-failed cleanup stays
queued on the ledger and retries on later admission, pruning, reconfiguration or reporter closure.
Already-started reports retain a stable send ID and estimate through partial writes. Reporting a
batch owns every pending start before its first append; same-seed retries reconcile those records
without admitting another send. Owner errors propagate while preserving queued liability, and
caller finalizers still close reporter leases so shutdown can drain after a failed report.
An abandoned seed leaves every admission lookup immediately. Its remaining cleanup obligation
stays separate, including when durable forgetting throws an ownership or unsafe-file error.
Send-to-seed and reference-counted scope-pin indexes avoid scanning all seeds on admission.
Forgotten send IDs do not subtract scope totals. Shutdown drains all reporters before
releasing ledger ownership; restart resolves orphan reservations conservatively without reviving
request capabilities.

Claude CLI, CodeBuddy and Qoder use one CLI invocation as one physical-count unit. The shared
`src/adapters/coding-agent/turn.ts` runner reserves a normal seed before spawning and keeps its
producer until completion. Child-internal retries and tool turns do not each consume L because
the proxy cannot observe those wire boundaries. Terminal actual usage, including usage above the
initial estimate, still settles in full. This preserves configured CLI use while bounding launches.

Within a fixed policy epoch, every live enforced request retains at least one normal-capacity
seed. For normal send capacity M and largest admitted physical limit Lmax, retained sends are
bounded by M × Lmax, with no overflow scope allocation. Legacy or experimental over-cap history
is retained and can prevent new seeds; lowering policy limits does not erase existing accounting.
`tests/lib/spend-seed-overflow.test.ts` covers capacity, delayed reports, persistence and finalization.
Unconfigured traffic keeps ordinary record shapes and capacity omission behavior; it does not
create seed instrumentation or identity checkpoints. `tests/lib/spend-zero-config-compat.test.ts`
compares exact bytes with the shipped reader for equal pool inputs.

Budget reservations retain their exact durable proof until their own dispatch/report confirms
them. A later reservation does not confirm an earlier pending send. Refunds remove the exact
send and original pool, and releasing an older permit preserves the latest surviving target.
Legacy direct charges still infer dispatch from a later charge and leave their newest booking
open. Report order updates terminal attribution; unrelated pending reservations remain independent.
`tests/lib/spend-pool-continuity.test.ts` covers reversed child reports and exact-pool cancellation.

Settlement follows what the request learned. The terminal usage belongs to the last send that
left, so that one settles with the real figure; every earlier send failed without reporting usage
of its own and may still have been billed, so it becomes unresolved spend rather than free. A
request that reports no usage at all leaves all of them unresolved. A pre-output Grok/Devin 429
binds usage carried by its error event before returning the HTTP refusal, just as the ordinary
streaming and buffered bridges bind terminal usage. If deferred settlement reaches a tracker with reserved sends after its ledger lease ends, only `SPEND_LEDGER_OWNER_NOT_HELD` is dropped with the discarded ledger. Other owner and storage failures propagate with pending send IDs intact so settlement can be retried.

Replay resolves what nobody is left to settle, and resolves it as unresolved spend whatever state
it was in. Giving an undispatched one its tokens back would assume the journal is complete up to
the crash, and the torn-tail rule says it is not: a send can dispatch and die before its dispatch
record lands. It would also reset a ceiling that had already fired, and an exhausted scope
staying exhausted across a restart is the whole reason this store is on disk. Both are journaled,
so a second restart has nothing to redo.
`tests/responses/responses-spend-ledger-wiring.test.ts` pins the
booking, the settlement split, the refund, a ceiling that refuses a dispatch rather than
describing it afterwards, and the restart.

The request tracker checks the current policy against the exact root, identity and pool scopes
on each charge. With an applicable ceiling, any refused booking prevents a new dispatch,
including full tracking capacity or a duplicate send id; the log uses the existing specific
workflow refusal reason. Requests without an applicable ceiling remain observe-only. Enforced reports use their live seed and retain already-started liability without a new
capacity admission. Observe-only reports keep the shipped permissive behavior, including omitted
bookings at capacity.
`tests/responses/responses-spend-capacity-guard.test.ts` covers these boundaries.

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

Every file check admits a ledger file only when it is a regular file, not a link, with exactly
one directory entry, owned by the process user. A refusal raises `SpendLedgerFileRefusedError`, a
`SPEND_LEDGER_OWNER_UNAVAILABLE` owner error. The error carries the file role (`journal`,
`journal-compaction`, `salt`) and the failed condition (`not-regular-file`, `symbolic-link`,
`extra-hard-link`, `foreign-owner`, `invalid-salt`), and never the path, salt, alias or request
content (#6314). Before this, one sentence covered five conditions and two files. A macOS sync
daemon briefly holding a second link to a journal inside a synced folder could then only be
diagnosed from an instrumented build. The guard is unchanged.
Responses dispatch maps this local refusal, including nested retry causes, to HTTP 503 with
`type: "server_error"` and `code: "spend_ledger_storage_unavailable"`. The sanitized role,
condition and synced-folder guidance reach the client without a "Provider unreachable" prefix.
Passthrough and compact release admission leases without recording host or account-health
failures; translated initial/recovery dispatch uses the same mapping. runTurn preserves the code
in buffered HTTP 503 responses and Combo preflight; an already committed SSE response carries
it in a structured terminal error. Generic upstream 503 remains `server_is_overloaded`.
The request log marks this as a synthetic `local-refusal`, preserves the storage code, and
releases only admission/probe leases: existing spend debt and dispatched-send charges remain.
Both 502 and 503 already belong to the internal transient-status and Combo-hop sets, so
this response correction does not change those retry sets.
`src/lib/synced-state-location.ts` is the advisory half. `acquireSpendLedgerServerLifecycle`
warns once at startup when the state directory resolves inside iCloud Drive, a File Provider
folder, Desktop/Documents with iCloud Desktop & Documents sync detected, or Desktop/Documents
while Google Drive for desktop is present (`GoogleDrive-*` under CloudStorage, or DriveFS),
and it refuses
nothing on that basis. `tests/lib/spend-ledger-file-journal.test.ts` pins the refusal shape, and
`tests/lib/synced-state-location.test.ts` pins the classification.

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
