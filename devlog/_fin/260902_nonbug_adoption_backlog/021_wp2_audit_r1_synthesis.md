# wp2 audit round 1 — synthesis

Reviewer: grok-4.6 adversarial lane (agent `01a05e12`).
Verdict: `GO-WITH-FIXES (blockers=3)`. All three accepted. No rebuttals.

The reviewer confirmed the plan's central claim — there is a real band above
15 MiB that succeeds today — and then corrected the evidence I used to argue it.
That correction is blocker 3 and it matters more than it looks.

## Blocker 3 — I overstated the ceiling (ACCEPTED)

My plan's table claimed HTTP dies at ~16.7 MB. Wrong. The 16,777,000 /
16,777,300 figures in `ws-upstream.ts:31-38` are the **WebSocket close**
measurement, and the very same comment says *"The same request body succeeds
over HTTP SSE, so the ceiling belongs to this transport alone."* Issue #2426
records an 18.2 MB HTTP 200.

So the regression is **larger** than I wrote, not smaller: there is no
established HTTP ceiling at all in the range the PR's default would refuse. I
was citing a WS number as if it bounded HTTP. Corrected table:

| Body size | Today | After #3142 default |
|-----------|-------|---------------------|
| 15 MiB … frame limit − 1 | WS send succeeds | local 413 |
| >= frame limit (16 MiB − 64 KiB) | HTTP SSE fallback sends the original body; 18.2 MB observed OK | local 413 |

This also settles the alternative the reviewer weighed: a canonical-only default
at 15 MiB is still wrong, because it would refuse working ChatGPT traffic in the
15 MiB–18.2 MB band. Default-off is not merely the safer option, it is the only
one supported by the measurements we actually have.

## Blocker 1 — the refusal shape is a trap on the enabled path (ACCEPTED)

I had put the #3177 mapping OUT of scope on the grounds that default-off defuses
the retry-loop concern. That reasoning is backwards. Default-off means the
**only** users who ever see this code are the ones who deliberately enabled it —
so the enabled path is the whole feature, not an edge case.

`streamingContextOverflowResponse` (`src/server/responses/context-overflow.ts:8-16,29-50`
on `origin/dev`) emits SSE `response.failed` / `context_length_exceeded` with
`retryable: false`, and the passthrough upstream-413 path already uses it
(`core.ts:4530-4534`). A local `formatErrorResponse(413, ...)` is a retryable
transport error to Codex, which resends the same oversized body — the exact loop
the PR set out to stop.

Correction: a streaming refusal uses `streamingContextOverflowResponse`. The
JSON 413 stays only for non-streaming requests, where it is the right shape.

## Blocker 2 — criterion 5 had no activating test (ACCEPTED)

"Every rebuild site is guarded, including the 401 replay" was a claim with
nothing driving it: neither named test file reaches the 401 replay,
`rebuildAndRefetch`, or the alternate-account retry. Under
C-ACTIVATION-GROUNDING-01 that is a code comment wearing an acceptance criterion.

Correction: add an integration case that drives a rebuild path with an oversized
rebuilt body and asserts no second upstream fetch. The 401 replay gap itself is
confirmed real — unguarded at PR head `core.ts:4071-4097` and at the same place
on current `origin/dev` (`4106-4135`).

## File-map additions from the reviewer

- all seven `docs-site` locale copies of `providers.md`, which the PR does touch
- `src/server/responses/context-overflow.ts` as a consumer (blocker 1)
- the malformed-value warning sibling used by `upstreamHostCircuitThreshold`
  (`src/config.ts:1809-1823, 2261-2270`)
- `src/server/request-log.ts` confirmed in scope: the PR adds
  `RequestLogContext.errorCode`, absent from the current tree

## Base

Reimplementation branches from current `origin/dev` (`c87071400`), which carries
#3177. The wp1 branch is 20 commits behind that and is not a base for this work.

## Line drift corrected

`ws-upstream.ts:152-167` is the doc comment; the fallback is `:199-201`.
`tests/ws-upstream.test.ts:692` is `:693`.
