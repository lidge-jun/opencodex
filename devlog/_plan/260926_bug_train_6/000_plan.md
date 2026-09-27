# Bug-PR merge train batch 6 — plan

Branch `codex/bug-train-6` from `origin/dev` at `e807e1e27b`. One PR to `dev`; each carried PR is one
squashed commit with the contributor as author and a `Co-authored-by` trailer. Integration fixes are
separate commits after the carried ones.

## Carried

| PR | Change | Why it is in |
|---|---|---|
| #5914 (@moseoridev) | `withUniqueToolCallIds` wraps the `openai-chat` adapter and remints only tool-call ids that repeat the caller's history or an id already emitted in the response (`-<n>` suffix). | Real infinite-loop bug with Claude Code behind upstreams that mint positional ids (`call-0-0`). Adapter-local, no credential path. |
| #5882 (@Yum-wu) | Native Chat refetches once on a zero-output mid-stream socket reset, gated by the ambiguous-resend allowance; replacement send releases its retained request copy. | Fixes dropped native Chat turns on reset. Maintainer blocker (retained request bytes after reselection) answered by `318520ebd6`; audit must confirm. |
| #5849 (@lzfxxx) | Test-only isolation and budget fixes (serial lane additions, fixture executable, timeouts, launcher wait for config injection). | Removes known flakes on macOS/Linux runners; no runtime change. Needs conflict resolution against current `dev`. |

## Left out, with reason

- #5539 — flips deliberate "preserve caller spelling" tests for unpinned native Chat; a policy change the author marked `[WRONG BRANCH]`.
- #5916, #5831, #5911, #5915 — OAuth / main-account credential paths; they need a written security review (batch 7 candidate).
- #5782, #5800, #5497, #4222 — large feature-sized or conflicting, hygiene failures.

## Build steps

1. `git merge --squash pr-<n>` per PR in order 5914, 5882, 5849; resolve conflicts against `dev`.
2. Check file-size ratchet, test-layout registries, structure docs for each carried file set.
3. Integration commits only if a gate fails.

## Check

- `bun x tsc --noEmit`, `bun run structure:check`, `bun run privacy:scan`.
- Focused: `tests/adapters/openai/openai-chat-tool-call-id-remint.test.ts`, `tests/responses/chat-native-spend.test.ts`,
  `tests/responses/responses-reset-replay.test.ts`, `tests/lib/upstream-retry-zero-output.test.ts`, test-layout guards,
  file-size ratchet, the files #5849 touches.
- Exact-head hosted CI on the batch PR, then `gh pr merge --squash --admin --match-head-commit`.

