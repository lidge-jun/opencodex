# closeout (recorded 2026-09-09)

Landed via #4128 MERGED (`b2142586a`, merge commit `91db6c2f2`, both ancestors of origin/dev);
issue #4122 CLOSED. Remote CI on the exact head `b2142586a` was green: 28 successful check runs,
0 failures, 2 skipped by their own matrix gates (`macos control`, `windows ${{ matrix.shard }}/6`).

Delivered exactly the `000_plan.md` file-change map: the optional routed-model hint on
`parseUpstreamQuotaHeaders` / `applyAccountQuotaFromUpstreamHeaders`
(src/codex/quota.ts:411-538), all four `src/server/responses/core.ts` write paths plus the six
`codexWsQuotaObserver` factory call sites, the compact path
(src/server/responses/compact.ts:1018), and the four regression rows in
tests/codex-integration/codex-quota-parser-parity.test.ts.
src/codex/quota-auto-refresh.ts stayed unchanged as planned.

Carried forward, not regressions:

- Already-polluted account entries keep the stale account-level `short*` tuple until the six-hour
  hydration TTL expires them on disk, or until a restart or a genuine non-Spark short write
  replaces them in memory. Declared out of scope in the `000_plan.md` non-goals and unchanged by
  the merge.
- A Spark-saturated account is no longer preemptively avoided for Spark-routed requests, because
  routing evidence reads only the account-level slot (src/routing/quota.ts:40-61). Bounded to
  Spark requests and absorbed by the existing 429 pool rotation. Spark-aware exhaustion sourced
  from `customWindows` remains a follow-up.

The unit was committed into the product PR rather than kept separate; moving it here is that
correction, made after the merge closed the unit.
