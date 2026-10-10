# Phase 3 (wp4): final dev-tip CI and record

1. Take the final `origin/dev` SHA after the last merge.
2. Observe the push-triggered CI on that SHA; dispatch Cross-platform CI once if the push
   run does not cover the platform legs. Confirm expected jobs ran; distinguish skipped,
   cancelled and failed.
3. Triage any failure as introduced by this unit (fix forward in a PR) or pre-existing
   (cite an earlier run with the same failure).
4. Write `040_dispositions.md` with each PR's outcome, each closed item, the uncertain list,
   and the CI run ids.
