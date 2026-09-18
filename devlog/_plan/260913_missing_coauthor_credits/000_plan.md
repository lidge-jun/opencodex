# Missing co-author credits (origin/dev last 3000)

A maintainer carry that names another author's pull request can still leave that
author invisible on GitHub when the **actual landing commit** has no account-linked
`Co-authored-by` trailer. The last 3,000 commits on `origin/dev` were scanned
against `CREDITS.md`. One new landing is still in that state and is not already
on the page: **#3988 by @rrmlima**, merged through **#4031**.

## Loop spec

- **Loop archetype:** satisfy-spec (attribution repair, not optimization).
- **Trigger:** operator request to find collaborators whose GitHub credit did not
  go up in the last 3000 commits, update the record, open a PR, and merge it.
  HOTL. Unlimited subagents. No local test suite. Push `--no-verify` authorized.
- **Goal:** `CREDITS.md` records the missing landing with a cited maintainer
  quote; the forward commit carries an account-linked noreply trailer; a PR
  targeting `dev` is merged.
- **Non-goals:** history rewrite; tag invalidation; inferring credit from diffs;
  changing `.github/scripts/pr-carry-attribution.cjs`; `bun test` / full suite;
  GitHub native stacks; starring or account actions; merging to `main` (release
  promotion remains maintainer-controlled). Default branch is `main`, so profile
  credit from this forward commit appears after the next `dev`→`main` promotion,
  same as #3787 / #3811.
- **Verifier:** `rg '/pull/3988' CREDITS.md` (must match); `git log -1 --format=%B`
  on the **exact squash object** (`gh pr view --json mergeCommit`) must contain
  `137737127+rrmlima@users.noreply.github.com`; `gh pr view` shows base `dev` and
  merged. PLAN-VERIFIER-REAL-01: `rg` reads `CREDITS.md` as a direct path argument.
  No test file observes this docs change. Local suite: NOT RUN (user-forbidden).
  Merge uses `gh pr merge --squash --match-head-commit` with the trailer in the
  squash message so it cannot be dropped again.
- **Stop condition:** #3988 is on `CREDITS.md`, the PR is merged to `dev`, or
  NOOP if a later origin/dev commit already repaired it.
- **Memory artifact:** this unit
  `devlog/_plan/260913_missing_coauthor_credits/` plus
  `.codexclaw/evidence/4c876c16-4cd9-4a26-bcd5-743ccaa1b137/credits-scan/`.
- **Expected terminal outcomes:** DONE (row + merged PR); NOOP (already repaired);
  BLOCKED (merge protection); UNSAFE (history rewrite / raw email in tree).
- **Escalation:** disputed authorship; a second maintainer approval the session
  cannot provide. Dispatch retirement: main reclaims after two distinct agents
  fail a packet.
- **HOTL bounds:** write `CREDITS.md` only (optional one-line `AGENTS.md` number
  sync rejected — the "27 landings" sentence is historical). New branch from
  `origin/dev` in a clean worktree. Wall clock 4h. Push `--no-verify`. Merge
  authorized.

## Phase map (dependency order)

1. **010 inventory freeze** — persist the scan window and the unique miss. No
   `src/` edits.
2. **020 branch + CREDITS.md row** — create worktree/branch `docs/credits-3988-rrmlima`
   from `origin/dev` first, then insert the #3988 table row and commit with the
   numeric-id noreply trailer.
3. **030 PR and merge** — push that same branch `--no-verify`, fill
   `.github/PULL_REQUEST_TEMPLATE.md` including the exact-head SHA in the
   description, squash-merge with `--match-head-commit` and the trailer in the
   squash message.

## Scope

**IN:** `CREDITS.md` (MODIFY). Forward `Co-authored-by: rrmlima <137737127+rrmlima@users.noreply.github.com>`.
**OUT:** `.github/scripts/*`, `AGENTS.md` (leave the historical 27), any other
carries whose landing already has a GitHub-resolved author or trailer.

## SoT

`CREDITS.md` is the SoT this unit patches. `structure/` is untouched.
