# Phase 6 — merge and integration receipts

Previous D (wp5): #6117 at `d2bfd2808f` verified (red-green 11/11, focused 451/451, flagged `test:changed` files rerun 617/0, sol review PASS). Direction: land #6097, #6112 and #6117 on `dev`, then close the carried originals and record receipts.

## Gate per PR (repeat until merged)

1. `git fetch origin`. If the PR head does not contain `origin/dev`, rebase onto it, check that the diff for this PR's paths is unchanged (or rerun the focused set if the union touched them), push with `--force-with-lease` naming the old head, and wait again.
2. Every Cross-platform CI job and `enforce-target` on the exact head must have concluded `success` (or `skipped` by the workflow's path filter); pending, cancelled or older-head runs don't count. `label` and CodeRabbit are advisory.
3. Codex and CodeRabbit threads: correct findings fixed, others answered.
4. Post a maintainer-integration comment (MAINTAINERS.md: dev-only integration without a second approval) naming the exact head, the CI run id and the security review, then squash-merge with `--admin` and a message that keeps the `Co-authored-by` trailer.

Order: #6097 (oldest CI), then #6112, then #6117. Each merge puts the others behind `dev`, so they are rebased right after it and CI reruns.

## After all three land

- Comment on #5927 and #5497 with a thank-you, the replacement PR and the merge SHA, then close them.
- Comment on #4213 with the merged fixes (image Pool path, trial prompt); keep it open until a user confirms.
- One devlog PR from `dev` carrying `devlog/_fin/260927_release_train_4/provider-compat/` with all phase results.
- Dispatch Cross-platform CI on `dev` (it does not run on push) and confirm the run's head SHA equals the final `dev` head and every job succeeds. If `dev` breaks from this lane's change, fix it through a new PR.

## Audit amendment (sol reviewer, FAIL → folded)

1. CI evidence is the Cross-platform CI aggregate `ci` job on the exact head concluding `success`, plus every job that the workflow requested for that event and lane concluding `success`. Jobs gated to `workflow_dispatch` (Windows shards, macOS control) or to other paths are legitimately skipped on a PR (`.github/workflows/ci.yml:757,839`), and the aggregate already tells real failures from legitimate skips (`ci.yml:1532,1684`). `enforce-target` must succeed for the PR event. After merge, dispatch `ci.yml` on `dev` with the default `lane=all` and apply the same rule (`privacy-gate` is PR-only, `ci.yml:1199`).
2. Union check before every push that follows a rebase: both test-layout registries must list every new test file from the PRs already merged, and the layout guards, file-size ratchet, typecheck and the PR's focused set must pass on the rebased head.
3. Merge with `gh pr merge --squash --admin --match-head-commit <checked head> --subject <title> --body-file <file>`. The body file carries the summary and a standalone `Co-authored-by` trailer where the PR carries someone else's work; read the squash commit back after the merge to confirm the trailer.
