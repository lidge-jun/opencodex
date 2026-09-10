# 010 — Phase 1: land PR #3163 (closes #3156)

## What lands

PR #3163 `ingw/fix-copilot-context-3156` — head `486b2f99f3182acf055274755ade9c6571203ac9`.

- MODIFY `src/codex/catalog/provider-fetch.ts` (+49) — read GitHub Copilot's live context
  window at `capabilities.limits.max_context_window_tokens`, preserving the existing
  metadata precedence and the safe-integer boundary for malformed values.
- MODIFY `tests/codex-catalog.test.ts` — routed catalog regression for accepted,
  conflicting, and invalid Copilot payloads.

No local code is written in this phase; the diff is the contributor's.

## Why it is landable as-is

`gh pr checks 3163` reports 23 checks, all pass, on the exact head above. The PR body
carries root cause, precedence reasoning, and per-suite verification counts
(`tests/codex-catalog.test.ts`: 255 pass / 0 fail).

## Execution

1. Re-read `gh pr view 3163 --json headRefOid,mergeStateStatus` to confirm no drift.
2. `gh pr merge 3163 --squash --admin --delete-branch`.
3. `git fetch origin dev` and `git merge-base --is-ancestor <merge> FETCH_HEAD`.
4. Confirm #3156 auto-closed; `Closes #3156` targets `dev`, which is not the default
   branch, so close it by hand if GitHub did not.

## Verification (C)

- `gh pr view 3163 --json state,mergeCommit` reports MERGED with a SHA.
- ancestry check exits 0.
- `gh issue view 3156 --json state` reports CLOSED.

