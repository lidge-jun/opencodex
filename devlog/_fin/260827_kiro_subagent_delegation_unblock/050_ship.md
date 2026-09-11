# wp3 — ship: branch, gates, PR against `dev`

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp3`

## What is being shipped

Branch `codex/kiro-subagent-delegation-unblock`, cut from `origin/dev`
`a57b9620`, three commits:

| commit | content |
|---|---|
| `0cfbb394a` | wp1 — enable the code-mode catalog nudge for Kiro |
| `e1019d30d` | wp2 — reserve catalog room for the code-mode execution path |
| `605c07bd5` | wp2 evidence devlog |

## Pre-flight state

| check | result |
|---|---|
| `bun x tsc --noEmit` | exit 0 |
| `bun run test` | exit 0, 15185 tests / 951 files |
| `bun run privacy:scan` | `Privacy scan passed` |
| working tree | clean |
| `gh auth status` | logged in as `lidge-jun` |

`privacy:scan` is run because `src/AGENTS.md:27` requires it for changes touching
requests or logging, and this unit changes what is injected into an upstream
request body.

## PR requirements this repo enforces

From `AGENTS.md` and `.github/PULL_REQUEST_TEMPLATE.md`:

- Target `dev`. `main` is release-only, and the `enforce-target` check rejects
  wrong-base PRs.
- Fill every template section: Summary, Verification, Checklist. `enforce-target`
  also rejects empty, thin, or malformed descriptions.
- No GUI screenshot needed: nothing under `gui/` is touched.
- No `Closes #N`: this unit has no filed issue.

## Push authorization

`DEV-GIT-PUSH-01` makes pushing an ESCALATE action requiring explicit user
approval. Granted in the originating request: *"구현완료하고 pr 올려놔 별도 브랜치
잡고 출발"* — that names the branch and the PR, so the approval covers pushing
this branch and opening this PR. It does not extend to promoting to `main`,
merging, or any other remote mutation.

## Sequence

1. `git push -u origin codex/kiro-subagent-delegation-unblock`
2. `gh pr create --base dev` with the filled template
3. Verify the PR renders, targets `dev`, and reports its checks

## Acceptance

PR exists, targets `dev`, description carries all three template sections with
real verification output, and the URL is reported to the user.
