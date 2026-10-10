# Round ledger

Captured from live `git ls-remote` and `gh` at **2026-09-10T16:19:21Z**. Every value is a command
result, not narration.

## Round unit

PR #4217 merged into `dev` at `2026-09-10T16:13:35Z` from head
`538668bb0b1c8cc9f28737df3dd574af85a733b3`, with `ci`, `enforce-target`, `changes`,
`select windows runner`, `react-doctor`, `label`, `hygiene`, and `resolve-pr` all SUCCESS and the
product legs SKIPPED by the `changes` filter on a documentation-only PR. Landing proven by
`git merge-base --is-ancestor 538668bb0 origin/dev` after fetching; `dev` was `0aa685031` at that
moment.

## Lanes

All seven branches are published on `origin`. Each is exactly one commit on `6d3ad12e3` touching only
its own packet file, verified before the push and re-read from the remote after it.

| Lane | Worktree | Branch | Remote head | PR | Final-head CI | State |
|---|---|---|---|---|---|---|
| L1 | `~/.codex/worktrees/260911-l1/opencodex` | `codex/260911-l1-responses-core` | `29c342da74f89f9b6f21b501bef99fcf53a1d536` | none open | — | thread not opened yet |
| L2 | `~/.codex/worktrees/260911-l2/opencodex` | `codex/260911-l2-catalog-provider` | `b28f06ee04603698c2dc2bf134c80d3b7796c480` | none open | — | thread not opened yet |
| L3 | `~/.codex/worktrees/260911-l3/opencodex` | `codex/260911-l3-account-pool` | `6fd401636a6e1f26f8f8f6067c471db7900722aa` | none open | — | thread not opened yet |
| L4 | `~/.codex/worktrees/260911-l4/opencodex` | `codex/260911-l4-service-cli` | `f48cede91719257f8ae1565f8907b1a0b09df7dd` | none open | — | thread not opened yet |
| L5 | `~/.codex/worktrees/260911-l5/opencodex` | `codex/260911-l5-integrations-io` | `a7a92089cbbd7da539a71d74f7d8abda4724ba41` | none open | — | thread not opened yet |
| L6 | `~/.codex/worktrees/260911-l6/opencodex` | `codex/260911-l6-streaming-tools` | `3760f81fddc5b7af6d742c1216c894838c762ee9` | none open | — | thread not opened yet |
| L7 | `~/.codex/worktrees/260911-l7/opencodex` | `codex/260911-l7-docs` | `cd5dcd6a253109e60f6f2fb30ac08a1692c43a73` | none open | — | thread not opened yet |

The `PR` column is a `gh pr list --head` snapshot at the capture time above. A lane thread that opens
its pull request afterwards supersedes this column; refresh it rather than trusting it.

## Local checks

`bun test`, `bun run test`, `bun run test:changed`, `bun run typecheck`, `bun run build:gui`,
`bun install`: **NOT RUN** in this round, by operator instruction. Hosted CI on each exact pushed
head is the only product evidence this round cites.

## Audit history

| Round | Verdict | Outcome |
|---|---|---|
| 1 (`030`) | fail | Seven findings, all folded in. |
| 2 (`040`) | fail | Six findings; it separated four real round-1 fixes from three that were only described as fixed. |
| 3 (`050`) | near-pass | Five findings: four folded, one rebutted with the issue text that disproved it. |
| wp2 (`080`) | near-pass | Three acceptance-criteria gaps folded before the pushes. |

