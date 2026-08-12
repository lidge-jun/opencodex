# 021 — WP2: adversarial falsification of the zero-close conclusion

`020` and `030` both concluded that nothing is closable. A conclusion of "zero"
is exactly the kind that hides a lazy sweep, so it was handed to an independent
agent whose brief was to **break** it rather than re-derive it.

**Result: `FALSIFICATION RESULT: ZERO-CLOSE CONFIRMED`.**

## Attack 1 — issues referenced by merged commits

The strongest closable signal is a merged commit naming its issue. Every
`(#NNNN)` reference in `121f1ad92..dc4dd45b0` commit subjects was extracted and
resolved:

| Number | Type | State | Commit |
|--------|------|-------|--------|
| #1236 | issue | CLOSED / completed | `93a083d1f` |
| #1190 | issue | CLOSED / completed | `ba5215021` |

Both were already closed. No open issue is claimed as fixed by any commit in
the release delta.

## Attack 2 — closable without a code fix

Duplicates, answered questions, and author-confirmed resolutions can close
without a fix. All 62 open issues' last comments were read. Nothing qualified,
and the near-misses actively contradict closure:

- **#1273** — "Leaving this issue open for defect 2."
- **#1201** — "I narrowed this issue instead of closing it."
- **#1024** — closure conditioned on a direct-upstream control test that has
  not been run.
- **#1177** — closure conditioned on profiling evidence that does not exist.

A maintainer has already made an explicit keep-open decision on each. Closing
them would overrule a human judgment on weaker evidence.

## Attack 3 — PR supersession, re-checked against live `dev`

Checked at live `dev` `bd991e14c`, newer than the RC:

- **#1161** — not superseded. `dev` still restricts vision backends to
  `openai | anthropic`; no `src/vision/describe-chat.ts`.
- **#1008** — not superseded. No `src/usage/rollup.ts`, no
  `usageRollupEnabled`.
- **#581** — not superseded, and **closed by someone else at 04:48:45Z**
  during this loop, with a stale-activity comment. Recorded because it is a
  state change this loop did not make and would not have made: `dev` contains
  none of its zh-TW assets, so it was closed for inactivity rather than
  supersession.
- No duplicate open PR pair. The high-overlap candidates are distinct work
  (#1367 vs #1361; #1164 vs #1165 were split at maintainer request; #1317 and
  #1318 are different providers).

## Attack 4 — the single close-after-release claim

**#1366 confirmed.** `831a120ea` genuinely fixes the reported failure: invalid
Grok expiry normalizes to `0` instead of `NaN`, non-finite disk credentials
cannot be adopted, malformed Claude expiry is normalized, and expired or
unknown imported credentials enter refresh validation. PR #1369 adds the
lifecycle regression test. Both `831a120ea` and the merge `e8ce2b93d` are
ancestors of the RC.

It stays open until the fix is published — closing it now would tell the
reporter their bug is fixed in a version they cannot install.

## Disposition

WP2 and WP3 close with **zero closures made**, verified twice by independent
agents. The one pending closure (#1366) is gated on the release, which is
gated on the owner's security decision.

This is a `NOOP` outcome for the closure half of the goal, and a correct one:
the previous campaigns (`260808_bug_campaign`, `260806_disposition_sweep`)
drained the closable backlog, so the remaining 62 issues and 16 PRs are live
work rather than debris.
