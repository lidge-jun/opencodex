# 000 — Plan: next-release recommendation report (wp1)

Unit: devlog/_plan/260907_next_release_recommendations
Class: C2 (docs-only deliverable; research via read-only explorer lanes)
Goal: rank 10–30 items to land on `dev` before the release after v2.46.0 (dev open at 2.47.0).

## Diff-level plan
- Write scope: this directory only (000_plan.md, 010_recommendations.md). No src/gui/docs-site edits.
- Branch: codex/260907-next-release-recommendations (local commit only; no push/merge).
- Lanes (each an independent astra-high explorer, read-only):
  - L1 non-draft (`review-ready` label) PRs: #3858 #3845 #3843 #3840 #3839 #3837 (+ #3748 #3742 enhancement review-ready; #2805 maintainer-sponsored)
  - L2 draft bug PRs + small feature: #3863 #3862 #3860 (open, feature) #3856 #3849 #3848 #3841 #3838 #3769 (+ hygiene-blocked flags)
  - L3 open bug issues without PR: #3807 #3782 #3781 #3775 #3765 #3761 #3719 #3675 #3661 #3657 #3644 #3522 #3506 #3464 #3433
  - L4 open enhancement issues + older draft feature PRs worth carrying: #3859 #3817 #3729 #3630 #3573 #3266 #3336 #3389 #2280/#2279 #3652 #3635 #2805
  - L5 devlog/_plan residual work (units dated 260905–260907, plus older units with open TODOs)
  - L6 post-2.46.0 regressions: dev CI status, main..dev delta, release follow-up notes in devlog/_fin/260907_release_246
  - L7 catch-all PRs (audit round 1 blocker 1): #3833 #3810 #3741 #3738 #3709 #3663 #3648 #3639 #3532 #3463 #3458 #3451 #3350 #3349 #3340 #3283 #3282 #3252 #3080 #3025 #3010 #2956 #2921 #2881 #2562 #2527 #2462 #2366 #2362 #2355 #2351 #2244 #2230 #2213 #2033 #1645
  - L8 catch-all issues (audit round 1 blocker 2): #3777 #3774 #3705 #3667 #3666 #3494 #3459 #3417 #3379 #3377 #3376 #3375 #3320 #3255 #3245 #3191 #2894 #2834 #2811 #2730 #2511 #2495 #2455 #2358 #1811 #1782 #1711 #1533 #1416 #1213 #95 (L3 already covers #3861 #3857 #3855 #3846)
  - Inventory reconciliation: 010 must carry a dated appendix listing every open PR (59 at audit time) and open issue (57) with lane + disposition, so coverage is checkable by diffing against `gh pr list`/`gh issue list`.
- Each lane returns: per item -> disposition, risk class, evidence anchors (path:line / URL), overlap notes, effort.
- Main session merges lane returns, dedups, ranks, writes 010_recommendations.md.

## Acceptance (from goalplan c-1..c-3; tightened after audit round 1)
- 10–30 ranked items. Each item has: source id, disposition, risk class, effort, ≥1 evidence anchor gathered this session (GitHub URL or path:line), and a one-line ranking rationale under the stated criteria (user impact × risk × effort × contributor-credit cost).
- Appendix reconciles the full open PR/issue inventory (every number appears once with lane + disposition); overlaps between PRs and issues are recorded as explicit pairs.
- `bun run privacy:scan` exit 0 on the report commit; commit contains only the two files in this directory (`git show --stat` as proof).
- ≥5 anchors spot-checked live by the main session, with the anchor, command, and result recorded in 010's verification section.
- Security: only already-public evidence (existing issues/PRs/diffs) may be cited; no new weakness is written here (AGENTS.md security working notes).
