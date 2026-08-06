# 050 — #907 stale bundled prices: the blocker record

Outcome: **no code in this repository**. The fix belongs in
`lidge-jun/jawcode`.

Precisely: this is not unfixable, and not blocked in the sense of "nothing can
be done". It is fixable upstream, and under the current source-of-truth policy
it should not be fixed locally. A new narrowly-scoped "verified corrections"
layer would be a technically legitimate design — `expected-prices.ts` is
precedent for exactly that shape — but it would deliberately diverge the
bundle from its canonical source to route around a one-line upstream edit.
Upstream-first is the cheaper and more honest order.

## Why this is not a regeneration

The obvious move is `bun run generate:jawcode-metadata` and commit the result.
That reproduces the defect exactly.

`scripts/generate-jawcode-metadata.ts:22-24` resolves its source from
`JAWCODE_MODELS_JSON` or `../jawcode/packages/ai/src/models.json`, and
`:82-98` copies the four cost fields with no transformation. The generated file
is a pure projection. And the canonical source carries the same stale numbers:

```console
$ python3 - <<'EOF'   # /Users/jun/Developer/new/700_projects/jawcode
/openai/gpt-5.6-terra        {'input': 2.5, 'output': 15, 'cacheRead': 0.25, 'cacheWrite': 3.125}
/openai/gpt-5.6-luna         {'input': 1, 'output': 6, 'cacheRead': 0.1, 'cacheWrite': 1.25}
/openai-codex/gpt-5.6-terra  {'input': 2.5, ...}
/github-copilot/gpt-5.6-terra{'input': 2.5, ...}
/opencode-zen/gpt-5.6-terra  {'input': 2.5, ...}
EOF
```

Four provider bundles, same wrong numbers, different repository.

## Why the overlay is not an escape hatch

`src/usage/expected-prices.ts:1-11` scopes the overlay to models whose jawcode
rows are **missing or all-zero**, and `src/usage/cost.ts:139-145` gives a valid
nonzero jawcode row precedence over it. A nonzero-but-wrong row is never
reached. Zero means "not billable here", not "free" — that distinction is the
whole design, and widening it to mean "or wrong" would break the precedence
contract for every model.

## Why hand-editing the bundle is not an option

`src/generated/jawcode-model-metadata.ts:1-2` declares itself generated. The
next regeneration reverts the edit silently, and
`tests/jawcode-metadata-sync.test.ts:21-47` regenerates from the same source
and byte-compares — so a hand-edit fails CI immediately, which is the test
working correctly.

Passing a corrected JSON through `JAWCODE_MODELS_JSON` would produce the right
bytes while canonical jawcode stays wrong. That is deliberate source
divergence dressed up as a fix.

## The correction to the report

The reporter asserted cache writes should be zero. They should not. The
official page publishes a `Short context cache writes` column with nonzero
values for all three models (retrieved 2026-08-03, `verdict=strong_ok`):

| Model | input / cachedInput / cacheWrite / output |
|---|---|
| `gpt-5.6-sol` | 5.00 / 0.50 / 6.25 / 30.00 |
| `gpt-5.6-terra` | 2.00 / 0.20 / 2.50 / 12.00 |
| `gpt-5.6-luna` | 0.20 / 0.02 / 0.25 / 1.20 |

Sol's bundled row is already correct. A regeneration that zeroed cache writes
would replace one wrong number with another — and it would have looked like
progress.

## The upstream change

In `lidge-jun/jawcode`, `packages/ai/src/models.json`:

```diff
 "gpt-5.6-terra": { "cost": {
-  "input": 2.5, "output": 15, "cacheRead": 0.25, "cacheWrite": 3.125
+  "input": 2, "output": 12, "cacheRead": 0.2, "cacheWrite": 2.5
 }}
 "gpt-5.6-luna": { "cost": {
-  "input": 1, "output": 6, "cacheRead": 0.1, "cacheWrite": 1.25
+  "input": 0.2, "output": 1.2, "cacheRead": 0.02, "cacheWrite": 0.25
 }}
```

Sol unchanged. All four provider bundles need the same correction or they will
contradict each other.

## What lands here afterwards

Regenerate, commit the generated diff without hand-editing, and add a
table-driven regression near `tests/usage-cost.test.ts:153-159` asserting
`resolveMatchedPrice("openai", model)` returns the exact tuple with
`source: "jawcode"` and `status: "verified"` for all three models.

That test is the durable part. The existing sync test proves the bundle matches
its source; it cannot prove the source matches the vendor. This one pins the
actual published numbers, so the next price cut fails a test instead of
silently overcharging users.

## The coupled change nobody would have looked for

`PRIORITY_MULTIPLIERS` (`src/usage/expected-prices.ts:152-156`) stores Fast
pricing as *ratios against the base rates* — Terra `1.6`, Luna `0.4`. Those
ratios were calibrated when the bases were stale.

Correcting the bases therefore breaks Fast estimates for the same two models:
1.6 × 2 = 3.2 against a published Fast Terra of 4, and 0.4 × 0.20 = 0.08
against a published 0.40. The regeneration that fixes #907 must recompute or
replace those multipliers in the same change, or it will fix an overcharge on
standard requests while introducing an undercharge on Fast ones.

This is the kind of coupling a ratio-based design hides: the numbers stay
syntactically valid and no test fails.
