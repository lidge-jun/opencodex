# 040 — Recorded deferrals

Deferring is a disposition, not an omission. Each item below stays open with a
stated reason rather than being force-landed.

## #3348 / #3312 — combos failover hardening

Both carry the same confirmed correctness blocker: generic HTTP 410 and 413 are
classified as retryable hops (`src/combos/failover.ts:563-617` on both heads), so an
oversized or invalid request would be replayed to the next provider. Their own tests
encode the wrong expectation. #3348 functionally supersedes #3312 (30 shared files,
near-identical source diffs; #3312 is additionally CONFLICTING/DIRTY).

At 2,248 lines across 34 files spanning failover, credential rotation, durable
cooldown persistence, shutdown, and the core response path, this is not reviewable
inside a mixed campaign. It needs its own split stack.

## #3325 — dev bump guard fork filter

The code is correct, but `.github/workflows/` is a restricted surface
(`.github/scripts/pr-sponsored-surface.cjs:24-27`) and the hygiene gate fails
`unsponsored_surface` without a maintainer sponsorship decision. That is a policy
action for a human, not a patch. Note the second red check is a cancelled
`enforce-target` run that `gh pr checks` renders as a failure.

## All six bug issues

See 000. Every one needs reporter evidence or a product decision. Three of them
(#3352, #3320, #3279) would require weakening an auth or identity boundary to
"fix" without a reproduction, which is the wrong trade.
