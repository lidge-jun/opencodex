# 008 — Audit synthesis and plan amendments (wp0, round 1)

Reviewer: claude-opus-5 auditor, report `007_audit_wp0.md`, verdict GO-WITH-FIXES (blockers=6).
Main-agent judgment: near-pass → all six folded as amendments below. Live re-probe run at
`origin/dev` = `79e03643d` on 2026-09-05 (this doc supersedes the conflicting sections).

## Blocker 1 (High) — mergeability re-probe with `git merge-tree --write-tree origin/dev <head>`

GitHub's `mergeable` probe skips rename detection; `merge-tree` is the authority. Result:

| PR | Head | merge-tree |
|----|------|------------|
| #3529 | 92b4eda26 | CLEAN |
| #3525 | 288506dc6 | CLEAN |
| #3524 | cf0b3fe0a | CLEAN |
| #3519 | 6b92ab7db | CLEAN |
| #3515 | 4f09faf5d | CLEAN |
| #3502 | 6671a1623 | CONFLICT |
| #3490 | 3fbe8a2c7 | CLEAN |
| #3489 | dbcfde8ca | CLEAN |
| #3484 | a4c50d104 | CLEAN |
| #3480 | 74ef8faae | CLEAN |
| #3469 | e11089af8 | CONFLICT |
| #3407 | 38d45300a | CLEAN |
| #3388 | 007076ebd | CONFLICT |
| #3348 | a64ed3250 | CONFLICT |
| #3444 | baefb1334 | CLEAN |
| #3447 | 745b70e1e | CLEAN |
| #2956 | cc6aa5f48 | CONFLICT |
| #2783 | ad74f037d | CONFLICT |
| #2973 | b6a879267 | CONFLICT |
| #3323 | 0facdae69 | CLEAN |
| #3487 | ee3b22d28 | CLEAN |
| #3329 | 1876d6001 | CLEAN |
| #3421 | 432016100 | CLEAN |
| #2432 | c83d8eda1 | CLEAN |
| #3531 | aef450d93 | CLEAN |
| #3528 | dad2112a1 | CLEAN |

**Amendment to 010 §0.1-0.2 and §2:** wp1 expected outcome is restored to 7/7. #3323, #3515,
#3484, #3525, #3529 need no rebase; a GitHub-side "CONFLICTING" flag on any of them is a
rename-detection artifact. If GitHub refuses the squash button, the fallback is a maintainer
carry branch created by `git merge origin/dev` onto the PR head (rename-aware) and pushed
with `--no-verify`, never a manual file-move rebase. #3490 keeps its `layout.json` +
`tests/codex-integration/` placement fix (a real gate, independent of mergeability).
**Amendment to 020:** #3489 needs no rebase; only #3469 keeps the two-test-rename recipe.

## Blocker 2 (High) — head drift

| PR | Manifest head | Live head | Consequence |
|----|---------------|-----------|-------------|
| #3529 | 4f103a1e7 | 92b4eda26 | review now CHANGES_REQUESTED → 010 §3.7 adds "re-read review threads; dismiss if stale on the new head, else fold the requested change" before ready/merge |
| #3480 | 63623c640 | 74ef8faae | already handled in 002/010 (author rebase) |
| #3531 | f486b5d60 | aef450d93 | non-draft; #2960 regression fixed by author (050 E4 stands) |
| #3528 | 735e3f5c5 | dad2112a1 | alias half removed; SUPERSEDED reasoning = scope split only |
| #3530 | 14fbbd187 | MERGED 6580694c7 | 000 manifest row marked MERGED; E0 follow-up in wp5 stands |

Rule carried into every implementation P: re-read `gh pr view <n> --json headRefOid`
immediately before any merge/carry action; a moved head restarts that item's pre-merge checks.

## Blocker 3 (Medium) — E0 anchors

050 E0: target test now at `tests/routing/anthropic-quorum-cache.test.ts:144` (`bdafc5191`
inserted a test at `:122`); the quoted import line is gone. Implementer re-anchors at B by
`rg -n "removeAccount|quorum" tests/routing/anthropic-quorum-cache.test.ts` before patching.

## Blocker 4 (Medium) — Co-authored-by form

All trailers use the ID-prefixed noreply form `<id>+<login>@users.noreply.github.com` resolved
via `gh api users/<login> --jq .id` at B, or the author's real commit email when the PR commits
carry one. The id-less `<login>@users.noreply.github.com` form is forbidden in this unit.
Known: Ingwannu → `186453546+Ingwannu@users.noreply.github.com` (010 §3). #3489's
`<opencodex-fix@local>` and #3329's `" " <wj@nas-backup>` are replaced by the login-resolved form.

## Blocker 5 (Medium) — #3531 identity and #3329 disposition

- #3531: author is `benedictusrey`; trailer resolved per Blocker 4 at B (050 §E4 identity line replaced).
- #3329: single disposition = **LAND_WITH_FIX, wp5 layer E7**, appended after E0-E6; requires hand
  re-resolution of `src/server/responses/core.ts` under the lab-boundary invariant
  (`tests/core-lab-boundary.test.ts` is a verifier for E7) and the trailer per Blocker 4.
  006 Counts stay: LAND_WITH_FIX 13 includes #3329.

## Blocker 6 (Low) — ledger schema and wp6 stop condition

060 ledger schema is the nine-column form from 010 §7:
`| WP | Item | Disposition | Carry branch / PR | Head SHA | CI run id | Landing SHA | Ancestry proof (cmd + exit) | Original closed (comment URL) |`.
wp6 stop condition: every LAND/REIMPLEMENT/IMPLEMENT row has a landing SHA with ancestry
exit 0 and an original-closure link (or an explicit "keep open" rider: #3522, #3462), every
DEFER/SUPERSEDED has a closure or comment link, and `bun run privacy:scan` exit 0 on the
closeout commit; then the unit moves to `devlog/_fin/`.


## Round 2 synthesis

| Blocker | Status | Action |
|---------|--------|--------|
| 1-4 | FOLDED | none |
| 5a #3531 identity | REBUTTED-ACCEPTED | 050 original trailer (`benedictusrey888`, id 192305729) stands |
| 5b #3329 | FOLDED (round 2) | E7 written in full at the end of 050 (file map, field chain, activation scenarios, verifiers incl. `tests/lab/core-lab-boundary.test.ts`, trailer `234569343+Veritas-7`); merge-tree CLEAN so carry = merge, not hand-resolution. Body DEFER mentions in 050 are superseded by the E7 section. |
| 6 ledger | FOLDED (round 2) | 010 §7 row format replaced with the 060 nine-column schema; wp6 stop condition written into 060 |

Main-agent judgment: **near-pass** → exit A>B for wp0 (docs-only). Residuals: none blocking.

DOCEOF; rg -n 'Author \| Head merged' /private/tmp/ocx-closeout.xomWAA/wt/devlog/_plan/260905_open_work_closeout/010_wp1_stack_a_land_as_is.md | head -2; tail -3 /private/tmp/ocx-closeout.xomWAA/wt/devlog/_plan/260905_open_work_closeout/060_ledger.md