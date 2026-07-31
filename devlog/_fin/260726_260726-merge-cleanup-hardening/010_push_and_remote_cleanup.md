# 010 — WP1: push `dev`, close PR #403, retire three remote branches

This work-phase mutates remote state only. It writes no source files, so the
"diff" here is the exact command sequence with its pre-conditions and the
expected observable result of each step.

## Pre-conditions (re-verify immediately before executing)

| Check | Command | Required value |
|-------|---------|----------------|
| Local tip | `git rev-parse dev` | `3ec8f532bab2b3fb663ca5d8c711b452cf4d806d` |
| Remote tip | `git ls-remote origin refs/heads/dev` | `6d8f05fdce63cb1a9b10491a49a601efba68b03e` |
| Fast-forward safety | `git merge-base --is-ancestor origin/dev dev` | exit 0 |
| Worktree clean | `git status --porcelain` | only ignored/`.DS_Store` noise |
| PR #403 head contained | `git merge-base --is-ancestor 092dd749 dev` | exit 0 |

If the remote tip has moved, STOP and re-evaluate: someone else pushed and the
fast-forward assumption no longer holds.

## Step 1 — push `dev` (MUTATES REMOTE)

```
git push origin dev
```

Plain push, never `--force`: `origin/dev` is an ancestor of local `dev`, so this
is a fast-forward. A non-fast-forward rejection means the pre-condition table is
stale — do not escalate to force.

Expected: `6d8f05fd..3ec8f532  dev -> dev`.

## Step 2 — close PR #403 explicitly (MUTATES REMOTE)

Order matters. Deleting the head branch would close #403 as a silent side
effect; closing it first with the containment proof makes the outcome
intentional and auditable.

```
gh pr comment 403 --body "<containment proof>"
gh pr close 403
```

The comment must state, in English per the repository review guidelines:

- that `092dd749` is now contained in `dev` (`git merge-base --is-ancestor`
  exit 0), so the work shipped rather than being abandoned;
- the integration commit that carried it (`f6520fcd`);
- the one conflict resolved on the way in (`src/lib/process-control.ts`
  `stopProxy`: dev's post-stop port drain kept together with this branch's 409
  `refused` ownership guard);
- that the head branch is being retired as part of this cleanup.

Expected: `gh pr view 403 --json state` → `CLOSED`.

## Step 3 — delete the three approved remote branches (MUTATES REMOTE)

User-approved deletion set, with the SHA each one is expected to point at:

| Remote branch | Inspected SHA | Contained in pushed `dev`? |
|---------------|---------------|----------------------------|
| `claudedesktop` | `6da54a89` | yes — merged as `0a78672f` |
| `codex/260723-grok-build-bridge` | `092dd749` | yes — merged as `f6520fcd` |
| `codex/260726-grok-build-prod` | `092dd749` | yes — same SHA as above |

Verify containment first, then delete:

```
git ls-remote --heads origin claudedesktop codex/260723-grok-build-bridge codex/260726-grok-build-prod
git merge-base --is-ancestor <each SHA> dev   # each must exit 0
git push origin --delete claudedesktop codex/260723-grok-build-bridge codex/260726-grok-build-prod
```

Refuse the delete for any ref whose remote SHA differs from the inspected value
or is not contained in `dev`.

## Step 4 — verify the end state

```
git ls-remote --heads origin
```

Expected absent: `claudedesktop`, `codex/260723-grok-build-bridge`,
`codex/260726-grok-build-prod`.

Expected present: `dev`, `main`, `preview`, `dev2-go`, `feat/macos-app`,
`tmp/dev2-go-source-export` (head of open PR #455), `fix/stall-timeout-600`
(not in the approved deletion set; leave it).

Then prune stale local tracking refs:

```
git fetch origin --prune
git branch -vv
```

## TESTS

No source change, so no unit test applies. The verifier for this phase is the
observable remote state in Step 4 plus the SHA equality in c1.

## Verification (C)

| Criterion | Command | Expected |
|-----------|---------|----------|
| c1 | `git rev-parse HEAD` and `git ls-remote origin refs/heads/dev` | identical SHA |
| c2 | `gh pr view 403 --json state` | `CLOSED` |
| c3 | `git ls-remote --heads origin` | 3 branches absent, preserved set present |

## Rollback

Branch deletion is recoverable while the SHAs remain known: `git push origin
<sha>:refs/heads/<name>` recreates any of the three, and every SHA in this doc
is also reachable from `dev`. A closed PR can be reopened with `gh pr reopen`
as long as its head ref exists, so reopening #403 requires recreating
`codex/260723-grok-build-bridge` first.
