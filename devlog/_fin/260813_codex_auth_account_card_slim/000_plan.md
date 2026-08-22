---
title: Codex Auth account-card slim + whole-box advanced
date: 2026-08-13
class: C2
---

# 000 — Objective

Codex Auth account-pool cards currently stack diagnostic defaults (log label, 30-day usage, pinned hint, a full selection-order row, and a six-column quota row). That makes a healthy account card taller than the job: pick an account and see remaining quota.

Outcome: each account card shows three default information rows. Advanced settings below the pool fold as whole boxes. No disclosure, accordion, or show-more inside any card or settings box.

## Constraints

- IN: GUI account-pool cards, Codex Auth page assembly, compact QuotaBars presentation used by those cards, i18n keys, existing GUI tests, this unit.
- OUT: server/quota math, stacked/overview QuotaBars, AccountPriorityControl behavior, dirty checkout files, merge/release.
- Dirty primary checkout stays untouched. Implementation lives in the 260813-codex-auth-slim worktree on branch codex/260813-codex-auth-account-card-slim.
- Local full suite is out of scope. Focused GUI tests run in the worktree. Full bun run test / typecheck run on ssh lidge after --no-verify push.

## Design Read

name: opencodex-codex-auth-account-card-slim
Reading this as: a dense operator dashboard card for people who already manage a Codex account pool, in the current OpenCodex admin language.

Do's: three default rows; quota stays on the card; whole-box advanced fold; keep rotation strategy visible; exceptional state copy may still appear.
Don'ts: inner-card fold; wrapping boxes in another card; new aesthetic; emoji; gradient quota bars; hiding quota or destructive remove.

DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D5
Reasoning: Preserve-redesign of an existing SaaS admin surface; density stays, chrome shrinks.

UX-LAZY-01: hide unused defaults instead of adding a per-card more. Discoverability of advanced routing flags is a section header, not an in-card disclosure.
UX-STATE-01: hidden = auto-switch + model-picker targeting + Default-mode request_user_input. Why = set-once operator flags. Where = Advanced settings section under the visible rotation-strategy box.

## Work-phase map

1. 010 Slim cards (foundation: the complained-about surface).
2. 020 Whole-box advanced section.
3. 030 Tests, Browser QA, push, remote suite.

One work-phase = one PABCD cycle. Do not implement 010 and 020 in the same B.

## Accept

- Default healthy card = header, identity+order, one quota meter row.
- No details, accordion, or show-more inside a card or settings box.
- Strategy box remains visible. Auto-switch, picker, request_user_input hide as whole boxes.
- Locales keep key-set parity.
