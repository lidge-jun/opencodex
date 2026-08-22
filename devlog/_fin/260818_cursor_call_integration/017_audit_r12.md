# 016 — Audit round r12: the artifact-chain class, found twice more

## The pattern, now named

Rounds `r7`, `r8`, `r10`, `r12` and `r13` all found the SAME class of defect: a
phase boundary where the artifact one phase produces is not the artifact the next
phase reads.

| Round | The gap |
|-------|---------|
| r7 | No push between the rebase (WP2) and remote verification (WP3) — lidge would fetch the pre-rebase branch |
| r8 | That push ran BEFORE WP2b changed code, so lidge would bless a tree without WP2b |
| r10 | The chain stopped at WP3 — nothing downstream asserted the tree being cut, reviewed, and merged was still the verified SHA |
| r12 | `VERIFIED_TIP` was recorded AFTER the gates ran, and per-layer gates had no execution site at all |
| r13 | `PR1_HEAD = <PR1_TIP>` was prose, not an assignment — under zsh it exits 127 |

Each document reads correctly on its own terms, which is why these survived rounds of
reading them one at a time. The defect only surfaces when you ask at every boundary:
what does this side produce, and does the other side bind to it?

## r12 finding 1 (High) — `VERIFIED_TIP` recorded after it was used

`020` created the lidge worktree at an unnamed `<SHA>`, ran every gate, and only then
introduced `VERIFIED_TIP` in a section claiming to be "before any gate". If
`cursor-call` moved during the ~8-minute suite, `030` would bind to a different tree
than the one tested.

**Closed.** The capture moved to the top of the worktree section: read the LIVE remote
with `git ls-remote`, assert local and remote agree, create the worktree AT that SHA,
re-assert `git rev-parse HEAD` inside it before installing. Every gate then runs in
`/tmp/ocx-cc-${VERIFIED_TIP:0:9}`, so the path itself carries the SHA.

## r12 finding 2 (High) — per-layer evidence had no execution site

`020`'s table said WHAT each layer runs and never WHERE. Running PR1's tests at
`VERIFIED_TIP` proves nothing about PR1: that tree already contains PR2's and PR3's
code, so a PR1 test could pass because of something a PR1 reviewer never sees. Yet
`030` requires each PR body to cite commands, output, and a SHA.

**Closed.** `020` gains the execution procedure and `030` step 5 names the sequencing.
Because the layer branches do not exist until `030` step 2, WP3 is ordered:

1. gates at `VERIFIED_TIP` — full suite, typecheck, privacy:scan, audit:high,
   build:gui. This is PR3's evidence.
2. `030` steps 0-4 — bind, cut, prove the partition, record the head SHAs.
3. one lidge worktree per layer head, pinned and asserted, running that layer's
   typecheck plus its own test files.
4. `030` step 6 — push and open the PRs, each citing its own run.

`PR3_HEAD` equals `VERIFIED_TIP`, so step 1 already covers it. Every layer's evidence
now names the same SHA `040` asserts with `gh pr view --json headRefOid` before
merging.

## What r12 confirmed holds

- WP2 → WP2b: checkpoint push and equality assertion exist; WP2b's later push
  supersedes them as authoritative.
- WP4 → WP5: expected heads recorded and checked before every merge.
  `PR3_HEAD = VERIFIED_TIP` is correct because PR3's head IS `cursor-call`.
- WP5 → WP6: `040` produces `MERGED_DEV`; `050` gates that exact SHA instead of
  re-reading a moving `dev`.
- WP6's note requires each gate's command, output, and SHA.
- Stack proof at the audited tip: no duplicate subjects, zero merges, ancestry chain
  passes, ranges `17 + 3 + 27 = 47`.
- Both `010` conflict resolutions and `015`'s failure-specific usage design: no drift.

## Tally

Thirteen rounds, 35 findings, every one verified against the tree and absorbed. Two
clusters account for most: four rounds on how to split the stack (resolved by
abandoning subsystem purity — `009`), and five on artifact-chain boundaries (resolved
here).

