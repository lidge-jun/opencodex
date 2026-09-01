# 000 — bug_pr_closeout_stack: Plan

## Objective

Close as many open opencodex bugs and pull requests as can be closed with evidence,
in one session, without running the repository-wide local suite. Two mechanisms:

1. **Merge train** for pull requests that already carry a maintainer-reviewed body
   and a green or known-flake-only exact-head CI run.
2. **Stacked implementation** for issues whose defect is fully visible in the tree,
   each landing as its own squash merge into `dev`.

Evidence base collected 2026-09-02 in this worktree:

- 47 open PRs, 55 open issues (`gh pr list`, `gh issue list`).
- `gh pr checks 3163` — 23/23 pass on head `486b2f99f3182acf055274755ade9c6571203ac9`.
- `gh pr checks 3166` — head `17f01162ad404f1bcee7d7f00998fc0e143365e5`; `test 3/4` red on
  `tests/responses-state.test.ts > late async spill completion cannot overwrite the shutdown
  fallback` with `ETIMEDOUT` out of `src/responses/spill-store.ts:232` (ACL budget exhausted
  under runner load). The PR touches `src/codex/auth-context.ts` only — the failure is a
  timing flake in an unrelated subsystem.
- `gh pr checks 2083` — 24/24 pass, `APPROVED`, `CLEAN`; #2986 is its maintainer carry on
  current `dev` with an independent security review recorded in the PR body.

## Loop-spec

- Loop archetype: verifier-defined (each item has a binary landing proof).
- Write scope: `src/cli/models.ts`, `src/combos/request.ts`, `src/server/responses/core.ts`
  (read-only for phase 5), `docs-site/src/content/docs/reference/cli/lifecycle.md`,
  `docs-site/src/content/docs/reference/configuration/server.md`, matching `tests/` files,
  and this devlog unit.
- Out of scope: releases, promotion to `main`/`preview`, npm publish, deployment, auth or
  credential rewrites beyond what a named issue requires, other worktrees.
- Verification policy (user-directed): **no repository-wide local suite**. CI runs behind the
  work — each phase pushes, opens its PR, and merges by admin; CI is then tracked and judged
  at the end of the train rather than blocking each merge.
- Merge mechanism: `gh pr merge --squash --admin`.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp0 | 000 | this roadmap; goalplan lock | — |
| wp1 | 010 | land PR #3163 (closes #3156) | wp0 |
| wp2 | 020 | land PR #3166 (closes #3157) | wp1 |
| wp3 | 030 | land carry PR #2986; close #2083 landed-via-maintainer | wp2 |
| wp4 | 040 | implement #3094 — `ocx models new-policy`/`new-arrivals` dispatch | wp3 |
| wp5 | 050 | implement #3108 — combo default reasoning effort reaches the target | wp4 |
| wp6 | 060 | implement #3158 T19/T21 — `/readyz` shape + three hub/remoteGui config keys | wp5 |

wp4–wp6 are a stack: each branch is cut from the previous one's landed `dev`, so a lower
layer's merge is the upper layer's base (DEV-STACK-01).

## Accept criteria

- c-1..c-6: one per work-phase, each requiring a merge SHA proven an ancestor of
  `origin/dev` via `git merge-base --is-ancestor <merge> FETCH_HEAD`, plus the issue closed.
- c-7: at least three bug/PR items closed with landing proof.
- Final CI judgment: `gh run list --branch dev` green on the last landed `dev` head, or every
  remaining red identified as the known `responses-state` spill flake.
