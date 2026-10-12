# 050 — wp6 Delivery: verification, PR, exact-head CI

## Goal

Land the branch as one PR to `dev` with evidence a reviewer can check. No merge, no release, no
edits to the live `~/.claude` or `~/.opencodex`.

## Local gates (run from the task worktree at the final head)

| Command | Reads this unit's target because |
|---|---|
| `bun run typecheck` | `tsconfig.json:15` includes `src` only; it type-checks the changed source, not the test files |
| `bun test <every test file named in 010–040>` | direct arguments |
| `bun run test:changed` | tests whose import graph reaches files changed since the `dev` merge base; selects nothing for docs-only commits; subprocess/golden consumers named in 030/040 run explicitly |
| `bun test tests/lab/core-lab-boundary.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/cli/cli-capabilities.test.ts tests/ci-workflows/skill-ocx.test.ts` | boundary, layout, ratchet and registry guards the change can trip |
| `bun run structure:check` | structure/ ownership and invariant bindings for touched areas |
| `bun run skill:surface:check` | generated skills/ocx surface vs CAPABILITIES |
| `bun run privacy:scan` | whole tree incl. devlog |
| `bun run lint:gui` and `cd gui && bun test <each gui test file named in 040>` | direct file arguments; `bun run test` in gui expands to the whole `tests` directory |

Superseded by the maintainer directive (see "wp6 P amendment"): no local test suite, including the full `bun run test`, is run for this unit; hosted CI owns test execution.

## Privacy self-check before the first push

Grep the push range for account identifiers seen during research (the maintainer's e-mail, org id,
org name) and for any absolute home paths in committed docs: `git log -p origin/dev..HEAD | rg -n -i -f .tmp/privacy-ids.txt` (the pattern file lives in the gitignored `.tmp/` of the task worktree and lists the account e-mail, org id and org name seen during research plus the macOS home-directory prefix; the identifiers themselves are never written into a tracked file). Exit 1 (no match) is the pass condition..
A hit is fixed by rewriting the unpushed commits.

## Push and PR

- `git push -u origin feat/claude-cli-first-party` (user-authorized for this task).
- `gh pr create --base dev --head feat/claude-cli-first-party --title "feat(claude): independent first-party switch for the Claude Code CLI" --body-file <tmp>`
- Body follows `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist). Summary leads with the
  problem (Desktop 1P silently routed every terminal `claude`), the new behaviour matrix, and the accepted
  limitation from 000. GUI screenshot uploaded to the `pr-assets` branch and linked by commit SHA, never
  committed to this branch.

## Exact-head CI

`gh pr view <PR> --json headRefOid,statusCheckRollup`, then `gh run list --commit <HEAD>` and
`gh run view <run> --json event,headSha,attempt,status,conclusion,jobs`. Report run ids, events and
conclusions; pending, skipped, cancelled and approval-blocked are reported as such, never as passing.

## wp6 P amendment (no-local-suites directive and rebase)

Supersedes the local-gates table above where it names test runs:

1. Rebase `feat/claude-cli-first-party` onto the current `origin/dev` (`git fetch origin dev`, `git merge-tree --write-tree HEAD
   origin/dev` must report no conflicts first, then `git rebase origin/dev`). The branch is unpublished, so this rewrites
   nothing anyone has pulled.
2. Local gates at the rebased head, non-suite only: `bun run typecheck`, `(cd gui && bun x tsc -p tsconfig.app.json --noEmit)`,
   `bun run lint:gui`, `bun run skill:surface:check`, `bun run structure:check`, `bun run privacy:scan`,
   `git diff --check origin/dev..HEAD`, plus the account-identifier grep of the push range.
3. Push, open the PR (template sections; Verification states plainly that local test suites were not run on the maintainer's
   instruction and lists the static gates, the dashboard render check (wp5: the branch server started with `bun run src/cli/index.ts start` under an isolated temp HOME, driven by agbrowse — a manual render observation, not a test suite), and the hosted CI runs), upload the screenshot
   to the `pr-assets` branch and link it by commit SHA.
4. Check = exact-head hosted CI: record run ids, events and conclusions; a failing test job is a real result to fix in a
   follow-up commit on this branch, never rerun blindly.
