# Execution order and per-PR gates

This is the operative sheet for work-phases wp2..wp5. It supersedes the order lines in
003 wherever they disagree, because it accounts for the pairwise conflict found at the
A gate (005, correction 2).

## Order

| # | PR | lane | gate before it lands |
|---|---|---|---|
| 1 | #2672 | L1 | already full-matrix green; merge |
| 2 | #2674 | L1 | retarget to dev after #2672, confirm CI re-run, merge |
| 3 | #2671 | L1 | add the reviewer's live-row-vs-config test, then merge |
| 4 | #2684 | L1 | fix PR-body checklist (label + enforce-target), merged-tree suite for the adapter, merge — **before #2690** |
| 5 | #2639 | L3 | cherry-pick `status` only; combo-failover file must be 74/74 |
| 6 | #2647 | L3 | re-apply 3 rows on dev-based branch; re-verify the 51->60 snapshot live |
| 7 | #2690 | L3 | rebase on post-#2684 dev, resolve the openai-chat.ts conflict once |
| 8 | #2663 | L2 | FULL suite on merged tree via ocx-run on lidge-ai — mandatory, it has no other behavioral evidence |
| 9 | #2694 | L4 | re-evaluate after #2663; NOOP-and-close if subsumed |
| 10 | #2638 | L4 | diagnose hygiene failure first; preserve synchronous subagent activation |
| 11 | #2693 | L4 | BLOCKED pending one upstream fact; post the question on the PR |
| 12 | #2497 | L4 | NEEDS_HUMAN security review before anything lands |

## Standing rules for this round (from the A gate)

1. Compile evidence means the MERGED tree, never the PR head alone.
2. Every pair of PRs touching a shared file gets `git merge-tree` before either merges.
3. Green checks are not health unless the list includes `ci` / `test N/4` / `macos`.
4. `bun test` takes a machine-wide lock; run one suite at a time, long ones on lidge-ai.
5. Pushes use `--no-verify` (user-approved for this round). No main/preview, no release.

## Known cross-PR file contention

`src/adapters/openai-chat.ts` — #2684 and #2690 (conflict proven, ordered above).
`src/server/responses/core.ts` — #2663, #2638, #2497, and #2694's abandoned attempt.
Any two of those landing must be re-checked pairwise, not assumed independent.
`src/server/responses/responses-field-backfill.ts` — #2639 only.
`src/providers/registry.ts` — #2671 only; `command-code-efforts.ts` — #2647 only.
