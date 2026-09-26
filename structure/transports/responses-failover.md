# Responses Failover And Replay

`src/server/responses/compaction-recovery-policy.ts` is a pure eligibility policy, not a dispatcher.
It requires explicit configuration and normalized attempt evidence, preserves ordinary requests,
and refuses cancellation, committed semantic output, tool effects, protected failures, exhausted
send budgets and repeated recovery. Its Devin `invalid_argument` exception is separately opted in;
an opaque HTTP 400 alone never grants replay. The caller owns canonical target resolution, output
validation and shared-budget reservation. `compaction-recovery.ts` connects this policy to
self-contained routed v1/v2 compaction in `core.ts` and `compact.ts`; normal and successful
requests keep their original route. One configured emergency target shares the original send
and translation budgets. Physical-send receipts and explicit retry-helper reports reconcile legacy
fetch sends without double charging external reservations; one prepaid emergency permit is shared
with adapter dispatch, and only additional retries draw from the remainder. Adapter observers retain partial-output and structured denial evidence
before response projection. Native encrypted compaction, uploaded files, stored continuations,
and policy/combo routes are excluded. Emergency output must contain one readable portable
compaction item; recent original user messages are retained verbatim, and recovery failure keeps
the original failure. `tests/responses/responses-compaction-recovery-policy.test.ts` and
`tests/responses/responses-compaction-recovery.test.ts` pin these boundaries.

Retry, replay, and combo failover on the Responses data plane: upstream reset retry, the
ambiguous-resend gate and replay boundary, combo quota fallback and commit boundaries, compaction
routing overrides, and output headroom. The endpoint and dispatch rules they build on are in
[Responses transport](responses.md).

## Chat-to-Responses message phase inference

Chat Completions streams do not carry the Responses `message.phase` field. The bridge keeps an
unphased live message provisional while its deltas arrive, then assigns `commentary` when a later
tool, search, reasoning, or assistant boundary proves that more work follows, and assigns
`final_answer` when a terminal `done` closes the current message unless the shared stop-reason
classifier marks that reason as truncated. Normal provider reasons such as `end_turn`,
`stop_sequence`, and `tool_use` therefore remain final answers, as does an absent reason. Explicit
adapter phases always win. Streaming `output_item.added` remains unphased until that future boundary
is known; `output_item.done` and the terminal response snapshot carry the authoritative inferred phase
with the same item id. The batch/non-streaming bridge follows the same rule.

> Decision record: [ADR-0069](../decisions/ADR-0069-chat-to-responses-message-phase-inference.md)

## Upstream reset retry

