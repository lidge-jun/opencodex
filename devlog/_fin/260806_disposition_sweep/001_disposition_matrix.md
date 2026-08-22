# 001 — Disposition matrix (audited, terra PASS)

Scope: exactly the ten items from the 2026-08-06 triage report. User rules:
incomplete → close + resubmit guidance; non-bug → close with evidence; own
PRs → rebase + terra audit + push (NO MERGE); absorbed → close with
evidence; complete-but-undecided → stale-mark; shell → close.

Base: `origin/dev` = `b3a1d90a8`. Audit trail: initial terra audit FAIL
(7 findings), amended, FAIL (wp2 contradiction), amended, PASS.

| # | Target | Bucket | Action | Executor phase |
|---|--------|--------|--------|----------------|
| 1 | PR #1036 (+#1017) | R1-review | request-changes: synthetic-tool provenance, final-catalog derivation; stays open | wp1 |
| 2 | issue #919 | R2 close | close as intended-policy/enhancement; no #914 citation; reopen = attribution proposal or new repro | wp1 |
| 3a | issue #1090 | R4-partial | wp2 test first; close only if attempt-3 (`model_provider="opencodex"`) proves by-design; else status comment | wp2 |
| 3b | issue #1091 | comment | status comment: legitimate ask, security-sensitive design (config.ts:1253 gate), keep open | wp1 |
| 4 | PR #1068 (+#994) | R1-review | comment: rebase required (CONFLICTING), Zen slice credible, Claude-path gap remains; stays open | wp1 |
| 5 | PR #936 (own) | R3 | rebase onto b3a1d90a8+, terra security audit, push; PR stays open, NO merge | wp3 |
| 6 | issue #1059 | keep-open | status comment: shard-by-shard burn-down plan expectation | wp1 |
| 7 | PR #1008 (own) | R3 | rebase, triage 29 threads fix-now/redesign, implement fix-now, terra audit, push; NO merge | wp4 |
| 8 | PR #1019 | R5-adjacent | comment: split into reviewable slices, hygiene gate noted; stays open | wp1 |
| 9 | PRs #1084/#1083/#1081/#1079/#1077 + issues #1062/#1063/#1060/#1058/#1076/#1082 | R1/R6 close (PRs) + comment (issues) | close each PR with verified defect list + reopen invitation; issues get policy comment, stay open | wp1 |
| 10 | PRs #1085, #997 | R5-adjacent | rebase-request comments, READY verdict noted; stay open | wp1 |

## Verified defect evidence for item 9 closes

- #1084: cooldown endpoint permits `google-antigravity` but calls
  `clearAnthropicAccountCooldown` which only clears the Anthropic health map
  (`src/server/management/oauth-account-routes.ts:374`,
  `src/oauth/anthropic-routing.ts:117`) — functional no-op for the new
  provider; no pool-routing consumer for the added config.
- #1083: selector changes a badge only; metrics remain provider-aggregated.
- #1081: six locale files contain a bare string literal after a value
  (`"prov.expiresAt": "...", "Accounts ({n})",`) — invalid TS, does not
  compile; token expiry mislabeled as subscription expiry.
- #1079: same six-locale breakage; promised daily breakdown absent;
  "yesterday" is a rolling window.
- #1077: closest to viable, but accepts refresh tokens via argv (leaks into
  shell history/process lists), missing required GUI evidence, credential
  surface needs security review.

## Constraints

- NO merge into dev anywhere in this loop.
- All sweep-branch changes (devlog + #1090 test) land via an open PR only.
- #919 close and agentHits closes are owner-policy decisions recorded here;
  comments must be respectful, specific, and carry explicit reopen paths.
