# 020 — Phase 2: #908 long-context pricing tiers

Stack layer 1. Work class C2: one conventional slice through an existing
pricing pipeline, no new module boundary.

## The defect

Several vendors reprice the **entire request** once the prompt crosses a token
threshold. The estimator cannot express that. `resolveMatchedPrice()` resolves
one flat `Cost4` and never sees a token count, so every request bills at the
short rate — including the long ones, which are the expensive ones.

`applyPriorityMultiplier()` (`src/usage/cost.ts:269-286`) already establishes
the shape of a conditional repricing step, but it keys off `serviceTier`, so it
cannot be reused as-is.

## The trap

The threshold is measured on **raw** `usage.inputTokens` — the total prompt
size including cache reads and writes (`src/types.ts:311-318`). But
`normalizeCostTokens()` subtracts cache read and write to produce billable
input (`src/usage/cost.ts:121`). A 280k prompt with a 200k cache read has 80k
billable input and still crosses the 272k threshold.

Selecting the tier after normalization would silently under-bill exactly the
cache-heavy long requests — the ones where being right is worth the most. Tier
selection reads `usage.inputTokens` directly; `tokens.input` is forbidden here.

## Verified thresholds

| Model | Threshold | Operator | Multiplier `in/out/cRead/cWrite` |
|---|---|---|---|
| `gpt-5.6-sol`, `-terra`, `-luna` | 272,000 | `>` | 2 / 1.5 / 2 / 2 |
| `grok-4.5` | 200,000 | `>=` | 2 / 2 / 2 / 2 |
| `MiniMax-M3` | 512,000 | `>` | 2 / 2 / 2 / 2 |

The OpenAI operator is exclusive: the page reads "Prompts with >272K input
tokens". xAI's is inclusive: "Long context ≥ 200k tokens". Getting these
backwards is a one-token error nobody would ever notice, so both boundaries get
a test.

## Model-id exactness

`src/generated/jawcode-model-metadata.ts:44` contains **both** `minimax-m3`
(0.6/2.4/0.12/0) and `MiniMax-M3` (0.3/1.2/0.06/0). The first-party registry ID
is the cased `MiniMax-M3` (`src/providers/registry.ts:247-255`). Case-folding
the lookup would select the wrong base row — the tier rule must match exactly.

Provider scoping matters for the same reason: `cursor` and `openrouter` routes
resell these models under their own terms and must not be charged first-party
tier rules.

## Audit correction: long context and Fast are mutually exclusive