`src/lib/upstream-retry.ts` guards upstream fetches against stale pooled keep-alive sockets
(Cloudflare closes idle connections; Bun's fetch reuses the dead socket and rejects with
`ECONNRESET` before any response bytes). `fetchWithResetRetry` never retries on its own
account. A reset-shaped rejection is replayed only when the caller passes `replaySafe: true`,
and then up to 3 total attempts with jittered backoff, warn-logged. Without it the rejection
becomes the terminal refusal described in
[ambiguous connection-reset replay boundary](#ambiguous-connection-reset-replay-boundary).
Reusable request bytes were never the test: a string body makes a send mechanically
repeatable, not idempotent, and a model POST is not idempotent. Timeouts, aborts,
`ECONNREFUSED`, HTTP error statuses, and mid-stream SSE failures are never retried at all.

The opted-in callers are the sidecars, whose work is a tool call rather than a turn: the
vision describers, the web-search executors and loop, and the image loop. The model-POST
paths — native Responses passthrough, the generic adapter dispatch and its continuation loop,
compact, and native Chat — are deliberately not opted in. Adapters with their own
`fetchResponse` (kiro, cursor, google) keep their own retry policies; kiro imports the shared
abort/sleep helpers from this module.

## Ambiguous-resend gate

A model POST that fails with the caller having observed nothing is one question asked at three
points. Two are HTTP: before any response head, and after a head whose SSE body carried only
control events. The third is a Codex WebSocket that closes or errors under its create frame before
any Responses event (#4191). `src/lib/request-resend-gate.ts` is the single answer. It derives
stage, cause, permission and send class from `src/lib/request-failure-model.ts` and adds exactly
one thing the table names but does not implement — the narrowly scoped operator override for `refused-ambiguous`.

The override is bounded on three axes at once. The provider opts in with
`providers.<name>.retryOnReset`; the request must be one
`src/server/responses/reset-replay.ts` can judge self-contained, meaning nothing stored, no
server-side continuation state, complete input and only client-executed tools; and the whole
logical request holds one replacement grant, whichever stage asks for it. The grant lives on the
request's execution budget, so a combo child that derives its own scope draws on the same
counter rather than holding a second. A replacement never widens a send budget: it still has to
fit inside the allowance the leg already had, and it is charged to the same counter every other
send goes through.

The number of replacements is the request's as well. A leg reads it from `route.provider`, which
credential rotation, OAuth refresh, transport resolution and each combo target reassign inside one
request, so the grant is held to the smallest ceiling any leg has presented rather than to
whatever the asking leg presents. Otherwise a request that had already spent the one replacement a
strict row granted bought a second duplicate inference as soon as a more permissive row asked, and
how many times one turn could be re-sent depended on the order the rows happened to ask in. A
derived scope draws on the same grant even when its parent is a hand-built view rather than a
factory budget: the claim is public on the parent, so unlike a pending external booking there is
nothing private that forces a second counter.

A committed or futile failure refuses without touching the grant, so a turn that already emitted
output cannot drain the replacement a later ambiguous reset would have been entitled to. The
cause is derived from the `AttemptRecoveryKind` the send will be recorded as, which is what
keeps the reason in the log and the reason the gate weighed from being two different values.

The WebSocket row is asked once, at the end of the passthrough recovery loop, after every leg has
let the settled 502 through. The exchange marks only a socket that closed or errored
(`markCodexWsSocketDeath`) and records the stage it reached: `pre-header` when nothing came back,
`protocol-prelude` when frames arrived but none was a Responses event. Silence keeps its 504, and a native steering or
injection exchange is never marked, because its channel may already have sent continuation frames
on that socket. The send budget is asked before the gate, so a replacement the request cannot fund
leaves the grant unspent. The replacement is one HTTP send, never a second socket, and its answer
is sorted exactly like the pre-header row's (see
[ambiguous connection-reset replay boundary](#ambiguous-connection-reset-replay-boundary)) before
it goes round the recovery loop again.

## Console upload rejection recovery

`src/providers/opencode-zen-rate-limit.ts` recognizes the complete Console upload-rejection envelope only at the effective HTTPS opencode.ai Zen/Go generation endpoint. A provider row name cannot authorize another destination. The two recovery loops in `src/server/responses/core.ts` wait 800 ms and replay the captured serialized request once; cancellation, nonreplayable responses, other errors and a second upload rejection keep their failure semantics. The recovery kind is persisted as `console-go-upload-retry` and has a localized Logs label.

## Same-provider combo quota fallback

Native account-gated model selection maps no grant to 400, temporary capable-account exhaustion to 429, and actual credential failures to 401; Images, Live, and Search reuse this distinction. For a failover combo with multiple models on the same Codex-login OpenAI provider, a pre-stream
429/402 carrying only `x-codex-*-reset-at` may advance to the later model on the same account. The
failed physical combo target still enters its normal target cooldown. An explicit `Retry-After`
remains an account-wide instruction and blocks the later target; a quota response with neither an
explicit retry delay nor a usable reset timestamp keeps the conservative default account cooldown.
This exception is request-scoped and is not applied to direct requests, round-robin combos, or a
combo whose remaining eligible targets use other providers.

> Decision record: [ADR-0070](../decisions/ADR-0070-same-provider-combo-quota-fallback.md)

## Single-target cooldown retry ownership

`src/combos/failover.ts` reports whether the current failure actually records a cooldown.
`src/combos/resolve.ts` forwards that result for each target; `src/server/responses/core-combo.ts`
permits its bounded same-target retry only when this failure records the failed target and its
cooldown is live. A stale-generation refusal cannot borrow a sibling request's shared entry.

## Combo per-target reasoning controls

`src/server/responses/core.ts` passes the combo's `reasoningEffortMode` and the final target's
`supportedLadderFor` result to `src/combos/request.ts` before adapter parsing. Explicit empty
capability ladders remove effort and thinking controls in every combo mode; adaptive mode also
removes those controls for unknown ladders and preserves `reasoning.summary`. Known non-empty
ladders retain the existing per-target effort resolution. This request normalization does not
change target order or attempt accounting; provider-400 decisions follow the [request-local target compatibility](../runtime.md#request-local-target-compatibility) contract.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Upstream key attempt accounting

Key identity is sealed at the guarded physical dispatch after queued selections are rebuilt.
Raw adapter terminal usage is recorded before continuation, search, or image loops merge it;
repeated parsing of one physical response does not count it twice. Key changes preserve the
previous attempt while retaining the active attempt object shared by streaming/combo callbacks.
Bounded failure-body observation retains reported usage and releases cloned readers on abort.
Identity and consumer aggregation follow the [account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution).

## Combo reasoning replay target eligibility

When a serving-route change leaves a tool-bearing history whose reasoning has neither plaintext nor
usable opaque content, a target that requires plaintext reasoning replay is ineligible. Failover
continues to the next target; exhausting the eligible targets returns `400 target_incompatible`.
Opaque reasoning minted by another provider or account is never forwarded, and plaintext is never
fabricated.

## Combo streaming commit boundary

An HTTP 200 does not by itself commit a streaming combo child. The combo parent runs the child's
downstream Responses SSE through `src/server/responses/combo-stream-preflight.ts`, which owns one
reader and buffers only until one of these boundaries:

Native post-header reset recovery shares that boundary, because it is asking the same question
about the same bytes. With `replayReadErrors`, the preflight reports the stage it observed —
`headers-only` before any parsed event, `protocol-prelude` after `response.created`,
`semantic-output` once anything else arrives, including a payload it could not parse — and the
resend gate decides. A `response.created` whose snapshot already carries output items is not a
prelude.

- a non-control Responses event begins client-visible output or a tool/action item, after which the
  target is committed and cross-target replay is forbidden;
- a `response.failed` terminal arrives first, in which case the terminal is converted back through
  the ordinary bounded combo-failure classifier and may advance to the next declared target;
- a top-level `error` arrives before output, in which case unknown, rate-limit, and server failures
  may advance while errors explicitly classified as non-retryable 4xx remain committed;
- a completed/incomplete terminal or the aggregate preflight byte or retained-chunk cap is reached,
  in which case the current target is committed conservatively.

The buffered bytes are replayed unchanged before the reader continues. Native passthrough and eager
relay identity markers are restored on the wrapped response so Windows/Bun stream paths and deferred
logging retain their existing owners. A failed child keeps its physical attempt receipt and usage,
while the successful child remains the logical request result.

A `runTurn` adapter has the equivalent boundary in `preflightAdapterEvents`
(`src/adapters/run-turn-queue.ts`), streaming and non-streaming alike: when its first meaningful
event is a tool call the current request did not declare, and no earlier replay-unsafe heartbeat
recorded a side effect, `src/server/responses/run-turn-execution.ts` projects the fail-closed
undeclared-tool refusal as a pre-commit 502 so the combo can hop with the unchanged catalog. After
any output or a replay-unsafe heartbeat the refusal stays with that child. Chat Completions and
Anthropic Messages inbound requests do not use this classification.
The same heartbeat also decides an ordinary pre-output adapter error or an empty end: after a
replay-unsafe heartbeat the child's 502 is marked non-replayable, so the combo stops on it instead
of sending the turn to the next target.

HTTP 410 remains terminal by default. It advances and cools only the exact combo target when the
structured code or message explicitly identifies a model lifecycle event (end-of-life, retired,
deprecated, sunset, decommissioned, or no longer available). An unrelated application-level 410 is
not retried.

> Decision record: [ADR-0071](../decisions/ADR-0071-combo-streaming-commit-boundary.md)

Usage consumers preserve positive incomplete-history metadata and connected CLI usage follows the client-scoped hub contract, both specified in [usage accounting](../dashboard-and-usage.md#usage-accounting): readable totals are not a complete ledger, and local management and account data stay separate. Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity. The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`. Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration and records its isolated owner and support limits.

Console upload-rejection recovery excludes query-bearing and fragment-bearing destinations even when their host and generation path match the canonical endpoint.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).

Chat helper admission in `src/server/responses/core.ts` follows the [deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence; see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Lite and routing metadata use the same suffix-normalized model object as serialization, including configured bracket-suffix removal.

## Grok Devin pre-output rate limits

For direct Grok Responses requests served by the Devin runTurn adapter,
`src/server/responses/run-turn-execution.ts` uses `preflightAdapterEvents` before creating the
streaming Response. A first-event 429 without a replay-unsafe heartbeat becomes an HTTP 429 JSON
error through the shared error formatter and client Retry-After resolver. The buffered first event
is replayed for every other outcome. The preflight is bounded by the configured stall timeout,
including any earlier OAuth failover preflight on this path. On expiry, its pending iterator read is
handed to SSE replay exactly once; timeout therefore starts a 200 SSE response. An opted-in Devin
cooldown heartbeat also starts SSE before its wait ends. Once SSE begins, the stream forwards safe
heartbeats and checks the first meaningful event: a pre-output 429 may rotate to an eligible OAuth
account and replay the unchanged request. Without an eligible account it remains an in-stream
failure, since HTTP status is already committed. Text, reasoning, and tool output commit the stream
and prevent later rotation. Buffered Responses turns ignore the cooldown-ready heartbeat during
preflight and apply the same HTTP 429 formatter to a final refusal after OAuth failover. Other
buffered results retain the original event list, including output preceding a late error. Combo
children ignore cooldown readiness during their own preflight, so a final 429 without output can
still move to the next combo target. Devin combo children bypass opted-in stated-reset waiting and
surface the pre-output 429 immediately, because the outer response cannot forward their wait
heartbeats while it is choosing a target. An earlier replay-unsafe heartbeat or meaningful output keeps
the failure on the current target.

## Optional client transport hints

`dropCodexSafetyBuffering` defaults to false. Canonical OpenAI forward Responses can remove only
the two safety-buffering response headers, matching response.metadata events and top-level
safety_buffering fields. Pull/eager client output boundaries compose this with policy failure
normalization; refusal/error semantics, retryability, cancellation and captured EOF errors remain
intact. Internal inspection observes original upstream frames. Native codex.response.metadata.headers
WebSocket metadata and compact are excluded. This does not disable upstream safety enforcement.

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch) privately to final dispatch; preliminary route selection does not inject Go-only headers.
Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates; account quota surfaces use [safe probe diagnostics](inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority. Raw-byte readers on this path supply their own byte and deadline budgets under the [bounded ingestion contract](inventory.md#bounded-response-ingestion-and-orcarouter-login).

Translated Chat requests preserve caller reasoning intent until a combo or policy selects a
concrete target. Empty-ladder stripping and effort mapping apply to each attempt copy, never the
shared ingress body, so a later capable fallback still receives the caller's requested effort.
`src/server/responses/core-normalize.ts` strips an empty ladder from both parsed adapter options
and raw reasoning on each translated Chat attempt, preserving summary controls. Policy fallback
captures the original body before this normalization, including for its first candidate.

> Decision record: [ADR-0110](../decisions/ADR-0110-chat-reasoning-failover-intent.md)

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

Translated Chat request construction uses the [inline-image budget](streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached, rejects inputs above the safe decoded-pixel ceiling, caps native decode work process-wide, and stops queued work when the request is cancelled.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior. Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate. Unicode pattern normalization uses [copy-on-write traversal](byte-accounting.md#unicode-pattern-normalization) while preserving the existing schema and wire semantics.

## Compaction routing overrides

`src/server/responses/compaction-routing.ts` applies `compactionRouting` before model routing in
both `request-prepare.ts` and `compact.ts`. It requires explicit `request_kind: "compaction"` in
`x-codex-turn-metadata`, supplied as a header or embedded in Responses `client_metadata`, and on
`/v1/responses` a `compaction_trigger` input item as well, so metadata alone cannot move an
ordinary turn. Every supplied metadata copy must agree, both that the request is a compaction and
on which trigger it carries; copies that name different triggers are rejected rather than reconciled.
Malformed, absent, and ordinary-turn metadata leave the request unchanged. WebSocket requests use
only per-frame metadata; handshake headers can describe an earlier request.

`compactionRouting.triggers` names the `compaction.trigger` values the override covers, drawn
from Codex's own `manual` and `auto`. Omission means `["manual"]`, so a block that does not
mention triggers routes manual `/compact` only and leaves automatic compaction exactly where it
routes today. `["auto"]` or `["manual", "auto"]` is the opt-in for #5012: an automatic
pre-sampling compaction on a routed thread otherwise stays bound to the canonical `openai`
reservation in `routeCompactionModel`, because that reservation releases only when no enabled
canonical `openai` provider exists (#2901), not when its quota is exhausted. A hand-edited
`triggers` the schema would reject disables the whole block instead of widening it, so a
malformed edit can never route more than it names.

The override changes only the model and optional reasoning effort. Existing native forwarding,
routed summaries, capability handling, and retry budgets remain authoritative; native compact
still removes reasoning before sending. Internal handoffs carry the override record (with the
conversation's source model) as a recursion guard so combo children and fallback attempts
retain their selected targets. Overrides bypass shadow interception and conversation
combo recall, and do not publish replacement combo/handoff recall. They never change the
conversation's configured model or any compaction request outside the configured triggers.

`compactionRoutingKeepsProviderIdentity` compares the source model's concrete route with the
selected route (provider name, Codex account mode and namespace; combos on either side never
match, and a bare source model the lane remembers as a combo target counts as a combo source,
recorded as `sourceCombo` when the override is applied, and a configured combo target is recorded as
`targetCombo` so its concretely routed children stay portable too). A matching identity keeps the caller's credential and may use the native compact
endpoint. A mismatch marks the credential domain as rewritten, exactly like a shadow
intercept, and forces the portable summarizer even for a native-capable target: `compact.ts`
skips `/responses/compact`, and `request-prepare.ts` sets `parsed._portableCompaction`, which
`request-sidecar-auth.ts` (`routedCompaction`) and the passthrough adapter's compaction body
build both honor for canonical ChatGPT destinations. Native ciphertext is replayable only by the
backend that minted it; the conversation model would otherwise resume with an omission marker
in place of its history.

`tests/responses/responses-compaction-override.test.ts` covers trigger selection, config validation,
native and routed handlers, same-provider credential retention, cross-provider portable summaries
and their replay, combo failover, and subsequent conversation settings.
## Ambiguous connection-reset replay boundary

Three failures look alike from the outside — the turn may have executed and we cannot
prove otherwise — and they are answered differently, because the status is an instruction
to the client and the client obeys it. Codex builds its retry policy from
`ApiRetryConfig { retry_429: false, retry_5xx: true, max_attempts: request_max_retries() }`
with `DEFAULT_REQUEST_MAX_RETRIES = 4`. A 5xx is therefore an invitation to send the whole
turn up to four more times, and a 429 is where the client stops.

**A pre-header fetch rejection this proxy refuses to replay is a refusal this proxy made.**
`src/lib/upstream-retry.ts` returns a marked **429** carrying its own code,
`upstream_reset_replay_refused`. No response headers is not evidence that the model POST
was never processed, so the decision not to replay is ours, made before any response
existed — the same shape as `request_send_budget_exhausted`, and it takes the same status
for the same reason. An explicitly replay-safe operation retries instead, and a provider that
opted into `retryOnReset` may spend the request's single replacement grant; once that grant is
gone, or the leg has no send left, or a later attempt fails any other way, the leg settles as
this same refusal. Nothing on that path hands the client a status that invites the whole turn
to be sent again. See [ambiguous-resend gate](#ambiguous-resend-gate).

That includes what the replacement send itself answers. Once the grant is spent, the first send
may already have run the turn, so `settleOperatorReplacement` sorts the replacement's answer, for
the pre-header row in `fetchWithResetRetry` and the WebSocket row alike:

| Replacement answer | Result |
| --- | --- |
| 2xx | Returned unchanged. |
| 307, 308, 401, 402, 408, 409, 413, 429, or any 5xx | Body released; settles as the refusal. |
| Any other status | Real status and body kept, marked non-replayable. |

The refusal set is everything that would send again: the client retry table (408, 409, 429,
every 5xx, which the Codex client retries whatever the headers say), a client following a
307/308 with the same body, a 413 answered as a context overflow the client compacts and resends,
and this proxy's credential and quota recovery (401 refresh or rotation, 402/429 account
rotation). The gateway statuses in `isTransientUpstreamStatus` are only
a subset; 429 and 529 escaped them before. A kept status stays the upstream's evidence for the
caller, and the marker stops every recovery loop that checks it, such as the opaque-blob rebuild
of a 400 or the Codex pool's gated-model retry. A combo rebuilds a failed attempt as a new
response, so `consumeComboFailure` records `nonReplayable` and the combo stops rather than hopping
on, say, a context overflow. The cost is that a real 401, 402 or 429 on a replacement send is not
recorded against its credential on that request.

A 2xx replacement carries no marker, and its stream can still fail before any output. A marker
cannot carry that case, because the combo preflight rebuilds the failure as a fresh Response, so
the request execution budget's `ambiguousResendSpent` is what stops the combo, for all three
replacement rows (pre-header, SSE and WebSocket): a status the client would resend becomes the
refusal, and anything else keeps its status and the non-replayable marker. The direct path skips
the streamed opaque-blob rebuild and settles the preflight's projected failure by the same rule.
Policy fallback does not hop on a marked answer.
A scope derived from a budget this factory did not build (the shape-tested bridge in
`src/lib/request-execution-budget.ts`) remembers a grant it claimed through the bridge, keyed by
the bridged parent, so every sibling scope reports it spent even when that parent predates the
`ambiguousResendSpent` flag.

**An upstream reset observed mid-stream or after a terminal keeps its existing behaviour.**
The passthrough read path still settles a genuine upstream reset as a synthetic 502, and the
Codex WebSocket transport still settles `upstream_closed_before_response` (socket closed
after the create frame) and `upstream_no_response` (origin never produced an event) as 502
and 504. Those describe something the upstream did after our send, and they are the contract
the public server reference already documents. The 504 and a drop after the response started
are never replaced. Only the 502 of a socket that closed or errored before any Responses event
may be replaced over HTTP, when the provider opted into `retryOnReset` (#4191). That replacement
claims from the request's one allowance; if it resets before its head, that is the pre-header row
again and may use a configured second replacement, otherwise it settles as the refusal.

This reclassification is the recorded behaviour change: before it, the pre-header refusal
borrowed `upstream_closed_before_response` and its 502, which multiplied the duplicate send
the refusal exists to prevent. The distinct code is what keeps the two separable afterwards —
both are non-replayable, but only one is ours to restate.

Because the refusal now carries 429, a 429 is no longer sufficient evidence of a provider
rate limit. Every same-target replay, key rotation, account rotation and pool-quota recorder
that keys on 429 first asks `isNonReplayableResponse`:
`src/server/responses/adapter-dispatch.ts`, `src/server/responses/adapter-continuation.ts`,
`src/server/responses/passthrough-dispatch.ts`, `src/server/responses/compact.ts` and
`src/server/chat-native.ts`. Compact additionally records the transport outcome rather than
the client-facing status, so pool health sees exactly what it saw before the correction.
Rotating on a synthetic 429 would both re-send an inference that may already have run and
write a cooldown against a credential that refused nothing — a false signal that outlives the
request, which is the same hazard `rotateRunTurnAdapterOnPreflight429` already guards for the
send budget.

In `adapter-dispatch.ts` the guard at the top of the recovery loop is necessary and was not
sufficient. The refusal can also be produced by a refetch made INSIDE an arm, and that arm
then still holds it: the same-target loop re-enters while `rateLimitRetries` is below the
configured attempts, and the key, Anthropic-pool and generic-OAuth rotations re-enter while a
credential is left to try. The key-401 arm is in the same class from the other direction — its
refetch answers 429 and it falls through into the arms below. So every arm that reassigns
`upstreamResponse` from `rebuildAndRefetch` re-enters the loop guard rather than continuing,
which is what makes the top-of-loop check the single exit for this verdict.

**A refusal this proxy made never acquires a `Retry-After` and never becomes quota evidence.**
Guarding the ten call sites that READ 429 as a rate limit left the sites that WRITE evidence,
synthesize a wait, or re-classify the status on the way out. `isNonReplayableResponse` is the
wrong question for those, because it also covers the WebSocket post-send verdicts, which are
genuine upstream observations; the question is whether any upstream produced this status at
all. `isReplayRefusalResponse` in `src/lib/upstream-retry.ts` answers exactly that, applied
where the refusal is synthesized and reapplied by `src/bridge/errors.ts` when the formatter
re-wraps it after combo failure consumption. Three writers consult it or the code:
`src/server/responses/passthrough-delivery.ts` skips `recordCodexUpstreamOutcome`, which would
otherwise classify the synthetic 429 as quota exhaustion and cool the account;
`src/server/responses/passthrough-error.ts` suppresses the retryable-429 default and drops any
inherited header, taking provenance from the caller that still holds the response and falling
back to the code in the body — provenance is not optional there, because the bounded read
answers with an empty string for anything not display-safe and an empty body is exactly what
the default fires on; and `src/server/chat-native.ts` restores the code its own classifier overwrote —
429 maps to `rate_limit_error`, which already carries a code, so the branch that copies an
upstream code could never reach it — and suppresses the same synthetic wait.

**The verdict is a property of the response, and every surface states it the same way.** The
translated Chat wrapper in `src/server/chat-completions.ts` was the fourth writer and the one
that had none of this: it preserved the cyber-policy code and `model_not_found`, took the
upstream code only when `classifyError` had produced none, and then attached the retryable-429
default. A refusal therefore left the Chat bridge as an ordinary rate limit carrying an
instruction to send the turn again. It now reads the same two things the native surface reads —
`isReplayRefusalResponse` on the response it still holds, and `isReplayRefusalCode` on a body
that came through an intermediate formatter — and never the status, which a refusal and a real
rate limit share. The failed-envelope path in the same function restates it too, so a refusal
arriving as `status: "failed"` is not reported as the 502 a Codex client retries four times.
Because a re-wrap is where the in-process marker is lost, `retainReplayRefusal` and
`carryReplayRefusal` in `src/lib/upstream-retry.ts` are what each formatter calls:
`src/bridge/errors.ts`, `src/server/responses/passthrough-error.ts`, both Chat wrappers, the
routed Claude Messages wrapper, and the deferred-logging re-wrap in `src/server/relay.ts`.

**Dropping `Retry-After` is necessary and not sufficient.** The status stays 429 because Codex
stops there and a 5xx invites four more sends, but the Stainless-generated clients — `openai`
and `anthropic`, Python and Node — decide from a status table that includes 429 and compute
their own backoff when no wait is named, so a bare 429 is still resent by most callers of this
proxy. Every surface therefore also emits `x-should-retry: false`, the one signal those clients
read before that table. The refusal is the only code that gets it: the WebSocket post-send
verdicts are genuine upstream observations and keep their existing 502/504 contract. The
acceptance evidence is a count, not a shape — `tests/server/replay-refusal-parity.test.ts` runs
the proxy over a socket, drives all four surfaces with a client that implements the published
SDK rule, and asserts one physical upstream send per logical request, with a rate-limit control
that shows the same client resending.

The existing provider HTTP-status policy and the shared physical-send budget remain
independent: zero refuses dispatch, invalid counts fail, and a stopped send is counted once.
A denied first combo target returns a local typed 429 `request_send_budget_exhausted` without
dispatch; a denied later hop returns the last real upstream failure without contacting that target.
`src/bridge/errors.ts` retains only the allowlisted non-replayable transport codes,
reapplies the in-process marker, attaches no `Retry-After`, and restates 429 for the refusal
code alone so a combo or adapter formatter holding an upstream-shaped 502 cannot hand the
client back a retryable status. Other upstream codes keep the existing classification;
cyber-policy hard blocks retain precedence. The helper, formatter and public Responses count
regressions live in `tests/lib/upstream-retry.test.ts`,
`tests/responses/responses-send-budget-counts.test.ts` and
`tests/codex-integration/reserve-dispatch.test.ts`. The three write-side paths are pinned
separately: a second armed same-target attempt in
`tests/responses/responses-send-budget-counts.test.ts`, the absent cooldown and absent
`Retry-After` on a Codex pool account in `tests/responses/responses-account-label.test.ts`,
the formatter in `tests/server/retry-after-429.test.ts`, and the native Chat classification in
`tests/providers/upstream-transient-retry.test.ts`.

## Combo output headroom

A combo child is admitted against two budgets, not one. `resolveInputCeiling` in
`src/server/responses/input-admission.ts` answers "how much input may this target take", which
`modelMaxInputTokens` can tighten below the window. The context window itself is what input and
output actually share. When the caller declared `max_output_tokens`,
`checkComboTargetInputAdmission` requires both `estimated input <= ceiling` and
`estimated input + min(declared output, target output ceiling) <= window`, so the output reserve
is counted once rather than charged twice against an already-tightened input budget.
Both direct and combo estimates omit replayed assistant thinking for `openai-chat` models outside
`preserveReasoningContentModels`, matching the adapter's wire omission; other targets still count it.

The refusal is local: HTTP 413 `input_admission_refused` before any upstream bytes are sent, which
existing combo policy already treats as a safe hop. That ordering is the whole point. A target whose
total window cannot hold the turn plus the caller's allowance answers 200, emits a few hundred
tokens and stops on `finish_reason: length`, which the Anthropic surface renders as an output-token
error naming a limit the model never approached — and by then output has committed and no later
target may be tried.

Scope is deliberately narrow. Direct and single-target requests keep the loose 2.5x
pathological-input gate, because they have nowhere to hop. Compaction turns stay exempt. Unknown
context and a caller that declared no output allowance both remain fail-open, so this invents no
limits for custom providers. Canonical native slugs that the narrower pinned table does not carry
resolve their window from the generated in-tree bundle, which is what made the gate inert on the
route where this was first observed; explicit provider and operator caps may only narrow it.

Regression coverage: `tests/server/input-admission.test.ts` and
`tests/helpers/combo-context-headroom-cases.ts`.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).


## Account refusal and rotation boundaries

Native Responses uses the existing pre-stream OAuth HTTP-429 account rotation: account quorum and
cooldown remain in force, while generic OAuth uses the stable snapshot ceiling described below. The
complete credential/transport/replay identity is refreshed, and usage is attributed to the serving
account. Single-account installs do not rotate; a missing alternate credential preserves the original
error while transient recovery remains available.

Kiro adapter additionally classifies bounded HTTP 400/403/429 refusals before output.
Confirmed monthly exhaustion is persisted for the sent login, suspension is quarantined
in process, and an eligible alternate is admitted under the shared rotation and physical
send budget. The original response remains readable if alternate admission fails. A
terminal OAuth refresh rejection can use an eligible alternate only after the original
generation is marked for reauthentication. Final Kiro 5xx errors have fixed public text.
The Kiro replacement reserves a no-wait account lease before committing OAuth selection;
a full replacement leaves the original refusal in place. A successful rotation transfers
the request's lease before the replacement send, and the final response body releases it.
Organization or project exhaustion
allows an initial alternate attempt because the response does not identify the refusing scope. After
resolving an alternate, organization-level retry is withheld only when both credentials have the same
known workspace account id. Stored Pool/main-pool alternates supply that id directly; a request-owned
`main` alternate uses the caller credential's `chatgpt-account-id`. Project exhaustion remains
retryable because no project identity is available. Distinct or unknown workspaces retain failover;
same-workspace suppression applies only to the in-request move. A suppressed move still records
normalized 429/402 evidence and cooldown on the refused account. Credential-refresh failures are
fenced by account and global routing-state generations, so late failures from obsolete state are ignored.
`src/codex/quota-rejection.ts` owns the scoped-exhaustion evidence used only after an alternate
credential has been resolved.

Send-budget refusal is attributed as a withheld rotation only when a model-family-aware eligibility
check confirms from the live roster that at least two accounts exist and an alternate is not currently
cooled. That check applies no cooldown and advances no rotation.

Generic OAuth snapshots its eligible roster before dispatch. Its request rotation ceiling is
`max(3, min(eligibleCount, GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST) - 1)` (the cap is six); the live picker still filters cooldowns, so the snapshot supplies the
stable ceiling without making a cooled account eligible. Same-provider auth recovery keeps the last
physical target, rather than a diagnostic key, and a real send is charged once even when recovery
rebuilds the request.

Precommit Codex model refusals use bounded account recovery for HTTP `detail` and WebSocket-projected
`error.message` bodies. Only an exact HTTP 400 refusal naming the requested or wire model establishes
denial evidence; ordinary malformed requests and committed stream errors do not authorize another
send. Account selectors, uploaded files and send budgets retain their existing restrictions.

OpenCode Go inference POSTs obey the same operator gate; the destination itself does not authorize
replay. A granted pre-header replacement that returns transient 5xx has its body cancelled and returns
the non-replayable refusal. Policy fallback and account rotation preserve that marker instead of
interpreting its 429 as fresh quota evidence. `src/server/responses/policy-fallback.ts` retains one
deep snapshot of the first parsed wire body for a policy selector, including supported synthetic Fast
and effort forms; retries serialize that snapshot so prior recovery mutation cannot alter a later
provider's input. Object-identity metadata is recomputed per attempt.

Compaction route identity excludes policy selectors and combos on either side; synthetic fast/effort
suffixes are removed before identity checks. A stale selector resolved only through the default
provider cannot establish the original serving identity and remains portable.

## Anthropic Fast downgrade recovery

The `anthropic` OAuth and `anthropic-apikey` registry entries use native `anthropic-speed` FastWire
only for `claude-opus-5-5`, `claude-opus-5` and `claude-opus-4-8`; there is no provider-wide Fast
fallback. In the main adapter dispatch loop, a fast refusal naming fast mode or the `speed` parameter
(400 or 429), or a 429 with a fast-pool remaining header of zero, may use one shared-budget repair
permit for a standard-speed resend. The resend charges the root workflow send counter once without a
second request-budget charge. The request retains the drop decision through later rebuilds and records
`anthropic-fast-downgrade`, cause `parameter-rejected`, and a `downgraded` / `response-declined` tier
outcome. A spent budget leaves the original refusal intact; generic 429 and 529 responses keep their
ordinary handling. This repair precedes same-target 429 waiting and credential rotation. Continuation
and sidecar owners do not use this repair. Coverage: `tests/routing/fastwire-policy.test.ts` and
`tests/responses/responses-anthropic-fast-downgrade.test.ts`.
