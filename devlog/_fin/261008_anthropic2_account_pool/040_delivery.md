# 040 — Delivery (wp5)

1. Push `codex/anthropic2-account-pool`, open one PR against `dev` using
   `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist). Verification states that no
   local suite ran by owner instruction and names the hosted CI run for the exact head.
2. GUI change requires a rendered screenshot in the description (uploaded via the `pr-assets` branch and
   linked by commit SHA, never committed to the feature branch).
3. CI repair loop: read failing job logs for the exact head, fix the root cause, push, re-read. Skipped,
   queued, cancelled or older-head results are not passes.
4. Independent security-focused review of the final diff — credential store, refresh, duplicate guard,
   collision guard, isolation, fallback, no replay after output — findings folded or rebutted with reasons.
   This change touches credential handling, so the review is mandatory before merge (AGENTS.md security
   boundary).
5. Merge with `--match-head-commit` after every required check is green on that head.

Acceptance coverage expected in CI (spread across the phase test files): shared A/B fixtures with equal
account and session IDs and distinct tokens; concurrent isolation; physical-send attribution; asynchronous
fencing after awaits; pool-off reactive recovery inside B; no replay after output; onboarding leaves the
default provider and bare-model resolution unchanged; reset-grant idempotency per instance; custom
`anthropic2` rows (key provider, gateway OAuth, orphan auth) preserved.

Not verified by this unit: live Anthropic accounts, real OAuth login, provider-side account separation.
