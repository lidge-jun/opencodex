# WP0 cleanup — EXECUTED RECORD (session 01a01f4b, performed 2026-08-20)

STATUS: HISTORICAL. Every deletion below was executed during wp0 and verified against
live state afterwards (post-check 2026-08-21: 33 local branches remain, 0 deleted
remote refs resurrected, 9 worktrees). Nothing in this file is a pending command.
Anyone repeating a cleanup of this shape MUST run the preflight template at the end
against CURRENT state first; this snapshot is not reusable as a target list.

## Protected set (mechanical, applied before every batch)

The protected set was computed mechanically, not by eye, and deletion aborted on any
intersection: `dev`, `main`, `preview`, every open-PR head (31 at snapshot time),
every branch checked out in any worktree, and every dirty worktree. KEEP entries
below are the rows the protected set excluded from their surrounding batch.

## Worktrees removed (were all clean; content preserved in dev or a surviving ref)

- /private/tmp/ocx-m2148.LzD2/wt (absorb-baseurl-override, merged)
- tmp.bxVhqaJyPc/sweeper (tmp-reclaim-1-sweeper, merged)
- tmp.bzZ2ssU8WM/wp1b (split-wp1b-type-clusters, merged)
- tmp.gLNBuhAyoP (detached d0cd99672, merge of two dev ancestors, nothing unique)
- tmp.LfX0NlBXvp/r1876 (ingw/fix-windows-v2-catalog-blocking-1852, merged)
- tmp.Mb171xHMCb/r2031 (ingw/fix-mimo-vision-1927, merged)
- tmp.pQMnjf3VMg/wp1 (split-wp1-types, merged)
- tmp.vSBe0MZ0LP/w2080 (pr2080, PR merged)
- tmp.xfjQ3jxADE/w1934 (pr1934, PR merged)
- tmp.2IOChwQmxR/wp1b + tmp.t3YTdy1JDC/wp1b (detached b2ac2500c) — removed ONLY
  after preservation branch wip/wp1b-superseded-b2ac2500c was created at b2ac2500c
  and verified (unique cherry patches; superseded by a0f8c0135 in dev).
