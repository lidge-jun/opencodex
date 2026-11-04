# Optional Codex Upload Reduction

## Incremental WebSocket continuation

`src/server/responses/codex-ws-incremental.ts` owns bounded, socket-local completed-prefix
state behind the default-off `codexWsIncrementalUpload` switch. The process flag lives in
`src/config/codex-ws-incremental-setting.ts`, so config loading never reaches the Responses
transport from a Child or Hub client; the transport subscribes to clear its state on disable.
It implies cross-turn reuse. Only the trusted admitted caller can seed or inherit a prefix;
unidentified callers do neither. Caller identity comes from admission, never the request body.
Ordinary canonical ChatGPT creates can send only newly
appended input and the acknowledged response ID when the envelope and full prefix match.
Provider-issued item IDs/status and empty reasoning content are normalized only for
comparison; ciphertext, call IDs, nonempty content and tool arguments remain exact.
Existing stateful lanes, native controls and warmup frames retain their own ownership.
Unknown, failed or incomplete completions cannot seed a future delta.
Before any response activity, an unambiguous `previous_response_not_found` refusal of a
proxy-synthesized delta permits one full-create resend from that request's retained frame.
Pacing, auth and cancellation are checked again; recovery requires a fresh shared send permit
and physical-send report. Exhaustion returns the original refusal. An oversized full frame disposes
the socket and uses the existing guarded HTTP path. Caller-supplied IDs, foreign response
identities, malformed status wrappers, committed output and unknown delivery never grant
this recovery. Only a completed recovered response can seed the next prefix.

The opt-in preserves an explicit HTTP provider proxy instead of dropping it on the WS
path; unsupported egress and custom executors retain HTTP fallback. A per-request ID
travels in message metadata instead of fragmenting socket identity. Socket/account,
credential, thread, proxy and rewritten-destination boundaries remain authoritative.
Idle retention is at most ten minutes, total age fifty minutes and exchanges 256;
comparison state is capped at 64 MiB per context and 128 MiB across contexts. Disabling
the feature clears comparison state. A cold oversized create uses existing HTTP/SSE;
the WS frame limit applies to the actual delta frame, not its omitted full reference.
Integration points: `src/server/responses/ws-upstream.ts` builds delta frames and owns the
oversized-create fallback; `src/server/responses/codex-ws-request.ts` carries the request ID;
`src/server/responses/codex-ws-exchange.ts` records dispatch and seeds completed prefixes;
`src/server/responses/codex-ws-session.ts` and `src/server/responses/codex-ws-pool.ts` hold
socket lifetime and retention limits;
`src/server/responses/fetch-helpers.ts` keeps the explicit-proxy WS path and history slimming;
`src/server/responses/codex-ws-send-accounting.ts` selects reporter ownership for recovery.

`src/server/management/system-routes.ts` exposes content-free send/reference byte counters.
They compare WS JSON frames with full JSON, not compressed HTTP or interface billing.
`tests/responses/codex-ws-incremental.test.ts` covers prefix changes, identity separation,
unknown completion, ciphertext changes, references and image-policy composition.
`tests/responses/codex-ws-cache-miss.test.ts` covers bounded cache-miss recovery and its
caller, admission, cancellation, output-commit and full-frame-size exclusions.
`tests/responses/codex-ws-pool-contention.test.ts` checks continuation across the old
idle/age deadlines and expiry at the bounded replacement deadlines. These are retention
limits, not upstream availability guarantees; peer closure still drops all socket state.

## Historical image and tool context

`src/server/responses/history-slim.ts` applies optional `upstreamHistorySlim: "codex"`
only to canonical native Codex outbound HTTP string bodies, before compression, and to
ordinary upstream WS creates when incremental upload is enabled. It leaves local replay
state unchanged. Before the latest user message, oversized inline images become text
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
same live registration (install and reconcile), never from a detached `loadConfig()` read such as `/api/sync`;
incremental upload implies socket reuse;
the [incremental transport contract](#incremental-websocket-continuation)
owns completed-state, retention limits, counters and fallback behavior.
