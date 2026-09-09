# 020 — Phase 2 (wp2): PR #3256 — Kiro reset-aligned cooldown

## Item

`fix(oauth): honor Kiro reset-aligned cooldown without Retry-After`, head
`821462f9a3f887ba2c913b7a7ca62cb624498a19`, base `origin/dev` at `529639a57`,
labels `bug`, `maintainer-sponsored`, `review-ready`.

## Phase class: ADOPTION on a restricted surface

No source is authored here. Per-file incoming change map (from
`gh pr view 3256 --json files`, 222 additions / 9 deletions):

| File | Role in this diff |
|------|-------------------|
| `src/combos/failover.ts` | the exported `parseRetryAfterMs()` shared HTTP-date parser |
| `src/oauth/generic-account-failover.ts` | the cooldown-selection call site |
| `tests/combos.test.ts` | parser regressions |
| `tests/kiro-pool-rank.test.ts` | failover-ranking regressions |

## Actual pre-fix behavior (corrected)

The first draft of this doc claimed an absent header caused a zero-delay retry.
That is wrong, and the correction matters because it changes what the fix is
for. Reading the current tree:

- `src/combos/failover.ts:29-45` — `parseRetryAfterMs()` returns `undefined` for an
  empty, unparseable, or already-elapsed value; it returns a clamped millisecond
  delay otherwise.
- `src/oauth/generic-account-failover.ts:205-211` — `const parsed = parseRetryAfterMs(...)`,
  then the exhausted-account branch is taken only when `parsed === null`, and
  `cooldownMs = exhausted ?? Math.min(parsed ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS)`.

So on the pre-fix tree an unusable header yields `undefined`, not `null`. The
`parsed === null` test never fires, `exhaustedCooldownMs()` is never consulted, and
the account falls back to `DEFAULT_COOLDOWN_MS` — sixty seconds, not zero. The
defect is therefore a wasted 60-second retry cycle against an account whose
allowance is provably spent until its window rolls over, exactly what the
comment at `:206-208` says the code intends to avoid. The fix makes the absent /
malformed case reach the reset-aligned cooldown instead of the default minute.

## TESTS — the assertion that is RED before the fix

In `tests/kiro-pool-rank.test.ts`: an exhausted Kiro account 429s with a missing
or malformed `Retry-After`. Assert the recorded `cooldownUntil` equals the
reset-aligned deadline from `exhaustedCooldownMs()`. On the pre-fix tree it
equals `now + DEFAULT_COOLDOWN_MS` (60 s) instead, so the assertion fails.
In `tests/combos.test.ts`: the parser cases — case-insensitive HTTP-date tokens,
the RFC 850 relative-year rule, UTC asctime, and elapsed dates — fail on the
pre-fix parser. Author-reported post-fix run: 72 pass across both files.

## Security review — explicit, not inferred

`MAINTAINERS.md` requires explicit security review for OAuth surfaces;
`.github/scripts/pr-sponsored-surface.cjs:24-27` restricts the `src/oauth/` prefix
and `assessSponsoredSurface()` at `:78` clears the CI code when the
`maintainer-sponsored` label is present. The label clears the gate; it is not
the review. The review:

- Blast radius, corrected and widened: this diff substantially rewrites the
  EXPORTED `parseRetryAfterMs()` in `src/combos/failover.ts`, which is also the
  parser behind combo-target cooldowns (`coolComboTarget()` at `failover.ts:62`).
  A parser change is therefore not confined to Kiro account ranking — it moves
  combo cooldown timing too. `tests/combos.test.ts` is the regression surface
  that must cover that second consumer, and it is in the diff.
- Direction of the shared-parser change, mode by mode: the rewritten parser is
  NARROWER, not broader. It implements the three HTTP-date grammars explicitly
  (`src/combos/failover.ts:41`) and rejects non-HTTP strings the prior bare
  `Date.parse` happened to accept, while gaining an opt-in `preserveImmediate`
  mode.
  In the DEFAULT mode — the one `coolComboTarget()` uses — an elapsed or
  unparseable date still yields `undefined`, so combo cooldown timing keeps its
  existing fallback semantics. In the OAuth call site's mode, a valid but
  already-elapsed date is converted to a 1 ms delay rather than discarded,
  which is what lets an explicit "retry now" instruction survive instead of
  being replaced by a 60-second default. Both modes keep the `MAX_COOLDOWN_MS`
  clamp. These are timing changes, not authorization changes, and the two modes
  must not be conflated: only the OAuth path takes the immediate branch.
- Credential handling: unchanged. Nothing here reads, writes, logs, or
  serializes a token, refresh credential, or account identifier.
- Workflow and release surfaces: untouched.
- Conclusion: accepted. Admin merge bypasses the approval requirement only; the
  green exact-head rollup, the combo-parser regressions, and this review are the
  non-bypassable evidence.

## Verification (C)

```
gh pr checks 3256                # full rollup, never --required alone
gh pr merge 3256 --squash --admin
git fetch origin dev && git merge-base --is-ancestor <merge-sha> FETCH_HEAD
```

If the gate is red on the current head, the outcome is BLOCKED, not merged.

