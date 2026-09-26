# Streaming Health And WebSocket

Management provider-validation calls use the [initialization-independent relative send-path validation](../config.md#provider-relative-send-paths) before persistence.

Native and translated delivery now have separate owners in the
[core module ownership](responses.md#core-module-ownership). This surface retains its existing behavior.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Codex WebSocket quota-family normalization remains generic; retired-model evidence is filtered
by the [OpenAI quota owner](../providers/openai-tiers.md#public-provider-contract), not by
removing support for non-default WebSocket quota families.

Key-auth hosted-search continuations validate account selection after pacing and report a failed
terminal on drift; see [continuation binding contract](../providers-and-adapters.md#hosted-search-continuation-binding).

Shared parsing and streaming follow the [request-copy](byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](responses-wire-shapes.md#passthrough-sse-stream-shapes-314).

## Heartbeat and stall deadline

RunTurn search interception forwards adapter heartbeats immediately and emits progress for buffered semantic events. Its bridge uses the search plan's stall deadline so a bounded sidecar search fits the watchdog budget.

Native Chat uses the same resolved `stallTimeoutSec` with a pending-upstream-read allowance that
pauses under downstream backpressure. Its Chat error and cancellation contract is documented in
[native Chat completion lifecycle](../data-planes/inbound-compat.md#native-chat-completion-lifecycle).

The HTTP/SSE bridge emits an SSE comment-line keep-alive (`: opencodex heartbeat`) during upstream
silence to re-arm Codex's idle timer (Codex's default `stream_idle_timeout` is 300 s and ANY SSE
bytes re-arm it). A comment line is discarded by every eventsource parser without producing an event,
so strict Responses decoders never see an unknown variant. Those bridge-enqueued keepalive frames do
NOT count as activity for the bridge's own watchdog: a bounded stall deadline closes the stream with
`response.incomplete` / `upstream_stall_timeout` and cancels the upstream request if no real
adapter events arrive. The deadline is checked on the 2 s heartbeat tick and its budget is resolved
by `src/stall-timeout.ts` (`resolveStallTimeoutSec`): a public upstream defaults to 300 s, a **local
upstream** (loopback, RFC 1918 private, link-local, or a `.local`/`.lan` name — classified by
`src/lib/local-upstream.ts`) defaults to **disabled**, and any explicit `stallTimeoutSec` overrides
both — including `stallTimeoutSec: 0`, the operator's off switch, which disables the watchdog for
public upstreams too. A disabled budget resolves to `0`, and the watchdog kill is gated on budget
`> 0`, so a `0` never mis-arms a kill on the first beat; keep-alives keep flowing regardless, so a
silent-but-healthy local model (CPU-bound thinking or a long time-to-first-token) stays connected.
Adapter-yielded `{ type: "heartbeat" }` events DO reset the watchdog.
During an opted-in standalone Devin stated-reset wait, `src/adapters/devin/cloud-direct/stated-reset-retry.ts`
emits a safe adapter heartbeat immediately and schedules the next ones at intervals no greater than
500 ms, below the shortest positive
stall budget of one second. The cooldown-ready marker opens SSE before the wait ends; a later
pre-output 429 still reaches the OAuth rotation check before any model output is committed.
The Anthropic adapter maps both SSE comments and `ping` events to that heartbeat (#5707), so an
upstream that only pings while a long thinking block is silent still counts as live.
When the Responses-to-Chat converter receives that typed heartbeat, it emits the same bounded SSE
comment after ensuring the initial assistant-role chunk. Chat clients therefore keep receiving
transport bytes during long reasoning without a fabricated content/tool/usage event. The comment
does not reset a semantic-progress watchdog, and it does not alter the bridge's upstream stall or
cancellation decisions.

> Decision record: [ADR-5805](../decisions/ADR-5805-chat-completions-heartbeat-relay.md)

Top-level `emptyCompletionRetry: true` opts Responses turns into one identical replay when an
upstream turn produces neither output text nor a tool call, including a stream that ends before a
terminal event. A terminal-less stream is replayed only before actionable output; post-output EOF
remains incomplete so text or tool calls cannot be duplicated. The default is off because the replay
may be billable; `OCX_EMPTY_COMPLETION_RETRY=0` is a disable-only emergency override. Streaming and
buffered HTTP adapters plus `runTurn` transports share the same guard, while combo attempts and
routed compaction stay excluded. Pre-content reasoning is retained under named event-count and byte
caps and emits liveness heartbeats while held. A second empty result or retry failure becomes typed
502 `empty_completion_retry_failed`; usage is merged across sends, and the Logs attempt records
recovery kind `empty-completion`.

The fetch and runTurn web-search loops honor `streamRoutedModelOutput`: leading text and reasoning
stream live until the first tool boundary, and final replay omits already delivered events.
The web-search loop requests `stream: true` for every routed-model iteration, but buffers the events
needed to decide whether to intercept a synthetic search call. Text explicitly phased as
`commentary` is safe to forward live because it cannot terminate the turn; this keeps Kiro's
progress visible. A Kiro stream EOF after user-facing text or reasoning gets one bounded completion
retry, because neither the upstream text event nor `END_TURN` / `STOP_SEQUENCE` reliably distinguishes
progress from a final answer. Those two clean-stop reasons prove only that the inference ended; on a
tool-enabled turn, only the private completion tool authorizes `final_answer`. Any other explicit
reason already terminated the inference upstream and is reported as a terminal state rather
than converted into another model request: output-token limits become continuable incomplete output,
context-window exhaustion becomes a non-retryable `context_length_exceeded` error, filtering becomes
filtered incomplete output, and a `TOOL_USE` without an actual tool call is a contradiction. Since
the stop reason arrives only at the end of the stream, `required`-mode assistant text is held inside
the adapter until a real tool call starts or the stream ends, then released as `commentary` unless a
private completion call supplied the final answer. Each held event yields a `heartbeat` in its place
so the stall watchdog stays armed. Synthetic search calls, real tool calls,
and terminal events remain buffered until the iteration validates. Only the first iteration's final
response headers/status and any 429 key rotations are handled eagerly. A failure before downstream
SSE starts returns non-2xx JSON; once headers have started the final response, a generation failure
is emitted as `response.failed` SSE.

### Pending response-body reads

`src/lib/response-body-inactivity.ts` bounds pending byte reads using the same resolved
`stallTimeoutSec` budget (`resolveStallTimeoutMs`), so it inherits the same local-vs-public default
and the `0`-disables rule: a disabled budget passes `0`, and the guard treats a non-positive budget
as "arm no clock" rather than firing immediately. Connect/stall budgets and this body-silence budget
therefore read the same setting in different phases: one bounds event stalls on the bridge, the
other bounds pending raw byte reads. There is no separate body-inactivity setting.
The guard has no read-ahead queue: it starts a monotonic deadline only when its
consumer asks for bytes, pauses on a non-empty chunk, and does not reset on empty
chunks. Discarded empty chunks yield to the macrotask queue periodically, so a large
configured timeout cannot starve timers or unrelated requests, and yielding is not
progress. A slow downstream consumer is not an upstream stall. EOF, errors, caller
abort and parser abandonment remove the timer/listener and release the source
reader without awaiting a potentially broken cancellation promise.

`src/server/responses/passthrough-execution.ts` applies the guard after native
response classification, outside the direct relay and lifetime wrappers. Native
SSE, including the missing-Content-Type fallback, retains its original Response
identity and existing watchdog/terminal ownership. Bounded JSON and error readers
are not wrapped again. Direct bodies and returned redirect bodies are guarded;
bytes, response headers and status are preserved.

`src/server/responses/adapter-delivery.ts` and
`src/server/responses/adapter-continuation.ts` scope initial and continuation
parsers independently, for both streaming and buffered HTTP adapters. Retried
responses are classified before parsing, so unread retry-body cancellation does
not abort the shared request or start a generation deadline during backoff.
A body timeout publishes a typed read failure and cancels only that body's reader;
it does not abort the request-wide signal before the enclosing bridge can emit
its failure terminal. A caught body failure is classified before signal state, so a
source cancellation that synchronously aborts the shared signal still reports the
stall. Buffered initial timeouts return HTTP 504; continuation
timeouts become an in-stream error with status 504, while caller cancellation
retains status 499. Normal completion does not abort a shared request.

Regression coverage lives in `tests/lib/abort-idle-deadline.test.ts`.

### Pre-stream provider input overflow

A provider HTTP 413 received before streaming starts is unambiguous request-size refusal, but raw
relay is not compatible with Codex: Codex classifies the unknown status as retryable and resends the
same oversized turn through its reconnect budget. For a streaming Responses caller, OpenCodex
therefore converts the final 413 (after any adapter-owned bounded image retry) into one HTTP-200 SSE
`response.failed` event with `error.code = context_length_exceeded` and `retryable = false`. Codex
recognizes that terminal contract, marks the context as full, and can run its own compaction policy
on the next turn. Combo routing treats 413 as a stop condition and performs the conversion only at
the outer client boundary, so the failed target is never recorded as a successful combo attempt.

Non-streaming Responses callers retain HTTP 413 and receive a JSON `error` with
`type: invalid_request_error` and `code: context_length_exceeded`, including routed synthetic
compaction. The upstream body is replaced with the same bounded, proxy-owned message used by SSE.
Combo attempts retain their existing internal failure accounting; classification happens only at
the outer client boundary. Local admission and configured outbound-byte refusals keep their own
distinct codes. Classification does not shrink input or automatically retry compaction.
The proxy never silently drops
prompts or images: it does not own the client's transcript, and deleting input would hide data that
was never analyzed. The streaming error message is proxy-owned and bounded instead of relaying the
upstream 413 body, which may echo request content.

> Decision record: [ADR-0049](../decisions/ADR-0049-heartbeat-and-stall-deadline.md)

Kiro transient HTTP 429 recovery is coordinated process-wide after the first throttle: healthy
traffic remains parallel, but throttled followers wait behind one abort-aware probe and share a
deadline that is re-checked after every sleep. Event-stream `ThrottlingException` records the same
deadline for the next client replay. Retries are bounded to three attempts; hard quota responses and
ordinary 5xx errors are not replayed. Completion fallback rebuilds only replayable text, preserves
the original user/tool-result turn for reasoning-only attempts, supplies neutral non-empty carriers
for empty tool output, and validates role alternation plus tool-use/result pairing before transport.

Provider-level `retryOn429` (devlog 260802_429_same_target_retry) is the generic, opt-in
same-target 429 retry for API-key providers (`authMode: "key"`), primarily single-key pools
that cannot use multi-key failover. In the pre-stream recovery loop, a 429 waits (`Retry-After`
or the fixed interval, capped at `maxIntervalMs`) and replays the identical request on the same
key before any failover, up to `attempts` extra times per request (the budget lives outside the
recovery loop, so a 413/401 replay cannot re-arm it). The same wait-and-replay applies to every
other key-auth surface that bypasses that loop: the Responses passthrough wire (e.g. the
built-in DeepSeek preset), the image/video bridge and web-search sidecar loops (before their
`on429` key rotation), and Anthropic terminal-guard continuations (before key/account
failover). The policy covers HTTP-capable adapters only: custom `runTurn` transports in the
image loop run through an event queue and never receive an HTTP status, so they are outside
the HTTP retry scope and cannot replay a 429. Codex never retries 429 client-side (openai/codex#30471), so this is the only
defense for those providers; the final 429 still carries `Retry-After` for clients that honor
it. Concurrent requests each honor their own policy — there is no process-wide shared cooldown
(unlike the Kiro pattern), so a rate-limit storm multiplies upstream volume by at most
`attempts + poolKeys` per request (same-key replays, then failover keys; the pool size is the
operator-configured `apiKeyPool` length, fixed for the duration of the request). Every surface
releases (and awaits the cancellation of) the unread 429 body before the backoff, records the
`rate-limit-429` recovery kind on replay sends, and the bridge loops clear the old
response-header deadline before the wait and start a fresh one afterward — client cancellation
is re-checked after the wait, so 499 always wins over a stale-deadline edge, and backoffs never
consume the connect budget or surface as a 504. The wait is abort-aware:
once the server observes the client disconnect (Bun propagates it asynchronously, observed
1–10 s), the sleep is interrupted, the unread 429 body is released, and the request is
cancelled with 499 before any replay; because the propagation is async, a replay may precede
the cancel if the interval elapses first (bounded by the same `attempts` budget).

OpenCode Go (`https://opencode.ai/zen/go/v1`, serving subscription traffic such as Muse Spark) ships a patient same-target fallback when no explicit `retryOn429` is configured: same-key wait-and-replay with a 10s interval and a 60s cap, `Retry-After` honored. Replays draw from the shared per-request send budget, so a burst typically absorbs a couple of paced sends before the 429 surfaces — without this, a single-key pool surfaced the first 429 immediately and the client’s own retry budget aborted the goal (`exceeded retry limit, last status: 429`). An explicit `retryOn429` — including `enabled: false` — always overrides the fallback; every other provider without the knob keeps fail-fast behavior.

Provider-level `requestPacing` is the proactive companion to `retryOn429`. It reserves outbound
request-start slots before transport work begins, so a known RPM ceiling does not have to fail once
before the proxy reacts. One provider-wide lane enforces the aggregate ceiling. Exact model lanes
may add a slower interval without lowering the provider-wide interval or blocking an otherwise
eligible sibling model. Queue wait is abort-aware and happens before the response-header timeout is
armed. The shared fetch boundary covers HTTP and Responses WebSocket sends; explicit adapter
`fetchResponse` and `runTurn` dispatches reserve the same lane at their call sites. Image-bridge
iterations reserve before arming their per-attempt response-header deadline.

> Decision record: [ADR-0050](../decisions/ADR-0050-heartbeat-and-stall-deadline.md)

Historical `web_search_call` output items from previous Responses turns are not converted into
assistant text. They are UI/search-cell evidence, not a replayable search result payload; turning
them into strings risks routed models echoing an internal marker or implying a current search ran
when the sidecar is unavailable. The active sidecar path is the only place that emits new
`web_search_call_begin` / `web_search_call_end` events.

Four independent clocks bound this path. `stallTimeoutSec` is the base bridge event-stall budget.
`connectTimeoutMs` (default 200 s) covers only DNS/TCP/TLS and the wait for final response headers,
not response-body generation. Config-file-only
`webSearchSidecar.routedModelStallTimeoutMs` (default 200 s, integer 1..2147483647) bounds continuous
raw response-byte inactivity for a routed-model iteration and resets on every non-empty byte.
`webSearchSidecar.timeoutMs` (default 60 s) separately bounds one hosted search request (lowered
from 200 s so an unavailable/limit-exhausted search backend degrades within ~1 min instead of
hanging the whole turn, #398). The
effective web-search bridge watchdog is
`max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 s` (230 s at defaults,
dominated by the routed-model stall clock),
with seam heartbeats between bounded units. None of these clocks is a total generation deadline.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## WebSocket

The WebSocket endpoint exists at `/v1/responses`, but discovery is opt-in:

```json
{
  "websockets": false
}
```

`websocketsEnabled(config)` is true only for an explicit `true`. When false, opencodex removes
`supports_websockets` from injected provider tables and routed catalog entries, keeping Codex on
HTTP/SSE. When true, Codex may use Responses WebSocket frames handled by `src/server/ws-bridge.ts`.
If Codex still attempts a WebSocket upgrade while the feature is disabled, `/v1/responses` rejects
the upgrade with 426 so Codex falls back to HTTP cleanly.

That setting controls the client-facing upgrade only. The transparent upstream
ChatGPT WS optimization described above is selected independently and still
returns the same downstream SSE contract. The canonical `openai` provider uses
upstream WebSocket by default; `providers.openai.upstreamWebsocket: false` sends
its streaming turns over HTTP/SSE instead. This explicit choice also makes
native mid-turn steering and injection unavailable on that provider. It does
not change the endpoint, credential, or downstream event format.
Its WSS route checks NO_PROXY first, then selects the
first non-empty HTTPS_PROXY, https_proxy, ALL_PROXY, or all_proxy value. HTTP_PROXY alone does not
route WSS. Unsupported or malformed selected proxy values skip the WebSocket attempt and use the
existing SSE path immediately; they never fall through to a lower-priority proxy or direct WebSocket
egress. HTTP/SSE fallback retains Bun fetch's own proxy rules, which do not consult ALL_PROXY.

The endpoint handles `response.create`, ignores `response.processed`, supports warmup
`generate: false`, and feeds the same request pipeline as HTTP/SSE.

Registry-declared per-model compatibility hints (`modelResponsesUpstreamStreaming`) may ask the
upstream Responses endpoint for bounded JSON on ANY client transport — WebSocket or ordinary
HTTP/SSE. The bridge reframes that JSON into the same Responses event sequence
(`src/server/responses-json-events.ts`): WS turns send the frames as WebSocket messages, while
HTTP clients that requested streaming receive a synthesized terminal SSE body (created →
output_item.done → terminal → `[DONE]`). No production registry entry currently opts in:
DeepSeek V4 Flash used this path while its public-beta Responses stream was suspected of not
closing on the terminal event, but the official guide documents a
`response.completed`/`response.incomplete`/`response.failed` terminal with no `data: [DONE]`
sentinel, and live probes (2026-08-07) confirm the stream closes on the terminal. The relay's
terminal-output boundary (`src/server/relay.ts`) cuts the stream at that event and synthesizes
`[DONE]` itself, so DeepSeek streams live again; the registry knob remains as a one-line
rollback for upstreams that regress, kept suite-reachable by a synthetic-registry fixture in
`tests/providers/deepseek-inbound-wire.test.ts`.
Synthesized output is capped at 10,000 items across HTTP and WebSocket reframing. HTTP frames are
encoded incrementally, so bounded upstream JSON cannot expand into an unbounded event array or SSE string.

DeepSeek V4 Flash keeps native Responses streaming for progressive reasoning, text, and tool-call
delivery. Its registry entry enables a model-scoped terminal repair before the existing
inspection/client split. A real `response.completed`, `response.failed`, or `response.incomplete`
event always passes through unchanged. If every opened output item has a structurally complete
`output_item.done` and no real terminal arrives for five seconds, the repair emits exactly one
`response.completed` snapshot and closes the upstream reader. EOF or `[DONE]` uses the same strict
completion check; open, malformed, duplicate, contradictory, or unknown output graphs fail closed
as `response.incomplete`, never synthetic success. The repair shares the per-turn translator byte
budget, preserves backpressure, and composes ahead of item-id/snapshot rewrites so HTTP/SSE and
WebSocket clients observe the same canonical lifecycle.

When the hosted-search bridge is also armed, repair wraps the raw first leg BEFORE the bridge:
the bridge suppresses an intercepted `web_search` lifecycle, so a complete call whose leg never
closes would otherwise leave the grace timer unarmed and the turn stalled. The same wrap applies
to every continuation leg the bridge's `send` returns — each leg gets its own grace window on the
shared abort controller — so a terminal-less continuation cannot stall the bridged turn either.
`tests/web-search/web-search-passthrough-bridge.test.ts` drives both legs through `handleResponses`
with an injected scheduler and proves search execution, continuation dispatch, and final terminal.

`ws-bridge.ts` preserves upstream `failed` and `incomplete` status values in the final WebSocket
frame rather than always emitting `response.completed`. If the response status is `failed`, a
`response.failed` frame is sent; otherwise `response.completed` carries through the original status.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](../dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Raw reasoning and provider-authored summary deltas both remain real upstream activity; visibility does not change heartbeat or terminal ownership. See [reasoning presentation](../providers/chat-compat.md).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

## Translated Chat inline-image budget

`src/adapters/openai-chat-images.ts` reuses the shared image normalization ladder for translated Chat bodies above a 3.5 MiB base64-image budget. This is best effort, not a whole-request ceiling. Remote URLs are not fetched; unprocessable and terminal images remain attached, and retained bytes continue to count during demotion. Under-budget construction stays synchronous; delegating MiMo awaits conditional asynchronous construction. Native decoding is admitted through a process-wide four-operation gate, guarded by a 16-million-pixel ceiling confirmed from codec metadata, and request cancellation stops queued and subsequent normalization work. Native Chat passthrough and Anthropic-only 413 retry policy retain their existing behavior.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

## Experimental native mid-turn steering

`codexNativeSteering: true` is an independent, default-off opt-in for the client-facing
Responses WebSocket endpoint. It requires `websockets: true`, the canonical ChatGPT forward
route, an eligible Bun runtime, and a supporting model/execution mode. HTTP fallback and
translated/sidecar/Combo paths do not gain steering. Plaintext V2
restoration is excluded because it is not a transparent native event stream.

`src/server/responses/native-steering.ts` owns one downstream turn and one private physical
upstream connection. The connection remains bound to the credential selected by the ordinary
dispatch path and never enters the idle reuse pool. The normal authentication, admission,
quota observation and pre-dispatch guard remain in force. `response.steer` accepts user-only
input, preserves its target response ID, and cannot select another account or lane.
A steering owner is installed only after turn admission; warmup and capacity refusal leave
no retained owner. Superseding a turn clears its old owner before any early return.

An acceptance acknowledges queued input, not application. The parent terminal is relayed,
but the native chain ends only after outstanding submissions settle and the last response
ends. Automatic successors are relayed without an extra create. A pending event preserves
its `required_input` stubs; exactly one explicit same-parent/lane continuation may provide
the saved results. Results may arrive before the pending event: completed output items and
terminal output advertise the permitted call/approval IDs. Stub `name` is optional on a
returned function output; a different supplied name is still refused. New user messages may
accompany results, but privileged messages, unrelated IDs and duplicate results cannot. This
implementation pins routing, models and tools; validated generation overrides follow the
[continuation-setting contract](#steering-settings-public-api-and-diagnostic-probe). A failed steer does not
cancel an explicit continuation already dispatched. Explicit continuations
are paced and recheck the captured dispatch guard after waiting. No tools, accepted input
or ambiguously delivered sends are automatically replayed.

`src/server/responses/native-steering-replay.ts` journals only committed native input into
the existing thread-scoped replay cache. Rejected/uncommitted steer text is excluded. Sparse
terminal outputs are reconstructed from completed output-item events. Derived state inherits
the original non-persistable-body restriction from `src/responses/state/body-policy.ts`;
`state.ts` keeps its existing public exports. The original request is never mutated. The
bounded journal is discarded at teardown. Prefix arrays are appended iteratively, so a
byte-valid history cannot overflow the runtime's positional-argument stack. This keeps subsequent ordinary delta-input turns
working without inventing IDs or silently dropping the steering instruction.

Native chains bypass single-response SSE repair/terminal truncation. Wire IDs, lane IDs and
control events are preserved. A single bounded reader owns delivery; client cancellation,
account invalidation and shutdown abort its upstream. Numeric usage is summed once per
response; steering control frames (which can contain returned user input) are not log samples.

Bounds: 32 outstanding submissions, 128 response IDs per chain, 32 MiB replay journal
with a 128 MiB aggregate pinned-journal ceiling independent of the configured budget,
the configured inbound and upstream body ceilings, and the shared application-owned memory budget,
256 KiB / 1,024 required-input stubs, existing WS frame/queue byte limits, a 90-second control
wait, and a 30-minute saved-tool-result wait. Ordinary active-response silence uses the
configured stall deadline. Unsupported routes return explicit errors rather than discarding
steers. Unknown or mismatched protocol identities fail closed without replay.

The regression fixture is derived from the pinned OpenAI Python SDK response-steering
schemas at commit `98e1d24f4902ab58830adf0e2b6a729a5d5429b1`; it is not a live Astra
compatibility certification. End-to-end live client/backend verification remains required
before promoting this experimental option to a default.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.


## Experimental native function-result injection

`codexNativeInjection` is a separate, default-off opt-in on the Responses WebSocket
ingress. An initial request must explicitly set `multi_agent.enabled: true`. The
canonical ChatGPT forward route remains experimental; public API injection requires
the exact `https://api.openai.com/v1` provider, non-forward authentication and
`upstreamWebsocket: true`. Only that public route adds `responses_multi_agent=v1`
to the outgoing beta header. No client/model capability or subscription entitlement
is inferred. Translated, Combo, sidecar, plaintext-restoration and HTTP-fallback
paths cannot receive controls. The common interface lives in
`src/server/responses/native-response-control.ts`; it shares transport ownership,
not protocol semantics, with steering. Mode selection excludes multi-agent turns from
steering even when injection is disabled. An explicit new turn after completion can
select another mode through ordinary dispatch; no queued work or acceptance is invented.

`src/server/responses/native-injection.ts` retains the normally selected credential
and private socket. `src/server/responses/native-injection-protocol.ts` validates
only string-valued developer `function_call_output` items for completed calls
advertised by that response and lane. IDs are never global lookup keys. One physical
injection awaits acknowledgement at a time because success carries a response ID,
not an injection ID; further submissions remain in a bounded FIFO.
The configured upstream body limit is checked before a result reserves calls or
enters the queue, including while another result awaits acknowledgement. A size
refusal leaves the original socket and outstanding result usable for a corrected submission.
Repeated call results, mismatched/repeated acknowledgements and unsupported shapes fail closed. On
non-forward routes, native events also enforce the current request's explicit tool
catalog before advertising or relaying a client-executed call.

A response terminal is relayed immediately, but pending acknowledgements and
unreturned advertised calls retain the socket. Late tool results still reach that
socket. A `response_already_completed` failure is relayed unchanged, including its
returned input; only an explicit same-parent/lane/settings client create can supply
those saved outputs once. The existing continuation pacing and captured dispatch
guard run again. The proxy never reruns tools, invents acceptance, switches accounts
or automatically creates a recovery response. Unknown delivery terminates without
HTTP fallback or replay. The client decides how to recover other failures.

`src/server/responses/native-injection-replay.ts` commits accepted outputs only,
after all acknowledgements settle, inserting results after their owning calls and
preserving the original non-persistable-body policy. Failed inputs do not enter
continuation history. The existing numeric usage observer excludes inject events,
including echoed failed tool outputs, from log samples. All private bodies and
timers are disposed on teardown.

Limits: 32 pending submissions including the on-wire frame, 8 MiB queued frame
bytes, 1,024 function identities / 256 KiB identity bytes, 128 response IDs and a
32 MiB replay journal. An on-wire injection has an absolute 90-second acknowledgement
deadline independent of incoming output; saved-tool-result waits use 30 minutes.
Existing socket/SSE frame limits and the active-response stall deadline also apply.
`tests/responses/ws-native-injection.test.ts` exercises the real handler, captured
auth, dispatch, relay, replay and synthetic failure paths. It is not live backend
or Codex App/CLI compatibility certification.


### Rich saved-result continuations and server-owned output

`src/server/responses/native-tool-results.ts` validates the wider **continuation**
contract: function/custom results accept strings or bounded arrays of `input_text`,
`input_image` and `input_file`; MCP approval responses require an explicit boolean.
Absent and explicit direct callers compare alike; program callers must match the
server-advertised origin. Call and approval namespaces are distinct. Type, call,
item, caller and agent provenance remain bound to this connection. Hosted calls
never advertise client-owned result slots. References are forwarded, not fetched,
uploaded, interpreted as local paths, flattened or split into separate requests.
Result contents compare structurally with array order preserved. The parser
allows documented detail/cache-breakpoint fields; unknown shapes are refused.

Only an explicit same-parent/lane/settings `response.create` after the terminal
can return all remaining saved results and approval decisions, once. An early
same-parent create cannot cancel into normal dispatch. Missing decisions never
become approval; rejected and accepted results remain distinguishable. Rich,
custom and approval **inject** frames still fail before physical send: a general
Responses input shape is not evidence that a beta injection operation accepts it.
The existing count, byte, acknowledgement and account-ownership limits remain.

`src/server/responses/native-response-output.ts` reconciles completed wire items
with sparse terminal output without losing hosted calls, their results, encrypted
agent messages or provenance. Shared IDs must preserve content and relative order;
a contradiction fails rather than silently choosing one transcript. Continuation
bodies are copied before retention; accepted results alone enter replay history.
The wire relay does not synthesize or modify server-owned events or approvals.
`tests/responses/ws-native-result-continuations.test.ts` covers those contracts,
including false approval decisions, typed identity, content order, unsupported
injection batches, sparse terminals and explicit mode transitions. No test asserts
that a live subscription backend accepts these optional execution modes.

### Steering deadlines and replay completeness

`src/server/responses/native-steering.ts` uses monotonic, per-submission 90-second
acknowledgement deadlines. Accepting or rejecting a steer removes only that
submission's deadline; later steers or unrelated output never extend another
submission's time. Accepted input can wait for a safe boundary while the active
response retains ordinary sliding idle liveness. At a parent terminal, outstanding
steering gets a fixed 90-second successor deadline. The first valid
`waiting_for_required_input` notification replaces that parent's successor wait
with a 30-minute tool/approval deadline; repeated notifications cannot restart it.
An explicit saved-result continuation starts a fresh 90-second successor bound
at local submission, including any existing pacing/auth wait. Late pending events
or a rejected steer cannot extend or cancel that in-flight continuation's bound.
Unacknowledged steers retain their own earlier deadlines during these phase changes.

One unrefed timer tracks the earliest deadline. A late control or response event
cannot rescue an expired deadline before the timer callback runs. Expiry settles
once, clears retained replay bodies and follows the existing connection-failure
path. It reports unknown delivery, not a synthesized rejection or success, and
never resends instructions/results, reruns a tool or chooses another account.
Normal completion and detach cancel the timer. Defaults and frame/count limits
remain unchanged; no capability or execution-mode allowance is added.

`src/server/responses/native-steering-replay.ts` uses the same
`src/server/responses/native-response-output.ts` reconciliation as injection
replay: retain completed wire items omitted by a sparse terminal, match shared
identities by content and relative order, and reject contradictions before calling
the continuation-cache writer. This affects local replay, not the original wire
terminal. Completed parents can be remembered; failed/incomplete parent output
stays private until a validated successor commits the prefix. Merged output is
charged against the unchanged 32 MiB serialized history budget. The existing
body-persistence eligibility and accepted-only steering commit rules still apply.
`tests/responses/ws-steering-stability.test.ts` binds these deadline and replay
contracts to deterministic clocks and a synthetic real-handler continuation test.
`src/server/responses/native-response-json.ts` owns content comparison without
importing either control owner, keeping the replay dependency graph acyclic.
Injection retains its existing helper export names and comparison semantics.

## Steering settings, public API and diagnostic probe

`native-steering-settings.ts` validates a bounded allowlist for explicit saved-result
continuations: `reasoning`, `text` (including structured-output format),
`stream_options` and a validated `max_output_tokens` field. Unknown/malformed overrides
fail before result reservation. Null resets the supplied setting; omission keeps
the current authorized wire value. Models, tools, instructions, account, lane,
service tier, execution mode and other settings remain pinned. The schema uses
`REASONING_SUMMARY_DELIVERY_VALUES`, not a second invented enum.

`native-steering-policy.ts` reuses normal selector pins, subagent caps, native
clamps, provider effort mapping, empty-ladder handling and summary/verbosity
capabilities on private generation-only data. Subscription output-token overrides
are explicitly refused. `codex-ws-exchange.ts` overlays normalized keys on the
current wire base, retaining new values across later explicit continuations.
Normal pacing and captured account/dispatch guards still run before physical send.
No tool results are transformed by generation normalization or rerun on rejection.

Steering is restricted to the canonical ChatGPT forward route. In particular, an
API-key Responses WebSocket cannot retain a steering channel because its successor
generations do not pass through ordinary per-request send and spend admission. Public
API WebSockets remain available for multi-agent injection. Initial mode selection explains disabled,
multi-agent, conversation-bound and automatic-compaction exclusions without breaking
ordinary creates or inventing model entitlement. HTTP fallback remains non-steerable.

`scripts/steering-probe.ts` and `scripts/steering-smoke.ts` provide a bounded,
content-free direct/proxy wire check. Default operation is plan-only; `--self-test`
is offline. Live runs require both consent flags and distinct explicit environment
credentials. Destinations are canonical upstream plus loopback, with no URL secrets,
query or fragments. The script never discovers stored credentials, modifies config,
executes tools/approvals, retries sends, or logs payloads/IDs. It checks acceptance,
successor creation and a synthetic result marker separately; an unobserved required-
input path is `not_exercised`, not pass. The live run uses at most four initial
synthetic requests plus resulting continuations, each bounded to 120 seconds,
5,000 events and 2 MiB received bytes. It can consume model usage and is not a
Codex App/CLI UI certification. The fixture suite also exercises real loopback sockets.

`tests/responses/ws-steering-completion.test.ts` and `ws-steering-smoke.test.ts`
cover effective wire settings, immutable-route refusals, policy preservation,
independent API credentials, unavailable-mode diagnostics and safe probe outcomes.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

WebSocket [compaction routing selection](responses-failover.md#compaction-routing-overrides) uses per-frame metadata; handshake metadata cannot supply a later frame's trigger.
