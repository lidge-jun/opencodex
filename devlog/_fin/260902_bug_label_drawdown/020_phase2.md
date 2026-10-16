# 020 — Batch B: rebase service for CONFLICTING bug PRs

Three PRs are `CONFLICTING`/`DIRTY`. The user authorized doing the rebase work rather than
waiting on contributors.

- **#3168** fix(remote): restore authenticated GUI health (@Ingwannu) — 27 files,
  +117/-20, `DIRTY`. Touches the remote-hub surface that moved heavily on `dev` this week,
  which is almost certainly the conflict source. This is #3158's T3 follow-up.
- **#3148** fix(claude): keep proxy admission keys out of subscription launches
  (@Veritas-7) — `CONFLICTING` + `CHANGES_REQUESTED`. Credential-boundary surface;
  overlaps the shipped stale-credential work. Verify against current `src/cli/claude.ts`
  before assuming it still applies.
- **#3135** fix(codex): retain caller main after pool rejection (@luvs01) —
  `CONFLICTING` + `CHANGES_REQUESTED`, draft. The plan guessed #3166 might have subsumed
  it. **The A-gate audit disproved that (A3): it is INDEPENDENT.** #3166 is the *initial
  selection* boundary — keep a healthy request-owned `__main__` pin so Pool discovery does
  not persist an exhausted stored account before the first send. #3135 is the *post-rejection
  retry* — after a stored Pool credential is excluded, still allow one caller-owned main
  send. The landed tree still shows the gap: `src/codex/auth-context.ts:510` retains
  `!options.excludeAccountId` and `src/server/responses/compact.ts:385` still drops on
  `!authCtx.accountId`. So this gets rebased, not closed.

  It is also `unsponsored_surface` on `src/codex/auth-context.ts`, the same credential
  boundary as #3176. Rebasing is ours to do; merging needs the recorded security review.

## Method per PR

1. Fetch the head, rebase onto current `origin/dev` in a scratch branch.
2. Resolve conflicts by reading both sides — never by taking one wholesale.
3. If the contributor branch cannot be pushed to, cherry-pick unique commits onto
   `codex/<n>-carry` preserving author credit, open the carry PR, and close the original as
   `landed-via-maintainer` naming the merge SHA.
4. If `dev` already contains the fix, close as superseded with the landing SHA that did it.

## Verification (C)

Rebased head resolves cleanly, focused tests for the touched subsystem pass, merge SHA
proven an ancestor of `origin/dev`.
