# 050 — wp6: #2497 adjudication

Head `86a49e852`, `MarcTCruz` fork (`maintainerCanModify: true`), **399 behind**,
merge-tree **CONFLICT**. 20 files including `src/oauth/chatgpt.ts`,
`src/codex/account-store.ts`, `src/codex/auth-context.ts`,
`src/server/responses/core.ts`, `src/server/responses/codex-auth-error.ts`.

## The question this phase actually answers

The user authorized fixing what can be fixed, so the question is not "may I touch it"
but **"can this rebase be done without me deciding OAuth semantics on the author's
behalf?"**

Attempt the rebase and classify every conflict:

- **Mechanical** — imports moved, a function renamed upstream, formatting. Resolvable
  without deciding anything about token lifetime, refresh ordering, or replay identity.
- **Semantic** — the upstream range and the PR both changed how a token is refreshed,
  when a credential is rebound, or which account owns a replay. Resolving these means
  authoring an OAuth refresh path and then reviewing my own credential code.

If every conflict is mechanical: push the rebase, run CI, hand a current PR to a
security reviewer. If any is semantic: stop, record the exact hunks, return
**NEEDS_HUMAN**.

My prior expectation is that 399 commits across `auth-context.ts` and `core.ts` —
both heavily rewritten in that window — will produce semantic conflicts. That is a
prediction, and this phase tests it rather than assuming it. The previous round
recorded #2497 NEEDS_HUMAN without attempting the rebase; defensible then, not now
that fork pushes are authorized.

## Hard limits regardless of outcome

- `AGENTS.md`: conflict analysis on an unfixed OAuth path goes to `.tmp/`, never a
  tracked directory.
- `MAINTAINERS.md`: this surface needs explicit security review. Even a perfectly
  clean rebase does not make it mergeable by me.
- Never force-push a resolution that changes behavior the author did not write.

## Verification (C)

```bash
bun x tsc --noEmit
bun test tests/chatgpt-oauth.test.ts
bun test tests/codex-account-store.test.ts
bun test tests/codex-main-account-refresh.test.ts
bun test tests/responses-native-main-refresh.test.ts
bun test tests/core-lab-boundary.test.ts
```

One at a time; full suite on `lidge` via `ocx-run`.

## Terminal outcome

**NEEDS_HUMAN** or **UNSAFE**, with the conflict classification as evidence. A clean
mechanical rebase upgrades it to "current and reviewable", which is the most this
round can honestly deliver on an OAuth refresh path.
