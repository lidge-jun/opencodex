# 040 — phase 4: publish the stack

No production code. This phase turns the three landed layers into three reviewable
pull requests.

## The chain

```
codex/260809-vision-sidecar-card   → PR #3 (base: codex/260809-vision-sidecar-api)
codex/260809-vision-sidecar-api    → PR #2 (base: codex/260809-vision-eligibility-core)
codex/260809-vision-eligibility-core → PR #1 (base: dev)
──────────────────────────────────── dev
```

Three layers, inside the 2-4 range `DEV-STACK-01` recommends. Each is separately
mergeable: the predicate is inert without a caller, the API layer is a real
server-side guard with or without the GUI, and the GUI layer degrades to the legacy
list against an older server (`visionModels` is optional by design).

## Sequence

1. Confirm the worktree is on `origin/dev` and clean; never touch the `dev`
   branch checked out in `/Users/jun/Developer/new/700_projects/opencodex`.
2. Create each branch from the tip of the one below and commit that layer's files
   only. Keep the devlog unit on layer 1 so the plan lands with the foundation.
3. `git push -u origin <branch>` per layer, bottom-up.
4. `gh pr create --base <branch below> --head <branch>` per layer. Pass `--base`
   explicitly on every one: omitted, `gh` falls back to `branch.<name>.gh-merge-base`
   or the repository default branch, which would silently retarget a layer at trunk.
5. `gh pr view <n> --json baseRefName,headRefName,isDraft` per PR as the evidence
   this phase owes.

## PR bodies

Every PR fills `.github/PULL_REQUEST_TEMPLATE.md` — Summary, Verification,
Checklist — because `enforce-target` rejects thin or malformed descriptions.
The GUI layer's description **must** embed a screenshot: the gate requires one from
any PR whose title or description mentions `gui`.

Each body also carries the stack map (`DEV-STACK-03`):

```markdown
**Stack** (merge bottom-up):
| # | PR | Layer | Review focus |
|---|----|-------|--------------|
| 3 | #c | dashboard vision card | layout, non-localized effort values |
| 2 | #b | management API | the 400 gate and the allowed-list payload |
| 1 | #a | vision eligibility core ← you are here | the predicate and its inversion cases |
```

## Cascade rule

If review changes a lower layer, rebase upward with
`git rebase --update-refs`, re-push with `--force-with-lease` (never bare
`--force`), then verify per `DEV-STACK-02`: `git log --oneline <lower>..<upper>`
shows only the upper layer's own commits, and each PR's base ref still names the
branch below. Review state is assumed stale after any cascade.

## Authorization boundary

Push and PR creation are authorized for this unit. **Merging is not** — not the
bottom PR, not auto-merge, not a queue bypass. Merging is a separate decision that
stays with the user (`DEV-STACK-04`, `DEV-GIT-PUSH-01`).

## Acceptance

| Row | Verifier | Covered? |
|---|---|---|
| three branches exist with the right ancestry | `git log --oneline <lower>..<upper>` | yes |
| three PRs open with correct bases | `gh pr view --json baseRefName,headRefName` | yes |
| bodies satisfy the template | `enforce-target` on the PR | yes, once CI runs |
| nothing merged | `gh pr view --json state` shows OPEN | yes |
