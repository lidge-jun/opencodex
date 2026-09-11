# Streaming Health And WebSocket

## Heartbeat and stall deadline

The HTTP/SSE bridge emits an SSE comment-line keep-alive (`: opencodex heartbeat`) during upstream
silence to re-arm Codex's idle timer (Codex's default `stream_idle_timeout` is 300 s and ANY SSE
bytes re-arm it). A comment line is discarded by every eventsource parser without producing an event,
so strict Responses decoders never see an unknown variant. Those bridge-enqueued keepalive frames do
NOT count as activity for the bridge's own watchdog: a bounded stall deadline (default 300 s,
configurable via `stallTimeoutSec`, checked on the 2 s heartbeat tick) closes the stream with
`response.incomplete` / `upstream_stall_timeout` and cancels the upstream request if no real
adapter events arrive. Adapter-yielded `{ type: "heartbeat" }` events DO reset the watchdog.

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
returns the same downstream SSE contract. Its WSS route checks NO_PROXY first, then selects the
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

`ws-bridge.ts` preserves upstream `failed` and `incomplete` status values in the final WebSocket
frame rather than always emitting `response.completed`. If the response status is `failed`, a
`response.failed` frame is sent; otherwise `response.completed` carries through the original status.
