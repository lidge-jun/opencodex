# 000 - 260815_old_draft_triage: Plan
 
## Objective
 
Triage the 18 older open drafts (#1703 #1669 #1664 #1660 #1655 #1652 #1645 #1644 #1624 #1584 #1569 #1557 #1552 #1526 #1521 #1498 #1367 #1165): land the worthwhile (provider additions prioritized), close the superseded, keep the rest drafted with named gaps. Then a release-readiness hardening loop on dev (no publish).
 
## Loop-spec
 
- Archetype: verifier-defined (gh state + lidge suite + dev CI).
- Write scope: GitHub PR state + devlog unit + repair branches. Out of scope: npm publish, tags, main/preview, issues.
- Bounds: one session; heavy repairs capped at one worker attempt each, else KEEP-DRAFT.
- Subagents: gpt-5.6-sol, medium effort (owner directive).
 
## Evidence base
 
4 sol/medium explorer verdicts (2026-08-15, diff-level + merge-tree + GraphQL threads) against origin/dev 420db6274.
 
## Disposition summary (010 has full evidence)
 
- CLOSE (2): #1498 (superseded by policy routing + #1702, 31 unresolved defects), #1367 (retired seam, 10 blockers).
- KEEP-DRAFT (6): #1552 (auth sponsorship), #1703 (unsafe routing design), #1645 (5 correctness/security blockers), #1557 (not fail-closed), #1526 (5748-line auth surface), #1624 (dormant contract).
- CHERRY-PICK light (6): #1664 MiniMax, #1669 modelPickerOrder, #1660 terminal guard, #1652 streamAborted, #1165 imageInput, #1644 droid docs.
- CHERRY-PICK heavy (4): #1655 empty-completion guard, #1569 native chat->chat, #1584 request pacing, #1521 service tiers.
 
## Work-phase map
 
| WP | Doc | Slice |
|----|-----|-------|
| wp1 | 010 | this matrix |
| wp2 | 020 | CLOSE 2 + KEEP-DRAFT 6 comments; dispatch 6 light repair workers |
| wp3 | 020 | integrate light six; lidge verify; land via admin PR; close source PRs with landed-SHA comment |
| wp4 | 020 | heavy four: one worker attempt each; land what passes, else KEEP-DRAFT |
| wp5 | 030 | release-readiness loop: lidge gates, dev CI, release.ts preflight, report |
 
## Landing mechanics (from 260815_open_pr_triage, proven)
 
Cherry-pick contributor commits (author preserved) onto repair branch off origin/dev, repair commits on top, integrate into int branch, lidge suite, open PR to dev, --admin merge, close source PR with landed-SHA comment. Direct dev push impossible (Protect dev ruleset, bypass=pull_request).
 
## Accept criteria
 
- c1 matrix; c2 18 dispositions executed; c3 lidge suite green on final tree; c4 readiness report; c5 privacy clean.
 
