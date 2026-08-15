# 010 - Triage matrix (wp1 deliverable)
 
Evidence gathered 2026-08-15. "checks" = exact-head check-runs; "threads" = fresh unresolved reviewThreads (GraphQL). Verdicts from 5 independent explorer subagents, spot-verified by maintainer agent.
 
A-audit amendment (GO-WITH-FIXES, 2 blockers folded):
1. #1706 will be retargeted to dev explicitly ('gh pr edit 1706 --base dev') before merging - the repo does not auto-delete branches, so merge does not auto-retarget stacked children.
2. #1722/#1723 upgraded KEEP-DRAFT -> MERGE: the Cursor false-pass Major was fixed at head ca0a5124 (force-push 02:13Z, after the 01:56Z CodeRabbit comment); same fixed-in-branch standard the plan already applied to #1706. Residual: stale-thread hygiene only.
 
## MERGE (15)
 
| PR | What | Gate state | Notes |
|----|------|-----------|-------|
| #1708 | fix(lab) CL-01: negative control asserted its own repair | 35 green, 0 threads | harness integrity |
| #1709 | fix(lab) CL-02: transactional ledger mutations | 26 green, 0 threads | TOCTOU races closed |
| #1710 | fix(lab) CL-03: distinct transport failure classes | 35 green, 1 outdated | backward compatible |
| #1712 | fix(lab) CL-04: 400 on invalid read filters | 35 green, 1 minor | empty-artifactClass follow-up optional |
| #1715 | fix(lab) CL-05: GUI partial-read failures | 29 green, 0 threads | gui-screenshot-waived label present |
| #1717 | fix(lab) CL-07: fail-closed outcome validation | 29 green, 0 threads | clean vs #1709 |
| #1719 | fix(lab) CL-08: rebind runtime ownership on server replace | 32 green, 0 threads | lifecycle defect |
| #1720 | fix(lab) CL-09: passive read surface alignment | 32 green, 0 threads | clean vs #1712 |
| #1705 | feat(lab) CL-10 trust core | 31 green (react-doctor cancelled = superseded dup), 2 trivial + 1 minor threads | stack base |
| #1706 | feat(lab) CL-10 operator/community | 26 green, Major fixed in-branch (7a1e066ae) | explicit retarget to dev before merge; core-lab boundary test green |
| #1714 | fix(providers) static model discovery | 32 green, 0 threads | land BEFORE adapter stack (endpoint-guard fixture conflict) |
| #1721 | refactor(adapters) registry authority Part 1 | 26 green, 0 threads | rebase + mimo fixture fix (authority test only) after #1714 |
| #1722 | test(adapters) conformance Part 2 | 23 green; Major fixed at head ca0a5124 | stack order after #1721; A-audit upgrade |
| #1723 | test(adapters) buffered freeform Part 3 | 23 green, 0 threads | stack order after #1722; A-audit upgrade |
| #1716 | feat(models) per-custom-model reasoning effort | 27 green (+1 cancelled react-doctor dup; win shard skip systemic), screenshot present | "Critical duplicate payload" verified false positive; 1 minor trim nit |
 
## KEEP-DRAFT (7)
 
| PR | Why not now | Gap to merge |
|----|-------------|--------------|
| #1704 | own GUI quota PR: hygiene + enforce-target FAIL (no screenshot, no regression test), 5 fresh threads | screenshot, unit test, address threads |
| #1718 | external draft, light gates only, no full CI | author checklist + maintainer-triggered CI |
| #1725 | external draft, no full CI | author readiness + maintainer CI |
| #1727 | enforce-target (screenshot), hygiene empty_catch, unresolved Major: sqliteHome/databasePath leak in API/CLI/UI | redact path fields, fixed-message errors, screenshot |
| #1728 | author mid-flight: checklist 0/4, manual verification pending | author completes checklist |
| #1729 | 5 real macOS test failures in protection/lock core, 10 unresolved threads | fix lock/trigger semantics failures |
| #1732 | failing reclaim/gates checks, plausible TOCTOU + stopReason Majors, CI still running | post-open path re-validation, stopReason fix, drop duplicate workflow |
 
## Stacks and order constraints
 
- #1705 (base dev) -> #1706 (base cl10-public-core): merge #1705, then 'gh pr edit 1706 --base dev', then merge #1706.
- #1721 -> #1722 -> #1723 stack: merge in order; use --delete-branch on each merge so the next child retargets to dev automatically (or retarget explicitly).
- #1727 -> #1729 -> #1732 stack: all stay draft.
- Semantic conflict: #1714's canonical-endpoint guard breaks the mimo-free fixture in #1721's authority test (example.invalid/v1). #1714 lands first; #1721 rebases with MIMO_CHAT_URL fixture before merge. #1722/#1723 fixtures re-verified against the combined tree before their merges.
 
## Out of scope (open but not in owner's list)
 
#1703 #1669 #1664 #1660 #1655 #1652 #1645 #1644 #1624 #1584 #1569 #1557 #1552 #1526 #1521 #1498 #1367 #1165 - untouched this round.
 
