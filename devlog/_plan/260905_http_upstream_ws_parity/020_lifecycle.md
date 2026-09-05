# Bounded canonical upstream connection reuse

Depends on: protocol cycle and its verified request/metadata owner. P must re-read this document and current source after that PR lands.

## Landed-source refresh and loop specification

Protocol PR3643 is landed; this phase starts from published `bf58ef1824e7b827b2a6bc1a5effb5d36ce80180`. Class C4, spec-satisfaction loop. Goal: eligible full HTTP requests reuse a canonical upstream socket without mixing exchanges. No-code/configuration cannot provide reuse because the existing transport unconditionally closes every terminal; unrelated provider pools speak different protocols. Reuse the existing exchange implementation, not a second relay. Keep frontend transport, native identity, full histories, admission/pacing, and installation unchanged.

Resource scope: main implementation/audits under the user's no-other-task-communication instruction; no model override, new dependency, provider call or local full suite. Use disposable remote focused tests, typecheck and real loopback HTTP/WS QA plus full current-head CI. Initial wall-clock audit horizon is six hours from the explicit follow-up request. Evidence lives in this unit and the bound goalplan. A main audit is labelled as such; automatic PR review is a separate source. Prior immediate-admin permission closed PR3643 without waiting; it is not a green CI result for this new change.

Source refresh adds a load-bearing requirement: `beforeDispatch` now guards credentials both before dialing and immediately before each frame. Reuse must call the fresh request's guard, including on a warm socket, and a refusal cannot enter HTTP fallback. Existing exports and Response markers remain compatible. The verified protocol command selects WS, account-attribution, metadata-integrity, reframing, cancellation and core/Lab tests; new lifecycle coverage gets an explicitly registered test file. Positive/negative activation evidence below, not a count alone, closes this phase.

## File-change map

| Operation | Path | Exact change |
| --- | --- | --- |
| NEW | `src/server/responses/codex-ws-session.ts` | Own one WS connection, exclusive in-flight exchange, per-exchange listeners, bounded queue, and terminal/cancel cleanup. Extract the existing one-shot state machine rather than duplicating it. |
| NEW | `src/server/responses/codex-ws-exchange.ts` | Extract the existing single-request relay/metadata/fallback state machine; both retained and one-shot sessions call this exact owner. |
| NEW | `src/server/responses/codex-ws-wire.ts` | Own unchanged frame limits, event normalization and Response markers; facade re-exports preserve existing callers without a circular import. |
| NEW | `src/server/responses/codex-ws-correlation.ts` | Per-exchange response/item correlation for retained sessions; a first incompatible exchange remains one-shot, reused incompatible traffic fails closed. |
| NEW | `src/server/responses/codex-ws-pool.ts` | Own bounded idle sessions, canonical eligibility/keying, idle/max-age expiry, admission fallback and shutdown registration. No configuration/auth-store imports. |
| MODIFY | `src/server/responses/codex-ws-request.ts` | Project genuine turn-state/turn-metadata headers into absent per-frame metadata slots before final serialization and byte-cap checks; identity consumes that exact prepared frame. |
| MODIFY | `src/server/responses/ws-upstream.ts` | Keep the existing public entrypoint as compatibility facade; acquire an eligible idle canonical session or use the existing one-shot behavior, then send the prepared full frame. |
| MODIFY | `src/server/responses/fetch-helpers.ts` | Supply the final request and explicit context needed for pool ownership without changing provider pacing or HTTP-version/redirect fallback. |
| MODIFY | `src/server/index.ts` / existing shutdown composition if needed | Register/dispose the pool through the existing core-owned shutdown seam; no suspended startup or Lab import. |
| MODIFY | transport, auth-metadata, shutdown and boundary tests | Add lifecycle contract fixtures; retain all original one-shot/fallback tests. Register newly necessary test files in both test-layout manifests. |
| MODIFY | transport SoT and English reference | State eligibility, caps, fallback, and full-history HTTP behavior. No new home-config key is required. |

## Session API and state machine

`CodexWsSession` owns its socket and exposes a small exchange/dispose interface. State is `connecting -> idle -> active -> idle` on success, and `* -> closed` on abort/error/expiry/shutdown. Exactly one active exchange may own a socket. Global WS event listeners route only to that active owner; late frames cannot enter a successor exchange before terminal settlement.