- ~/.codex/worktrees/3a35 (devlog-release-2280, merged)
- ~/.codex/worktrees/3b3b (cursor-call-release-note-2, merged, upstream gone)
- ~/.codex/worktrees/83d5 (tmp-reclaim-2-doctor, merged)
- ~/.codex/worktrees/c6d8 (zcode-client, merged)
- ~/.codex/worktrees/fe69 (detached 63bfd149d, clean, reachable from many branches)
- ~/.codex/worktrees/land-1842 (clean, PR #1842 CLOSED, 0 unique patches)
- .tmp/pr-2045-review (b92bb611c; PR2045 merged into dev as 0161a66d9)
- .tmp/pr1903-review-8c38989f4 (PR1903 merged; commit kept by remotes/review/pr1903)

## Worktrees kept (dirty or otherwise protected — never in a removal batch)

- /private/tmp/opencodex-pr2068.uXcKNC (detached 5a4068bbd, kept by branch
  pr2068-check; PR 2068 OPEN)
- tmp.UFYNSQT3qw/land1920 (DIRTY, 2 changes + 3 unique commits)
- ~/.codex/worktrees/648b (DIRTY, 1 change)
- ~/.codex/worktrees/71a2 (DIRTY, 1 change; split-wp2a-config-names stays checked out)

## Local branches deleted

- Merged into origin/dev (git branch --merged proof at snapshot): all 46 merged
  branches except dev and split-wp2a-config-names (checked out in a kept worktree).
- Unmerged but 0 unique patches vs dev (git cherry all '-'):
  absorb-account-entitlement-stacked, absorb-capability-evidence,
  absorb-k12-short-window, absorb-xai-oauth-streaming,
  consolidate-prompt-cache-retention, fix-bearer-admission-2132, land-1842
  (PR closed), land-1876, ocx/integration, ocx/verify-2167.

## Local branches kept (unique commits or open PR)

combo-quota-badges (PR1704 OPEN), compat-multiagent-v2-catalog (4u), devlog-merge-log
(1u), devlog-three-issues (PR2181 OPEN), external-vision (1u),
issue-quality-provider-defect-bug-label (1u), land-1920 (3u+dirty wt),
cursor-call-prerebase-260818 (2u), ocx-dev-verify (1u), ocx/rebuild-2178 (1u), wip/*
(unique, incl. wip/wp1b-superseded-b2ac2500c), pr2053-check (2u), pr2056-check (1u),
pr2068-check (PR OPEN), pr2072-check (PR OPEN), pr2101-probe (5u), pr2105tmp (3u),
codex/merge-loop-closeout (2 unique local commits), main, preview, dev.

## Remote branches deleted (origin)

- 36 merged-into-origin/dev refs, none an open-PR head. The original 37-row list
  mistakenly included codex/merge-loop-closeout; the executed batch EXCLUDED it (it
  is a local-only KEEP with 2 unique commits and had no remote ref to delete):
  codex/absorb-agentrouter-language-framing, codex/absorb-antigravity-thought-signatures,
  codex/absorb-baseurl-override, codex/absorb-claude-shell-hook-gate,
  codex/absorb-fastwire-native-chat, codex/absorb-oauth-superseded-commit,
  codex/absorb-openai-chat-padding-repeats, codex/absorb-opencode-free-static-headers,
  codex/absorb-opencode-go-quota-siblings, codex/absorb-responses-id-backfill,
  codex/absorb-shadow-helper-attribution, codex/absorb-tool-search-passthrough,
  codex/audit-closeout, codex/audit-record, codex/audit-shadow-marker-leak,
  codex/audit-tool-search-id, codex/devlog-audit, codex/devlog-release-2280,
  codex/fix-admission-bearer-transport, codex/fix-audit-record-scan,
  codex/fix-privacy-scan-devlog, codex/fix-subagent-roster-truncation,
  codex/fix-windows-ci-shards, codex/harden-core-lab-guard,
  codex/logs-intercepted-helper-attribution, codex/merge-loop-outcome,
  codex/openai-chat-tool-call-heartbeat, codex/promote-2.28.0, codex/split-wp1-types,
  codex/split-wp1b-type-clusters, codex/split-wp2a-config-names,
  codex/sync-preview-2.28.0, codex/windows-shard-truncation-and-budgets,
  ingw/docs-tool-search-troubleshooting-1872, ingw/fix-mimo-vision-1927,
  ingw/fix-windows-v2-catalog-blocking-1852
- Unmerged, 0 unique, PR closed/merged: codex/absorb-account-entitlement-stacked,
  codex/absorb-capability-evidence, codex/absorb-k12-short-window,
  codex/absorb-xai-oauth-streaming, codex/consolidate-prompt-cache-retention,
  codex/fix-bearer-admission-2132, codex/land-1842, codex/land-1876

## Preflight template (mandatory for any future cleanup batch)

Run immediately before EACH delete batch; abort the batch on any intersection:

1. `git worktree list --porcelain` — collect worktree paths and checked-out branches
   (this reports metadata only, NOT status). Then for EACH listed path run
   `git -C <path> status --porcelain`; any output marks that worktree dirty.
   Protect both the dirty path and its attached branch (detached dirty worktrees
   protect the path itself).
2. `gh pr list --state open --json headRefName` — collect every open-PR head.
3. Protected = {dev, main, preview} ∪ open-PR heads ∪ checked-out branches ∪
   dirty-worktree branches ∪ dirty-worktree PATHS (a detached dirty worktree has
   no branch — its path itself is the protected row). `comm -12` the sorted
   candidate list against sorted Protected; any overlap aborts the whole batch,
   not just the row.
4. For unmerged candidates, re-prove 0 unique patches with `git cherry dev <ref>`
   at execution time; a snapshot proof is stale the moment the tree moves.
5. Detached commits require a durable preservation ref (branch or tag) verified with
   `git rev-parse` BEFORE the containing worktree is removed.
