# wp2 — Promote `dev` onto `preview`

## Preconditions

wp1 closed with no surviving blocker. `origin/dev` still at `9af3a7beb`; if it moved,
re-measure before branching — the promotion is of a specific tree, not of a branch name.

## Version

`preview` must carry a `-preview.` version or `release.yml` refuses the dispatch.
Prior names are date-suffixed: `v2.38.0-preview.20260831`, `v2.36.0-preview.20260830`,
`v2.36.0-preview.20260829`, `v2.34.0-preview.20260827`. Today's is
**`2.39.0-preview.20260901`**.

This means the promotion branch is not a byte-identical copy of `dev`: `package.json`
carries `2.39.0` on `dev` and must read `2.39.0-preview.20260901` on `preview`. That
one-line difference is the only intended divergence.

## Steps

1. `git fetch origin`, branch `codex/promote-preview-23900901` from `origin/preview`.
2. Merge `origin/dev` into it. Expect exactly one conflict — `package.json` version —
   resolved to `2.39.0-preview.20260901`. Any other conflict is unexpected and stops
   this phase for inspection.
3. Verify the tree matches `dev` except for that version line:
   `git diff origin/dev HEAD -- . ':!package.json'` must be empty.
4. Push, open the PR against `preview`.
5. `enforce-target` will fail and convert the PR to draft — `ALLOWED_BASES` is
   `["dev"]`. This is expected for every promotion PR and was handled identically for
   #3001, #3037, #3072, #3073. `gh pr ready`, then admin merge.
6. Wait for the **push-event** Cross-platform CI run on the resulting merge commit, and
   for Service lifecycle, which will be triggered because `package.json`,
   `src/cli/index.ts` and `src/service.ts` are in the merge.

## The failure this phase exists to not repeat

v2.38.0's preview promotion merged and then its CI failed, so the publish was never
dispatchable and the preview dist-tag silently stayed two cycles behind. A merged
promotion branch is not a releasable one. This phase is complete only when the promotion
SHA has a green push-event `ci.yml` run, not when the PR is merged.

If the macOS/shard failure recurs on the new promotion commit, rerun the failed jobs once
(`gh run rerun <id> --failed`). A second failure at the same assertion is a real defect
and escalates to a new work phase rather than being re-run until green.

## Evidence to capture

- promotion merge SHA and `git ls-remote origin refs/heads/preview`
- `gh api actions/runs?head_sha=<sha>` showing `Cross-platform CI: success` (push) and
  `Service lifecycle: success`
- the `package.json`-only diff proof from step 3

## Executed

PR #3123, merged at `75f3895c14965205be694e8ebb8e93f472630539`. The merge produced
exactly the one predicted conflict (`package.json`), resolved to
`2.39.0-preview.20260901`; `git diff origin/dev HEAD -- . ':!package.json'` was empty.
`bun test tests/release-version-line.test.ts` passed 3/3 on the branch before push —
the same file that refused v2.38.0's preview.

Push-event Cross-platform CI: run `33462203719`, success on rerun. Service lifecycle:
success. The first attempt failed on `tests/server-auth.test.ts:2288`, analyzed in
`070_outcome.md` and not a regression in this delta.
