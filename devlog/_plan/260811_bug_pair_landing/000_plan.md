# 260811 — Landing the seven paired bug fixes onto `dev`

## Objective

Land seven issue/PR pairs onto local `dev` as verified commits, one PABCD
work-phase per pair. Push, remote merge, PR comment, and issue close are all
out of scope: this unit ends with local commits awaiting the maintainer's
explicit publish decision.

## Baseline

| Item | Value |
|---|---|
| `dev` tip at unit start | `87e3ff9f6` (`refactor(cli): move CLI head dispatch into src/cli/root.ts (#1444)`) |
| Local `dev` vs `origin/dev` | fast-forwarded to identical; 0 ahead, 0 behind |
| Baseline `bun run typecheck` | clean |
| Bug-labelled open issues | 21 |
| Bug-labelled open PRs | 11 |
| Pairs in scope | 7 |

The four bug-labelled PRs with no linked issue (#1464, #1448, #1412, #1380) are
deliberately excluded: this unit lands the *paired* work, where an issue states
the observable defect and a PR claims to close it. An unpaired PR has no
independent statement of the defect to verify against.

## The seven pairs

| WP | Issue | PR | Head | Ahead/behind `dev` | CI | Review |
|---|---|---|---|---|---|---|
| wp1 | #1459 | #1460 | `7bf8b84a1` | 1 ahead / 4 behind | green | CHANGES_REQUESTED (1 blocker) |
| wp2 | #1273 | #1462 | `2f9225915` | 1 ahead / 3 behind | green | none yet |
| wp3 | #1454 | #1465 | `681c8821f` | 1 ahead / 0 behind | CLEAN | none yet |
| wp4 | #1453 | #1461 | `9e5cc13f5` | 1 ahead / 4 behind | RED | none yet |
| wp5 | #1449 | #1452 | `47271935f` | 1 ahead / 8 behind | green | CHANGES_REQUESTED (trust boundary) |
| wp6 | #1429 | #1434 | `89a96ce0e` | 9 ahead / 4 behind | RED | CHANGES_REQUESTED (2 blockers) |
| wp7 | #1439 | #1441 | `aa256f6d3`+ | 15 ahead / 3 behind | RED | CHANGES_REQUESTED (3 blockers) |

`windows N/4` is SKIPPED on every one of them; per #1059 the Windows leg is
dispatch-only and does not gate. That is not evidence of Windows correctness,
which matters for wp3 and wp5 — both are Windows-only code paths.

## Ordering rationale (PHASE-SPLIT-01)

Ordered by dependency and risk, not by effort:

1. **wp1 (#1460)** first. It touches `src/codex/catalog/sync.ts`, the file the
   catalog-staleness family shares. Landing it first fixes the base that wp4
   also reads, and its single blocker is a mechanical byte-compare correction.
2. **wp2 (#1462)** next. `src/config.ts` only; no overlap with wp1.
3. **wp3 (#1465)** next. `src/service.ts` + `startup-action-control.ts`; CI is
   already clean and it applies directly onto the tip.
4. **wp4 (#1461)** after wp1, because it touches `src/codex/sync.ts` and
   `src/codex/inject.ts` — adjacent to wp1's file, and its red CI must be
   root-caused against a `dev` that already carries wp1.
5. **wp5 (#1452)** next. Isolated to `src/lib/windows-user-principal.ts`, but
   its blocker is a trust-boundary narrowing, so it needs care rather than
   speed.
6. **wp6 (#1434)** next. Two durability blockers in one adapter file.
7. **wp7 (#1441)** last. +1859/-26 across `src/codex/shim.ts`, three open
   blockers, and it writes and deletes files on the user's `PATH`. Highest
   blast radius, so it lands on the most-verified tree.

No two consecutive work-phases write the same file, so each cycle's focused
suite is a meaningful gate rather than a re-run of the previous one.

## Landing rule per pair

A pair lands as **(a) cherry-pick of the contributor head** when its blockers
are closed and the diff is sound, or **(b) our own re-implementation** when the
contributor branch is unsalvageable. In case (a) with our corrections on top,
the contributor keeps authorship and we add a trailer; in case (b) the commit
is ours and credits the reporter and the contributor's approach in the body.

A blocker counts as closed only with a red-then-green ablation: the regression
must be shown failing against the unfixed code before it passes against the
fix. A green test that never had the chance to be red proves nothing.

## Out of scope, explicitly

- `git push`, force-push, remote branch creation, tag push.
- `gh pr merge`, review submission, PR/issue comments, issue closes.
- Release or npm publish.
- The pre-existing dirty worktree files (`.dirfd-probe-*.ok` and friends) and
  the ~45 sibling worktrees. Untouched.
- Security findings never land in this directory; scratch space only.
