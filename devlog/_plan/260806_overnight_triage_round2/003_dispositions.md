# 003 — Dispositions (closes, comments, and review requests)

User authorization on record: close duplicates and absorbed items, request
review where needed, extend the stack with new fixes.

## Issue closes

| Item | Action | Evidence |
|------|--------|----------|
| #1078 | close as duplicate of #1075 | identical body, same author, #1075 is 38 minutes earlier; cross-link both ways |

## Issues confirmed as fixable defects → stack extension

| Item | Decade doc | Branch |
|------|-----------|--------|
| #1075 (+#1078) shadow-call bare id | 010 | `codex/1075-shadow-call-namespaced` |
| #1065 DeepSeek 502 first-byte stall | 020 | `codex/1065-bounded-body-first-byte` |

## PR review comments (no closes — none absorbed)

| PR | Action |
|----|--------|
| 1085 | leave open; note READY verdict, flag security review as the gate |
| 1084 | review comment: no-consumer pool config, anthropic-only cooldown no-op, quota duplication |
| 1083 | review comment: filter is cosmetic, dead i18n keys, missing regression test |
| 1081 | review comment: does not compile (6 locales + `locale` undeclared), token-vs-plan expiry semantics, partial dev absorption of `expiresAt` |
| 1079 | review comment: does not compile (6 locales), missing promised breakdown, `yesterday` semantics |
| 1077 | review comment: argv-token secrecy, missing GUI screenshot, sponsorship required |

## Feature issues left open (out of scope)

#1086, #1082, #1076, #1073 — enhancements, not bugs; no action this round.

## Execution record (verified live, terra audit PASS on all planned items)

- #1078 CLOSED not-planned, comment 5198845197; #1075 OPEN with comment
  5198844990 (root-cause confirmation + namespaced correction + collision
  caveat).
- Six PR triage comments posted 2026-08-06: 1077/5198850702,
  1079/5198850571, 1081/5198850370, 1083/5198850193, 1084/5198850085,
  1085/5198851836.
- Audit-window closures NOT ours (verified): #1064 closed by its author
  hanbinnoh (superseded by #1066), #1074 and #1018 maintainer merges on
  2026-08-05, #1080 closed by issue-quality automation.

## Stack extension PRs (wp3/wp4)

| PR | Branch | Fixes | Evidence |
|----|--------|-------|----------|
| #1087 | codex/1075-shadow-call-namespaced | #1075 (+dup #1078) | gui suite 610 pass; red ablation 3 pass/1 fail; live QA screenshot in-branch |
| #1088 | codex/1065-bounded-body-first-byte | #1065 | bounded-body 21 pass; red ablation recorded; smoke 14 pass |
| #1089 | codex/shadow-call-drop-54mini | user request: drop 5.4-mini default | intercept suite 15 pass incl. override regression; docs en+4 locales; badge QA capture |
