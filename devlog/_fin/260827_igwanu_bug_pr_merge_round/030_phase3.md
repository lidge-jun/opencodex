# 030 — wp4: clean approved lane — #2733, #2726, #2747

## #2733 — fix(cli): neutralize usage report terminal controls

Lane **L1**. Head `2a0ab4be6`, ready, **MERGEABLE/CLEAN**, **APPROVED**,
24 checks zero failures, 43 behind. `luvs01`. Labels: `bug`, `review-ready`.

Touches `src/cli/usage-report.ts` (+15/-2) and `tests/cli-usage-report.test.ts`
(+25). This is terminal-escape-sequence neutralization in a report renderer — a
control-character injection fix. No overlap with any in-scope PR.

Cleanest merge in the round: approved, clean, green, with its own regression.

Test oracle verified load-bearing by mutation: tests kept, production fix reverted
-> 12 pass / 1 fail at `tests/cli-usage-report.test.ts:78` (raw ESC survives into
output). With the fix, 13 pass / 0 fail. No fixture involved.

**Merge as-is** — this one already carries a non-author `APPROVED` decision, so
the `MAINTAINERS.md` approval requirement is satisfied on the record rather than
by assertion.

## #2726 — fix(xai): normalize web search on the Grok CLI proxy

Lane **L1**. Head `790a581cf`, ready, **MERGEABLE/CLEAN**, **APPROVED**,
24 checks zero failures, 63 behind. `olddonkey`. Labels: `bug`, `review-ready`.

Touches `src/adapters/xai-web-search.ts` (+24/-...),
`tests/responses-routed-web-search-fields.test.ts`,
`tests/xai-web-search-compat.test.ts` (+44). No overlap.

Test oracle verified load-bearing by mutation: tests kept, production fix reverted
-> 14 pass / 2 fail at `tests/responses-routed-web-search-fields.test.ts:235` and
`tests/xai-web-search-compat.test.ts:148`. With the fix, 16 pass / 0 fail.

The diff replaces an `api.x.ai`-only host check with `isXaiResponsesDestination`,
widening normalization to the Grok CLI proxy (the OAuth lane). The PR documents a
2026-08-27 re-probe of `cli-chat-proxy.grok.com` showing the same dialect. Treat
that probe as the author's claim, not as verified fact — the previous round was
burned by exactly this kind of cited-but-unverified provenance. The live smoke
below is what actually settles it.

**Merge as-is** — carries a non-author `APPROVED` decision.

Note: `xai` is this operator's default provider (`defaultProvider: xai`), so this
one is worth a live smoke after landing rather than test-only evidence.

## #2747 — fix(tests): reap the recovery proxy instead of trusting `stop`

Lane **L1, gated on wp2**. Head `07b97587`, ready, MERGEABLE, 26 behind,
labels `bug`, `review-ready`. Failing `ci` and `macos`.

The `macos` job (run `33059606933`, job `98534630924`) fails on
`release version line` — the shared baseline, again. The `ci` job fails with
`needed job(s) did not pass`, i.e. it is a fan-in that inherits the same failure.
Unlike #2764 and #2767, #2747's `gates` job is green: its head predates the
release-runbook document that trips `privacy:scan`. Version line only.

Touches exactly one file: `tests/update-stop-first.test.ts` (+46/-18). Test-only,
no `src/` change, no overlap. This is the causal repair of a flaky test — it reaps
the recovery proxy process instead of trusting `stop` to have ended it, which is
exactly the "find the causal issue, don't rerun until green" discipline.

After wp2, re-run CI; expect green with no diff change.

## TESTS

- #2733: `tests/cli-usage-report.test.ts`
- #2726: `tests/xai-web-search-compat.test.ts`,
  `tests/responses-routed-web-search-fields.test.ts`
- #2747: `tests/update-stop-first.test.ts` (the PR *is* the test)

## Verification (C)

```bash
bun test tests/cli-usage-report.test.ts
bun test tests/xai-web-search-compat.test.ts tests/responses-routed-web-search-fields.test.ts
bun test tests/update-stop-first.test.ts
bun x tsc --noEmit
```

#2747 additionally needs the run repeated to show the reap actually removes the
orphan: a single green pass on a formerly-flaky test is weak evidence. Run it
3x and confirm no leaked proxy process survives.
