# 010 — design: `retryOn429` same-target wait-and-retry

의존: `000_research.md`

## Goal

Provider-level opt-in knob: on HTTP 429, wait (upstream `Retry-After` or a fixed interval)
and replay the identical request on the same key, up to `attempts` extra times, before the
existing multi-key failover runs. Default off → zero behavior change for existing setups.

## Surface

```jsonc
// ~/.opencodex/config.json → providers.<name>
"retryOn429": {
  "enabled": true,            // object presence also enables; false disables
  "attempts": 3,              // extra replays after the first 429 (1..20)
  "intervalMs": 5000,         // fixed wait when no usable Retry-After
  "maxIntervalMs": 60000,     // cap for any single wait
  "respectRetryAfter": true   // prefer the upstream Retry-After when parseable
}
```

## Implementation

- `src/types.ts`: `RateLimitRetryPolicy` interface + `OcxProviderConfig.retryOn429`.
- `src/config.ts`: zod schema entry (zod's default strip inside the object — an unknown key is
  dropped, never a config-rejecting error; the outer provider schema stays passthrough).
  Load-time degradation: one hand-edited invalid optional field (e.g. `attempts: 0`) is dropped
  with a warning instead of tripping the whole schema and hiding all providers behind a default
  config; misnamed keys (e.g. `attempt`) are warned about too; the management write boundary
  still rejects invalid policies.
- `src/providers/key-failover.ts`: `rateLimitRetryPolicyFor` (normalize/default) and
  `rateLimitRetryDelayMs` (Retry-After seconds/HTTP-date → capped, else `intervalMs`),
  reusing the existing `parseRetryAfterMs` cooldown parser; the fixed fallback is capped at
  `maxIntervalMs` too, so a single wait never exceeds the cap. Fail closed: only `authMode:
  "key"` (or the documented omitted default for custom API-key providers) may use replays —
  OAuth/forward are never replayed on the same token, local runtimes have no remote key to
  preserve, and unknown values are rejected. `providerConfigSeed` preserves the registry auth
  kind (including `"local"`) so the gate survives the seed round-trip.
- `src/usage/log.ts`: new `AttemptRecoveryKind` member `"rate-limit-429"`.
- `src/server/responses/core.ts`: in the pre-stream recovery loop, BEFORE the multi-key
  failover `while`, wait then `rebuildAndRefetch("rate-limit-429")`. Abort during the wait
  cancels the client request (the unread 429 body is released first). The retry budget lives
  OUTSIDE the recovery loop, so a 413/401 replay that comes back 429 cannot re-arm a fresh
  budget — bounded to `attempts` per request. After attempts are exhausted the existing
  failover and error mapping run unchanged. The same wait-and-replay applies to the other
  key-auth surfaces that bypass that loop:
  - Responses passthrough wire (`openai-responses` key-auth gateways, e.g. the built-in
    DeepSeek preset) — pre-relay, before the forward-pool logic;
  - image/video bridge and web-search sidecar loops (`src/images/loop.ts`,
    `src/web-search/loop.ts`) — before their `on429` key rotation;
  - Anthropic terminal-guard continuations — before key/account failover.
  Bridge retries apply to HTTP adapters only: a custom transport that enters the
  `adapter.runTurn` branch (`src/images/loop.ts`) returns before the HTTP 429 retry loop and
  therefore does not receive the wait-and-replay policy.
  Every surface releases (and awaits the cancellation of) the unread 429 body BEFORE the
  backoff, records the `rate-limit-429` recovery kind on replay sends, and (bridges) clears the
  old response-header deadline before the wait and starts a fresh one afterward, re-checking
  client cancellation before telemetry and replay.
  Covers Responses, chat completions, and routed Claude messages (they all enter
  `handleResponses`).

## Safety

- Pre-stream only: a 429 arrives before any bytes are relayed, so replaying the string-body
  request is lossless (same invariant as the transient-5xx layer in `lib/upstream-retry.ts`).
- Ordering: same-key retries run before failover, so "primary-first" users keep their key on
  rate-limit blips; failover still works after retries exhaust.
- Retry-wait bound: the SLEEP component is at most `attempts × maxIntervalMs` (default
  3 × 60 s = 180 s) when honoring upstream `Retry-After`; `attempts × intervalMs`
  (default 15 s) when `respectRetryAfter=false` or no header is present. Total request
  latency is higher: every attempt also consumes its own connect/response time (bounded by
  `connectTimeoutMs`), so the documented bound covers deliberate waits only.
- Identical replay: rebuilds are deterministic for the same parsed request (same serialized
  body and auth headers); the passthrough/continuation/e2e tests assert byte-identical bodies
  and identical auth headers across replays, not just send counts.
- Abort during the wait: the sleep is abort-aware — when the server observes the client
  disconnect (Bun propagates this asynchronously, observed 1–10 s), the wait is interrupted,
  the unread 429 body is released, and the request is cancelled with 499 before any replay.
  Because the propagation is async, a replay can still precede the cancel if the interval
  elapses first; that is bounded by the same `attempts` budget. Terminal continuations sleep
  on the upstream signal, so a body-cancel (SSE already streaming) aborts the wait too.
- Concurrency: each request honors its own policy independently — no process-wide cooldown is
  shared between concurrent requests (unlike the Kiro 429 pattern). Upstream volume per
  request: same-key replays add at most `attempts` sends, then multi-key failover adds up to
  `poolKeys − 1` more (or Anthropic account rotations), so the combined bound is
  `attempts + poolKeys` sends (pool size = configured `apiKeyPool` length, fixed per request) —
  a storm multiplies by that factor per request, not by `attempts + 1`.
- Header deadlines: the image/video and web-search bridge loops restart their response-header
  deadline after each deliberate wait, so backoffs never consume the connect budget and a
  rate-limit wait is never misattributed as a 504 header timeout. The old deadline is cleared
  BEFORE the sleep and client cancellation is re-checked after it, so 499 always wins over a
  stale-deadline edge.
- Expired `Retry-After`: a valid HTTP-date already in the past retries immediately (same as
  numeric `Retry-After: 0`) instead of falling back to the fixed interval.
- Recovery observability: every retry surface records the `rate-limit-429` recovery kind
  (normal loop, passthrough wire, image/video bridge, web-search sidecar, terminal
  continuations), so usage logs explain the extra sends.
- Final 429 still carries `Retry-After` for clients that honor it (Claude Code).

## Tests

- `tests/rate-limit-retry.test.ts` — policy normalization (incl. OAuth/forward gating) +
  delay computation (seconds, HTTP-date, `0`, malformed, cap; deterministic) + abort during
  the wait: a directly-invoked `handleResponses` with a controlled abort signal returns 499,
  cancels the unread 429 body, and performs no further upstream sends (deterministic — no
  real-socket disconnect timing involved).
- `tests/usage-log.test.ts` — the `rate-limit-429` recovery kind survives persisted usage logs.
- `tests/server-rate-limit-retry-e2e.test.ts` — single-key replay to success, immediate
  passthrough without the knob, exhausted attempts surface 429, and retry-before-failover
  ordering with a 2-key pool, plus key-auth `openai-responses` passthrough replaying 429 on
  the same key.
- `tests/terminal-guard-server.test.ts` — an Anthropic terminal-guard continuation that 429s
  is replayed on the same key before the error surfaces (3 upstream sends).
- `tests/images/loop.test.ts` + `tests/web-search.test.ts` — the bridge loops replay 429 on
  the same key before `on429` rotation runs (same-key sends counted, rotations zero).
