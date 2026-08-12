# 010 — wp1: GitHub dispositions (items 1,2,3b,4,6,8,9,10)

All writes are comments/closes/reviews; no code, no merges. Every action
records its comment id in the ledger table at the bottom.

## Planned actions

1. PR #1036: review comment (request changes): (a) conversion keys on bare
   tool name — a client-owned `edit_file` would be mistranslated; needs a
   per-request synthetic-name set; (b) structured-edit availability derived
   from the original request instead of the final prompt-filtered catalog.
   Approach endorsed; stays open.
2. Issue #919: close (not-planned) — behavior is intended account-health
   policy; reclassified enhancement; reopen path: concrete attribution
   policy proposal or new repro isolating non-network cause.
3. Issue #1091: status comment — valid request; blocked on security design
   (pool-eligibility gate at `src/config.ts:1253` is deliberate); keep open.
4. PR #1068: comment — rebase onto dev required (CONFLICTING); Zen registry
   slice credible with tests; end-to-end Claude Messages continuation
   regression still missing; #994 stays open either way.
5. Issue #1059: status comment — dispatch-only stands; expectation:
   shard-by-shard burn-down, gate restored only after full green run.
6. PR #1019: comment — split request into reviewable slices (settings
   schema / selector init / catalog convergence / GUI), hygiene gate must
   pass; stays open.
7. agentHits PR closes (verified defects in 001): #1084, #1083, #1081,
   #1079, #1077 — each closed with its specific defect list + explicit
   "complete and reopen" invitation. Linked issues #1062/#1063/#1060/
   #1058/#1076/#1082: one policy comment each (ideas retained; small
   independently-testable slices invited), stay open.
8. PRs #1085/#997: rebase-request comments; READY verdicts noted.

## Ledger (filled during execution)

| Target | Action | Comment/close id | Verified |
|--------|--------|------------------|----------|
| PR #1036 | review REQUEST_CHANGES | posted 2026-08-06 (gh pr review) | pending C |
| issue #919 | closed not-planned + comment | close via gh issue close | pending C |
| issue #1091 | status comment, open | 5199487703 | pending C |
| PR #1068 | rebase-request comment, open | 5199487780 | pending C |
| issue #1059 | status comment, open | 5199487879 | pending C |
| PR #1019 | split-request comment, open | 5199488679 | pending C |
| PR #1085 | security-pass comment, open | 5199488762 | pending C |
| PR #997 | rebase-request comment, open | 5199488854 | pending C |
| PR #1084 | closed + defect comment | gh pr close | pending C |
| PR #1083 | closed + defect comment | gh pr close | pending C |
| PR #1081 | closed + defect comment | gh pr close | pending C |
| PR #1079 | closed + defect comment | gh pr close | pending C |
| PR #1077 | closed + defect comment | gh pr close | pending C |
| issue #1062 | policy comment, open | 5199492623 | pending C |
| issue #1063 | policy comment, open | 5199492696 | pending C |
| issue #1060 | policy comment, open | 5199492785 | pending C |
| issue #1058 | policy comment, open | 5199492864 | pending C |
| issue #1076 | policy comment, open | 5199492948 | pending C |
| issue #1082 | policy comment, open | 5199493056 | pending C |
