# 260712 — PR batch landing (#96–#103) with review fixes

## Objective

Land all 8 open PRs from Wibias on lidge-jun/opencodex, honoring the parallel sol-reviewer
verdicts (2026-07-12 session 019f54d8): merge approved content, fix the named blockers on the
PR branches, merge in stack order, and leave main green with zero open PRs from the batch.

## Ground truth (explored)

- Stack: `cde614a1`(#96) → `c6af7f90`(#97) → `6bb3aecf`(#98) → `e8794d22`(#99) →
  `84d601f9`(#100) → `37b4b2d6`(#101) → `21e58b09`(#102), all on fork `Wibias/opencodex`,
  all base=main. #103 = `aa888074` (independent; overlaps only `src/server/management-api.ts`,
  `gui/src/pages/Debug.tsx`).
- Permissions: admin on repo; `maintainerCanModify: true` on PRs → can push fix commits to fork
  branches. main unprotected; merge-commit method is repo precedent (PR #87).
- `origin/dev` == `origin/main` == `182ddae9` (v2.7.8). Land to main; fast-forward dev in WP7.
- Bun 1.3.14 `node:zlib` enforces `maxOutputLength` for gzip AND zstd (verified:
  ERR_BUFFER_TOO_LARGE) → bomb fix is straightforward.
- Worktree HEAD has an unrelated unpushed commit `953fb5b9` (another task's work) — do not
  touch it; all landing work happens on branches cut from `origin/main` / fork branches.

## Landing mechanics (decision)

Fix-on-fork-branch + `gh pr merge N --merge` in stack order. Identical SHAs reach main, so each
successor PR's ORIGINAL stack prefix disappears from its diff; GitHub marks each PR merged
(attribution preserved). Drafts get `gh pr ready N` first. `--merge` is REQUIRED throughout —
squash/rebase would break the ancestry assumption (audit blocker 3). Fix commits pushed to a
predecessor branch land on main via that predecessor's merge; successor branches never contain
them, but 3-way merges cannot revert them (successor side unchanged since base). After EVERY
merge, verify the next PR's `mergeStateStatus` and effective diff before merging it.

Merge order: #103 → #96 → #97 → #98 → #99 → #100 → #101 → #102.

Known conflict point (audit blocker 2, verified via merge-tree): after #103 lands,
`gui/src/pages/Debug.tsx` CONFLICTS for #99..#102 tips. Resolution: WP5 merges origin/main into
the #99 branch and resolves Debug.tsx ONCE (combine #99 lint refactor + #103 injection wiring).
After #99 lands, #100–#102 merge cleanly (their own commits don't touch Debug.tsx, so 3-way has
only one changed side). #96–#98 are unaffected (verified: no conflict vs aa888074).

## Work-phase map (dependency-ordered, one PABCD cycle each)

| WP | Doc | Content |
|----|-----|---------|
| 1 | 010 | Plan (this doc set) + merge #103 |
| 2 | 020 | #96 + bounded decompression + SSRF resolution/reserved-ranges + activation tests → merge |
| 3 | 030 | #97 + restore GUI build gate in ci.yml → merge |
| 4 | 040 | #98 as-is → merge |
| 5 | 050 | #99 + Usage.tsx cancellation guard → merge |
| 6 | 060 | #100/#101/#102 as-is → merge |
| 7 | 070 | Closeout: verify zero open batch PRs, main CI green, dev fast-forward, comments |

## Reviewer verdicts folded in

- #96 BLOCK: bomb cap post-allocation (`src/server/request-decompress.ts:43-48`); SSRF passes
  non-literal hostnames unresolved (`src/lib/destination-policy.ts:82-110`); reserved IPv4
  ranges incomplete. → WP2 fixes.
- #97 BLOCK: deletes GUI build gate (`.github/workflows/ci.yml:73-76`). → WP3 restores.
- #99 BLOCK: `gui/src/pages/Usage.tsx` fetch has no cancellation → stale overwrite. → WP5 fixes.
- #98/#101/#102/#103 approved (nits recorded, non-blocking). #100 fixture commit legitimate.

## Rebutted residuals (recorded, not implemented)

- DNS rebinding pinning + redirect-hop validation (reviewer #96): the proxy is a loopback
  service whose providers are configured by the machine owner; validation-time resolution +
  reserved-range default-deny is proportionate. Full dial-time pinning needs a custom dialer
  Bun fetch does not expose. Recorded here + in WP2 commit message.
- #103 locale-time nit, #102 exhaustion-test nit, #98 adapter-level regression tests: cosmetic /
  non-blocking; noted for future work, not this batch.

## Rollback / partial-landing policy (audit blocker 5)

- Capture each merge-commit SHA in the goalplan ledger as it lands.
- If main CI fails after merge N: STOP merging successors; prefer fix-forward on main; if
  infeasible, `git revert -m 1 <merge-sha>` in reverse landing order back to the last green SHA.
- If a pushed fork fix must be withdrawn pre-merge: push a revert commit to the fork branch
  (never force-push another author's branch).

## Verification contract

Each WP: targeted `bun test` locally on the fix branch before push; PR checks green before
merge; WP6/WP7 run the full suite. Security fixes carry activation tests
(C-ACTIVATION-GROUNDING-01). Final: `gh pr list` empty for batch, `gh run list --branch main`
green.

## DONE — 2026-07-12 landing record

All 8 PRs merged in planned order; every merge gated on the predecessor's main CI green.

| PR | Merge SHA | Fix commits added on branch |
|----|-----------|------------------------------|
| #103 | d7b0a3fb | — |
| #96 | 93fd0897 | 94a1ce72 (inflation-time cap), 74202966 (SSRF DNS + reserved ranges) |
| #97 | d55a1e3a | — (amended: gate returns enhanced in #99; see 030) |
| #98 | 576d8c45 | — |
| #99 | 44db2ec1 | a0257db2 (Debug.tsx resolution), 77efcaf7 (Usage.tsx abort guard) |
| #100 | 464fd7d4 | — |
| #101 | 5dadf6d8 | 910fcaca (GUI-gate contract test) |
| #102 | 47072be3 | — |

Evidence: full suite 2145 pass / 0 fail at WP5 tip; gui lint+build clean; typecheck exit 0;
per-PR CI green at each tip; `dev` fast-forwarded to main (47072be3). Out-of-scope: dependabot
PRs #105+ opened by #97's new dependabot.yml — left for the owner. Deferred nits: #102
retry-exhaustion test, #98 adapter-level regression tests, #103 locale-time format.
What did NOT happen (LOOP-PESSIMIST-01): dial-time DNS pinning/redirect validation
(rebutted residual, loopback threat model); a #97 gate-restore commit (superseded by
stack-internal #99 re-introduction — first plan draft had it wrong).
