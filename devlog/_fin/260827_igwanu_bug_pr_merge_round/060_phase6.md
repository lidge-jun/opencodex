# 060 — wp7: #2497 adjudication and round close-out

## #2497 — Fix native main token refresh and replay

Lane **NEEDS_HUMAN**. Head `86a49e852`, draft, **CONFLICTING/DIRTY**,
**386 commits behind dev**, 5 checks with `enforce-target` and `hygiene` failing.
Author `MarcTCruz`.

The only PR in the round whose merge-tree **conflicts**, so no merged-tree compile
evidence exists or can exist without a human-authored rebase.

20 files: `src/codex/account-store.ts`, `account-usability.ts`, `auth-context.ts`,
`main-account.ts`, `model-entitlements.ts`, `src/config/atomic-write.ts`,
`src/lib/test-home-guard.ts`, **`src/oauth/chatgpt.ts`**, `src/routing/analytics.ts`,
`src/server/responses/codex-auth-error.ts`, `compact.ts`, **`core.ts`**,
`src/usage/log.ts`, plus seven test files.

Two disqualifying conditions, either sufficient alone:

1. **Security surface.** OAuth token refresh and replay, `src/oauth/chatgpt.ts`,
   the account store, auth-error handling. `MAINTAINERS.md` requires explicit
   security review; `AGENTS.md` names credential/token handling and OAuth flows as
   release-blocker-class triggers.
2. **386 commits of drift with a real conflict**, on files (`core.ts`,
   `auth-context.ts`) that `dev` changed in that window. Resolving those conflicts
   myself means rewriting an OAuth refresh path on the author's behalf and then
   reviewing my own credential-handling code.

This matches the previous round's disposition and nothing has improved since — it
has drifted further.

Disposition: **NEEDS_HUMAN**, recorded with the unblocking condition — author
rebase onto current `dev`, then human security review of the refresh/replay path.

## Round close-out

Produce `070_outcome.md` with the final disposition table: PR, lane, terminal
state, merge SHA or explicit reason. Every row cites evidence that exists now.

```bash
git fetch origin && git log --oneline origin/dev | head -20
git rev-parse dev origin/dev          # must be equal
gh pr list --repo lidge-jun/opencodex --state open --label bug
bun x tsc --noEmit
```

Plus the keystone proof: a PR red on `ci`/`macos`/`test 3/4`/`gates` before wp2
is green afterwards with no change to its own diff.

## Criteria mapping

- c1 — the 070 table covers all 13.
- c2 — the 000 merged-tree table plus the tsc-probe verification.
- c3 — per-PR focused receipts recorded in each phase doc.
- c4 — `git log origin/dev` shows only merge commits from PRs targeting `dev`.
- c5 — #2745, #2638, #2497 carry named security-review reasons, not silent skips.

## Honest terminal outcome

This round will not end with 13 merges. Three PRs (#2693, #2638, #2497) require
author or human action that no autonomous work substitutes for. The round is DONE
when each of the 13 has a recorded, evidenced disposition — which is what the goal
states — not when the open-PR count reaches zero.
