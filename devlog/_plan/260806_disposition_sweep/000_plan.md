# 000 — Plan: 10-item disposition sweep (2026-08-06)

## Objective

Dispose of exactly the ten items surfaced in the 2026-08-06 triage report
(user steering: "모든 pr은 아니고 너가 제시한 것만 처리"), record every
action in this unit, and open the unit as a PR. **Nothing merges to dev in
this loop** — code changes and the devlog land via an open PR only.

## Base

| Fact | Value |
|------|-------|
| `origin/dev` | `b3a1d90a8` (bfbc9a405 + devlog-only ledger commits; re-frozen after audit finding 1) |
| Worktree | `/Users/jun/.codex/worktrees/37e6/opencodex`, branch `codex/260806-disposition-sweep` |
| Scope freeze | the 10 items below; later arrivals (e.g. #1092) are OUT |

## Disposition rules (user authorization 2026-08-06)

| Rule | Bucket | Action |
|------|--------|--------|
| R1 | INCOMPLETE | close with a detailed defect list + "complete and reopen" guidance |
| R2 | NON-BUG | comment evidence, close, invite reopen with repro |
| R3 | OWN-PR | rebase onto dev, terra-verify, push to the PR branch — **no merge** |
| R4 | ABSORBED | close with source-level evidence (file:line or merge SHA) |
| R5 | STALE-CLEAR | complete-quality code but undecided intent → stale-mark comment, keep open |
| R6 | SHELL | non-compiling / no-op / cosmetic-only → close |

No merges this loop. Own-PR lanes end at "pushed, CI running, PR open".

## The ten items

| # | Item | Rule | Planned action |
|---|------|------|----------------|
| 1 | #1017 + PR #1036 (Cursor apply_patch) | R1-review | request-changes comment: synthetic-tool name provenance + final-catalog gaps; PR stays open (author active) |
| 2 | #919 (socket reset vs affinity) | R2 | close as intended-policy/enhancement with maintainer rationale; do NOT cite #914 as the successor (closed, pre-header scope only — audit finding 2); reopen path = concrete attribution-policy proposal or new repro |
| 3 | #1090 + #1091 (base_url injection) | R4-partial | #1090: regression test for the external-provider path on sweep branch + comment distinguishing attempt 1 (fixed, `inject.ts:74,636-658`) from attempt 3 (`model_provider="opencodex"` re-runs injection by design, `inject.ts:701-747`); close ONLY if attempt-3 scope proves by-design/resolved after full read — else keep open with status. #1091: status comment, keep open |
| 4 | #994 + PR #1068 (DeepSeek reasoning replay) | R1-review | comment: rebase required (CONFLICTING), Zen slice credible, Claude-path gap stays open |
| 5 | #936 (own, trust boundaries) | R3 | rebase onto dev, terra security audit, push — PR stays open for human security review |
| 6 | #1059 (Windows suite) | keep-open | status comment defining shard-by-shard burn-down expectation |
| 7 | #1008 (own, usage rollup) | R3 | rebase, triage 29 threads → fix-now vs redesign, implement fix-now, push — no merge |
| 8 | #1019 (account picker lifecycle, 106 files) | R5-adjacent | comment: split request into reviewable slices; hygiene gate noted; stays open |
| 9 | agentHits campaign: PRs #1084/#1083/#1081/#1079/#1077 | R6/R1 | close each with tailored, verified defect list + explicit "complete and reopen" guidance (user rule R1; author is active — audit finding 5 noted, tone must be respectful and specific). Linked issues #1062/#1063/#1060/#1058/#1076/#1082 are IN SCOPE as part of item 9: one policy comment each, stay open. Verified defects: #1084 cooldown no-op (`oauth-account-routes.ts:374` → `clearAnthropicAccountCooldown` Anthropic-only `anthropic-routing.ts:117`), #1081/#1079 invalid TS in six locales (bare string after value) |
| 10 | #1085 + #997 (easy rebases) | R5-adjacent | comment asking authors to rebase; note READY verdict; stay open |

PR state re-verified post-audit: #936 CONFLICTING (rebase required), #1068
CONFLICTING, #1036 now MERGEABLE/CLEAN.

## Work-phase map

| Phase | Doc | Content |
|-------|-----|---------|
| wp0 | 000-001 | this plan + per-item disposition matrix (docs-only cycle) |
| wp1 | 010 | GitHub dispositions for items 1,2,3(comment),4,6,8,9,10 |
| wp2 | 020 | #1090 regression test on sweep branch; close #1090 only if the attempt-3 scope proves by-design/resolved, else status comment + keep open |
| wp3 | 030 | #936 rebase + terra security audit + push (no merge) |
| wp4 | 040 | #1008 rebase + thread triage + bounded fixes + push (no merge) |
| wp5 | 050 | closeout ledger + open sweep PR + live end-state snapshot |

## Out of scope

Any merge into dev, main/preview promotion, releases, new feature
implementation, PRs/issues outside the ten items (incl. #1092, #557,
provider-preset drafts), the user's usage-log 500k cap edits,
account/identity actions.
