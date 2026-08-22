# 002 — RCA: #1065 DeepSeek V4 Flash 502 on the bounded JSON path

Mechanism confirmed structurally; the live failure mode is the most likely
match for the reported timings.

## Mechanism

`readBoundedResponseBody` arms its 30s inactivity timer at reader creation
(`src/lib/bounded-body.ts:130-134`), before the first body byte. The timer
only resets after a non-empty chunk (`:192-196`). A thinking model that
flushes headers promptly but computes >30s before its first JSON byte is
indistinguishable from a stalled upstream → `truncated: true` →
`formatErrorResponse(502, …, "upstream JSON response stalled before
completing")` at `src/server/responses/core.ts:2229-2239`. Reported
durations (~30.5–31.3s) = headers RTT + the 30,000ms inactivity window,
and the correlation with high/max efforts fits longer pre-output thinking.

Every `deepseek-v4-flash` turn takes this path: the registry pins
`modelResponsesUpstreamStreaming: { "deepseek-v4-flash": false }`
(`src/providers/registry.ts:1157`, #875 terminal-event unreliability), and
`core.ts:866-887` forces `parsed.stream = false` upstream.

The comment at `core.ts:745-749` ("generation time before the response
headers is untouched") is false for chunked-encoding upstreams that flush
headers before generation completes.

## Chosen fix (decade doc 020)

Option (a): add `firstByteTimeoutMs?: number` to `BoundedBodyOptions`,
defaulting to `inactivityTimeoutMs` so all other callers are
behavior-identical. The bounded JSON call site passes
`firstByteTimeoutMs: UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS` (180s) — the
total cap still bounds a dead upstream, and 30s between-chunk protection
is preserved once bytes flow. Correct the stale comment.

Rejected: (b) per-provider override — config surface for a universal
truth; (c) restore upstream streaming — reverts the #875/#1026 rationale.

## Test plan

`tests/bounded-body.test.ts` covers empty-chunk non-reset, inactivity
expiry, total deadline — nothing covers a delayed first byte. Add four
cases: delayed-first-byte-then-success (red without the fix),
first-byte-never-arrives fail-closed, inter-chunk stall still times out,
and default-path equivalence for the 5s error-body callers.

## Absorption check

Nothing on origin/dev (last 30 commits) or in any open PR touches
`bounded-body` or this stall path. #947 is the Darwin SSE relay, a
different path. #1069 is unrelated ladder metadata.

## Supersession note (2026-08-07)

The "keep bounded JSON, do not restore streaming" disposition above is
superseded by `devlog/_fin/260807_deepseek_responses_streaming/`: fresh
upstream probes (2026-08-07, including the tool-result replay shape behind
#875) show DeepSeek's `/responses` stream closing on the documented
`response.completed` terminal, and the official guide states there is no
`data: [DONE]` sentinel — which the relay's terminal boundary already
synthesizes. The deepseek registry opt-in is removed; the
`firstByteTimeoutMs` bounded-body fix this RCA shipped remains valid and
still guards the mechanism's synthetic-fixture path.
