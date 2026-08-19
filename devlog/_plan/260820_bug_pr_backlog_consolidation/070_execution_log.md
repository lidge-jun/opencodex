# 070 — Execution log: what actually shipped

Appended as work-phases close. This is the record of landed state, distinct from the plan.

## wp2 — issue #2132 (score 96)

**PR #2137**, branch `codex/fix-bearer-admission-2132`, base `dev`.

`substituteMainCredential` was computed from how the caller authenticated and never from where
the request routes, so a key-authenticated provider was gated on a ChatGPT credential it cannot
use. The predicate is now
`options.admission?.source === "bearer" && route.codexAccountMode !== undefined`
at both `core.ts:1088` and `compact.ts:325`.

It covers `pool` AND `direct`. Doc 010's "native ChatGPT pool" wording would have excluded
`direct` and re-broken #1686, whose Direct admission is only safe because substitution still
runs. 010 now carries a banner saying so.

Evidence: `tests/bearer-admission-routed-provider.test.ts` driven RED (it reproduced the exact
reported 401), full suite 13516 pass / 0 fail, typecheck and privacy scan clean. Re-audit round 2
by the same adversarial reviewer returned **VERDICT: PASS**.

## wp3 — issue #2092 (score 86)

**PR #2138**, branch `codex/consolidate-prompt-cache-retention`, base `dev`.

Absorbs @lilinxiong's #2102 contract: strip `prompt_cache_retention` on canonical ChatGPT
forward for the `gpt-5.6` family only, with an exact-or-dashed-prefix match so a future
`gpt-5.60` is not swept up. The retired value is not translated into `prompt_cache_options`.

Evidence: 5 of the new tests fail when only the adapter change is reverted; the two narrowness
guards stay green in both directions, which is what makes them guards rather than restatements.
Full suite 13537 pass / 0 fail.

### Closed with attribution

| PR | Author | Superseded by | Carried |
|---|---|---|---|
| #2102 | @lilinxiong | #2138 | the implementation itself |
| #2099 | @yzxcj797 | #2138 | issue link + repro fixture |
| #2091 | @luvs01 | #2138 | nothing; contract deliberately narrower |
| #2029 | @yzxcj797 | merged #2130 | nothing; #2130 adds the disk check review demanded |
| #2063 | @yzxcj797 | merged #2055 | nothing; #2055 is the stricter own-property lookup |

Each carries a comment naming the replacement and the specific reason, so no contributor has to
guess why their work closed.

## Still open by decision, not omission

- #2109 / #2110 (@drakonkat) — unresolved security gap in the override gate; needs a human pass.
- #2053 (@Ingwannu) — C4 OAuth; MAINTAINERS.md mandates security review.
- #2105 (@lilinxiong) — above threshold but no replacement exists yet; closing it now would lose work.
- #2101, #2040 — 20 and 14 files; each needs its own cycle.
- #2104 (@olddonkey) — review-ready and MERGEABLE; reclassified out of the deferred bucket, it is a
  KEEP that deserves review rather than supersession.

## Remaining work-phases

wp4 (#2100 + #2077 capability evidence), wp5 (#2056 K12 with the scorer correction), wp6 (#2131
responses id backfill with the duplicate-id fix). Each is a sibling off `dev`; none depends on
another.

