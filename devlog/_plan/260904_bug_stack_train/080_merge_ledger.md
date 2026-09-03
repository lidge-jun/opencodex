# 080 — Merge ledger

Every merge, with the proof form used for each:

```
git fetch origin dev && git merge-base --is-ancestor <merge-sha> FETCH_HEAD
```

| Order | PR | Merge commit | Ancestor of dev |
|-------|----|--------------|-----------------|
| 1 | #3369 | `f825858da5b2e8dc5c949cc9f17b5111bf07bda4` | ok |
| 2 | #3372 | `8a0c1086539b82648984e0a1c3546d9d493d5fd9` | ok |
| 3 | #3371 | `53a2adfc45ed18a980355abe353ec02f06f3f39e` | ok |
| 4 | #3373 | `d753fa53bec651c90e538602a56d1a1cddf56589` | ok |
| 5 | #3385 | `d060f53abe255b28f8c36330ddd0c4e39fd9b6a2` | ok |
| 6 | #3386 | `a33381182b144bfccb61269f4dfbc73057eacae2` | ok |

Each merge was gated on the check-run rollup for that PR's exact `headRefOid`, not on
`gh pr checks` output alone — a cancelled superseded run renders as a failure there, and
an empty required-check list is not evidence of green.

## Two rebuilds, and one flake that was not one

#3370 could not be rebased after its parent #3369 squash-merged: the branch still carried
the core commits, and the rebase conflicted against content that had already landed in
squashed form. Rebuilt as #3385 from the surface file set on current `dev`.

#3374 was rebuilt as #3386 after CI exposed the `styles.css` revert.

One genuine flake: `test 4/4` failed on
`update stops the running proxy before replacing files > npm launcher restarts the stopped
runtime after a staged update failure` — a 91-second timing-sensitive test in
`tests/update-stop-first.test.ts`, which reads nothing from `gui/` while that PR changed
only stylesheets. It passed locally (15 pass / 0 fail) and passed on re-run. Distinguishing
that from a real failure required reading the shard log, not assuming.
