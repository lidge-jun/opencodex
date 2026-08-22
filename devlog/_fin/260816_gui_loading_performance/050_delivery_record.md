# 050 — WP5: delivery record (stack publication, CI, remote suite, merge)

## Stack shape

Four dependency-ordered layers, each PR based on the one below, bottom targeting
`dev`:

| # | PR | Branch | Layer |
|---|----|--------|-------|
| 1 | #1854 | codex/gui-resource-deadline | resource deadline |
| 2 | #1855 | codex/gui-auth-unwedge | 401 re-bootstrap unwedge |
| 3 | #1856 | codex/gui-hidden-pause | hidden tab = zero timers |
| 4 | #1857 | codex/gui-poll-consolidation | shared scheduler + revisit freshness |

## Rebase history

Two cascades, both `git rebase --update-refs --onto origin/dev <old-base>` from
the top branch so all four refs move in one pass:

1. The stack was cut at `b81314cd2`; `origin/dev` had advanced 88 commits.
2. A second cascade onto `8f7a22ff7` picked up PR #1853, which had landed the
   admission-`source` contract. That one mattered: the remote suite had reported
   2 failures in `tests/loopback-listener-admission.test.ts` that were NOT ours —
   the remote checkout paired #1853's NEW test file with our older source. After
   the cascade the same suite ran clean, which is what confirmed the diagnosis.

A comment-text-only conflict in `gui/src/visibility-poll.ts` was resolved in
favor of the WP3 wording (see below).

## Layer independence correction

CI caught what local runs could not: WP3 (#1856) failed its own `gates` job with
nine failures in the codex-auto-switch and account-picker suites. Those tests
intercept `window.setInterval`, and `startVisibilityPoll` was scheduling through
the bare global — the fix existed only in the WP4 commit. Since DEV-STACK-03
requires every layer to be green at its own tip, the fix moved DOWN into WP3
(`116bcae03`, later `c75f88d6c`) where the migration itself lives.

Verified after the move: WP3 tip 913 pass / 0 fail, WP4 tip 924 pass / 0 fail.

## Verification evidence

- Remote full suite (`ssh lidge`, `bun test --isolate tests`) on the WP4 tip
  after the second cascade: **12700 pass / 0 fail / 15 skip, EXIT=0**.
  A `dev`-baseline run in the same session also finished EXIT=0, which is how the
  earlier 2 failures were attributed to the stale base rather than to this work.
- Local: `bun run typecheck` green; `cd gui && bun test tests` 924 pass;
  `bun run lint`, `bun run lint:i18n`, `bun run build` green.
- Browser: dashboard renders unchanged; revisit inside the freshness window
  issues zero requests with zero skeletons.

## CI flakes encountered (not regressions)

The macOS and `test 2/4` jobs each failed once with a **Bun runtime crash**
(exit 133 / exit 132, `storage-worker-lifecycle` under singleton isolation) —
the workflow itself distinguishes these from assertion failures and retries once
before giving up. Assertion count in both logs was `0 fail`. Re-runs cleared
them, and the same commits pass the full suite on Linux.

The `ci` aggregate job also failed on several branches by asserting before the
long macOS job had reported; re-running it after macOS completes is the fix.

## Screenshot gate

`enforce-target` requires a UI screenshot for any PR touching `gui/`. These four
change request lifecycle, timers, and caching with no visual delta, so the
maintainer waiver label `gui-screenshot-waived` was applied to all four, and a
post-change dashboard screenshot was captured during verification.

## Merge

Bottom-up, one at a time, each with `--match-head-commit` bound to the audited
SHA. `dev` requires one approval and the author cannot self-approve, so the
project owner's admin merge (pre-authorized by the user for this campaign) is
the path used.

- #1854 merged at 2026-08-16T17:15:18Z as `e2ef24ad6`.
- #1855 merged at 2026-08-16T17:39:13Z as `14c643bcd`.
- #1856 merged at 2026-08-16T17:47:45Z as `cc9087c64`.
- #1857 merged at 2026-08-16T17:52:02Z as `9c5eb1e38`.

Each child was retargeted to `dev` after its parent landed, and `dev` moved twice
more mid-flight (#1861, #1862, #1863), which cost two further cascades of the
remaining layers.

## Delivery verification (binding round r8, PASS)

An independent reviewer confirmed against `origin/dev`:

- all four merge commits are ancestors of `dev`, in stack order, each with final
  base `dev` and state MERGED;
- every layer's substance survived both rebases — the deadline race
  (`RESOURCE_TIMEOUT`, `timedOut`, `DEFAULT_REQUEST_DEADLINE_MS`), the bucket
  scheduler (`pollBuckets`, `syncBucketTimer`, `bucketShouldRun`), the freshness
  fields, the tri-state re-bootstrap with its watchdog, `visibility-poll.ts`, the
  cache envelope, and all six new test files;
- no commit landing after the stack tip touches any of the four GUI files;
- `dev` GUI suite 924 pass / 0 fail, `tsc --noEmit` exit 0, `privacy:scan` green,
  and all eight plan docs present with their D addenda.

One wording note from the review: `api.ts` holds no direct `AbortController` — the
bounded-fetch helper owns that composition and `api.ts` calls it. Refactor, not a
lost change.

## Terminal outcome

DONE. The infinite-loading wedge is fixed at both of its causes, hidden tabs cost
nothing, and a tab revisit inside the freshness window issues no requests at all.
