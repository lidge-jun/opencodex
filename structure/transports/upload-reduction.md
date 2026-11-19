# Optional Codex Upload Reduction

## Incremental WebSocket continuation

`src/server/responses/codex-ws-incremental.ts` owns bounded, socket-local completed-prefix
state behind the default-off `codexWsIncrementalUpload` switch. The process flag lives in
`src/config/codex-ws-incremental-setting.ts`, so config loading never reaches the Responses
transport from a Child or Hub client; the transport subscribes to clear its state on disable.
It implies cross-turn reuse for requests with a resolved data-plane caller principal.
Unidentified requests, including keyless loopback requests, use one-shot sockets and neither
send a delta nor retain a prefix. Caller identity comes from admission, never the request body.
Ordinary canonical ChatGPT creates can send only newly
appended input and the acknowledged response ID when the envelope and full prefix match.
Previously sent input items must match every field of the adapter-prepared input. Only
positions from acknowledged output use output-to-input normalization for provider-issued
item IDs, status, selected turn metadata and empty content fields. Ciphertext, call IDs,
nonempty content and tool arguments remain exact.
Existing stateful lanes, native controls and warmup frames retain their own ownership.
Unknown, failed or incomplete completions cannot seed a future delta.
Before any response activity, an unambiguous `previous_response_not_found` refusal of a
proxy-synthesized delta permits one full-create resend from that request's retained frame.
Pacing, auth and cancellation are checked again. At physical dispatch, recovery claims a slot
from the owning retry helper and a fresh shared send permit, which also claims the workflow send
ceiling (`#8149`). The permit makes a fresh spend reservation against the selected route's pool
and account. When the request tracker lacks an input estimate, the recovery permit prices the
resend from the prepared full create frame. A Combo with only an account ceiling must also
account for its dispatched delta before admitting the resend. This requires the selected account
and the delta's prepaid booking. The full-frame estimate also prices any unestimated delta input.
The replay guard records the full frame that left (`#8453`).
An unavailable input estimate or a refusal from the request, workflow or spend budget returns the original
refusal: the client sees `previous_response_not_found` for an ID the proxy synthesized, not a
budget error. The planner already forgot the socket's prefix, so the client's next ordinary
full-history request goes out as a full create. An oversized full frame disposes
the socket and uses the existing guarded HTTP path. Caller-supplied IDs, foreign response
identities, malformed status wrappers, replay-unsafe frames, committed output and unknown
delivery never grant this recovery. Only a completed recovered response can seed the next prefix.

Egress change: with the opt-in, a provider whose explicit egress is an HTTP proxy sends the
canonical Codex create over a WebSocket tunnelled through that proxy (CONNECT) instead of
downgrading to HTTP/SSE; without it, explicit egress keeps the HTTP downgrade and its one-time
warning. SOCKS and direct overrides, other egress and custom executors retain HTTP fallback. A per-request ID
travels in message metadata instead of fragmenting socket identity. The configured provider
route is part of both pool scope and reuse key, even when routes dial the same destination
with identical credentials. Caller, account, thread, proxy and rewritten destination also
partition reuse.
Idle retention is at most ten minutes, total age fifty minutes and 32 exchanges per socket
(the same bound as ordinary reuse);
comparison state is capped at 64 MiB per context and 128 MiB across contexts. Those caps
cover retained comparison keys only: each in-flight exchange also holds its full create text
for cache-miss recovery until it settles, outside the caps. That text is bounded by the inbound
body limit, not the WS frame limit, because only the delta has to fit a frame.
Disabling the feature clears comparison state.
The oversized-create shortcut is process-wide: while any socket holds a prefix
(`codexWsIncrementalHasRetainedState()`), an eligible oversized create from any caller or
thread acquires its socket and is planned first; if it is still oversized, that socket is
disposed and the request uses HTTP/SSE. A cold process sends it to HTTP/SSE directly. A cold oversized create uses existing HTTP/SSE;
the WS frame limit applies to the actual delta frame, not its omitted full reference.
Integration points: `src/server/responses/ws-upstream.ts` builds delta frames, owns the
oversized-create fallback, and estimates the prepared full create when recovery invokes its
admission callback; `src/server/responses/codex-ws-request.ts` carries the request ID;
`src/server/responses/codex-ws-exchange.ts` records dispatch and seeds completed prefixes;
`src/server/responses/codex-ws-session.ts` and `src/server/responses/codex-ws-pool.ts` hold
socket lifetime and retention limits;
`src/server/responses/fetch-helpers.ts` keeps the explicit-proxy WS path and history slimming;
`src/server/responses/codex-ws-send-accounting.ts` keeps observe-only combo bookings at the physical
receipt. The selected WebSocket executor captures recovery admission for a proxy delta.

