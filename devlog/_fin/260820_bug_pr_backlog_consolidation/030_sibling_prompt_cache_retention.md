# 030 — Sibling A: consolidate prompt_cache_retention (issue #2092)

Work-phase: wp4. Branch: `codex/consolidate-prompt-cache-retention`. Base: **dev** (sibling, not a stack layer).
Absorbs: **PR #2102 by @lilinxiong** (base implementation). Supersedes: **#2099 by @yzxcj797**, **#2091 by @luvs01**. Closes #2092.

## Why a sibling and not a layer

It touches only `src/adapters/openai-responses.ts`, which no other absorbed item touches. It has
no dependency on layers 1-2, so stacking it would impose a false merge order (DEV-STACK-01).

## Chosen contract

@lilinxiong's #2102: strip `prompt_cache_retention` only when
`forward && isCanonicalOpenAiForwardProvider(provider)` AND the model is `gpt-5.6` or
`gpt-5.6-*`. This matches the issue's own correction — the reporter withdrew the "strip
everywhere" claim, and some non-5.6 deployments still honor the field.

Rejected: #2091's blanket strip for every forward provider and every model (it inverts the
existing gpt-5.5 preserve pin at tests/openai-responses-passthrough.test.ts:807).
Rejected: #2099's `startsWith("gpt-5.6")`, which also matches `gpt-5.60`, and its stray
package.json 2.24.2 -> 2.25.0 bump.

## Carried from the superseded PRs

From @yzxcj797's #2099: the `Fixes #2092` issue link and the repro-shaped fixture
(`store:false`, streamed input array). From @luvs01's #2091: nothing — its key-auth preserve
case is already covered by #2102.

## Tightening to apply

Replace the string-prefix family match with the catalog/native-slug predicate if one exists
in the current tree (`rg -n "isGpt56NativeSlug|NATIVE_OPENAI_MODELS" src/`); otherwise keep
the exact `gpt-5.6` / `gpt-5.6-*` match and pin `gpt-5.60` as a NON-match in tests.

## Test plan (must fail RED first)

Carry #2102's tests; add `gpt-5.60` non-match; keep the gpt-5.5 preserve pin intact.

