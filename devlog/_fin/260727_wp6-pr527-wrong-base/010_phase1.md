# 010 — Phase 1: PR #527 request author rebase

## MODIFY / NEW / DELETE map

No production code changes.

External GitHub action only:

- NEW PR comment on https://github.com/lidge-jun/opencodex/pull/527.

## Comment content requirements

The comment must include:

- `#526` has been merged to `dev` as
  `9dd3c42dae2e7feda3581c6d477cf5a0d6e646bf`.
- Current #527 base/head:
  - base `codex/catalog-written-signal@ce716cc117ab23e4420c8c9fe860959968f66cdc`
  - head `codex/app-server-restart@a64aa585630f664a83c25253497a62810133e832`
- Why retarget alone is insufficient:
  - branch still carries old PR #526 commit
    `1ba588eff663a5be846a8723b90a452dca8cd04c`;
  - merge-tree against current `dev` conflicts in
    `tests/codex-refresh.test.ts` and `tests/injection-model-api.test.ts`.
- Requested author action:
  - rebuild #527 on current `dev`;
  - keep only the app-server restart change on top of `dev`;
  - drop duplicate commit `1ba588eff663a5be846a8723b90a452dca8cd04c`;
  - retarget the PR to `dev` after that.
- Review boundary:
  - supersede the prior maintainer note that said simple retargeting was enough;
  - do not remove the existing Grok sync failure diagnostic in `src/cli/index.ts`
    during the rebase;
  - process termination/restart behavior will be reviewed after the branch is
    clean and checks run on `dev`.
  - unresolved process/PID review findings mean this request is not merge
    approval.

## Verification

- `gh pr view 527 --json ...` captures live pre-comment state.
- `git merge-tree origin/dev origin/codex/app-server-restart` captures conflict
  evidence.
- `gh pr comment 527 --body-file <tmp>` returns a comment URL.
- `gh pr view 527 --json comments` confirms the new maintainer comment exists.
