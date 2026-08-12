# 260802 Triage Execution — 000 Research / Handoff

Date: 2026-08-02. This unit executes the decisions recorded in
`devlog/_fin/260802_issue_pr_triage/` (000_research.md audited PASS,
010_triage_matrix.md complete for all 37 issues + 32 PRs).

## Inputs

- Triage matrix buckets (from `../../_fin/260802_issue_pr_triage/010_triage_matrix.md`):
  - PR merge candidates: 866, 862, 860, 854, 853 (+653 conditional).
  - PR build-ourselves-worthy: 865, 863.
  - PR close-or-defer: 644, 616, 707.
  - Issues needs-info: 796, 695, 561, 553, 418, 201.
  - PR needs-author-work (21): 868, 861, 850, 839, 837, 847, 845, 844, 843,
    841, 840, 812, 811, 746, 744, 715, 693, 671, 581, 569, 557.

## Policy gates (MAINTAINERS.md, read 2026-08-02)

- PRs target `dev` only.
- A PR requires at least one maintainer approval and successful required CI
  before merge; authors do not approve their own PRs.
- Auth, credential handling, Actions, release automation, dependency
  installation, and other security-boundary changes require explicit security
  review. New provider presets are credential-destination changes requiring
  the contributing-guide evidence (documented endpoints, ToS/legal entity,
  resale/routing authorization for aggregators, named maintenance owner,
  citable verification date).
- Promotion `dev` -> `main` and npm releases are maintainer-controlled;
  merged PRs ride the next release train (no immediate release action here).

## Execution identity and voice

- `gh` authenticates as lidge-jun (project owner). Comments are posted in
  English per the repository review-language convention, in maintainer voice.
- No pushes of local commits, no releases, no `src/` changes in this unit.

## Work-phase map (decade docs)

- `010_merge_candidates.md` — per-PR gate checklist + merge plan (wp2).
- `020_build_worthy.md` — 865/863 deep-review plan + direction comments (wp3).
- `030_close_defer.md` — 644/616/707 close rationale + comment drafts (wp4).
- `040_needs_info.md` — issue comment drafts naming required evidence (wp5).
- `050_author_work_requests.md` — 21 tailored PR comment plans (wp6).
