# B1 — #4038 estimated decode tok/s in Logs

Raw research: `_research/4038.md`. **This one is pending a user decision.**

## Verdict — partly, and the history matters

The gap is real: `tokensPerSecond(outputTokens, durationMs)` never subtracts TTFT
(`src/usage/cost.ts:655-661`), `tokPerSecondResult` passes the full duration
(`src/server/management/shared.ts:103-113`), the `MetricSource` Pick does not even
include `firstOutputMs` (`:99-101`), and `rg decodeTokPerSecond` finds nothing on
this tree. TTFT itself is already recorded per request and per combo attempt
(`src/server/request-log.ts:468-479`, `src/server/responses/core.ts:2884-2890`).

It is not a calculation bug — the end-to-end metric is documented as end-to-end.

What changes the picture: **contributor PR #4040 already implemented exactly this
and was closed unmerged by the reporter**, on the grounds that proxy TTFT and the
provider's own generation window do not line up, and that a small post-TTFT
remainder makes the estimate explode. The issue stayed open, so the repository now
holds an acceptance criterion and a rejection of the same feature.

## Asked the user

Retry with a minimum-decode-window guard, drop it from this round, or re-land the
#4040 shape confined to the detail dialog.
**Recommendation: retry with the guard.** The failure mode named in the #4040 close
is bounded — a decode window under a floor produces no value rather than a wrong
one — and that is a smaller change than abandoning a metric the issue still wants.

## Fix shape if it proceeds

Additive only. Do not change `tokensPerSecond`, `tokPerSecondResult`,
`filterLogs`, `RequestLogEntry`, or `usage.jsonl`.

1. `decodeTokPerSecondResult` next to `tokPerSecondResult` in
   `src/server/management/shared.ts`; add `firstOutputMs` to the `MetricSource`
   Pick. Value is `tokensPerSecond(outputTokens, durationMs - firstOutputMs)`,
   always `estimated: true`.
2. Unavailable reasons: the existing usage/output reasons, plus `ttft_missing`
   when `firstOutputMs` is undefined and `invalid_duration` when TTFT is
   non-finite, negative, or the window is non-positive. **Plus the new guard: a
   window below the floor yields no value.**
3. Parent uses request TTFT; each attempt uses its own attempt-relative TTFT.
   `requestLogDto` already maps attempts separately — do not copy
   `childLog.firstOutputMs` onto the parent.
4. GUI: optional field on `LogDisplayMetrics` (cached rows predate it), stacked in
   the existing rate cell via `.logs-stack-end`, labelled in the detail and attempt
   tables, and `METRIC_REASON_KEYS` extended — it is a
   `satisfies Record<MetricUnavailableReason, string>` at `gui/src/pages/Logs.tsx:273-279`,
   so a missing key is a type error.
5. i18n keys in all nine locale files; `gui/tests/locale-parity.test.ts` enforces it.

Leave the speed filter on end-to-end (`gui/src/pages/logs-filter.ts:136-143`),
leave `src/routing/analytics.ts` alone, and keep this out of
`/api/request-history` even though it shares the DTO.

## Regression test

`tests/server/management-api-logs-metrics.test.ts` already pins e2e
(240 tokens / 2000 ms = 120) at `:166`. Adding a sibling field does not disturb a
`.tokPerSecond` equality; it would disturb a whole-`displayMetrics` snapshot, so
check for one before editing.

New cases: 240 tokens, 10000 ms, TTFT 2000 → decode 30 and e2e 24; TTFT absent →
`ttft_missing`; TTFT ≥ duration → `invalid_duration`; window below the floor →
no value rather than a four-digit rate. That last one is the assertion that answers
the #4040 objection.

## PR

`feat(logs): show an estimated decode rate alongside end-to-end throughput` —
branch `lane-b/5-4038`, PR base `lane-b/4-1711`, top of the Lane B stack.
Closes #4038.
