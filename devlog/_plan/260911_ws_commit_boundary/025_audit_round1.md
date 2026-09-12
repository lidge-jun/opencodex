# Audit round 1 — xai/grok-4.6 (read-only), dispositions

Verdict received: FAIL as written. Every finding below is dispositioned; the design record is
amended in place and the scope in 000 is widened to match.

| # | severity | finding | disposition |
|---|---|---|---|
| 1 | blocker | A marker honoured only by `fetchWithTransientRetry` leaves the Codex pool quota rotation (`shouldRetryCodexPoolAccountQuota`, core.ts:1120) and the combo 5xx hop (core.ts:3004 → `comboFailureDecision`) free to send again after `ws.send()`. | ACCEPTED. core.ts and src/combos/failover.ts enter scope minimally: (a) `shouldRetryCodexPoolAccountQuota` and `opaqueBlobRejectionBodyForRecovery` return early on `isNonReplayableResponse`; (b) the JSON body carries a structured `error.code` (`upstream_no_response`, `upstream_closed_before_response`) and `comboFailureDecision` returns `stop` for those codes, the same mechanism `origin_rejected` already uses. The code set lives in `src/lib/upstream-retry.ts` so combos need no server import. |
| 2 | major | Resetting the 90 s clock on quota/control frames removes the cap for a quota-only socket; it then runs to `connectTimeoutMs` (default 200 s) and settles as a `TimeoutError` 502 from `transportFailureResponse`, not the 504 the record promises. | ACCEPTED as a named behaviour change, with the status fixed. A socket that keeps sending frames or pongs is alive; the record now says so and names the quota-only case explicitly: it waits up to the operator's `connectTimeoutMs`, then the composite signal aborts with `TimeoutError`, and `cancelExchange` maps a pre-commit `TimeoutError` to the same non-replayable 504 instead of rejecting. Only a caller abort (AbortError) rejects. |
| 3 | major | Oracle list is short: metadata budget overflow rows (794), cumulative prelude bound (807), pre-response oversized frame (1064), and the `failureMessage()` helper cases in ws-failure-stage (171, 182, 208) all leave the 200 body-error shape. Foreign-stream 502 conflicts with the in-source note that a reused socket's foreign error must not become an HTTP refusal. | ACCEPTED. All listed tests are updated in wp2. The foreign-stream note was about a 4xx conversion that could authorize account replay; a non-replayable 502 authorizes nothing, and the test now asserts status 502, one send, zero fallback. The source comment is reworded to say that. |
| 4 | major | `failStream` rewrite could skip `cleanup()` and leak the pinger, silence timer, pong listener, or double-settle via `onClose`. | ACCEPTED. Order fixed in the record: `terminal = true; cleanup();` then settle, then `session.dispose()`. `cleanup()` and `commitResponse()` both clear the liveness timers and detach `pong`. |
| 5 | minor | I5 is stated globally while the no-metadata path commits at send. | ACCEPTED. I5 is scoped to exchanges with a metadata channel (the canonical Codex backend). |
| 6 | minor | `connectTimeoutMs` < 90 s makes a post-send abort a 502 connect timeout, not a 504. | ACCEPTED via finding 2: any pre-commit `TimeoutError` becomes the non-replayable 504. |
| 7 | minor | `docs-site/` paragraph on the fixed 90-second prelude deadline (reference/configuration/server.md:38-47) becomes wrong. | ACCEPTED. The paragraph is rewritten in wp3 to describe silence-based liveness and the honest status. |
| 8 | nit | Exact `codexWsFailureDetail` pin, `stage()` fixture defaults, fake-timer stepping for pong tests, feature-detect `ping` not pong. | ACCEPTED. `stage()` defaults `pings: 0, pongs: 0`; pinned strings updated; pong tests step the clock. |

Not accepted: none.

## Amended plan deltas (authoritative over 020 where they differ)

- Scope adds `src/server/responses/core.ts` (two early returns), `src/combos/failover.ts` (one
  structured-code stop), `docs-site/src/content/docs/reference/configuration/server.md` (one
  paragraph), `tests/responses/ws-failure-stage.test.ts`, `tests/combos/*` only if an existing
  decision table needs the new row.
- `cancelExchange(reason)` pre-commit: `reason?.name === "TimeoutError"` → non-replayable 504
  with `upstream_no_response`; anything else → `reject(reason)`.
- Liveness semantics: silence = no inbound message frame and no pong. Any inbound frame resets.
  Quota-only sockets are alive and wait for the client or `connectTimeoutMs`.

