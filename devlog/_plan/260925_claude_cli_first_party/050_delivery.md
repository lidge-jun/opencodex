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

The full `bun run test` is the default before review readiness. If it is impractical (concurrent
worktrees on this machine), record why, the exact focused commands and results, and what is left to CI.

## Privacy self-check before the first push

Grep the push range for account identifiers seen during research (the maintainer's e-mail, org id,
org name) and for any absolute home paths in committed docs: `git log -p origin/dev..HEAD | rg -n -i '<ids>'`.
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
