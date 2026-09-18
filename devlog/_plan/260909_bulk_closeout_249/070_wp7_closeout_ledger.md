# 070 — wp7 closeout, merge ledger (append-only)

Rows are appended by each work-phase's D. Landing SHA proof: `git fetch origin dev &&
git merge-base --is-ancestor <sha> FETCH_HEAD` → exit 0. Closure proof: the comment URL from
`gh issue close` / `gh pr close` / merge, and `gh issue view N --json state` = CLOSED.

| WP | Item | Disposition | Carry branch / PR | Head SHA | CI run id | Landing SHA | Ancestry proof (cmd + exit) | Original closed (comment URL) |
|----|------|-------------|-------------------|----------|-----------|-------------|-----------------------------|-------------------------------|
| wp0 | roadmap unit | docs | (local commit on dev checkout; PR at wp7) | — | — | — | — | n/a |

## Removal counter (target 25–30)

| Bucket | Planned | Landed | Closed |
|--------|---------|--------|--------|
| wp1 PR merges | 9 | 0 | — |
| wp1b PR merges (gated) | 2 | 0 | — |
| wp2 PR merges | 7 | 0 | — |
| wp3 PR merges | 6 | 0 | — |
| wp4 issue fixes | 4 | 0 | 0 |
| wp5 closes (issues 8 + PRs 4) | 12 | — | 0 |
| issues auto-closed by merges | 7 | — | 0 |
| **Total** | **47** | 0 | 0 |

## Verifier policy

No repository-wide local suite is run in any phase; focused files, `bun run typecheck`,
`bun run test:changed`, and exact-head hosted CI only. Pushes use `--no-verify`; mutating Git
uses `git -c core.hooksPath=/dev/null`. Contributor PRs have no `ci.yml` run at head until a
maintainer approves workflows; a LAND is not eligible for merge until that run exists and is
green at the exact head SHA (skipped/cancelled ≠ pass).

## wp7 stop condition (authoritative)

Every LAND/REIMPLEMENT row has a landing SHA with ancestry exit 0 and (where applicable) an
original-closure link; every CLOSE row has a comment URL and `state: CLOSED`; the removal
counter totals ≥ 25; `bun run privacy:scan` exit 0 on the closeout commit; the wp0 devlog and
the ledger are on `dev` through a docs PR; then the unit moves to `devlog/_fin/`.

## Human gates recorded at wp0

- wp1b (#3997, #4025): `maintainer-sponsored` label requires the MAINTAINERS.md security review
  of the credential-selection path in `src/codex/auth-context.ts`. Not executed by the loop.
- wp5: closing comments are drafted at wp0 and posted only after the maintainer authorizes wp5.
- All merges: admin merge on `dev` is authorized by the maintainer in this session
  (2026-09-09 request), scoped to the items in 006; it does not extend to DEFER items.

