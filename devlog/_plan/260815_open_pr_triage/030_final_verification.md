# 030 - Final verification (wp6)
 
## Landing
 
- dev tip: 88463de4e (merge of PR #1736, int/260815-pr-landings).
- Integration tip ba20ce17f tree is byte-identical to dev tip (empty diff).
 
## lidge suite (only host used for suites, per owner directive)
 
- Host: ssh lidge, worktree /tmp/ocx-triage-260815-int @ ba20ce17f.
- First run: 7 transient failures - bun installed gui deps mid-run
  (gui/node_modules/react created 14:14:19 KST, errors in the same minute
  window); install race, not a code defect.
- Rerun (clean): 12204 pass / 11 skip / 0 fail; Ran 12215 tests across 777
  files [448.99s]; TESTS_OK. typecheck (TSC_OK) and privacy:scan
  (PRIVACY_OK) green on the same tree.
 
## Dispositions (gh-verified 2026-08-15)
 
MERGED (15): #1705 #1706 #1708 #1709 #1710 #1712 #1714 #1715 #1716 #1717
#1719 #1720 #1721 #1722 #1723
 
KEEP-DRAFT with maintainer comment (7): #1704 (screenshot+test+threads),
#1718 (maintainer CI + checklist), #1725 (maintainer CI + checklist),
#1727 (path-redaction Major + empty_catch + screenshot), #1728 (author
checklist), #1729 (5 macOS test failures), #1732 (reclaim/gates red + 2
Majors).
 
Out of scope untouched: #1703 and older open drafts (not in the owner's list).
 