`src/server/management/system-routes.ts` exposes content-free send/reference byte counters.
They compare WS JSON frames with full JSON, not compressed HTTP or interface billing.
`tests/responses/codex-ws-incremental.test.ts` covers prefix changes, one-shot sockets for
unidentified callers, named route separation, unknown completion, ciphertext changes,
references and image-policy composition.
`tests/responses/codex-ws-cache-miss.test.ts` covers bounded cache-miss recovery and its
caller, admission, cancellation, output-commit and full-frame-size exclusions.
`tests/responses/codex-ws-recovery-budget.test.ts` covers admission to the selected Combo
account's spend ceiling for a full resend.
`tests/responses/codex-ws-pool-contention.test.ts` checks continuation across the old
idle/age deadlines and expiry at the bounded replacement deadlines. These are retention
limits, not upstream availability guarantees; peer closure still drops all socket state.

## Cache-miss spend admission

The [Responses spend tracker](responses-spend.md#credential-hop-reservations) supplies the
admission captured by `src/lib/request-execution-budget.ts`. If the retry helper's reporter
owns the initial send, it settles the delta's deferred report before reserving a transient
permit and subtracts that early report from its ordinary send count. Observe-only Combo
sends settle the initial booking through the physical receipt. The helper's live allowance
includes deferred reports and credits only its own unsettled prepaid booking.

Recovery reserves a fresh seed for the selected pool and account when spend is enforced.
The seed keeps its own estimate and stays independent of other pending reservations.
The prepared full create supplies input pricing when the tracker lacks a positive estimate.
If Combo prepayment began before an identity-only ceiling could apply, recovery uses the
captured identity ceiling and the exact dispatched receipt. It books any missing delta
liability against that account before admitting the resend, retaining the prepaid output
allowance and original pool booking. It prices any previously unestimated delta input at
the full-frame estimate. A missing estimate or unavailable booking returns the original
cache-miss refusal. A successful reservation still needs both the retry helper's slot and
the physical permit at dispatch. The separate prepayment path for paced compact retries
continues to fund those retries before dispatch.

## Historical image and tool context

`src/server/responses/history-slim.ts` applies optional `upstreamHistorySlim: "codex"`
only to canonical native Codex outbound HTTP string bodies, before compression, and to
ordinary upstream WS creates when incremental upload is enabled. It leaves local replay
state unchanged. The native `/responses/compact` endpoint receives the full context.
Before the latest user message, oversized inline images become text
placeholders and oversized tool text keeps bounded head/tail excerpts. Current-turn
items, remote URLs and file references remain intact. This is a lossy context policy,
not an exactly-once image cache; its default is off. `tests/responses/upstream-history-slim.test.ts`
exercises current-turn retention, UTF-8 excerpts and destination/encoding gating.
Socket continuation follows the [incremental contract](#incremental-websocket-continuation).

## Configuration

`src/config/schema/config-schema.ts` declares the optional `upstreamHistorySlim` enum, which defaults to `off`; `codex` selects the explicitly
lossy outbound history policy described in [Responses transport](responses.md#responses-httpsse).
Invalid disk values disable the option; `src/config/diagnostics.ts` rejects them on candidate writes. The live state-store
registration in `src/lib/state-store-registrations.ts` binds the policy without editing retained conversation data.
`codexWsIncrementalUpload` and `codexWsReuseAcrossTurns` are default-off booleans bound only from that
same live registration (install and reconcile). A persisted change from `ocx config set` takes
effect after the server adopts the updated configuration or restarts. The client integration
route `/api/sync` uses a detached `loadConfig()` snapshot. Incremental upload implies socket reuse.
The [incremental transport contract](#incremental-websocket-continuation)
owns completed-state, retention limits, counters and fallback behavior.
