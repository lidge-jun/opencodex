# 000 — WP6 PR #527 wrong-base handling plan

## Objective

Resolve the triage action for PR #527 only:

- Live PR #527 currently targets `codex/catalog-written-signal`, not `dev`.
- PR #526 has now been squash-merged to `dev` as
  `9dd3c42dae2e7feda3581c6d477cf5a0d6e646bf`.
- PR #527 head `codex/app-server-restart@a64aa585630f664a83c25253497a62810133e832`
  still contains the pre-squash PR #526 commit
  `1ba588eff663a5be846a8723b90a452dca8cd04c`.

This work-phase decides the safe maintainer action for #527 after #526 landed.

## Loop-spec

- Loop archetype: spec-satisfaction triage, not implementation.
- Trigger: wrong-base PR with stale stacked history after its dependency merged.
- Goal: leave PR #527 in a clear, actionable state without merging unsafe or stale
  code.
- Non-goals: do not merge #527; do not delete `codex/catalog-written-signal`; do
  not implement or approve the process-termination behavior in this phase.
- Verifier: live `gh pr view 527`, commit topology commands, merge-tree
  conflict output, and resulting PR comment URL if a comment is posted.
- Stop condition: PR #527 is classified as `needs-author-rebase` or otherwise
  documented with a fresh maintainer comment.
- Memory artifact: this devlog unit plus goalplan criterion `C-WP6-PR527`.
- Terminal outcomes:
  - `DONE`: fresh comment/request-rebase URL recorded.
  - `NOOP`: live state already changed to dev/green before action.
  - `NEEDS_HUMAN`: if retargeting/merging requires accepting process termination
    or UX/security implications.
  - `BLOCKED`: GitHub mutation fails or author branch permissions prevent action.
- Resource bounds: GitHub PR #527 metadata/comments only; no main/preview/release
  branch mutations.

## Live facts

- PR: https://github.com/lidge-jun/opencodex/pull/527
- Current base: `codex/catalog-written-signal@ce716cc117ab23e4420c8c9fe860959968f66cdc`
- Current head: `codex/app-server-restart@a64aa585630f664a83c25253497a62810133e832`
- Current status:
  - title: `[WRONG BRANCH] fix(codex): warn about stale Codex app-servers after a catalog write`
  - `mergeable`: `CONFLICTING`
  - `mergeStateStatus`: `DIRTY`
  - `enforce-target`: failure because target is not `dev`.
  - CodeRabbit skipped review because base is not `dev` or `preview`.
- Topology:
  - `origin/dev...origin/codex/app-server-restart`: `134 2`
  - PR commit list includes:
    - `1ba588eff663a5be846a8723b90a452dca8cd04c` — old unsquashed PR #526 commit.
    - `a64aa585630f664a83c25253497a62810133e832` — #527 app-server restart commit.
- Merge-tree against current `origin/dev` reports conflicts in:
  - `tests/codex-refresh.test.ts`
  - `tests/injection-model-api.test.ts`

## Classification

`needs-maintainer-rebuild` / `needs-author-rebase`

Reason: retargeting alone is not enough. The branch contains an old copy of the
already-merged #526 change and conflicts with current `dev`. In addition, the
actual #527 feature introduces process discovery/optional SIGTERM behavior and a
large new matching module, so it is not a safe automatic maintainer merge in this
wrong-base cleanup phase.

Audit correction: the comment must explicitly supersede the previous maintainer
guidance that said simple retargeting was enough. #527 is not cleanly stacked on
#526; both #526 and #527 forked from `4618c931`, and the old #526 commit
`1ba588eff663a5be846a8723b90a452dca8cd04c` has a different stable patch-id from
the landed squash `9dd3c42dae2e7feda3581c6d477cf5a0d6e646bf`. A generic rebase
may replay already-landed work.

## Planned maintainer action

Post one maintainer comment on PR #527:

1. State that #526 is merged to `dev`.
2. Ask the author to rebase/cherry-pick only the app-server restart commit onto
   current `dev`.
3. Explicitly request dropping duplicate commit
   `1ba588eff663a5be846a8723b90a452dca8cd04c`.
4. Name the two known conflict files from merge-tree.
5. Ask them to preserve the existing Grok sync failure diagnostic instead of
   reverting it while rebasing.
6. State that process termination/PID matching behavior still needs review after
   the branch is clean; this request does not mean the PR is merge-ready.
7. Explain that after rebuilding and retargeting to `dev`, normal review/checks
   can run.

No branch retarget, force-push, or merge in this work-phase.
