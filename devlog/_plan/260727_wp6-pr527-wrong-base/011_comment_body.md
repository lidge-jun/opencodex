#527 follow-up after #526 landed:

Please do not just retarget this PR to `dev`. My earlier note saying retargeting would be enough is now superseded.

Current live state:

- #526 is merged into `dev` as `9dd3c42dae2e7feda3581c6d477cf5a0d6e646bf`.
- #527 is still based on `codex/catalog-written-signal@ce716cc117ab23e4420c8c9fe860959968f66cdc`.
- #527 head is `codex/app-server-restart@a64aa585630f664a83c25253497a62810133e832`.
- The branch still carries the old pre-squash #526 commit `1ba588eff663a5be846a8723b90a452dca8cd04c`, so a generic rebase can replay already-landed work.
- A read-only merge-tree against current `dev` conflicts in:
  - `tests/codex-refresh.test.ts`
  - `tests/injection-model-api.test.ts`

Requested next step: please rebuild this PR from current `dev`, porting only the app-server stale-process warning / optional restart behavior from `a64aa585`, and drop the duplicate `1ba588e` catalog-write-signal commit. Then retarget the PR to `dev` so the normal checks and reviews run on the right base.

One rebase-specific note: please preserve the current Grok sync failure diagnostic in `src/cli/index.ts`; the existing #527 head appears to revert that back to silent best-effort catches.

This is not merge approval yet. The process detection / optional SIGTERM path still needs review on a clean `dev`-based branch.
