# Design record — commit boundary, liveness, abort

## Invariants that stay

- I1 No HTTP SSE fallback once `ws.send()` has returned (`sent === true`).
- I2 One `response.create` frame per exchange; no proxy-internal resend after send.
- I3 A refused create (`type: error`, no `stream_id`, 4xx status) before any response event is
  projected as that 4xx with the metadata snapshot (#3740); correlation runs first.
- I4 After the first `response.*` or `error` event has been relayed, every later failure is a
  body error on the already-committed 200 (the relay synthesizes `response.failed`).

## New invariant

- I5 (exchanges with a metadata channel, i.e. the canonical Codex backend) The client commit never
  precedes the upstream acknowledgment. Before the first
  `response.*`/`error` event the exchange holds no client Response. A failure in that window
  settles as a JSON error with an honest gateway status, marked non-replayable.

## Diff-level plan

### `src/lib/upstream-retry.ts`

Add a `WeakSet<Response>` with `markResponseNonReplayable(res)` and
`isNonReplayableResponse(res)`. In `fetchWithTransientRetry` the loop guard becomes
`if (res.ok || !isTransientUpstreamStatus(res.status) || isNonReplayableResponse(res)) return res;`.
Rationale in the doc comment: the origin may already be executing the request (RFC 9110 §9.2.2),
so a gateway status from a post-send transport is returned to the caller for its own policy.

### `src/server/responses/codex-ws-wire.ts`

- `CODEX_WS_LIVENESS_PING_INTERVAL_MS = 15_000`.
- `CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS` keeps its value (90 000) and gains a new meaning in its
  comment: the longest inbound silence (no message frame, no pong) tolerated before the first
  response event.
- `codexWsPreResponseFailure(status, message, prelude: Headers): Response` — builds
  `{ error: { type: "upstream_error", code, message } }` with `content-type: application/json`,
  `cache-control: no-store`, the metadata snapshot headers, and calls
  `markResponseNonReplayable`. `code` is `upstream_timeout` for 504 and
  `upstream_closed_before_response` for 502.
- `CodexWsFailureStage` gains `pings` and `pongs`; `codexWsFailureDetail` appends
  ` pings=N pongs=N` inside the bracket, after `elapsed`. `tests/responses/ws-failure-stage.test.ts`
  is updated in the same commit.

### `src/server/responses/codex-ws-exchange.ts`

- `failStream(error, status: 502 | 504 = 502)`: when `sent && !responseCommitted`, resolve
  `codexWsPreResponseFailure(status, message, metadata.snapshot())` instead of committing a 200,
  close the controller, dispose the session. When committed, unchanged.
- `cancelExchange(reason)` when `sent && !responseCommitted`: mark terminal, cleanup, dispose the
  session (this closes the socket, which is the upstream cancel), `reject(reason)`. The caller's
  own abort is never retried by the wrappers (`isConnectionResetError` excludes AbortError and the
  retry loops check `abortSignal.aborted`).
- Liveness replaces the single `preludeTimer`:
  - `armSilence()` (re)starts a `CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS` timer whose expiry calls
    `failStream("codex websocket response prelude timed out" + detail, 504)`.
  - `onMessage` and `onPong` call `armSilence()` while `!responseCommitted`.
  - After send, when `typeof ws.ping === "function"`, a repeating
    `CODEX_WS_LIVENESS_PING_INTERVAL_MS` timer calls `ws.ping()` until commit or terminal; a
    throwing `ping()` stops the pinger only.
  - `cleanup()` clears both timers and removes the `pong` listener; `commitResponse()` clears
    them too.
- The non-metadata path (`if (!metadata) commitResponse()`) is unchanged.

### Tests (`tests/responses/ws-upstream.test.ts`)

Updated oracles: prelude overflow → 502 JSON, not a WS-marked stream; first-response deadline
through `fetchWithTransientRetry` → 504, one send, zero HTTP; foreign-stream identity mismatch →
502; close 1006 / 1009 before any response event → 502 carrying the same messages; abort after send
before commit → the pending fetch rejects with the caller reason and the socket is closed.

New cases: a pong resets the silence clock past 90 s and the response still completes with one
send; a socket exposing `ping` is pinged every 15 s of prelude and stops after commit; a socket
without `ping` is never pinged and keeps the 90 s bound; `fetchWithTransientRetry` returns a
non-replayable 504 without a second call (`tests/lib/upstream-retry.test.ts`).

## Audit amendments

See `025_audit_round1.md`; its deltas override this file where they differ.

## Risks and their answers

- Client behaviour on 504: Codex retries stream requests on 5xx with backoff, which is the same
  policy it applies on the direct path; the proxy no longer substitutes its own.
- Pool recovery on 5xx: `shouldRetryCodexPoolAccountQuota` rotates only on body-confirmed quota
  evidence; the new body carries none. Opaque-blob recovery excludes 5xx other than 502 with an
  encrypted-output body, which this is not.
- Backend pong support unknown: feature-detected and degrades to the current bound.
- Request log: the failure is now a 504/502 row instead of a 200 with `streamAborted`; this is
  the intended diagnostic change.

## Verification

NOT RUN locally by rule. Remote CI on the final head is the only executable proof; the read-only
grok-4.6 review of the diff is the second pair of eyes.

