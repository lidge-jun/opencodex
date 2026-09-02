# 070 — Phase 7 (wp7): Issue #3141 — responses-state.json write storm

## Finding (gpt-5.6-sol investigator, high effort)

VERDICT FIXABLE_NOW, confidence high, no auth/release risk.

Every eligible completed response mutates the continuation cache and calls
`schedulePersist()` (`src/responses/state.ts:2182-2232`). A process-level timer
coalesces triggers every 2–30 s depending on snapshot size
(`src/responses/state.ts:1562-1573`) and byte-identical snapshots are skipped
(`:1521-1530`). Under concurrent completions, though, the revision changes
during async disk I/O, so the loop at `src/responses/state.ts:1479-1536`
performs up to four immediate full atomic rewrites per background tick. The
current tests codify that: four background writes and eight shutdown writes at
`tests/responses-state.test.ts:2204-2240`.

## MODIFY / NEW / DELETE map

- MODIFY `src/responses/state.ts` — parameterize `writeBoundedSnapshot()` with an
  attempt limit; pass `1` for ordinary background persistence and, when the
  snapshot is unstable, keep the existing delayed `schedulePersistAt(path, true)`
  follow-up instead of rewriting immediately. Retain bounded retry only for
  graceful shutdown after request draining. Leave the byte-identity check and
  `atomicWriteFileAsync()` untouched.
- MODIFY `tests/responses-state.test.ts` — update the background-churn
  expectation from four attempts to one plus a pending follow-up.
- MODIFY `docs-site/src/content/docs/troubleshooting/disk-usage-temp-files.md` —
  document the one-rewrite-per-background-cadence guarantee.

## TESTS

`tests/responses-state.test.ts`, case "background revision churn schedules
exactly one follow-up pass": assert `attempts === 1` with a pending follow-up
timer. Red on current HEAD, where the observed contract is `attempts === 4`.

## Verification (C)

```
bun test tests/responses-state.test.ts -t 'background revision churn'
bun run typecheck
```

Accepted tradeoff: crash-recovery state may lag by one extra debounce interval
under sustained traffic.

