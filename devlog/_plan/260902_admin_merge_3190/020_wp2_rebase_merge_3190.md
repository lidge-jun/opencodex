# 020 — wp2: rebase, exact-head CI, admin-merge #3190, close #2734

Depends on: wp1 landed on `origin/dev` so a GitHub merge of this head no longer inherits the 091 privacy failure.

## What #3190 is

PR #3190, author `lidge-jun`, branch `codex/adaptive-reasoning-effort-2731`, targets `dev`.
Two unique commits on merge-base `e40245e4c` (#3169):

- `e1fc1729b` feat(combo): adapt reasoning effort to target capabilities
- `5f8cd24dd` test(combo): cover adaptive effort mode and the tool-bearing opt-out

35 files. Completes #2731. Supersedes draft #2734. Opt-in `reasoningEffortMode: "adaptive"` (default remains `"strict"`) plus `omitReasoningEffortWithToolsModels` on openai-chat, plus the dashboard round-trip #2734 left open.

Not a security-boundary PR: no auth, credential, workflow, release, or dependency-install change. Admin merge still needs exact-head CI, not an empty `--required` list.

## Why rebase, not merge-as-is

Head is 19 commits behind `origin/dev` at freeze. GitHub merge with current `dev` is what made Privacy scan fail. After wp1, rebase onto the new `origin/dev` so:

1. the unique two commits sit on the privacy-clean tip;
2. later landings (#3172 combo default effort, #3175 failover e2e assertion, #3189 alias overlay, …) are in the base rather than conflicted at merge time.

Do not force-push the original contributor-looking branch if a rebase rewrite is cleaner as a new maintainer branch. Prefer:

```
git fetch origin
git switch -C codex/adaptive-reasoning-effort-2731-rebased origin/dev
git cherry-pick e1fc1729b 5f8cd24dd
```

If cherry-pick is clean, push `--no-verify` and either retarget #3190's head or open a carry PR that closes #3190. If #3190 still points at the old branch and `maintainerCanModify` is ourselves, pushing the same branch after rebase is allowed; use `--force-with-lease` only on that topic branch, never on `dev`.

Conflict policy: stop and inspect. Likely touch points are combo catalog / openai-chat / GUI combo serializer because #3172 already landed combo default-effort behavior. Do not silently drop #3190 tests.

## PR hygiene

Title/body mention combo GUI. `enforce-target` requires a screenshot of the UI change. #3190 already carries a placeholder image; after rebase confirm the body still has Summary / Verification / Checklist and a real screenshot, not a 1×1 dummy. If the dummy is still there, replace it with a captured Capabilities-section shot from a local GUI build (no full suite).

## Steps

1. Confirm wp1 merge is an ancestor of `origin/dev`.
2. Cherry-pick or rebase the two unique commits onto that tip.
3. If conflicts: resolve against current combo/openai-chat/GUI code; keep both the adaptive-mode behavior and the #3172 default-effort behavior.
4. Focused checks only: `bun x tsc --noEmit`; `cd gui && bun x tsc --noEmit` if GUI files changed; `bun test tests/codex-catalog.test.ts tests/openai-chat-hardening.test.ts tests/combo-management-api.test.ts tests/combo-workspace-data.test.ts tests/combos.test.ts tests/management-provider-validation.test.ts` if those files still exist after rebase; `bun run privacy:scan`.
5. Push `--no-verify`. Refresh #3190 (or open the carry). Fill the template.
6. Wait for exact-head Cross-platform CI on the new SHA. Record the run id. `gates` Privacy scan must be SUCCESS. Known macOS websocket flake: rerun that job, compare against #3128, do not rewrite unrelated code.
7. Admin squash merge: `gh pr merge <n> --squash --admin --delete-branch` with comment naming the bypass (owner-authored, CI green on exact head, no security-boundary).
8. Proof: `git fetch origin && git merge-base --is-ancestor <merge> origin/dev`.
9. Close #2734 with a comment: superseded by the landed #3190 merge SHA. Close #2731 only if the landed PR says Closes and the issue is still open — `dev` is not the default branch, so GitHub will not auto-close; close manually if the PR claims it.

## Accept

- Unique #3190 behavior is on `origin/dev` (adaptive mode + tool-bearing omit + GUI round-trip).
- Exact-head CI rollup for the merged SHA is recorded, including `gates` SUCCESS.
- `git merge-base --is-ancestor <merge> origin/dev` is true.
- #2734 is closed with credit.
- This worktree is not left on a deleted remote branch (switch back to a live topic or `origin/dev` tracking branch after delete).

## Activation

Trigger: after merge, `git fetch origin && git merge-base --is-ancestor <merge> origin/dev`; exit 0. Negative: if the merge commit is missing, do not claim DONE.
