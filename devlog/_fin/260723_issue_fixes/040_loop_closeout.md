# 040 — Loop close-out (DONE)

Terminal outcome: **DONE** — all four work-phases closed through D with attested
edges, Sol review verdicts, and green verification at every C gate.

## Commits (codex/260723-issue-triage-r2, base af973e54)

| WP | Commits | Issue | Verification |
|----|---------|-------|--------------|
| WP0 | 27b01651 | roadmap | docs-only; Sol audit FAIL(7)→FAIL(3)→PASS; tsc green |
| WP1 | 69a3c62d | #315 | pre-fix 3 fail → post 23/23; full 3629/0; Sol PASS |
| WP2 | edab2a72, 20dabb2c | #311 | pre-fix 1 fail → post 8/8; full 3637/0; Sol FAIL(2)→PASS |
| WP3 | f103d6cd, f39401d6, 7b1e497c | #252 | pre-fix 1 fail → post 12/12; full 3638/0; privacy scan pass; Sol FAIL(1)→PASS |

(d9eeaa2a — triage-lane #314 doc correction — is also on this branch, intentional.)

## Review synthesis highlights

- #315: nullable `WhamWindow`, same-source monthly coupling, go/free branch locked
  to tertiary by regression test (behavior byte-identical for legacy payloads).
- #311: prefix-set matching (defaults gpt-5.4-mini + gpt-5.6-luna), slash hard-exclude,
  `sourceModels` override, malformed-config hardening. Documented tradeoff: foreground
  bare-Luna turns are intercepted when enabled (existing ALL-requests contract);
  scope with `sourceModels: ["gpt-5.4-mini"]` if needed.
- #252: NO_MODEL_ARG placeholder sonnet→haiku + docs-site en/ja/ko/ru/zh-cn sync
  (reviewer-flagged contradiction → in-scope docs-sync per AGENTS.md).

## Named residuals (deferred, not dropped)

1. GUI shadow-intercept strings still say gpt-5.4-mini-only
   (gui/src/i18n/en.ts:65-71 + zh/Dashboard/Models hints) — gui/ was out of goal
   scope; needs a follow-up unit with GUI approval.
2. docs-site build not run locally (astro deps absent); CI covers it.
3. #252 live enum-acceptance dispatch (model:"haiku" through a real Claude Code
   client) not executed in-loop; corroborated by tier-alias slots + proxy-inert
   argument (ocx-route authority, claude-messages.ts:529). Verify on next live session.

## Push status

NOT pushed (LOOP-GIT-01 — push requires separate explicit approval). Branch is
7 commits ahead of origin/dev locally.
