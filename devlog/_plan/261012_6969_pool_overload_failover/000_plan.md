# 6969 — pooled native Codex: retry and fail over on a pre-output upstream overload

Issue: [#6969](https://github.com/lidge-jun/opencodex/issues/6969). Base: `origin/dev` `dc45bb2ca9`.

## Symptom

Pooled native Codex requests to `gpt-6.1-sol` end after one send when the ChatGPT backend
declines before any output with `server_is_overloaded` (503) or `upstream_server_error` (502):
`sendCount: 1`, `recoveryKinds: []`, `failureStage: protocol-prelude`. The pool neither retries
the account nor moves to another one, so the Codex client reports "Selected model is at capacity".

## Field evidence (content-free stage fields only)

Aggregated from the reporter's own request log (status, error code, `codexWsStage` counters,
failure stage/cause; no bodies, headers or account identifiers), OpenCodex 2.83.0:

| Shape | Rows |
| --- | --- |
| WS, `relayedEvents: 3`, `controlFrames: 2`, `protocol-prelude`, 502 `upstream-fault` | 213 |
| WS, `relayedEvents: 1` (error is the first Responses event), 502 `upstream-fault` | 47 |
| WS, `relayedEvents: 3`, 503 `server_is_overloaded`, `upstream-declined` | 20 |

One further 502 `upstream-fault` row relayed 336 events (output had started) and is an outlier
kept out of the shapes above. Every row carries a `codexWsStage`, so every observed failure rode the
upstream WebSocket. The counters are consistent with `response.created`, `response.in_progress` and a
terminal `error` frame, but they count frames, not event types, and cannot prove which events those
were or that no hosted tool ran. They explain the failure; they authorize nothing — replay
eligibility is decided from the frames themselves at run time (010). Time from the first Responses event to that refusal, over the
281 authoritative refusals (`upstream-declined` and `upstream-fault`): 70% within 2 s, 97.5% within
5 s, 98.2% within 10 s, and no further gain up to 60 s.

## Why each path misses the existing recovery

The recovery already exists: `fetchWithTransientRetry` (`src/lib/upstream-retry.ts`) retries a
transient 5xx on the same account up to three sends with capped, jittered, abort-aware backoff
against the request's shared send budget, and the pool block in `passthrough-dispatch.ts` moves a
surviving `shouldRetryCodexPoolAccountTransient` 5xx to one alternate account
(`retryCodexPoolOnAlternateAccount`, guarded by fixed accounts, a spent stored-401 budget, uploaded
files, the account-failover permit and the pool recovery window). Both read the HTTP status.

- **WebSocket (all field rows).** `codexWsExchange` resolves a 200 SSE Response at the first
  non-control frame (`commitResponse`). `wrappedRejectionResponse` projects only a pre-commit
  **4xx** `error` frame into an HTTP status, by design ("unlike its native client, this relay
  converts only precommit 4xx"). So a 5xx `error` frame — first, or after an empty
  `response.created`/`response.in_progress` preamble — is relayed inside a committed 200 body. No
  retry layer sees a 5xx; the failure is only classified later from the SSE terminal.
- **HTTP status 5xx (HTTP SSE/JSON).** Handled: the same-account ladder runs, then the pool move.
- **HTTP SSE in-stream zero-output failure** (200 head, then `response.failed`/`error`). Not
  retried; direct passthrough returns headers before the first event. No field evidence; out of
  scope here and recorded as residual.
- **Compact (`/v1/responses/compact`).** `compact.ts` runs the same-account ladder on an HTTP 5xx,
  but its alternate-account move recognises only 429/402, so a 5xx that survives the ladder never
  moves accounts.

## What is deliberately not replayed

Ingwannu's triage separates an authoritative terminal refusal from socket death or silence after
the send. The latter are settled as non-replayable gateway statuses
(`codexWsPreResponseFailure`) because the origin may still be running the turn; only an operator
`retryOnReset` grant may replace them. That boundary does not move. A refusal frame is different
evidence: the origin itself terminated that response with a structured server status, and the
native Codex client treats the same wrapped frame as a terminal HTTP error even after
`response.created`. That is client-visible terminality, not a backend proof that nothing ran, so
010 replays only when every relayed event was an empty lifecycle frame and the terminal carries no
output — nothing the client could have seen or acted on.

## Unit map

- `010_plan.md` — the single implementation work-phase (wp1), diff level.