Before/after behavior:

```ts
// before: every request constructs WebSocket, every terminal closes it
new WebSocket(wsUrl, { headers });
// after: canonical eligible request borrows a matching idle session
const identity = codexWsReuseIdentity(url, prepared.headers, prepared.frameText);
const lease = identity ? pool.acquire(identity) : null;
return lease
  ? lease.exchange(prepared, init.signal, metadataOwner)
  : oneShotExchange(prepared, init.signal, metadataOwner);
```

Keep the actual declaration shaped to existing Bun/Web types; no dependency or framework is added. The pool/session pair is internal functional coupling, not a new public package API.

## Identity and eligibility contract

### Source comparison amendment (2026-09-05)

Reference checkout: `openai/codex` at `d2d5b70241fb448044c1c088a977cc720d70443a`.
`core/src/client.rs:1358` checks unchanged request properties and an exact input
prefix before deriving an incremental payload; `:1893` pairs that payload with
the actual previous response id. `codex-api/src/endpoint/responses_websocket.rs:299`
holds an exclusive stream lock and `:826` finishes the serial read on completion.
This patch implements socket reuse, not that input-delta algorithm.

The [official WebSocket guide](https://developers.openai.com/api/docs/guides/websocket-mode)
describes connection-local continuation caches, optional named lanes, and full-input
recovery after cache loss. It documents the public API, not a guarantee for the
ChatGPT backend's private beta protocol. Our conservative subset is serial,
default-lane, complete-input creates. Non-null `previous_response_id`, explicit
`stream_id`, `generate`, or active background mode do not enter this pool. Their
existing one-shot behavior is unchanged; this is not new continuation support.
No steering or cross-lane fork is emitted. A named-lane frame cannot qualify a
connection for reuse. Earlier five-minute/32-exchange retirement is a local resource
policy, not an OpenAI limit, and never discards a continuation id invented by us.

Remaining validation before readiness: real backend compatibility is not proven
by public docs or mocks; rotating immutable handshake headers may prevent reuse.
No billing/quota causation claim follows from this work.

Reuse is canonical-URL-only and requires usable selected outbound auth/account identity plus explicit thread and turn identities. Missing either identity stays one-shot, so unrelated native turns cannot share a session. A mere model slug or account log label is not a reuse key.

Compute an in-memory nonlogged digest of the selected credential/account, conversation/turn scope, actual model/tier, and immutable handshake policy. No raw credential, account id or prompt is emitted in logs, receipt data, exported diagnostics, or persisted cache. Different credentials, account, model/tier, originator/beta/attestation policy, or incompatible handshake headers must never reuse a socket.

Request-scoped fields that can vary on a reused socket are carried in their documented per-frame metadata slots. Do not ignore a changed handshake-only field just to improve the hit rate: reconnect instead. An unknown/custom canonical handshake header participates in identity unless its per-request mapping is proven. Account refresh/replacement therefore invalidates reuse naturally; old idle entries are evicted rather than used under the new token.

### Identity production and consumers

The lifecycle cycle adds the pure `CodexWsReuseIdentity = { key: string; scope: string }` value in `codex-ws-pool.ts`; it is NOT supplied by the protocol cycle's `PreparedCodexWsRequest`. `codexWsReuseIdentity(url, headers, frameText)` is invoked after final request preparation at the existing transport entrypoint, so every retry automatically uses the new selected auth headers. No call-site may inject a synthetic identity. Creation is this helper; serialization/persistence is N/A (process-local digest only); deserialization is the final outgoing JSON record; consumers are pool acquire/release/evict only.

Eligibility requires the exact canonical URL, nonempty Authorization and ChatGPT-Account-Id, a nonempty `client_metadata.thread_id` or `thread-id`, AND nonempty `client_metadata.turn_id`. If both thread values exist they must agree. `session_id`/`session-id` alone or parent-thread-only are insufficient because they may be shared by siblings. The required turn id limits initial reuse to one native turn; invalid/nonstring/control-bearing/over-4096-byte identity fields disable reuse. Body and header thread conflicts disable reuse rather than choose one. Selected auth header values, not inbound headers or `ProviderFetchOptions`, supply the credential identity. Thus native passthrough calls with usable identity may reuse; sidecars/helper calls without it and all noncanonical calls remain one-shot.

`scope` is a process-local HMAC of canonical URL + account + thread + required turn; `key` includes that scope plus the selected bearer, model/tier and sorted immutable handshake header name/value pairs. One random process key prevents durable identifier correlation; it is never logged. A changed key in the same scope evicts an old idle connection. In-flight old-scope connections finish/cancel under their original request owner and are not transferred.

Only `x-codex-turn-state` and `x-codex-turn-metadata` are removed from immutable-header comparison after their genuine value is copied into the documented same-name WS `client_metadata` slot when the body does not already contain that slot. The lifecycle amendment performs this inside `prepareCodexWsRequest` BEFORE final serialization and final-frame byte measurement; the identity helper consumes that exact prepared frame. Existing fuller body metadata wins those projections. Tests include a changing header-only turn-state and a metadata projection that moves the final frame from below to above the ceiling. Lite is already normalized per frame by phase 010 and remains in the handshake key conservatively; a Lite mode change may redial. All other headers, including originator, beta, selected account/bearer, attestation, x-client-request-id, session/thread/installation/window values and unknown custom headers, participate in the key. This intentionally sacrifices reuse on varying unknown headers rather than infer safety.

The initial implementation sends each complete HTTP request as a complete `response.create`. It does not trim input, retain prompt histories, forge previous ids, or attempt semantic equality of tool/output items. Existing HTTP continuation expansion remains the owner of that behavior.

## Bounds and lifecycle

- Hard cap: 32 retained canonical sessions; at most one active exchange per retained session. On a busy key, use a separately owned one-shot connection, not an unbounded waiter queue or concurrent send on that socket. Global turn admission remains authoritative.
- Idle TTL: 30 seconds. Maximum connection age: 5 minutes. Named constants live in the pool owner; fake-clock tests cross exact boundaries.
- Maximum successful exchanges per retained socket: 32, bounding remembered response ids. Expired or superseded active exchanges may finish but are retired at release; age expiry does not kill an in-flight generation merely to free capacity. Correlation ids are bounded to 4096 bytes and item tracking to 10000 items; no prompt/output history is retained.
- No timer before first activation. Expiry uses bounded owned timers with `unref` where available; every timer/listener is cleared on disposal. Register one shutdown hook on activation and detach when the pool is fully disposed.
- Evict oldest idle entries before retaining a new one. Never evict/steal a live exchange merely to make room; use the existing one-shot bounded path.
- Successful terminal closes the exchange stream and releases a reusable socket only after its bounded terminal frame is enqueued. Failed/incomplete/error outcomes are conservatively disposed, not reused.
- Request abort removes that exchange's listener, errors its body exactly once, closes its socket, and releases its ownership. A completed request's later abort must not close a session leased to a successor request.
- Per-exchange listeners and quota callbacks detach before release. Session-level listeners handle idle unsolicited data and physical closure only. Explicit pool shutdown settles active requests without HTTP fallback; unexpected pre-send upgrade failure retains the original fallback. Optional socket ref/unref hints do not replace deterministic cleanup.
- Closing/error sockets are removed immediately. Reconnect/retry is allowed only before a frame was accepted for send; once inference may have started, do not fall back to HTTP and double-generate. Keep existing send-throw/upgrade failure semantics only when the no-send condition is proven.
- Per-frame and per-exchange queue limits remain the existing limits. Connection reuse does not retain completed queues or prior output.
- Shutdown closes idle and active pool-owned sockets, settles all requests, and unregisters timers. It cannot import Lab, block synchronous startup, or make unrelated providers start a timer.

### Frame attribution and terminal ordering

Reuse relies on the native Responses WS protocol's sequential exchange ordering: one submitted create finishes before the next create is sent. This is the same upstream assumption used by the Rust serial consumer; it does not prove arbitrary post-terminal untagged frames belong to a successor. While idle, ANY unsolicited non-close frame immediately disposes the socket and cannot be stored as the next request's prelude.

After successor acquisition, Responses data cannot flow until its own `response.created` identifies its response id (a standalone error remains legal). Track current response id and the set of item ids declared by `response.output_item.added`; explicit mismatching response ids or deltas for unknown items fail closed and dispose the session rather than exposing stale output. A server that omits the identifiers needed for that correlation may be served one-shot but its connection is not retained for reuse. Record deterministic A-terminal -> idle-late-frame and A-terminal -> B-created -> A-item-delta tests.

Untagged quota events are account/connection snapshots, NOT response usage or turn billing. They may update only the unchanged selected account, in arrival order; they are never attributed as B's tokens/cost. Untagged response metadata follows the native ordered-exchange protocol: after B is sent, its prelude is preserved exactly as phase 010, including on a reused session. Do not reject or drop a legitimate native prelude merely because the native protocol lacks an id on that control frame. Same account, credential, thread and turn are mandatory; different turn id reconnects. Explicitly tagged old-response frames are rejected, and any idle unsolicited frame disposes the session. The server-ordering assumption is not promoted into an ability to identify arbitrary malicious untagged replay.

This is an explicitly scoped compatibility guarantee, not enforcement against a malicious server replaying an indistinguishable valid frame. Tier E7 evidence is the reference serial protocol plus deterministic fixtures; residual untagged-provider-ordering risk is documented, and the final layer is none beyond protocol compliance. The trusted canonical upstream is already authoritative for all content/metadata within that exact account/thread/turn; reuse does not cross that authority. Creating a production failure for every normal untagged native prelude would be test-induced defense against an indistinguishable hypothetical violation and would break the requested compatibility. No monetary correctness claim follows from reuse.

## Acceptance matrix

| Trigger | Required observation |
| --- | --- |
| Same eligible identity, sequential successful requests | one WS handshake, two separate frames/bodies and metadata owners |
| Different account or token generation, same client thread | distinct sockets; no event/metadata crosses owners |
| Different thread/turn/model/tier/handshake policy | no reuse |
| Missing identity or noncanonical opt-in provider | existing one-shot path and no native pool entry |
| Concurrent requests with same key | no interleaved frames; bounded one-shot or explicit existing admission outcome |
| Old request signal aborts after its success and successor acquisition | successor remains alive |
| Active request aborts, closes, or overflows | one error terminal, socket disposed, no fallback resend |
| Initial upgrade fails before send | existing HTTP fallback once, with correct final request headers/body |
| Idle TTL/max age/cap crossed | expired/evicted idle socket closes and next request redials |
| Shutdown while idle and while active | all sockets/timers/listeners released; no hanging request |
| Changed provider pacing or explicit HTTP version | original pacing count and fallback protocol pin preserved |
| Full HTTP ingress -> canonical fake WS -> client stream | headers, Lite metadata, usage, tool continuation and cancellation observed end-to-end |

Security analysis and negative-case reasoning are maintained in ignored scratch. The independent reviewer must inspect the identity-key construction and the stale-abort race before approval. No test expectation is computed by the same identity/mapping helper it verifies.

## Delivery

Run the focused transport and integration suite, typecheck, privacy/secret checks,
and exact-head CI. Main audits obey the user's no-other-task-communication boundary;
do not represent them as independent security review. Publish with `--no-verify`
as a draft PR targeting dev while verification or review remains outstanding.
The subsequent owner instruction authorizes real selected-account verification
and merging after the remaining checks. Preserve the earlier PR-only publication
record as history, not a current merge prohibition. Start live checks with at most
24 creates, 512 requested output tokens each, concurrency at most two, and a
60-minute diagnostic horizon. Use a separate local process and read-only selected
credentials; no refresh, persisted credentials, secret logs or live proxy changes.
Keep required CI/review evidence truthful and prove fetched merge ancestry.
No production service restart or link occurs.

The independent A-B-A review trace was disproven in an ignored exact-head probe:
return-null cannot fall through to entry replacement. Add permanent facade
coverage to guard that intended retirement behavior; do not change correct pool
ownership merely to satisfy the proposed explanation.

Live backend validation also exposed pretty-printed error frames: the existing
relay prefixed only the first physical JSON line with SSE `data:`, so ordinary
SSE readers could not parse the error. Normalize physical CR/LF JSON formatting
inside the existing wire owner before SSE framing, preserving the parsed fields
and all size limits. Cover both errors and completed responses; compact native
frames remain byte-preserved. This is an observed wire fix, not an inferred
quota-accounting change.
