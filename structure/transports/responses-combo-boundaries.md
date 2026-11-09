# Combo Streaming Boundaries

## Client model identity

Combo dispatch in `src/server/responses/core-combo.ts` keeps its routing selector separate
from the original branded client label. Generated overflow envelopes use that label for
response models and fixed local wording; failed rewritten-turn request rows use only client
or catalog model identities. Synthetic children carry the label through their existing
options. Service diagnostics follow the [producer bounds](../ops/service-logging.md#combo-diagnostics).

## Context-window refusals

`isDefiniteContextOverflow` in `src/combos/failover.ts` reads bounded innermost provider messages.
OpenAI context-length wording keeps its substring match; Anthropic `prompt is too long: N tokens > M maximum`,
Bedrock `input is too long for requested model` and `Please reduce the length of the messages or completion`
count only at the start of the leaf message, so a validation error or SDK wrapper that echoes them is not
evidence. Parameter validation (`invalid_value`/`invalid_type`, a `param` outside the conversation and token
budget fields, `Invalid '<x>'`, Pydantic `input_value=`) never counts. This shared detector grants a
target-local hop before the generic HTTP 400 stop, without recording a cooldown. Code-only evidence
beside unrelated prose, malformed envelopes and arbitrary shorten-parameter requests stay terminal.
Cancellation, hard policy refusals, non-replayable attempts and the streaming commit boundary still win.
`src/server/responses/core-combo.ts` retains the first confirmed HTTP 400 context refusal and its child
diagnostics for exhaustion (including remaining replay-incompatible or unconsented metered targets)
or a refused later send budget. Later fatal errors and explicit fallback-policy refusals return immediately.
Every physical attempt retains its own send count and usage. Coverage: `tests/helpers/combo-context-overflow-cases.ts`
(registered by `tests/server/server-combo-failover-e2e.test.ts`), `tests/server/server-combo-reasoning-replay-eligibility.test.ts`
and `tests/responses/responses-combo-exhausted-error.test.ts`.

## Buffered required-tool contract

Before selection, `src/server/responses/core-combo.ts` excludes resolved Meta Responses destinations
for well-formed mandatory `tool_choice` selectors, including direct hosted/MCP choices and required allowed-tools lists. MCP's optional name may be null; an invalid name or server label still abstains. Normal and
recovery picks share the check, resolving the inbound wire's static model policy and actual Responses
transport URL; malformed and unknown selectors retain their ordinary error path. The next target
receives the original selector, and an all-Meta exhaustion names the constraint before any send.
The child parser accepts `tool_search`, `computer_use` and `image_gen` as recognized hosted choices.
Its raw body preserves the selector; existing destination compatibility, including routed private
tool-search lowering, still applies after parsing. Chat translation maps a direct `tool_search`
choice to its existing synthetic function name. MCP null names also parse inside required allowed-tools lists; function/custom null names remain invalid. A Chat destination is skipped before send when translation would degrade a mandatory choice to auto/none, including the resolved model's auto-only tool-choice policy; exhaustion reports the tool-choice constraint. Eligibility resolves synthetic Fast/effort selectors before model policy, matching child request preparation while preserving exact configured IDs.
For `required` with nonempty declarations at the top level or in `additional_tools`/`tool_search_output`, final preparation and Copilot renegotiation check the full parsed tool union; an empty union refuses Chat unless top-level hosted search belongs to later sidecar injection. Static candidate checks defer this decision until parsed tools are available.
Registered OpenAI API virtual models resolve to their wire model before adapter and auto-only policy checks, using the same registry resolver as child normalization. Other providers and unregistered IDs remain literal. Coverage: `tests/server/server-combo-required-tool-contract.test.ts`.

Required allowed-tools lists containing MCP entries also exclude Chat: a function name cannot retain
the MCP server's ownership, even when a client function has the same name. The shared predicate in
`src/server/responses/combo-required-tool-contract.ts` also guards direct Chat destinations after final
normalization in `src/server/responses/request-prepare.ts`. An incompatible direct route returns 400
before dispatch; an authorized policy candidate uses the [local policy refusal](policy-fallback.md)
so another originally eligible destination can serve the unchanged choice.
Copilot targets that negotiate Auto defer the static eligibility verdict to the child's final wire
and model check. A locally minted policy-candidate refusal survives failure rebuilding and permits a
hop without inferring authority from its serialized code or text. Non-replayable responses and spent
replacement grants still stop before this local-skip branch. A local candidate refusal does not cool
the target, so later compatible requests can select the healthy target again. `tests/providers/github-copilot/github-copilot-auto-runtime.test.ts`
and `tests/adapters/translator-budget-lifetime.test.ts` cover negotiation and refusal provenance.
On target-ladder exhaustion, a private tool-specific refusal identity yields the existing 503 combo-unavailable diagnostic only while every observed failure has that identity. Any generic local or upstream failure keeps the ordinary exhaustion result; copied error bytes cannot acquire the identity. A denied later send reservation keeps the retained failure instead of projecting this diagnostic. The diagnostic describes attempted targets, without claiming that eligibility-skipped targets were tried.

Before combo success bookkeeping, native delivery in `src/server/responses/passthrough-delivery.ts`
uses `src/server/responses/combo-required-tool-contract.ts` to check successful native
`openai-responses` JSON children with explicit required or named function/custom choices.
Only a parsed `completed` output array can prove a violation. A missing required call becomes
502 `required_tool_contract_unsatisfied`; normal failure handling owns target eligibility,
send budgets, fallback consent and spent-replacement refusal. Usage remains on the failed attempt.
Hosted calls satisfy an any-tool requirement only for a declared mapped capability. A mismatched
hosted call returns HTTP 400 with the same code, marked non-replayable and carrying
`x-should-retry: false`, because it may already have executed. Error formatting retains that client policy.
Provider-executed custom calls use response ownership and `isAuthorizedProviderExecutedCall` in
`src/server/responses-undeclared-tool-guard.ts`; a hosted call cannot masquerade as a client custom call.
Unknown tool declarations abstain; incomplete, failed and opaque payloads retain delivery.
Judgment precedes local hosted-image display projection, which replaces image calls with messages;
canonical SSE buffered for JSON callers is judged after restoration and before that projection too.
Accepted bodies retain response tool ownership and preinspection identity, with stale representation
headers removed after decoding. Existing non-replayable responses bypass inspection.
The guard uses the [exact internal media-type match](inventory.md#internal-response-media-types)
for JSON too: mixed-case JSON is inspected, while unrelated types and JSON names inside parameters
remain unread. Native delivery applies the same rule before choosing its SSE or JSON decoder.
Translated Chat, runTurn and native Chat terminal owners stay outside this buffered guard.
The streaming sibling below uses the existing inspector and rewrite readers; it never replays output.
`src/lib/errors.ts` declares the code and `src/bridge/errors.ts` preserves it through combo error
formatting without overriding cyber-policy precedence. Regression coverage lives in
`tests/server/server-combo-required-tool-contract.test.ts`, including the 151-tool call/result cycle.

## Streaming required-tool contract

For native `openai-responses` combo children requested with `stream: true`,
`src/server/responses/combo-required-tool-stream.ts` applies the same explicit required/named
contract derived from the caller body, independently of outbound capability filtering. Acceptable
calls retain caller-declared identities through the shared restorers. The adapter records authorized
hosted substitutions in `AdapterRequest.hostedToolSubstitutions` during the build step that applies
them; delivery reads that metadata and body from the request that produced the stream, including
in-place queued revalidation in `src/server/responses/request-transport.ts`. Every build supplies an
array, including empty, so removing a preference cannot retain an earlier build's authority.
`src/server/responses/combo-required-tool-fulfillments.ts` accepts `image_generation_call` for the
replaced image function only when that send still declares the hosted capability. A filtered tool or
lowered `none` selector never erases caller intent: missing calls retain the usual pre-commit fallback
or post-commit typed failure. Caller hosted non-function selectors retain their terminal owner.
Completed item events and terminal snapshots can satisfy it; a call start alone cannot.
Missing calls turn `response.completed` into `response.failed` with
`required_tool_contract_unsatisfied`, retaining response identity, output and usage.
The client rewrite judges restored calls before continuation observers and hosted-image display.
The raw inspector and client guard resolve selectors and observed calls through the same authorized
Muse/namespace alias maps, authorized self-named scrub and catalog-aware default-namespace normalization.
They compare name and namespace (the reserved `functions` group is bare) before reporting terminals
or persisting completion. Eager and tee retain their readers and cancellation owners.
Provider-owned custom calls retain their call-ID-prefix ownership. Hosted effects, unknown items,
and the local web-search bridge make the verdict non-replayable, including sparse terminal snapshots.

Only this mandatory native contract extends preflight to hold known reasoning frames. It keeps the
existing aggregate byte/chunk caps and a fixed `COMBO_REQUIRED_TOOL_REASONING_HOLD_MS` deadline of
1,000 ms from the first held reasoning frame in `src/server/responses/combo-stream-preflight.ts`.
Trickling frames do not reset it. Deadline expiry, text, tools, opaque/unknown events or either cap
commit this child; expiry releases held bytes and transfers the pending read to the existing relay,
preserving its eventual chunk or error exactly once without authorizing replay. A missing-call
terminal held before commitment becomes the existing 502 combo failure; another
target remains subject to eligibility, consent and budgets. After commitment the typed failed
terminal remains with that child. Lifecycle snapshots with output and failed/incomplete snapshots
with output commit conservatively; only a checked missing-call terminal with harmless text/reasoning
may be discarded. Cancellation wakes a pending read; every exit clears the hold timer and checks cancellation before parent success.
Auto/none, unknown contracts, direct native routes, Chat and runTurn keep their terminal owners.
Coverage: `tests/server/server-combo-stream-required-tool.test.ts`,
`tests/server/server-combo-stream-hosted-tool-contract.test.ts` (hosted substitutions, eager/tee),
`tests/server/server-combo-stream-send-contract.test.ts` (queued rebuilds and filtered required tools), and
`tests/routing/combo-required-tool-stream-preflight.test.ts`.

## Combo streaming commit boundary

An HTTP 200 does not by itself commit a streaming combo child. The combo parent runs the child's
downstream Responses SSE through `src/server/responses/combo-stream-preflight.ts`, which owns one
reader and buffers only until one of these boundaries:

SSE selection uses the [exact internal media-type match](inventory.md#internal-response-media-types).
Explicit non-SSE types pass through unread, including parameters or longer subtypes containing the
event-stream token. A caller can still opt into inspecting a response without a content type.

Native post-header reset recovery shares that boundary, because it is asking the same question about
the same bytes. With `replayReadErrors`, a read error that arrives while the preflight is still
inspecting returns the buffered prefix with the stage it observed — `headers-only` until
`response.created`, `protocol-prelude` after it — and the resend gate decides. Control frames
(`response.in_progress`, `response.queued`, `response.heartbeat`, the Codex metadata frames below, a
held mandatory-tool reasoning prelude) do not advance the stage. Once output or a payload the
preflight could not parse commits the stream, or a terminal ends inspection, the preflight returns
`accepted` (`failed` for a retryable zero-output terminal); a later read error belongs to the relay
and never reaches the resend gate. A `response.created` whose snapshot already carries output items
is not a prelude: it commits.

- a non-control Responses event (apart from the held mandatory-tool reasoning prelude above and the
  Codex metadata frames) begins client-visible output or a tool/action item, after which the
  target is committed and cross-target replay is forbidden;
- a `response.failed` terminal arrives first, in which case the terminal is converted back through
  the ordinary bounded combo-failure classifier and may advance to the next declared target;
- a zero-output `response.incomplete` with no reason, `adapter_eof`, `missing_terminal_event`, or
  `upstream_stall_timeout` follows the same failure path; explicit semantic or unknown reasons stay terminal;
- a top-level `error` arrives before output, in which case unknown, rate-limit, and server failures
  may advance while errors explicitly classified as non-retryable 4xx remain committed;
- another completed/incomplete terminal or the aggregate preflight byte or retained-chunk cap is reached,
  in which case the current target is committed conservatively.

The Codex WebSocket metadata channel writes `codex.rate_limits` and `codex.response.metadata` into
the same body, usually before `response.created`. These frames are rebuilt from quota and header
metadata, so the preflight treats them like the lifecycle preamble: they neither commit the child
nor end inspection. Any other unknown event type still commits. A zero-output
`server_is_overloaded` refusal that follows a rate-limit frame while the preflight is still
inspecting (below its byte and chunk caps) therefore advances to the next target;
`tests/responses/combo-codex-ws-overload-failover.test.ts` covers that hop (#8107).

The buffered bytes are replayed unchanged before the reader continues. Native passthrough and eager
relay identity markers are restored on the wrapped response so Windows/Bun stream paths and deferred
logging retain their existing owners. A failed child keeps its physical attempt receipt and usage,
while the successful child remains the logical request result.

`src/server/responses/core.ts` holds the admitted turn lease across the whole combo ladder.
Refused child relays can unbind without settling the parent; the accepted stream keeps its binding
after the ladder returns, until completion or cancellation. Buffered/exhausted exits release the
ladder binding in `finally`. `tests/server/server-combo-zero-output-failover.test.ts` covers failover,
accepted stream lifetime, cancellation, and exactly-once attached-lease release.
Plain admission leases without controller binding do not register or unregister a ladder controller.
Reasonless incomplete snapshots containing output items stay committed; an explicit `reason: null`
also stays terminal. `tests/routing/combo-stream-preflight.test.ts` pins these conservative boundaries.
Hop warnings in `src/server/responses/core-combo.ts` name the status and the closed condition from
`classifyUpstreamCondition` ([proxy-owned error detail](../data-planes/error-detail.md)); upstream codes,
messages and bodies stay out. `tests/responses/responses-combo-exhausted-error.test.ts` pins that log boundary.

A `runTurn` adapter has the equivalent boundary in `preflightAdapterEvents` (`src/adapters/run-turn-queue.ts`), streaming and non-streaming alike: when its first meaningful event is a tool call the current request did not declare, and no earlier replay-unsafe heartbeat recorded a side effect, `src/server/responses/run-turn-execution.ts` projects the fail-closed undeclared-tool refusal as a pre-commit 502 so the combo can hop with the unchanged catalog. After any output or a replay-unsafe heartbeat the refusal stays with that child. Chat Completions and Anthropic Messages inbound requests do not use this classification. The same heartbeat also decides an ordinary pre-output adapter error or an empty end: after a replay-unsafe heartbeat the child's 502 is marked non-replayable, so the combo stops on it instead of sending the turn to the next target.

A native Messages child uses `src/server/messages-native-preflight.ts` after the native log tap,
so the tap retains byte-stall/size/cancellation ownership. SSE media types are matched case-insensitively. Its bounded prelude accepts only an
empty-content `message_start` and `ping` as replayable. As in the native tap, the last untrimmed SSE event name must match the payload type (or be absent); a mismatch commits conservatively. A structured retryable `error` before
any other event returns to the ordinary combo failure classifier unless a later frame read with it commits; any content block (including
a tool start), unknown/malformed payload (a named event without data included; comment-only blocks are skipped), terminal or byte/chunk cap commits conservatively.
Buffered bytes replay unchanged. A collected failure after that commitment is non-replayable, while first output waits for a content frame the tap has seen.
For combo children, a bounded observer before frame transforms preserves the original read boundary for the replay decision. Complete harmless pings may follow a refusal; an unfinished following frame or a named empty frame commits conservatively. The observer stops after that decision or semantic output, and leaves ordinary standalone streaming and log ownership unchanged.
Preflight retention is charged to the translator budget and released on delivery/cancellation.
The Messages ingress offers its parsed body as that source by reference, with no ingress copy, and
only when no effort override rewrites it.
Native plans enforce the captured caller model scope, including internal calls with broad host admission. The same native executor binds the accepted stream to the parent's held lease, carries observed
usage on cancellation, and reports terminal errors without treating them as successful rows.

HTTP 410 remains terminal by default. It advances and cools only the exact combo target when the
structured code or message explicitly identifies a model lifecycle event (end-of-life, retired,
deprecated, sunset, decommissioned, or no longer available). An unrelated application-level 410 is
not retried.

> Decision record: [ADR-0071](../decisions/ADR-0071-combo-streaming-commit-boundary.md)

## Upstream account quota exhaustion failover

Free-tier `single request` / `err_free_prompt_cap` prose also cannot authorize a hop or provider cooldown on 400/422. The structured `free_rate_limited` code still hops on both statuses, with no cooldown because the cap is request-local.

A structured account-window exhaustion code (`usage_limit_exceeded`, `usage_limit_reached`, `1308`, `insufficient_quota`) makes `comboFailureDecision` hop even inside a 400 / `invalid_request_error` envelope, ahead of that terminal stop. Exhaustion prose alone never reaches that arm, and quota prose inside a 400 or 422 response stops instead of hopping: a request-validation body can quote prompt or parameter text back. `ACCOUNT_EXHAUSTION_TEXT` (`usage limit reached`, `token-plan ... quota has been exhausted`, and account/weekly/monthly/daily quota exhausted or exceeded wording) only lengthens a target's cooldown to `MAX_COOLDOWN_MS` on other statuses.

`src/server/responses/run-turn-execution.ts` passes the original adapter event code separately
from its classified verdict to `src/bridge/errors.ts`. When formatting a 400/422 produces
`insufficient_quota`, a response-identity WeakMap retains that original code (or its absence).
`src/server/responses/core-combo-failure.ts` and policy-candidate fallback read that provenance
before treating the serialized code as upstream evidence. Account-lease and translator-budget
response wrappers carry the original marker, including an absent upstream code, to their rebuilt
responses. A prose-derived quota code cannot authorize a hop or provider scope
on 400/422; genuine upstream exhaustion codes remain authoritative on both statuses. Rebuilt
failure responses retain the same distinction. Raw upstream envelopes carry their own code;
the formatter's client-facing classification and cyber-policy precedence remain intact.

Account exhaustion stays target-scoped in `comboFailureCooldownScope`: it names one account, and a provider row can carry several pooled accounts whose healthy siblings must stay eligible on the next request. Provider scope remains reserved for provider-wide evidence (rejected or unpaid credentials, the existing `GoUsageLimitError` / monthly-cap and billing arms).

The Devin direct chat adapter (`src/adapters/devin/cloud-direct/chat.ts`) maps a Connect `failed_precondition` trailer to 429 only when it carries explicit spent-window wording (`TRAILER_EXHAUSTED_RE`: usage limit reached, out of credits, a weekly/monthly/daily/usage quota or usage window that has been or is exhausted). Per-minute, per-hour and rate wording vetoes that evidence. Only a 429 spent window earns the constant `usage limit reached` label, which survives formatting as target-local exhaustion with the 10-minute fallback instead of becoming provider-scoped `insufficient_quota`. Raw trailer text stays inside the parser. Unqualified exhaustion, transient quota preconditions and request-specific preconditions such as MCP configuration errors stay 400 and stop.
Coverage: `tests/routing/router-combo-failover-classification.test.ts`, `tests/providers/devin-hardening.test.ts`, `tests/server/error-fidelity.test.ts`, `tests/codex-integration/combo-codex-exhaustion-cooldown.test.ts`, `tests/server/server-combo-quota-code-provenance.test.ts`, and `tests/responses/responses-combo-run-turn-classified-failure.test.ts`.

Native Chat child error bodies follow [the owned client-body contract](../data-planes/error-detail.md#client-error-bodies-chat). Combo classification consumes the retained legacy envelope through the ordinary bounded reader, while headers and response identity retain their original owners.

## Local workflow send refusals

A root workflow send ceiling stops the entire Combo ladder before another target is dispatched.
`src/server/workflow-refusal.ts` marks that locally constructed response as non-replayable;
`src/server/responses/core-combo-failure.ts` and `src/server/chat-completions.ts` preserve its
`x-opencodex-local-refusal` header and browser exposure when rebuilding the response. This propagation
requires the in-process proxy-error marker as well as the header: an upstream 429 cannot stop
ordinary failover by supplying the same header. The wire body remains `rate_limit_exceeded`.
The message says no additional provider request was sent when the current request already has
physical sends; an admission refusal before its first send retains the no-provider wording.
Coverage: `tests/responses/chat-native-spend.test.ts` and `tests/responses/responses-spend-contract-c.test.ts`.
