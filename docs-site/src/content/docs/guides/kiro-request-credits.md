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

The value must be a finite number of 0 or more. The management boundary rejects anything else, and
a hand edit that fails that rule is dropped on load with a warning naming the provider, so the rest
of the provider entry still loads. As with model prices, the price is applied when an estimate is
computed, so editing it re-estimates already-logged rows on the next refresh.

This is an estimate only. The price is never sent upstream, and it does not change provider
billing, account selection, or quotas.
