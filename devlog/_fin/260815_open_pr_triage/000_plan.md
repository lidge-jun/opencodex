# 000 — 260815_open_pr_triage: Plan

## Objective

Triage every open PR shown in the owner's 2026-08-15 list (22 PRs, #1704-#1732) in lidge-jun/opencodex. Each PR gets exactly one executed disposition: MERGE (squash via gh, or cherry-pick when unmergeable), CLOSE with evidence-led comment, or KEEP-DRAFT with named gaps. Owner directives: suites run only on ssh lidge; pushing to dev is authorized (--no-verify allowed); unlimited subagents; multi-cycle PABCD.

## Loop-spec

- Loop archetype: verifier-defined (gh PR state + lidge suite green on dev).
- Write scope: GitHub PR state (merge/close/comment), devlog unit docs. Out-of-scope: main/preview branches, npm release, issues, PRs #1703 and older (not in the owner's list).
- Budget / bounds: wall-clock one session; BLOCKED if lidge or gh auth fails.

## Evidence base

- 5 explorer subagent verdicts (diff-level per-PR review), 2026-08-15.
- GraphQL reviewThreads (authority for unresolved blocking threads).
- Exact-head check-run rollup per PR (gh pr view --json statusCheckRollup).

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010 | Triage matrix (this unit's docs) | - |
| wp2 | 020 | Lab CL merges: #1708 #1709 #1710 #1712 #1715 #1717 #1719 #1720, then #1705 -> #1706 stack | wp1 |
| wp3 | 020 | Adapters: #1714 merge, then #1721 rebase + fixture fix + merge; #1722/#1723 stay draft (Major thread) | wp2 |
| wp4 | 020 | Contributor #1716 merge; KEEP-DRAFT comments #1718 #1725 #1728; #1704 stays draft | wp2 |
| wp5 | 020 | Storage/log-guard #1727 #1729 #1732 stay draft (named gaps) | wp1 |
| wp6 | 030 | Final: lidge full suite on dev, verify all dispositions, report | wp2-wp5 |

## Merge mechanics (B-phase execution)

1. Independent lab fixes first (disjoint files; overlaps #1709/#1717 and #1712/#1720 verified clean by merge-tree): gh pr merge <n> --squash (--admin only if the review-requirement blocks; owner-directed triage).
2. #1705 merges; GitHub auto-retargets #1706 to dev; merge #1706.
3. #1714 merges. Then #1721: rebase onto dev, switch mimo-free fixture URL to canonical MIMO_CHAT_URL (semantic conflict with #1714's endpoint guard), push, merge.
4. #1716 merges (external contributor - use gh merge so it records as merged).
5. KEEP-DRAFT set: no state change; gaps recorded in 010 matrix; brief maintainer comment on external drafts (#1718 #1725 #1728).

## Accept criteria

- c1: 010 matrix written with per-PR evidence (this unit).
- c2: every listed PR shows merged/closed/draft disposition via gh pr view.
- c3: full suite green on lidge against final dev head.
- c4: no security notes in tracked files (log-guard findings stay in matrix form - all referenced fixes already public in PR diffs).
- c5: final per-PR outcome report.