The first draft of this phase composed the two multipliers — long context,
then Fast — and produced a $7.80 figure for a long Fast request. That request
cannot exist. OpenAI's Fast mode guide states plainly: "Long context,
fine-tuned models, and embeddings are not supported"
([fast-mode guide](https://developers.openai.com/api/docs/guides/fast-mode),
`verdict=strong_ok`, retrieved 2026-08-03).

They are two regimes, not two factors. The correct model is an
either/or driven by the confirmed service tier:

```text
base price → (Fast multiplier) OR (context multiplier) → calculateCost
```

A request **confirmed** as Fast never takes the context tier. The composition
test is replaced by an **exclusivity** test.

"Confirmed" is load-bearing. `effectiveServiceTier()`
(`src/usage/cost.ts:249-258`) collapses three sources into one scalar with the
precedence `responseServiceTier ?? requestedServiceTier ??
configuredServiceTier`, and the estimator only ever sees the result. OpenAI
documents that a Fast request may be served as `default`, and that the
response's `service_tier` is what identifies the tier actually used — and Fast
does not support long context at all, so a >272k request tagged `priority`
was necessarily *not* served as Fast.

Suppressing the context tier on a merely *requested* priority would therefore
under-bill exactly the request that provoked the downgrade. Exclusivity keys on
`responseServiceTier === "priority"`; a requested-or-configured priority with
no response confirmation takes the context tier.

That needs tier provenance preserved into the estimator rather than the
collapsed scalar, at **four** call sites — not three, which is what the first
amendment said:

| Site | Surface |
|---|---|
| `src/server/management/shared.ts:129-130` | `/api/logs` per-entry cost |
| `src/usage/summary.ts:291-292` | `/api/usage` totals |
| `src/usage/summary.ts:420-421` | per-model breakdown |
| `src/usage/summary.ts:529-530` | per-provider breakdown |

All four currently pass the collapsed `tier`. Updating three of them would
leave one cost surface still under-billing downgraded requests — and it would
be the kind of miss where the dashboard total disagrees with its own
per-provider breakdown for reasons nobody can reproduce.

### A second coupling this exposed

`PRIORITY_MULTIPLIERS` (`src/usage/expected-prices.ts:152-156`) carries Terra
`1.6` and Luna `0.4`. Those are *ratios calibrated against the stale bases*.
Once #907 corrects Terra to 2/12, the 1.6 multiplier yields 3.2/19.2 while
OpenAI publishes Fast Terra at 4/24. Luna is worse: 0.4 × 0.20 = 0.08 against a
published 0.40.

So #907 landing would silently break Fast estimates for two models. The
multipliers must move to verified absolute rates, or be recomputed against the
corrected bases, in the same change that corrects the bases. This is recorded
in `050` as part of the upstream follow-through — it is not this phase's work,
but it must not be discovered afterwards.

## The `-pro` alias gap

`gpt-5.6-sol-pro`, `-terra-pro`, `-luna-pro` are real selectable ids
(`src/providers/registry.ts:284-287`). The virtual-model resolver keeps the
*selected* id in `logCtx.model` and puts the wire id in `logCtx.resolvedModel`
(`src/providers/openai-virtual-models.ts:61-62`), and cost resolution
deliberately does not fall back through `resolvedModel`.

So a tier registry keyed only on base ids would silently skip every `-pro`
request — and those are exactly the large ones.

But tier rows alone are not enough, and the audit proved why by running it:

```console
$ bun run .tmp/probe_pro.ts
gpt-5.6-sol   -> {"input":5,"output":30,"cacheRead":0.5,"cacheWrite":6.25}
gpt-5.6-sol-pro   -> NULL (unpriceable)
gpt-5.6-terra-pro -> NULL (unpriceable)
gpt-5.6-luna-pro  -> NULL (unpriceable)
```

The aliases have no base price at all today, and `estimateRequestCost()`
returns `null` the moment base-price resolution fails
(`src/usage/cost.ts:352`). Since the tier is applied *after* price resolution,
a `-pro` request could never reach `applyContextTier()` — the proposed alias
test would have failed against the real estimator.

This phase therefore adds provider-scoped base-price rows for the three
aliases alongside their tier rows. That is a real bug of its own surfaced by
this work: `-pro` usage currently shows no cost estimate whatsoever.

## Design

`src/usage/expected-prices.ts` — add beside `Cost4`:

```ts
export type ContextTierName = "long";

export interface ContextTier {
  thresholdInputTokens: number;
  inclusive: boolean;
  multiplier: Cost4;
  source: string;
  verifiedAt: string;
}
```

plus an exactly-keyed `CONTEXT_TIERS` registry (`${provider}\0${modelId}`) and
`findContextTier()` / `isLongContext()`. No fuzzy matching, no case folding, no
model-level fallback. Every row records its official URL and `verifiedAt`.

`src/usage/cost.ts` — add `applyContextTier()`, applied only when the Fast
multiplier did not apply.

`resolveMatchedPrice()` stays token-independent; it is memoized by
provider/model (`src/usage/cost.ts:153-162`) and passing a token count would
poison that cache. The tier is selected after price resolution and before
`calculateCost()`, in both `estimateAttemptCost()` and `estimateRequestCost()`.

`contextTier?: ContextTierName` is added to `AttemptCostEstimate` and
`CostEstimate` so the dashboard can distinguish "long" from "just a bigger
number". A combo result carries it when any attempt does, while each attempt
keeps its own.

## Worked example

Sol, 300,000 input + 20,000 output, no cache:

- short: `300000/1e6 × 5 + 20000/1e6 × 30` = `1.50 + 0.60` = **$2.10**
- long: `300000/1e6 × 10 + 20000/1e6 × 45` = `3.00 + 0.90` = **$3.90**

There is no long-Fast figure. That was the audit's first blocker.

## Tests

Extend `tests/usage-cost.test.ts` — the sibling already covering normalization,
resolution, attempts, combos, and Fast composition.

1. Each OpenAI model at exactly 272,000 (no tier) and 272,001 (tier).
2. Grok at 199,999 (no tier) and exactly 200,000 (tier) — inclusive boundary.
3. `MiniMax-M3` at 512,000 / 512,001; lowercase `minimax-m3` gets no tier.
4. **Raw-vs-normalized**: raw input above 272k with a cache read large enough
   that normalized input falls below it — tier must still activate.
5. `cursor/gpt-5.6-sol` and `openrouter/openai/gpt-5.6-sol` stay untiered.
6. An untiered model is unchanged above every threshold.
7. The $2.10 / $3.90 worked example.
8. **Exclusivity, by provenance**: an entry above 272k with
   `responseServiceTier: "priority"` takes the Fast rate and leaves
   `contextTier` undefined. An entry above 272k with priority only in
   `requestedServiceTier` or `configuredServiceTier` — no response confirmation
   — takes the **context tier**, because Fast does not serve long context, so
   that request was downgraded. Both cases get a test; asserting only the first
   would silently reinstate the bug this correction removes.
9. Combo propagation: one long attempt + one standard attempt.
10. All three `-pro` aliases tier correctly at 272,001.

The existing Fast fixture at `tests/usage-cost.test.ts:408` uses 1M input,
which now crosses the threshold. It must move below 272k or its expected totals
change — the kind of silent fixture breakage that looks like a regression.
