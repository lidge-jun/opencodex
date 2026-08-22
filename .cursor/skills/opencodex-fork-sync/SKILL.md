---
name: opencodex-fork-sync
description: Use when performing an opencodex public-fork sync, updating vendor/main or vendor/dev, merging upstream/main into origin/main, rebuilding run/main then merging into main, or resolving fork-sync conflicts.
---

# opencodex fork sync

Read `docs/fork/OWNED.md` before resolving any conflict. Agents analyze, recommend, and test; a human confirms and lands `main`.

## Roles

| Role | Does | Must not |
|---|---|---|
| Coordinator | Fetches, opens the sync branch, lists conflicts, dispatches workers, assembles the decision table, pushes after confirmation | Resolve hunks itself or use whole-tree `-X ours` |
| File worker | Owns one conflict domain and reports 3-way intent, options, recommendation, and tests | Touch another domain or commit `main` |
| Test worker | Runs named tests; runs typecheck/full suite for shared runtime, routing, config, or server changes | Claim green without command output |
| Absorbed-patch worker | Compares overlay patches with upstream and identifies duplicates to drop | Keep a patch merely because the fork wrote it first |

Parallelize independent domains. Serialize `src/adapters/google.ts` and `src/server/responses/core.ts`.
Workers must be **Composer 2.5** or **GPT 5.6 Luna**.

## Sync commands

```bash
git fetch upstream origin --prune
git switch vendor/main
git merge --ff-only upstream/main
git switch vendor/dev
git merge --ff-only upstream/dev
# PR-base only; do not merge vendor/dev into origin/main
git switch -c sync/upstream-YYYYMMDD origin/main
git merge --no-ff vendor/main
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
gh pr create --base main --head sync/upstream-YYYYMMDD --title "sync: upstream YYYYMMDD" --body "<summary and verification>"
gh pr merge <number> --merge
```

Open and merge the sync PR on the fork into `main` only after human confirmation. `vendor/main` remains an exact fast-forward of `upstream/main`; `vendor/dev` remains an exact fast-forward of `upstream/dev` for PR bases only. Do not commit overlay work on either vendor branch.

## Rebuild daily `main`

`origin/main` is the daily driver (release + overlay + selected `feat/*`). Rebuild on disposable `run/main`, then merge into `main`. Never force-push `main`.

```bash
git switch -C run/main overlay
git merge <selected-origin-feat-head>
git push --force-with-lease origin run/main
git switch main
git merge --no-ff origin/run/main
git push origin main
```

Do not retarget those upstream PRs to upstream `main`, and stop replaying a `feat/*` once it is contained in `vendor/main`.

## Conflict report (required for every conflict)

```text
file/hunk:
upstream intent:
overlay intent:
classification: upstream-owned | fork-owned | shared-hotspot
options: theirs+reapply | ours | true merge | drop absorbed | extract to src/fork/
recommendation: (correctness, then features, then fewer future conflicts)
exact test commands:
```

| Classification | Default |
|---|---|
| `upstream-owned` | Take theirs; re-apply still-needed fork intent as a small new commit |
| `fork-owned` | Take ours |
| `shared-hotspot` | Manual/agent report; preserve upstream control flow and re-fit fork behavior |
| Lockfile | Take theirs; regenerate if the overlay added dependencies |
| Absorbed idea | Drop ours |

## Decision policy

| Mode | Cases |
|---|---|
| Auto-propose (still show) | Whitespace, comments, locale-only, lockfile theirs + reinstall |
| Always wait | Auth, OAuth, adapters, `src/server/responses/core.ts`, workflows, behavior changes |
| Never | Skip failing tests; force-push `main`; delete a fork feature just to clean the merge without an explicit drop decision |

Tests:

```bash
bun test tests/<matching>.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Use the focused matching adapter test for provider changes (for example `bun test tests/google-hardening.test.ts`). Use typecheck and the full suite for shared runtime/routing/config/server changes; use privacy scanning for logging or credential changes. Do not claim completion without output.

Never run `git config`; never use whole-tree `git merge -X ours` or `-X theirs`; never force-push `main`; never skip a failing test. Never open upstream PRs from `main`, `overlay`, `run/main`, `run/dev`, or `dev`. Upstream PRs come from isolated `feat/*` branches based on `vendor/dev`.
