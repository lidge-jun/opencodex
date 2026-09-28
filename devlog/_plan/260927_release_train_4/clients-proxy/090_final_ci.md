# Phase 9: final integration and CI

Depends on all selected carries and triage. This phase writes no product code
unless the last `dev` run exposes a lane-owned regression; any repair gets its
own new PABCD work phase and ordinary PR.

## Exact evidence map

- MODIFY `devlog/_plan/260927_release_train_4/clients-proxy/000_plan.md`
  disposition rows when outcomes change. Before: candidate judgments at
  `origin/dev` `24b2f39b77`; after: each row names actual lane PR, merge SHA,
  source PR/issue state, and any residual hold.
- NEW a numbered outcome file under this unit, recording each PR head and
  merge SHA, focused commands and their exits, required CI run IDs/URLs,
  final `dev` run URL, and remaining cross-lane file overlaps.

## Acceptance and proof

Fetch latest `origin/dev`; for every lane PR, retain the exact pre-merge PR
head SHA and required-job run IDs that passed before merge. `ci.yml` does
not run on a push to `dev`, so after the merge resolve the integrated `dev`
commit and explicitly dispatch `gh workflow run ci.yml -R
lidge-jun/opencodex --ref dev -f lane=all`. Identify the resulting run by
`workflow_dispatch` event and exact `headSha`, then record its run ID, URL,
attempt, requested jobs and final conclusions. If `dev` moves before dispatch,
refresh the head and verify the run covers that newer integrated tree instead
of claiming evidence for an older SHA. Missing, skipped, cancelled, pending,
failed, and wrong-head results do not count as passing for requested jobs.
Compare changed paths
against other lane overlap in the final report. `git status --short` must
contain no unaccounted files, and each source PR/issue closure must point to
the actual integrated SHA.
