# Model Price Overrides

## Configuration and API

`ProviderCostOverlay` in `src/types/provider.ts` keeps four required base rates and an optional
`promptLengthPricing` discriminated policy: `automatic`, `flat`, or `custom` with a positive
safe-integer `thresholdTokens`, `gt`/`gte` comparison and four absolute alternative `rates`.
Absent policy retains legacy automatic context behavior. `src/config/schema/leaf-validators.ts`
rejects malformed/unknown nested fields on writes and copies only validated policy fields for
display, dropping an explicit `automatic` policy so absence is the single stored form of
Automatic; load degradation drops an invalid model row without losing the provider.

`src/providers/openai-tiers.ts` accepts these same rate and policy shapes through the shared
`validCost4` predicate in the pure `src/usage/user-cost-validation.ts` module when migrating
legacy `openai-multi` overlays. It rejects unknown row
fields and malformed policies, and preserves valid policies while rewriting model keys to `openai`.
`tests/adapters/openai/openai-provider-option-migration.test.ts` covers preservation and rejection.

`src/server/management/model-routes.ts` serves `GET/PUT /api/providers/{provider}/model-costs`.
GET and successful PUT receipts retain all four rates and the optional validated policy.
A `cost: null` write removes the entire model override. Writes retain atomic persistence,
rollback and sibling-model preservation. `tests/server/model-costs-prompt-length-pricing.test.ts`
covers persistence, receipts, reset, rollback and external edits.

`src/config/live-reconcile.ts` scopes explicit pricing PUT intent to one complete model row.
After recursive reconciliation under the config mutation lock, it reapplies that row (or its
deletion) and validates the final candidate before publication. This prevents concurrent mode
changes from mixing Custom fields into Flat/Automatic policies, and honors replacement even
when the submitted base rates equal the old baseline. Unrelated saves still adopt disk edits.
`src/cli/models-runtime.ts` reads the complete policy in `cost` and projects only base rates in
`effectiveCost`. `set-price` reads the current row first and carries that model's policy into
the replacement row, so a base-rate edit never silently drops a Flat or Custom policy; its receipt
must echo the same policy, with absent and `automatic` treated as equal.

## Dialog and estimates

`gui/src/components/ModelPriceDialog.tsx` edits base rates plus Automatic, Flat rate or Custom
threshold pricing. Automatic retains catalog context rules with the saved base tuple. Flat skips
context adjustments; Custom replaces the catalog rule on both sides of its single threshold.
Parsing, draft building, per-field validation and receipt comparison live in the pure
`gui/src/components/model-price-cost.ts`; the dialog sends no policy for Automatic, validates
complete policy receipts before refreshing the model list and retains its uncertain-outcome/reload
flow. `gui/tests/models-price-editor.test.tsx` covers this behavior.
The comparison Select renders its menu inside the modal dialog so native modal inertness does
not block pointer or keyboard interaction with its options.

`src/usage/cost.ts` selects rates against inclusive `usage.inputTokens`, before subtracting cache
reads/writes for cost estimates; output is excluded from threshold selection. Alternative rates
apply to every token bucket of the request. Custom rates are standard-speed rates that stand in
for the catalog long-context rate, so a crossed threshold follows the catalog's
`confirmedPriorityRelation` for that model: `stack` (or no catalog rule) applies the Priority
multiplier once, `lower-bound` keeps the custom rates and sets `priorityLowerBound`, and
`exclusive` prices a confirmed Priority request from the base rates. Confirmation requirements are
unchanged. `customThresholdApplied` stays separate from the catalog `contextTier` marker and is
set only when the custom rates priced the request. Each Combo attempt selects its own tuple.
`tests/usage/usage-prompt-length-pricing.test.ts` pins boundaries, cached prompts, whole-request
rates, compatibility, Combo and Fast/Priority behavior.
It also verifies Automatic Haiku overrides at 99,999/100,000/100,001 inclusive prompt tokens,
including cache reads/writes and the inherited catalog band for both Anthropic OAuth pools.

## Credit-billed providers

A provider that bills credits reports a measured count instead of a token allocation, so
`src/usage/credit-billing.ts` owns the bounds and the billing basis that `src/usage/cost.ts`
attaches to an estimate. `providers.<name>.creditPriceUsd` is bounded to `0..1_000_000` by the
same predicate the config schema and load degradation use; a single attempt may report at most
`1_000_000_000` credits, and one token bucket of a priced row at most `1_000_000_000_000` tokens.
Bounding only one factor is not enough: `1e308 x 1e308` is `Infinity`, which `JSON.stringify`
writes as `null`.

A cost estimate therefore carries an optional `billing` field. `{ source: "provider-credits",
providerCredits, creditPriceUsd }` means the total is `providerCredits x creditPriceUsd` and the
four token component fields carry no allocation; a Combo reports it only when every attempt shared
one credit price, and reports `{ source: "mixed" }` when the attempts were billed differently, so
the parent total is real but its split exists only per attempt. Absent `billing` means a token
price, which is what every older row reports.

`priorityLowerBound` follows the rate that produced each amount, and a Combo's total is a floor
when the applicable token-priced legs are. A credit charge is exact for its configured price, so it never
sets the marker and never vetoes one: `credits x price + >=token` is still `>=` the true total, so
a mixed Combo keeps the floor any token leg earned. A credit leg's own catalog rate contributes
nothing, because that rate priced neither the leg nor the total. A credits-only Combo is exact and
reports no floor. `gui/src/pages/logs-cost-format.ts` applies the same rule to a row seeded by an
older build or served by an older proxy, where the marker and reasons were already persisted. A
credit-priced row whose count or price cannot produce a representable amount is unavailable with
`credit_cost_unrepresentable` rather than falling back to a token estimate. A missing credit reading
with no output is also unavailable because the charge is unknown. Combined attempts retain incomplete
credit evidence when any attempt lacks a reading and another has one, including a retry HTTP failure.
A token-priced row whose
normalized token count exceeds the bound is `invalid_usage`.
`tests/usage/usage-provider-credit-price.test.ts`, `tests/server/management-api-logs-metrics.test.ts`
and `gui/tests/logs-cost-credit-billing.test.tsx` cover the bounds, the mixed aggregation and the
rendered detail.

`src/usage/user-cost-overlays.ts` copies the complete policy into its versioned registry:
policy-only edits invalidate price memoization and usage caches; identical reloads remain stable.
`tests/server/model-costs-pricing-cache.test.ts` exercises warmed cache invalidation and reset.
These settings affect estimates, not upstream billing or official catalog price lists.

Only reported or estimated usage is priced by `src/usage/cost.ts`. Partial tokens on an unreported or unsupported attempt do not establish its full cost. `src/usage/summary.ts` marks a multi-attempt request unpriced when any potentially billed attempt lacks measured usage, while a refusal before generation without usage remains a known zero. Measured attempts retain their individual estimates.
