# Phase 5 (wp6): release 2.75.0

`dev` is at 2.75.0, `main` at 2.74.0, `preview` at 2.74.0-preview.20260930, npm latest=2.74.0.

0. Freeze the candidate: the `dev` SHA whose final Cross-platform CI run succeeded, before the pre-move
   merge. Both promotions start from that SHA.
1. Pre-move: `gh workflow run dev-version-bump.yml --ref main -f intended-version=2.75.0 -f mode=pre-move`
   → PR opening `dev` at 2.76.0; accept only the four version sources; merge.
2. Preview promotion from the final dev SHA: branch, `git merge -s ours` origin/preview,
   `bun scripts/release-version-sources.ts sync 2.75.0-preview.20261001`, PR to `preview`, merge.
3. Main promotion from the same SHA: branch, `git merge -s ours` origin/main, tree equal to the
   candidate, PR to `main`, merge.
4. Gate: push-event Cross-platform CI and Service lifecycle on each promotion merge SHA succeed.
5. Dispatch `release.yml` for preview with `expected-sha`; dispatch main only after the preview
   release run succeeds.
6. Verify npm dist-tags, gitHead, GitHub releases, latest.json. Write the outcome.
