---
title: Kiro request credits
description: Kiro completion guardrails and refusals, the credit metering opencodex records, and how to price credits in USD.
---

On tool-enabled turns, opencodex holds Kiro's ordinary text until completion is validated.
If Kiro ends with plain text instead of its private final-answer tool, one bounded retry
still runs, and only the resulting final answer is displayed. Progress accompanying a real
tool call remains visible. A normal private final answer needs no completion retry.

When Kiro's safety filter stops a turn (`CONTENT_FILTERED`, for example the Claude `BIO` classifier), the request ends as a refusal that clients do not retry: Claude clients see `stop_reason: "refusal"` and Codex sees a failed response carrying Kiro's category and explanation. If the filter stops the bounded retry, no final answer is displayed; the progress held from the first attempt and any partial text from the retry are shown as commentary before the refusal.

When Kiro emits credit metering, request logs preserve the reported spend as
`usage.providerCredits`, including in the persisted usage ledger. These are Kiro credits;
token counts may still be estimated. Completion fallback requests add their reported credits.
An absent value means Kiro did not report credit usage; an explicit zero means it reported no spend.

## Pricing credits in USD

Set `providers.kiro.creditPriceUsd` to the USD price of one credit for your plan to cost those
rows from what Kiro billed instead of from their estimated tokens:

```json
{ "providers": { "kiro": { "creditPriceUsd": 0.02 } } }
```

The price is opt-in and has no default, because it depends on the plan: on
[kiro.dev/pricing](https://kiro.dev/pricing/), Pro is $20 for 1,000 credits ($0.02) and add-on
credits are $0.04. Check your own plan rather than copying these two figures.

With a price set, the estimate for a metered row follows these rules:

- A row that reports credits costs `providerCredits x creditPriceUsd`. Its estimated token counts
  are still recorded, but they no longer set the price, so a long conversation that Kiro cached
  reads the way Kiro billed it.
- A row with no credits and no output — refused or cancelled before generation — costs 0.
- A row with output but no reported credits keeps the token estimate, because Kiro reported no
  credit spend to price.
- Account-suffixed rows such as `kiro-<account>` use the provider's price. An entry for an exact
  configured name wins first, so a provider named `kiro-team` with no price of its own is not
  priced by `kiro`'s value.
- The price only replaces a cost that already resolved. A model with no token price at all stays
  unpriced and is counted under unpriced requests instead of cost — `kiro-auto`, Kiro's default
  model, is one such row — so a price does not by itself make every Kiro row priced.
- Without the key, every cost stays the token estimate.

A credit-billed row has no token allocation to show. The estimate records its billing basis
instead: the request-log detail panel labels the section **Estimated cost** rather than API
list-price equivalent, prints **Credit-priced total** with the charge as
`<credits> credits × <price> per credit`, and omits the four token component rows, which would
otherwise read as `$0.0000` each beside a nonzero total. A Combo whose attempts were not all
billed the same way — one credit attempt beside a token-priced one, or two credit prices — reports
**Combined total (per-attempt basis)** and marks the split as mixed, because summing the credits
would produce a number that matches no price. Each attempt still states the charge and price it
actually incurred. The management API exposes the same decision as an optional `billing` object on
the cost estimate; clients that do not read it are unaffected.

### Bounds and unrepresentable values

`creditPriceUsd` must be **between 0 and 1,000,000**. The management boundary rejects anything else,
and a hand edit that fails that rule is dropped on load with a warning naming the provider, so the
rest of the provider entry still loads. As with model prices, the price is applied when an estimate
is computed, so editing it re-estimates already-logged rows on the next refresh.

Credits are bounded too — a single attempt may report at most 1,000,000,000 of them — and one
token bucket of a priced row at most 1,000,000,000,000 tokens. Both bounds are far outside any real
plan: the priciest published credit plans are cents per credit, and a single response reports a few
thousand credits. They exist because bounding the price alone does not keep the product
representable: `1e308 x 1e308` is `Infinity`, and `JSON.stringify` writes that as `null`.

When a row **is** credit-priced but its credit count or price cannot produce a representable
amount — an out-of-bound or non-finite reading, or an overflowing product — its cost is reported as
unavailable with the reason `credit_cost_unrepresentable`, rather than falling back to the token
estimate. A fallback would report a different amount than the credit basis you configured, which is
exactly what the price is meant to replace. A finite but absurd token count on a token-priced row
is classified as `invalid_usage` for the same reason: no price can repair that number, and saying
"price unmatched" would point at the price table.

This is an estimate only. The price is never sent upstream, and it does not change provider
billing, account selection, or quotas.
